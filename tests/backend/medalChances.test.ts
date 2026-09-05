import assert from "node:assert/strict";
import test from "node:test";
import { normalizeIfscPayload } from "../../server/src/adapters/IfscAdapter.js";
import { deriveMedalChances } from "../../server/src/state/medalChances.js";
import type { CompetitionSnapshot } from "../../server/src/types/domain.js";
import { boulderPayload, twoAthleteLeadPayload } from "../fixtures/ifscPayloads.js";

const ENDPOINT = "https://ifsc.results.info/api/v1/category_rounds/10704/results";

function normalize(payload: unknown): CompetitionSnapshot {
  return normalizeIfscPayload(payload as Parameters<typeof normalizeIfscPayload>[0], ENDPOINT);
}

test("Boulder medal projections are not polluted by the P0 aggregate-score truncation", () => {
  const canonical = normalize(boulderPayload(69.4));
  const previouslyTruncated = structuredClone(canonical);
  previouslyTruncated.athletes[0].score = 69;
  assert.deepEqual(
    deriveMedalChances(canonical, "connected", false),
    deriveMedalChances(previouslyTruncated, "connected", false)
  );
});

test("Boulder final medal calculation uses four routes and does not finish negated statuses", () => {
  const active = normalize(boulderPayload(69.4));
  active.roundStatus = "active";
  const unfinished = structuredClone(active);
  unfinished.roundStatus = "unfinished";
  const notFinished = structuredClone(active);
  notFinished.roundStatus = "not finished";
  const incomplete = structuredClone(active);
  incomplete.roundStatus = "incomplete";
  const suspended = structuredClone(active);
  suspended.roundStatus = "suspended";
  const finished = structuredClone(active);
  finished.roundStatus = "finished";

  const activeChances = deriveMedalChances(active, "connected", false)!;
  assert.equal(activeChances.totalRoutes, 4);
  assert.equal(activeChances.routesRemaining, true);
  for (const snapshot of [unfinished, notFinished, incomplete, suspended]) {
    assert.deepEqual(deriveMedalChances(snapshot, "connected", false), activeChances);
  }
  assert.equal(deriveMedalChances(finished, "connected", false)!.routesRemaining, false);
});

test("DIFF-009 stays gated until top semantics are validated by continuous real samples", () => {
  const payload = twoAthleteLeadPayload(0, 2, 1);
  payload.ranking[0].status = "pending";
  payload.ranking[0].start_order = 8;
  payload.ranking[1].score = "TOP";
  payload.ranking[1].start_order = 7;
  const snapshot = normalize(payload);

  const gated = deriveMedalChances(snapshot, "connected", false)!;
  const enabledForComparison = deriveMedalChances(snapshot, "connected", true)!;
  const gatedGold = gated.athletes.find((entry) => entry.athleteId === "201")!.outcomes[0];
  const enabledGold = enabledForComparison.athletes.find((entry) => entry.athleteId === "201")!.outcomes[0];
  assert.equal(gatedGold.verdict, "undecided");
  assert.match(gatedGold.reason, /top that is not yet officially confirmed/i);
  assert.equal(enabledGold.verdict, "needs_conditions");
  assert.equal(enabledGold.conditions[0].conditionLevelTrust, "top_unconfirmed");
});

test("Lead DNS is settled and never describes an impossible future top", () => {
  const payload = twoAthleteLeadPayload("DNS", 999, 1);
  payload.ranking[0].status = "DNS";
  payload.ranking[1].score = "42";
  const snapshot = normalize(payload);
  const chances = deriveMedalChances(snapshot, "connected", false)!;
  const gold = chances.athletes.find((entry) => entry.athleteId === "201")!.outcomes[0];
  assert.equal(gold.verdict, "eliminated");
  assert.equal(gold.reason, "She did not start, so Gold is out of contention.");
  assert.doesNotMatch(gold.reason, /top|climb|route/i);
});
