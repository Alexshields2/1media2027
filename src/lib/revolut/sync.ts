import { db, schema } from "../../db";
import { insertExpenses, type ExpenseInput } from "../expenses";
import { openRows } from "../reconcile";
import { suggestMatches } from "../matching";
import { getAccounts, getTransactions, RevolutApiError, type FetchLike, type RevolutTransaction } from "./api";
import { expireAccessToken, getAccessToken, getConnection, saveSyncState } from "./connection";

// Revolut Business transactions -> Expenses (money out) and unmatched incoming payments (money in).
// Idempotent: every row is keyed by the Revolut transaction ID ("revolut:<id>", the same key a
// Revolut statement CSV uses), so re-syncing an overlapping window adds nothing twice.
// Money in is only ever a suggestion on the Payments page: the owner assigns it to a month.

const OUT_TYPES = new Set(["card_payment", "transfer", "fee", "atm", "tax", "charge"]);
const IN_TYPES = new Set(["transfer", "topup", "card_credit"]);

export interface IncomingCredit {
  externalId: string;
  date: string;
  amount: number;
  currency: string;
  payer: string | null;
  reference: string | null;
  description: string;
}

export type MappedTransaction =
  | { kind: "expense"; items: ExpenseInput[] }
  | { kind: "income"; credit: IncomingCredit }
  | { kind: "skip"; reason: "not completed" | "own transfer" | "other type" };

const round2 = (n: number) => Math.round(n * 100) / 100;
const stripPrefix = (s: string | undefined, re: RegExp) => s?.replace(re, "").trim() || undefined;

/** Pure: one Revolut transaction -> what to record. ownAccountIds are this business's Revolut accounts. */
export function mapTransaction(tx: RevolutTransaction, ownAccountIds: Set<string>): MappedTransaction {
  if (tx.state !== "completed") return { kind: "skip", reason: "not completed" };
  const legs = tx.legs ?? [];
  const leg = legs.find((l) => ownAccountIds.has(l.account_id)) ?? legs[0];
  if (!leg) return { kind: "skip", reason: "other type" };
  const cp = leg.counterparty;
  const own =
    tx.type === "exchange" ||
    cp?.account_type === "self" ||
    (!!cp?.account_id && ownAccountIds.has(cp.account_id)) ||
    (legs.length > 1 && legs.every((l) => ownAccountIds.has(l.account_id)));
  if (own) return { kind: "skip", reason: "own transfer" };

  const date = (tx.completed_at ?? tx.created_at).slice(0, 10);
  const id = `revolut:${tx.id}`;

  if (leg.amount < 0 && OUT_TYPES.has(tx.type)) {
    const amount = round2(-leg.amount);
    const amountEur = leg.currency === "EUR" ? amount : leg.bill_currency === "EUR" && leg.bill_amount ? round2(Math.abs(leg.bill_amount)) : null;
    const merchant = tx.merchant?.name || stripPrefix(leg.description, /^(to|payment to)\s+/i) || (tx.type === "fee" ? "Revolut" : "Unknown");
    const cardNo = tx.card?.card_number?.replace(/\D/g, "") ?? "";
    const foreign = leg.bill_currency && leg.bill_currency !== leg.currency ? ` (${Math.abs(leg.bill_amount ?? 0).toFixed(2)} ${leg.bill_currency})` : "";
    const items: ExpenseInput[] = [
      {
        externalId: id,
        date,
        merchant,
        description: [leg.description, tx.reference].filter((x) => x && x !== merchant).join(" · ") + foreign || null,
        amount,
        currency: leg.currency,
        amountEur,
        revolutAccountId: leg.account_id,
        cardLast4: cardNo.length >= 4 ? cardNo.slice(-4) : null,
        notes: amountEur === null ? `Paid in ${leg.currency}: add the euro amount.` : null,
        hint: { type: tx.type, mcc: tx.merchant?.category_code ?? null },
      },
    ];
    if (leg.fee && leg.fee > 0) {
      items.push({
        externalId: `${id}:fee`,
        date,
        merchant: "Revolut",
        description: `Fee on ${merchant}`,
        amount: round2(leg.fee),
        currency: leg.currency,
        amountEur: leg.currency === "EUR" ? round2(leg.fee) : null,
        revolutAccountId: leg.account_id,
        hint: { type: "FEE" },
      });
    }
    return { kind: "expense", items };
  }

  if (leg.amount > 0 && IN_TYPES.has(tx.type)) {
    const description = leg.description ?? "";
    return {
      kind: "income",
      credit: {
        externalId: id,
        date,
        amount: round2(leg.amount),
        currency: leg.currency,
        payer: stripPrefix(description, /^(money added from|payment from|transfer from|from)\s+/i) ?? null,
        reference: tx.reference ?? null,
        description,
      },
    };
  }
  return { kind: "skip", reason: "other type" };
}

/** Money in as unmatched incoming payments with suggested matches. Never applied to payment rows. */
export async function insertIncomingCredits(credits: IncomingCredit[]): Promise<{ inserted: number }> {
  if (!credits.length) return { inserted: 0 };
  const rows = await openRows();
  let inserted = 0;
  for (const c of credits) {
    const suggestions = suggestMatches({ ...c, channel: "revolut" }, rows);
    const [row] = await db
      .insert(schema.incomingPayments)
      .values({
        source: "bank",
        externalId: c.externalId,
        receivedDate: c.date,
        amount: c.amount,
        currency: c.currency,
        payer: c.payer,
        reference: c.reference,
        description: c.description,
        bankFormat: "revolut",
        sourceFile: "Revolut API",
        suggestions,
        notes: c.currency !== "EUR" ? `Paid in ${c.currency}, not EUR: check the amount before confirming.` : null,
      })
      .onConflictDoNothing()
      .returning({ id: schema.incomingPayments.id });
    if (row) inserted++;
  }
  return { inserted };
}

export interface SyncResult {
  from: string;
  transactions: number;
  expensesAdded: number;
  incomeAdded: number;
  skippedOwnTransfers: number;
  skippedOther: number;
  uncategorised: number;
}

/** Pulls accounts and transactions since the last sync (with a 3-day overlap) and records them. */
export async function syncRevolut(opts: { fetch?: FetchLike; now?: number; firstSyncDays?: number } = {}): Promise<SyncResult> {
  const now = opts.now ?? Date.now();
  try {
    let token = await getAccessToken({ fetch: opts.fetch, now });
    let accounts;
    try {
      accounts = await getAccounts(token, { fetch: opts.fetch });
    } catch (e) {
      if (!(e instanceof RevolutApiError && e.status === 401)) throw e;
      // The cached access token was revoked early: refresh once and retry.
      await expireAccessToken();
      token = await getAccessToken({ fetch: opts.fetch, now });
      accounts = await getAccounts(token, { fetch: opts.fetch });
    }
    const own = new Set(accounts.map((a) => a.id));
    const conn = await getConnection();
    const fromMs = conn?.syncedThrough ? conn.syncedThrough.getTime() - 3 * 86_400_000 : now - (opts.firstSyncDays ?? 90) * 86_400_000;
    const from = new Date(fromMs).toISOString();

    const seen = new Set<string>();
    const expenses: ExpenseInput[] = [];
    const credits: IncomingCredit[] = [];
    let ownTransfers = 0;
    let other = 0;
    let newest = conn?.syncedThrough?.getTime() ?? 0;
    let to: string | undefined;
    // Newest first, 1000 per page; the next page ends at the oldest created_at seen.
    for (let page = 0; page < 50; page++) {
      const txs = await getTransactions(token, { from, to, count: 1000 }, { fetch: opts.fetch });
      let fresh = 0;
      for (const tx of txs) {
        if (seen.has(tx.id)) continue;
        seen.add(tx.id);
        fresh++;
        const m = mapTransaction(tx, own);
        if (m.kind === "expense") expenses.push(...m.items);
        else if (m.kind === "income") credits.push(m.credit);
        else if (m.reason === "own transfer") ownTransfers++;
        else other++;
        // Only completed transactions move the cursor, so pending ones are picked up once they complete.
        if (tx.state === "completed") newest = Math.max(newest, Date.parse(tx.created_at));
      }
      if (txs.length < 1000 || !fresh) break;
      const oldest = txs[txs.length - 1].created_at;
      if (oldest === to) break;
      to = oldest;
    }

    const e = await insertExpenses(expenses, "revolut");
    const i = await insertIncomingCredits(credits);
    const result: SyncResult = {
      from: from.slice(0, 10),
      transactions: seen.size,
      expensesAdded: e.inserted,
      incomeAdded: i.inserted,
      skippedOwnTransfers: ownTransfers,
      skippedOther: other,
      uncategorised: e.uncategorised,
    };
    await saveSyncState({
      accounts: accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency })),
      syncedThrough: newest ? new Date(newest) : (conn?.syncedThrough ?? null),
      lastSyncAt: new Date(now),
      lastSyncResult: { ...result },
      lastError: null,
    });
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await saveSyncState({ lastSyncAt: new Date(now), lastError: msg.slice(0, 300) }).catch(() => {});
    throw err;
  }
}
