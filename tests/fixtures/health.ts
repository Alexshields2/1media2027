import type { HealthInputs } from "../../src/lib/health-score";

// Realistic weeks for made-up clients, as the client-health agent would gather them.

const steadyHistory = [
  { weekOf: "2026-11-02", leads: 40, ctr: 1.2 },
  { weekOf: "2026-10-26", leads: 38, ctr: 1.1 },
  { weekOf: "2026-10-19", leads: 42, ctr: 1.3 },
  { weekOf: "2026-10-12", leads: 41, ctr: 1.2 },
];

export const fixtures = {
  healthy: {
    cplTarget: 10,
    meta: { spend: 392, leads: 44, impressions: 41220, clicks: 612, frequency: 1.8 },
    history: steadyHistory,
    ghl: { newLeads: 44, untouchedOver24h: 0 },
  },
  cplSlightlyOver: {
    cplTarget: 15,
    meta: { spend: 386, leads: 21, impressions: 30500, clicks: 440, frequency: 2.1 },
    history: [{ leads: 24, ctr: 1.5 }, { leads: 22, ctr: 1.4 }, { leads: 23, ctr: 1.5 }, { leads: 21, ctr: 1.4 }],
    ghl: { newLeads: 21, untouchedOver24h: 0 },
  },
  cplWayOver: {
    cplTarget: 15,
    meta: { spend: 600, leads: 20, frequency: 1.5 },
    history: [{ leads: 21 }, { leads: 19 }, { leads: 20 }, { leads: 22 }],
    ghl: { newLeads: 20, untouchedOver24h: 0 },
  },
  volumeDown30: {
    cplTarget: 30,
    meta: { spend: 280, leads: 28, frequency: 1.5 },
    history: [{ leads: 40 }, { leads: 40 }, { leads: 40 }, { leads: 40 }],
    ghl: null,
  },
  volumeHalved: {
    cplTarget: 30,
    meta: { spend: 190, leads: 19, frequency: 1.5 },
    history: [{ leads: 40 }, { leads: 40 }, { leads: 40 }, { leads: 40 }],
    ghl: null,
  },
  fatigueFrequency: {
    cplTarget: 20,
    meta: { spend: 300, leads: 20, frequency: 3.4, ctr: 1.5 },
    history: [{ leads: 20, ctr: 1.5 }, { leads: 20, ctr: 1.6 }],
    ghl: { newLeads: 20, untouchedOver24h: 0 },
  },
  fatigueBoth: {
    cplTarget: 20,
    meta: { spend: 300, leads: 20, frequency: 3.6, impressions: 30000, clicks: 300 }, // CTR 1.0%
    history: [{ leads: 20, ctr: 1.6 }, { leads: 21, ctr: 1.5 }, { leads: 19, ctr: 1.6 }, { leads: 20, ctr: 1.7 }],
    ghl: { newLeads: 20, untouchedOver24h: 0 },
  },
  someUntouched: {
    cplTarget: 20,
    meta: { spend: 200, leads: 12, frequency: 1.4 },
    history: [{ leads: 12 }, { leads: 11 }],
    ghl: { newLeads: 12, untouchedOver24h: 2, untouchedNames: ["Mary Byrne", "Sean Kelly"] },
  },
  mostUntouched: {
    cplTarget: 15,
    meta: { spend: 186, leads: 6, frequency: 2.1, impressions: 15000, clicks: 140 },
    history: [{ leads: 14, ctr: 1.0 }, { leads: 12, ctr: 1.1 }, { leads: 15, ctr: 0.9 }, { leads: 13, ctr: 1.0 }],
    ghl: { newLeads: 6, untouchedOver24h: 5, untouchedNames: ["Mary Byrne", "Sean Kelly", "Niamh Walsh", "Declan Ryan", "Orla Doyle"] },
  },
  noSpend: {
    cplTarget: 15,
    meta: { spend: 0, leads: 0 },
    history: [{ leads: 20 }, { leads: 20 }],
    ghl: { newLeads: 0, untouchedOver24h: 0 },
  },
  spendNoLeads: {
    cplTarget: 15,
    meta: { spend: 250, leads: 0, frequency: 1.2 },
    history: [{ leads: 20 }, { leads: 20 }],
    ghl: { newLeads: 0, untouchedOver24h: 0 },
  },
  nothingConnected: { cplTarget: 15, meta: null, ghl: null },
  noTargetNoHistory: {
    cplTarget: null,
    meta: { spend: 100, leads: 10 },
    ghl: { newLeads: 10, untouchedOver24h: 0 },
  },
} satisfies Record<string, HealthInputs>;
