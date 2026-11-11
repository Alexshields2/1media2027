import { test } from "node:test";
import assert from "node:assert/strict";
import { setupChecklist, setupProgress } from "../src/lib/setup";

const empty = { metaAdAccountIds: null, ghlLocationId: null, stripeCustomerId: null, billingMethod: "invoice" as const, cplTarget: null, reportRules: null, reportGreeting: "" };

test("checklist only asks for a Stripe customer when billing is Stripe", () => {
  assert.deepEqual(setupChecklist(empty).map((i) => i.key), ["meta", "ghl", "cpl", "rules", "greeting"]);
  assert.deepEqual(setupChecklist({ ...empty, billingMethod: "stripe" }).map((i) => i.key), ["meta", "ghl", "stripe", "cpl", "rules", "greeting"]);
});

test("progress counts filled items; blanks and whitespace count as missing", () => {
  const p = setupProgress({ ...empty, metaAdAccountIds: "act_1", ghlLocationId: "   ", cplTarget: 0, reportGreeting: "Hi guys" });
  assert.equal(p.done, 2);
  assert.equal(p.total, 5);
  assert.deepEqual(p.missing.map((i) => i.short), ["GHL", "CPL target", "report rules"]);
  assert.equal(p.complete, false);
  const full = setupProgress({ metaAdAccountIds: "act_1", ghlLocationId: "loc", stripeCustomerId: "cus_1", billingMethod: "stripe", cplTarget: 12, reportRules: "None", reportGreeting: "Hi Pat" });
  assert.ok(full.complete);
  assert.equal(full.done, 6);
});
