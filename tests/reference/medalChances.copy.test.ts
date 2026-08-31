import assert from "node:assert/strict";
import test from "node:test";
import { deriveMedalChances } from "../../server/src/state/medalChances.ts";
import type { CompetitionSnapshot, MedalChances, MedalKind, MedalOutcome } from "../../server/src/types/domain.ts";
import { BOULDER_ATOMS, type BoulderAtom } from "./referenceEngine.ts";
import {
  BOULDER_ALL_OPPONENTS,
  BOULDER_BOTH_OPPONENTS,
  BOULDER_ENDED_COUNTBACK,
  BOULDER_MIXED_STATUS,
  BOULDER_PURE_OPPONENT,
  BOULDER_TWO_REMAINING,
  LEAD_DNS,
  LEAD_NECESSARY_42_PLUS,
  LEAD_NECESSARY_43,
  LEAD_PURE_OPPONENT,
  LEAD_TOP_GATED,
  LEAD_WAITING_CLIMBING_FINISHED,
  boulderNecessaryBoundary,
  boulderSnapshot,
  leadSnapshot
} from "./fixtures/scenarios.ts";

function derive(snapshot: CompetitionSnapshot): MedalChances {
  const result = deriveMedalChances(snapshot, "connected", false);
  assert.ok(result);
  return result;
}

function outcome(chances: MedalChances, athleteId: string, medal: MedalKind): MedalOutcome {
  const found = chances.athletes
    .find((athlete) => athlete.athleteId === athleteId)
    ?.outcomes.find((entry) => entry.medal === medal);
  assert.ok(found);
  return found;
}

function displayScore(score10: number): string {
  return score10 % 10 === 0 ? String(score10 / 10) : (score10 / 10).toFixed(1);
}

function expectedBoundaryCopy(atom: BoulderAtom): string {
  const countback = " (if that ties Bea, Ada takes it on the semi-final ranking).";
  if (atom.result === "top") {
    if (atom.attempts === 1) return `Needs to flash the boulder${countback}`;
    if (atom.attempts <= 9) return `Needs to top her last boulder in ${atom.attempts} attempts or fewer${countback}`;
    if (atom.attempts <= 20) return `Needs at least ${displayScore(atom.score10)} points on her last boulder${countback}`;
    return `Needs to top her last boulder${countback}`;
  }
  if (atom.attempts === 1) return `Needs to flash the zone${countback}`;
  if (atom.attempts <= 9) return `Needs to zone her last boulder in ${atom.attempts} attempts or fewer${countback}`;
  if (atom.attempts <= 20) return `Needs at least ${displayScore(atom.score10)} points on her last boulder${countback}`;
  return `Needs to zone her last boulder${countback}`;
}

for (const atom of [
  BOULDER_ATOMS.T1,
  BOULDER_ATOMS.T2,
  BOULDER_ATOMS.T9,
  BOULDER_ATOMS.T10,
  BOULDER_ATOMS.T20,
  BOULDER_ATOMS.T21,
  BOULDER_ATOMS.Z1,
  BOULDER_ATOMS.Z2,
  BOULDER_ATOMS.Z9,
  BOULDER_ATOMS.Z10,
  BOULDER_ATOMS.Z20,
  BOULDER_ATOMS.Z21
]) {
  test(`English golden: ${atom.id} uses its exact attempt tier and semi-final countback`, () => {
    const formal = outcome(derive(boulderSnapshot(boulderNecessaryBoundary(atom))), "Ada", "gold");
    assert.deepEqual(formal.conditions, [{ summary: expectedBoundaryCopy(atom) }]);
  });
}

test("English golden: one vs two remaining boulders uses singular/plural and both", () => {
  const one = outcome(derive(boulderSnapshot(boulderNecessaryBoundary(BOULDER_ATOMS.T2))), "Ada", "gold");
  const two = outcome(derive(boulderSnapshot(BOULDER_TWO_REMAINING)), "Ada", "gold");
  assert.equal(one.reason, "Gold is still in play with 1 boulder left.");
  assert.equal(two.reason, "Gold is still in play with 2 boulders left.");
  assert.deepEqual(two.conditions, [{
    summary: "Needs to flash both remaining boulders (if that ties Bea, Ada takes it on the semi-final ranking)."
  }]);
});

test("English golden: finished pure-opponent path states the exact flash and countback", () => {
  const formal = outcome(derive(boulderSnapshot(BOULDER_PURE_OPPONENT)), "Ada", "gold");
  assert.deepEqual(formal.conditions, [{
    summary: "Takes Gold unless Bea flashes the boulder (a tie on points would then go to Bea on the semi-final ranking)."
  }]);
});

test("English golden: two opponents use both; all three are intentionally generalized", () => {
  const both = outcome(derive(boulderSnapshot(BOULDER_BOTH_OPPONENTS)), "Ada", "silver");
  assert.deepEqual(both.conditions, [{ summary: "Takes Silver unless both Bea and Cia rank ahead of her." }]);

  const all = outcome(derive(boulderSnapshot(BOULDER_ALL_OPPONENTS)), "Ada", "bronze");
  assert.equal(all.verdict, "undecided");
  assert.equal(all.reason, "Too many ways this could still go — too early to call.");
  assert.deepEqual(all.conditions, []);
});

test("English golden: an alternative self path uses sufficient language, never unique Needs language", () => {
  const formal = outcome(derive(boulderSnapshot(BOULDER_MIXED_STATUS)), "Cia", "silver");
  assert.deepEqual(formal.conditions, [
    {
      summary: "Topping her last boulder in 2 attempts or fewer would secure Silver outright (if that ties Bea, Cia takes it on the semi-final ranking)."
    },
    {
      summary: "Holds Silver unless Ada ranks ahead of her (a tie on points would go to Cia on the semi-final ranking)."
    }
  ]);
  assert.ok(formal.conditions.every((condition) => !condition.summary.startsWith("Needs")));
});

test("English golden: completed tie reasons distinguish the actual medal from ‘or better’", () => {
  const formal = derive(boulderSnapshot(BOULDER_ENDED_COUNTBACK));
  assert.equal(outcome(formal, "Ada", "gold").reason, "Her final score already secures Gold.");
  assert.equal(outcome(formal, "Ada", "silver").reason, "Her final score already secures Silver or better.");
  assert.equal(outcome(formal, "Cia", "bronze").reason, "Her final score already secures Bronze.");
});

test("English golden: Lead uses official 42+ and integer 43, never internal decimals", () => {
  const plus = outcome(derive(leadSnapshot(LEAD_NECESSARY_42_PLUS)), "Ada", "gold");
  const integer = outcome(derive(leadSnapshot(LEAD_NECESSARY_43)), "Ada", "gold");
  assert.deepEqual(plus.conditions, [{ summary: "Needs at least 42+ on the final route." }]);
  assert.deepEqual(integer.conditions, [{ summary: "Needs at least 43 on the final route." }]);
  assert.doesNotMatch(JSON.stringify([plus, integer]), /42\.25|42\.3|43\.0/);
});

test("English golden: TOP remains explicitly unconfirmed while DIFF-009 is false", () => {
  const formal = outcome(derive(leadSnapshot(LEAD_TOP_GATED)), "Ada", "gold");
  assert.equal(formal.verdict, "undecided");
  assert.equal(formal.reason, "The remaining outcome depends on a top that is not yet officially confirmed.");
  assert.deepEqual(formal.conditions, []);
});

test("English golden: Lead pure-opponent path uses the next legal 42+ score", () => {
  const formal = outcome(derive(leadSnapshot(LEAD_PURE_OPPONENT)), "Ada", "gold");
  assert.deepEqual(formal.conditions, [{ summary: "Takes Gold unless Bea reaches 42+ on the final route." }]);
});

test("English golden: dynamic Lead relation says ranks ahead and gives both countback directions", () => {
  const formal = outcome(derive(leadSnapshot(LEAD_WAITING_CLIMBING_FINISHED)), "Ada", "gold");
  assert.deepEqual(formal.conditions, [{
    summary: "Score at least 43 on the final route (if that ties Bea, Ada takes it on the semi-final ranking), and ranks ahead of Cia (a tie on points would go to Cia on the semi-final ranking)."
  }]);
});

test("COUNTEREXAMPLE copy regression: DNS must not describe an impossible future top", () => {
  const formal = outcome(derive(leadSnapshot(LEAD_DNS)), "Ada", "gold");
  assert.equal(formal.verdict, "eliminated");
  assert.equal(formal.reason, "She did not start, so Gold is out of contention.");
  assert.doesNotMatch(
    formal.reason,
    /topping the route/i,
    `DNS is terminal, but the formal copy promises an impossible action: ${formal.reason}`
  );
});
