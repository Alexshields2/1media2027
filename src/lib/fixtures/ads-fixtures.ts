// Fixture Meta Ads and GoHighLevel data for tests and AGENTS_MOCK demos.
// Deterministic: the same account and dates always give the same numbers.
// Shapes follow the real APIs loosely (Meta insights rows with string numbers and an
// actions array; GHL contacts), so the mocked model has to parse them like the real one would.

/** Ad account IDs that simulate a failing Meta account (for retry tests and demos). */
export const FAILING_ACCOUNTS = new Set(["act_error"]);

function seeded(key: string) {
  let h = 2166136261;
  for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

export interface MetaInsightRow {
  campaign_name: string;
  spend: string;
  impressions: string;
  inline_link_clicks: string;
  actions: { action_type: string; value: string }[];
  date_start: string;
  date_stop: string;
}

export function metaInsights(adAccountId: string, since: string, until: string): { data: MetaInsightRow[] } {
  if (FAILING_ACCOUNTS.has(adAccountId)) throw new Error(`Meta Ads: (#17) User request limit reached for ${adAccountId}`);
  const rnd = seeded(`${adAccountId}:${since}:${until}`);
  const campaigns = ["Lead Gen | Main offer", "Lead Gen | Retargeting"].slice(0, 1 + Math.floor(rnd() * 2));
  return {
    data: campaigns.map((campaign_name, i) => {
      const spend = Math.round((i ? 60 + rnd() * 80 : 180 + rnd() * 260) * 100) / 100;
      const impressions = Math.round(spend * (90 + rnd() * 60));
      const clicks = Math.round(impressions * (0.008 + rnd() * 0.012));
      const leads = Math.max(1, Math.round(spend / (8 + rnd() * 14)));
      return {
        campaign_name,
        spend: spend.toFixed(2),
        impressions: String(impressions),
        inline_link_clicks: String(clicks),
        actions: [
          { action_type: "lead", value: String(leads) },
          { action_type: "link_click", value: String(clicks) },
        ],
        date_start: since,
        date_stop: until,
      };
    }),
  };
}

const FIRST = ["Mary", "John", "Siobhan", "Declan", "Aoife", "Patrick", "Niamh", "Ciaran", "Grainne", "Sean", "Orla", "Liam"];
const LAST = ["Murphy", "Kelly", "O'Brien", "Walsh", "Byrne", "Ryan", "O'Connor", "Doyle", "McCarthy", "Gallagher"];
const TOWNS: [string, string][] = [["Naas, Co. Kildare", "W91 X2Y3"], ["Swords, Co. Dublin", "K67 F2T8"], ["Navan, Co. Meath", "C15 KP20"], ["Bray, Co. Wicklow", "A98 E4H1"], ["Mullingar, Co. Westmeath", "N91 D7C2"]];
const NEEDS = ["Driveway, about 60 sq m", "Full attic conversion", "Bathroom refit", "Patio and paths", "Garden room 4m x 3m"];

export interface GhlContact {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  city: string;
  postalCode: string;
  dateAdded: string;
  customFields: { key: string; value: string }[];
  tags: string[];
}

export function ghlContacts(locationId: string, startDate: string, endDate: string, count: number): { contacts: GhlContact[]; total: number } {
  const rnd = seeded(`${locationId}:${startDate}:${endDate}`);
  const contacts = Array.from({ length: count }, (_, i): GhlContact => {
    const first = FIRST[Math.floor(rnd() * FIRST.length)];
    const last = LAST[Math.floor(rnd() * LAST.length)];
    const [city, postalCode] = TOWNS[Math.floor(rnd() * TOWNS.length)];
    const digits = String(1000000 + Math.floor(rnd() * 8999999)).slice(0, 7);
    return {
      id: `ghl_${locationId}_${i}`,
      firstName: first,
      lastName: last,
      phone: `+35387${digits}`,
      email: `${first.toLowerCase()}.${last.toLowerCase().replace(/[^a-z]/g, "")}@example.com`,
      city,
      postalCode,
      dateAdded: `${startDate}T10:00:00Z`,
      customFields: [
        { key: "timeframe", value: rnd() > 0.5 ? "Within 3 months" : "ASAP" },
        { key: "budget", value: rnd() > 0.5 ? "€10,000 – €15,000" : "€5,000 – €10,000" },
        { key: "project", value: NEEDS[Math.floor(rnd() * NEEDS.length)] },
      ],
      tags: rnd() > 0.7 ? ["high intent"] : [],
    };
  });
  return { contacts, total: count };
}

/** Tool definitions for the fixtures, named like the Composio tools the real agent sees. */
export const FIXTURE_TOOL_DEFS = [
  {
    name: "METAADS_GET_INSIGHTS",
    description: "Meta Ads insights for one ad account and date range, per campaign: spend, impressions, link clicks, actions (leads).",
    input_schema: {
      type: "object" as const,
      properties: {
        ad_account_id: { type: "string" },
        time_range: { type: "object", properties: { since: { type: "string" }, until: { type: "string" } }, required: ["since", "until"] },
      },
      required: ["ad_account_id", "time_range"],
    },
  },
  {
    name: "HIGHLEVEL_LIST_CONTACTS",
    description: "GoHighLevel contacts created in a location between two dates.",
    input_schema: {
      type: "object" as const,
      properties: { location_id: { type: "string" }, start_date: { type: "string" }, end_date: { type: "string" } },
      required: ["location_id", "start_date", "end_date"],
    },
  },
];

/** Leads Meta reports for the account(s), so GHL fixtures return a matching count. */
export function metaLeadCount(rows: MetaInsightRow[]): number {
  return rows.reduce((n, r) => n + Number(r.actions.find((a) => a.action_type === "lead")?.value ?? 0), 0);
}
