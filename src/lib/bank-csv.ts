import { createHash } from "node:crypto";

// Bank CSV exports -> incoming credits. Pure functions (no database), unit-tested with fixtures.
//
// Column mapping is data, not code: each format lists the header names it may use for each field
// (matched case-insensitively, ignoring surrounding spaces). To support a new bank or a changed
// export, add or edit an entry in BANK_FORMATS.

export interface BankFormat {
  id: "revolut" | "aib";
  label: string;
  /** Headers that must all be present for auto-detection. */
  detect: string[];
  columns: {
    date: string[];
    /** Signed amount column (positive = money in). Used when credit/debit columns are absent. */
    amount?: string[];
    /** Money-in column (unsigned). */
    credit?: string[];
    /** Money-out column (unsigned). */
    debit?: string[];
    currency?: string[];
    payer?: string[];
    reference?: string[];
    /** One or more columns joined into a description. */
    description: string[];
    id?: string[];
    state?: string[];
    type?: string[];
    /** Money-out extras (expenses). */
    card?: string[];
    account?: string[];
    mcc?: string[];
    fee?: string[];
  };
  /** Date order in the export. ISO dates (with optional time) are always understood. */
  dateOrder: "dmy" | "iso";
  /** Rows whose state column is set and not in this list are skipped (e.g. pending or reverted). */
  okStates?: string[];
  /** Rows whose type column is in this list are skipped (e.g. card payments, exchanges). */
  skipTypes?: string[];
  /** Money-out rows whose type column is in this list are not expenses (e.g. currency exchanges). */
  debitSkipTypes?: string[];
  defaultCurrency: string;
}

export const BANK_FORMATS: BankFormat[] = [
  {
    id: "revolut",
    label: "Revolut Business",
    // Revolut Business "Statement → Excel/CSV". Older and personal exports use "Completed Date"/"Started Date".
    detect: ["state", "description"],
    columns: {
      date: ["Date completed (UTC)", "Date completed", "Completed Date", "Date started (UTC)", "Started Date", "Date"],
      amount: ["Amount", "Total amount", "Paid in"],
      currency: ["Payment currency", "Currency", "Orig currency"],
      payer: ["Payer", "Counterparty", "Counterparty name"],
      reference: ["Reference"],
      description: ["Description"],
      id: ["ID", "Transaction ID"],
      state: ["State"],
      type: ["Type"],
      card: ["Card number"],
      account: ["Account"],
      mcc: ["MCC"],
      fee: ["Fee"],
    },
    dateOrder: "iso",
    okStates: ["COMPLETED"],
    skipTypes: ["EXCHANGE", "CARD_PAYMENT", "CARD_REFUND", "FEE", "ATM"],
    debitSkipTypes: ["EXCHANGE", "CARD_REFUND", "TOPUP", "REFUND"],
    defaultCurrency: "EUR",
  },
  {
    id: "aib",
    label: "AIB",
    // AIB internet banking "Export to CSV". Headers come with leading spaces; dates are DD/MM/YYYY.
    detect: ["posted transactions date", "credit amount"],
    columns: {
      date: ["Posted Transactions Date", "Transaction Date", "Date"],
      credit: ["Credit Amount"],
      debit: ["Debit Amount"],
      currency: ["Posted Currency", "Local Currency"],
      description: ["Description1", "Description2", "Description3", "Description"],
      type: ["Transaction Type"],
    },
    dateOrder: "dmy",
    defaultCurrency: "EUR",
  },
];

export interface BankCredit {
  /** Stable ID for dedupe: the bank's own transaction ID, or a hash of the row. */
  externalId: string;
  date: string; // YYYY-MM-DD
  amount: number;
  currency: string;
  payer: string | null;
  reference: string | null;
  description: string;
}

/** Money out (an expense candidate). amount is positive. */
export interface BankDebit {
  /** "revolut:<transaction id>" (the same ID the Revolut API uses), "<id>:fee" for a fee on it, or a row hash. */
  externalId: string;
  date: string;
  amount: number;
  currency: string;
  /** Merchant or payee, e.g. "Canva" or "Acme Ltd" (from "To Acme Ltd"). */
  counterparty: string;
  description: string;
  reference: string | null;
  /** Bank's own type, upper case (CARD_PAYMENT, TRANSFER, FEE, ATM, Debit…). */
  type: string | null;
  cardLast4: string | null;
  account: string | null;
  mcc: string | null;
  /** A transfer to another of our own accounts (excluded from totals). */
  ownTransfer: boolean;
}

export interface ParsedBankCsv {
  format: BankFormat;
  credits: BankCredit[];
  /** Money out, for Expenses. The Payments page ignores these. */
  debits: BankDebit[];
  /** Rows that were not credits (money out, pending, card payments) or couldn't be read. */
  skipped: number;
  errors: string[];
}

/** RFC 4180 CSV parser: quotes, escaped quotes, commas/newlines inside quotes, CRLF, BOM. */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, "");
  const delim = sniffDelimiter(s);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function sniffDelimiter(s: string): string {
  const first = s.split(/\r?\n/, 1)[0] ?? "";
  const count = (d: string) => first.split(d).length - 1;
  return count(";") > count(",") ? ";" : count("\t") > count(",") ? "\t" : ",";
}

const norm = (h: string) => h.trim().toLowerCase();

export function detectFormat(headers: string[]): BankFormat | undefined {
  const hs = new Set(headers.map(norm));
  return BANK_FORMATS.find((f) => f.detect.every((d) => hs.has(norm(d))));
}

/** Parses "1,234.56", "€1 234,56", "(12.00)", "-12" into a number. */
export function parseAmount(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  let s = raw.trim().replace(/[€£$\s]/g, "").replace(/[A-Z]{3}$/i, "");
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  // Decimal comma ("1.234,56" or "12,50") vs thousands comma ("1,234.56").
  if (/,\d{1,2}$/.test(s) && !/\.\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round((neg ? -n : n) * 100) / 100;
}

/** "2026-11-03 14:02:11", "2026-11-03T14:02:11Z" or "03/11/2026" -> "2026-11-03". */
export function parseDate(raw: string | undefined, order: BankFormat["dateOrder"]): string | null {
  if (!raw) return null;
  const s = raw.trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const parts = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (parts) {
    const [a, b, y] = [parts[1], parts[2], parts[3].length === 2 ? `20${parts[3]}` : parts[3]];
    const [d, m] = order === "dmy" ? [a, b] : [b, a];
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const named = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[a-z]*[\s-](\d{4})/);
  if (named) {
    const m = months.indexOf(named[2].toLowerCase()) + 1;
    if (m) return `${named[3]}-${String(m).padStart(2, "0")}-${named[1].padStart(2, "0")}`;
  }
  return null;
}

export function parseBankCsv(text: string, formatId?: BankFormat["id"]): ParsedBankCsv {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error("The file is empty.");
  // Some exports put a title line or two above the header; use the first row that matches a format.
  let headerIdx = 0;
  let format = formatId ? BANK_FORMATS.find((f) => f.id === formatId) : undefined;
  if (!format) {
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      format = detectFormat(rows[i]);
      if (format) {
        headerIdx = i;
        break;
      }
    }
  } else {
    const found = rows.slice(0, 10).findIndex((r) => r.some((c) => format!.columns.date.map(norm).includes(norm(c))));
    headerIdx = found >= 0 ? found : 0;
  }
  if (!format) throw new Error("Couldn't recognise this file. Choose the bank format (Revolut Business or AIB) and try again.");

  const headers = rows[headerIdx].map(norm);
  const col = (names?: string[]) => (names ?? []).map((n) => headers.indexOf(norm(n))).filter((i) => i >= 0);
  const first = (names?: string[]) => col(names)[0];
  const c = {
    date: first(format.columns.date),
    amount: first(format.columns.amount),
    credit: first(format.columns.credit),
    debit: first(format.columns.debit),
    currency: first(format.columns.currency),
    payer: first(format.columns.payer),
    reference: first(format.columns.reference),
    description: col(format.columns.description),
    id: first(format.columns.id),
    state: first(format.columns.state),
    type: first(format.columns.type),
    card: first(format.columns.card),
    account: first(format.columns.account),
    mcc: first(format.columns.mcc),
    fee: first(format.columns.fee),
  };
  if (c.date === undefined) throw new Error(`No date column found for ${format.label}. Expected one of: ${format.columns.date.join(", ")}.`);
  if (c.amount === undefined && c.credit === undefined) throw new Error(`No amount or credit column found for ${format.label}.`);

  const credits: BankCredit[] = [];
  const debits: BankDebit[] = [];
  const errors: string[] = [];
  const seen = new Map<string, number>();
  const seenDebit = new Map<string, number>();
  let skipped = 0;
  const get = (r: string[], i: number | undefined) => (i === undefined ? undefined : r[i]?.trim());
  // Our own account names in this export (Revolut "Account" column), to spot transfers between them.
  const ownAccounts = new Set(c.account === undefined ? [] : rows.slice(headerIdx + 1).map((r) => get(r, c.account)?.toLowerCase()).filter((a): a is string => !!a));

  /** Reads a money-out row; returns nothing for money in, unreadable rows and skipped types. */
  const readDebit = (r: string[]) => {
    const type = get(r, c.type)?.toUpperCase() || null;
    if (type && format.debitSkipTypes?.includes(type)) return;
    let amount: number | null;
    if (c.debit !== undefined) {
      if (parseAmount(get(r, c.credit))) return;
      amount = parseAmount(get(r, c.debit));
      if (!amount) return;
      amount = Math.abs(amount);
    } else {
      const signed = parseAmount(get(r, c.amount));
      if (signed === null || signed >= 0) return;
      amount = -signed;
    }
    const date = parseDate(get(r, c.date), format.dateOrder);
    if (!date) return;
    const description = c.description.map((j) => r[j]?.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ");
    const counterparty = description.replace(/^(to|payment to|card payment to)\s+/i, "").trim() || description || "Unknown";
    const currency = (get(r, c.currency) || format.defaultCurrency).toUpperCase();
    const cardNo = get(r, c.card)?.replace(/\D/g, "") ?? "";
    const account = get(r, c.account) || null;
    const others = [...ownAccounts].filter((a) => a !== account?.toLowerCase());
    const ownTransfer =
      type === "TRANSFER" &&
      (/^(to|from)\s+(my\s+)?(EUR|GBP|USD|CHF|PLN|SEK|NOK|DKK|CAD|AUD)\b/i.test(description) || others.some((a) => counterparty.toLowerCase() === a || description.toLowerCase().includes(a)));
    const bankId = get(r, c.id);
    let externalId: string;
    if (bankId) externalId = `${format.id}:${bankId}`;
    else {
      const base = createHash("sha256").update(["debit", format.id, date, amount, description, r.join("|")].join("|")).digest("hex").slice(0, 24);
      const n = (seenDebit.get(base) ?? 0) + 1;
      seenDebit.set(base, n);
      externalId = `${format.id}:${base}:${n}`;
    }
    const base = {
      date,
      currency,
      reference: get(r, c.reference) || null,
      cardLast4: cardNo.length >= 4 ? cardNo.slice(-4) : null,
      account,
      mcc: get(r, c.mcc) || null,
    };
    debits.push({ ...base, externalId, amount: Math.round(amount * 100) / 100, counterparty, description, type, ownTransfer });
    const fee = Math.abs(parseAmount(get(r, c.fee)) ?? 0);
    if (fee > 0 && bankId) {
      debits.push({ ...base, externalId: `${externalId}:fee`, amount: fee, counterparty: "Revolut", description: `Fee on ${counterparty}`, type: "FEE", mcc: null, ownTransfer: false });
    }
  };

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const state = get(r, c.state)?.toUpperCase();
    if (state && format.okStates && !format.okStates.includes(state)) {
      skipped++;
      continue;
    }
    readDebit(r);
    const type = get(r, c.type)?.toUpperCase();
    if (type && format.skipTypes?.includes(type)) {
      skipped++;
      continue;
    }
    let amount: number | null;
    if (c.credit !== undefined) {
      amount = parseAmount(get(r, c.credit));
      if (!amount) {
        skipped++; // debit row
        continue;
      }
      amount = Math.abs(amount);
    } else {
      amount = parseAmount(get(r, c.amount));
    }
    if (amount === null || amount <= 0) {
      skipped++;
      continue;
    }
    const date = parseDate(get(r, c.date), format.dateOrder);
    if (!date) {
      errors.push(`Row ${i + 1}: couldn't read the date "${get(r, c.date) ?? ""}".`);
      skipped++;
      continue;
    }
    const description = c.description.map((j) => r[j]?.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ");
    const payer = get(r, c.payer) || null;
    const reference = get(r, c.reference) || null;
    const currency = (get(r, c.currency) || format.defaultCurrency).toUpperCase();
    const bankId = get(r, c.id);
    let externalId: string;
    if (bankId) externalId = `${format.id}:${bankId}`;
    else {
      // No transaction ID (AIB): hash the row; repeat identical rows get an occurrence number.
      const base = createHash("sha256").update([format.id, date, amount, description, r.join("|")].join("|")).digest("hex").slice(0, 24);
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      externalId = `${format.id}:${base}:${n}`;
    }
    credits.push({ externalId, date, amount, currency, payer, reference, description });
  }
  return { format, credits, debits, skipped, errors };
}
