// Expense categories and the built-in categorisation rules. Pure functions (no database), so the
// Expenses page, the importers and the tests share them.

export const EXPENSE_CATEGORIES = [
  { key: "software", label: "Software & subscriptions" },
  { key: "advertising", label: "Advertising (client ad spend)" },
  { key: "contractors", label: "Contractors & freelancers" },
  { key: "payroll", label: "Salaries & payroll" },
  { key: "office", label: "Office & equipment" },
  { key: "travel", label: "Travel" },
  { key: "meals", label: "Meals & entertainment" },
  { key: "bank_fees", label: "Bank & fees" },
  { key: "tax", label: "Tax & Revenue" },
  { key: "transfers", label: "Transfers between own accounts" },
  { key: "other", label: "Other" },
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]["key"];
export const CATEGORY_KEYS = EXPENSE_CATEGORIES.map((c) => c.key) as ExpenseCategory[];
/** Moving money between our own accounts isn't spending: left out of every total. */
export const EXCLUDED_FROM_TOTALS: ExpenseCategory[] = ["transfers"];

export const isCategory = (v: unknown): v is ExpenseCategory => typeof v === "string" && (CATEGORY_KEYS as string[]).includes(v);
export const categoryLabel = (k: string | null | undefined) => EXPENSE_CATEGORIES.find((c) => c.key === k)?.label ?? "Uncategorised";

const NOISE = new Set(["ltd", "limited", "inc", "llc", "plc", "gmbh", "bv", "co", "com", "www", "ie", "uk", "eu", "the", "payment", "card", "pos", "purchase", "to", "from", "ireland", "dublin", "ireland ltd"]);

/**
 * The merchant name reduced to a stable key for category memory: "FACEBK *8XK2PL3" -> "facebk",
 * "Google *GSuite_1media" -> "google gsuite media", "Canva Pty Ltd" -> "canva pty".
 */
export function merchantKey(merchant: string): string {
  const words = merchant
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\*[a-z0-9]{6,}\b/g, " ") // "*8XK2PL3" reference codes
    .replace(/[^a-z]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 1 && !NOISE.has(w));
  return words.slice(0, 4).join(" ") || merchant.trim().toLowerCase().slice(0, 40) || "unknown";
}

export interface CategoryHint {
  merchant: string;
  description?: string | null;
  /** Bank type: CARD_PAYMENT, TRANSFER, FEE, ATM… (CSV upper case or API lower case). */
  type?: string | null;
  /** Card merchant category code. */
  mcc?: string | null;
  ownTransfer?: boolean;
}

const RULES: [ExpenseCategory, RegExp][] = [
  ["tax", /\b(revenue commissioners?|collector general|ros\b|revenue\b|paye\b|vat payment|corporation tax|cro\b)/],
  ["advertising", /\b(facebk|facebook|meta (platforms|ads)|fb ads|instagram ads|google ?ads|adwords|tiktok ?ads|linkedin ?ads|bing ?ads|snapchat ads)/],
  ["payroll", /\b(payroll|salary|salaries|wages|brightpay|thesaurus payroll)/],
  ["contractors", /\b(upwork|fiverr|deel|freelancer|contra\b|toptal|invoice from)/],
  ["bank_fees", /\b(revolut (fee|business)|bank (fee|charge)s?|fee on|stripe fee|plan fee|transfer fee|fx fee)/],
  [
    "software",
    /\b(canva|google (workspace|gsuite|cloud|one|storage)|gsuite|workspace|adobe|slack|notion|openai|chatgpt|anthropic|claude|vercel|supabase|github|zapier|make com|highlevel|gohighlevel|leadconnector|composio|figma|zoom|microsoft|office ?365|dropbox|hubspot|calendly|loom|framer|webflow|godaddy|namecheap|cloudflare|mailchimp|apple com bill|elevenlabs|capcut|grammarly|1password|lastpass|asana|clickup|monday com|xero|quickbooks|sage)/,
  ],
  ["travel", /\b(ryanair|aer ?lingus|aerlingus|uber|bolt|free ?now|irish rail|iarnrod|dublin bus|luas|hotel|booking com|airbnb|circle k|applegreen|maxol|texaco|parking|eflow|toll|hertz|europcar|easyjet)/],
  ["meals", /\b(restaurant|cafe|coffee|deliveroo|just eat|starbucks|insomnia|costa|butlers|bewleys|mcdonald|supermac|eddie rockets|nandos)/],
  ["office", /\b(ikea|amazon|currys|harvey norman|viking|staples|officeworks|apple store|argos|smyths|woodies|eason)/],
];

const MCC_RULES: [ExpenseCategory, (n: number) => boolean][] = [
  ["meals", (n) => [5811, 5812, 5813, 5814].includes(n)],
  ["travel", (n) => (n >= 3000 && n <= 3999) || [4111, 4121, 4131, 4511, 4722, 4784, 5541, 5542, 7011, 7512, 7523].includes(n)],
  ["software", (n) => [4816, 5734, 5817, 5818, 7372, 7379].includes(n)],
  ["advertising", (n) => n === 7311],
  ["office", (n) => [5044, 5045, 5111, 5732, 5943, 5200].includes(n)],
  ["tax", (n) => n === 9311],
];

/** A category from the built-in rules, or null when nothing fits (left for the owner or Claude). */
export function builtInCategory(h: CategoryHint): ExpenseCategory | null {
  if (h.ownTransfer) return "transfers";
  const type = h.type?.toUpperCase() ?? "";
  if (type === "FEE") return "bank_fees";
  const text = ` ${merchantKey(h.merchant)} ${(h.description ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  for (const [cat, re] of RULES) if (re.test(text)) return cat;
  const mcc = Number(h.mcc);
  if (Number.isFinite(mcc) && mcc > 0) for (const [cat, test] of MCC_RULES) if (test(mcc)) return cat;
  if (type === "ATM") return "other";
  return null;
}

/** The euro value of an expense for totals: amount_eur, or the amount itself when paid in euro. */
export function euroValue(e: { amount: number; currency: string; amountEur: number | null }): number {
  if (e.amountEur !== null && e.amountEur !== undefined) return e.amountEur;
  return e.currency === "EUR" ? e.amount : 0;
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s;
};

/** CSV for the accountant: one row per expense, transfers between own accounts marked as excluded. */
export function expensesCsv(
  rows: {
    date: string;
    merchant: string;
    description: string | null;
    amount: number;
    currency: string;
    amountEur: number | null;
    category: string | null;
    vatAmount: number | null;
    client: string | null;
    source: string;
    cardLast4: string | null;
    receiptUrl: string | null;
    notes: string | null;
    externalId: string;
  }[],
): string {
  const head = ["Date", "Merchant", "Description", "Amount", "Currency", "Amount EUR", "Category", "VAT", "Rechargeable to", "Source", "Card", "Receipt", "Notes", "Reference", "In totals"];
  const lines = rows.map((r) =>
    [
      r.date,
      r.merchant,
      r.description,
      r.amount.toFixed(2),
      r.currency,
      r.amountEur === null ? (r.currency === "EUR" ? r.amount.toFixed(2) : "") : r.amountEur.toFixed(2),
      categoryLabel(r.category),
      r.vatAmount === null ? "" : r.vatAmount.toFixed(2),
      r.client,
      r.source,
      r.cardLast4 ? `•${r.cardLast4}` : "",
      r.receiptUrl,
      r.notes,
      r.externalId,
      EXCLUDED_FROM_TOTALS.includes(r.category as ExpenseCategory) ? "no" : "yes",
    ]
      .map(csvCell)
      .join(","),
  );
  return [head.join(","), ...lines].join("\r\n") + "\r\n";
}
