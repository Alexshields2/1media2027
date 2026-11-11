import { test } from "node:test";
import assert from "node:assert/strict";
import { RULES, scoreCpl, scoreFatigue, scoreHealth, scoreUntouched, scoreVolume } from "../src/lib/health-score";
import { fixtures } from "./fixtures/health";

const signal = (s: ReturnType<typeof scoreHealth>, key: string) => s.signals.find((x) => x.key === key)!;

test("healthy client is green on every signal", () => {
  const s = scoreHealth(fixtures.healthy);
  assert.equal(s.status, "green");
  assert.equal(s.issue, "Everything Healthy");
  assert.deepEqual(s.signals.map((x) => x.status), ["green", "green", "green", "green"]);
  assert.equal(s.cpl, 8.91);
  assert.equal(s.leads, 44);
  assert.equal(s.spend, 392);
});

test("CPL up to 30% over target is yellow, beyond is red", () => {
  const slight = scoreHealth(fixtures.cplSlightlyOver);
  assert.equal(slight.status, "yellow");
  assert.equal(slight.issue, "CPL Rising");
  assert.match(signal(slight, "cpl").detail, /\+23%/);

  const way = scoreHealth(fixtures.cplWayOver);
  assert.equal(way.status, "red");
  assert.equal(way.issue, "CPL Rising");
  assert.match(way.reason, /€30 vs €15 target \(\+100%\)/);
});

test("CPL exactly at the yellow boundary stays yellow", () => {
  const s = scoreCpl({ cplTarget: 10, meta: { spend: 130, leads: 10 } });
  assert.equal(s.status, "yellow");
  assert.equal(scoreCpl({ cplTarget: 10, meta: { spend: 131, leads: 10 } }).status, "red");
  assert.equal(scoreCpl({ cplTarget: 10, meta: { spend: 100, leads: 10 } }).status, "green");
});

test("lead volume is compared with the previous 4 weeks' average", () => {
  const down30 = scoreHealth(fixtures.volumeDown30);
  assert.equal(signal(down30, "volume").status, "yellow");
  assert.equal(down30.issue, "Lead Volume Down");
  assert.match(signal(down30, "volume").detail, /28 leads vs 40 a week over the previous 4 weeks \(down 30%\)/);

  const halved = scoreHealth(fixtures.volumeHalved);
  assert.equal(halved.status, "red");
  assert.equal(halved.issue, "Lead Volume Down");
});

test("only the last 4 weeks of history count", () => {
  const s = scoreVolume({ meta: { spend: 100, leads: 20 }, history: [{ leads: 20 }, { leads: 20 }, { leads: 20 }, { leads: 20 }, { leads: 500 }] });
  assert.equal(s.status, "green");
});

test("volume needs at least two weeks of history", () => {
  const s = scoreVolume({ meta: { spend: 100, leads: 2 }, history: [{ leads: 40 }] });
  assert.equal(s.status, "unknown");
  assert.match(s.detail, /not enough history/);
  assert.equal(RULES.volumeMinWeeks, 2);
});

test("creative fatigue: high frequency alone is yellow, with CTR falling it is red", () => {
  const freq = scoreHealth(fixtures.fatigueFrequency);
  assert.equal(freq.status, "yellow");
  assert.equal(freq.issue, "Creative Fatigue");

  const both = scoreHealth(fixtures.fatigueBoth);
  assert.equal(both.status, "red");
  assert.equal(both.issue, "Creative Fatigue");
  assert.match(signal(both, "fatigue").detail, /Frequency 3\.6, CTR 1% vs 1\.6% \(down 38%\)/);
});

test("CTR computed from clicks and impressions when not given", () => {
  const s = scoreFatigue({ meta: { spend: 1, leads: 1, impressions: 10000, clicks: 100 }, history: [{ leads: 1, ctr: 2 }, { leads: 1, ctr: 2 }] });
  assert.equal(s.status, "yellow"); // 1% vs 2% = down 50%
});

test("untouched leads: any is yellow, most (3+) is red, with names", () => {
  const some = scoreHealth(fixtures.someUntouched);
  assert.equal(some.status, "yellow");
  assert.equal(some.issue, "Leads Not Worked");
  assert.match(signal(some, "untouched").detail, /2 of 12 new leads untouched for over 24h: Mary Byrne, Sean Kelly/);

  const most = scoreHealth(fixtures.mostUntouched);
  assert.equal(most.status, "red");
  // Several red signals: Leads Not Worked outranks CPL and volume.
  assert.equal(most.issue, "Leads Not Worked");
  assert.equal(most.action, "Call the client today and go through each untouched lead by name.");
  assert.match(most.reason, /^5 of 6 new leads untouched/);
  assert.match(most.reason, /CPL €31 vs €15 target/);
  assert.match(most.reason, /down 56%/);

  // 2 of 3 is a majority but under the minimum of 3: yellow.
  assert.equal(scoreUntouched({ ghl: { newLeads: 3, untouchedOver24h: 2 } }).status, "yellow");
});

test("no spend is a budget problem, spend with no leads is tracking", () => {
  const none = scoreHealth(fixtures.noSpend);
  assert.equal(none.status, "red");
  assert.equal(none.issue, "Budget Issue");
  assert.equal(none.cpl, null);

  const noLeads = scoreHealth(fixtures.spendNoLeads);
  assert.equal(noLeads.status, "red");
  assert.equal(noLeads.issue, "Tracking Issue");
});

test("signals that can't be checked are unknown and never make a client green or red", () => {
  const s = scoreHealth(fixtures.nothingConnected);
  assert.equal(s.status, "yellow");
  assert.equal(s.issue, "Tracking Issue");
  assert.ok(s.signals.every((x) => x.status === "unknown"));

  const partial = scoreHealth(fixtures.noTargetNoHistory);
  assert.equal(signal(partial, "cpl").status, "unknown");
  assert.match(signal(partial, "cpl").detail, /no CPL target/);
  assert.equal(signal(partial, "volume").status, "unknown");
  assert.equal(partial.status, "green"); // judged on what we have: leads worked
});

test("scoring is deterministic", () => {
  assert.deepEqual(scoreHealth(fixtures.mostUntouched), scoreHealth(fixtures.mostUntouched));
});
