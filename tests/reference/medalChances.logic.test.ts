import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { deriveMedalChances } from "../../server/src/state/medalChances.ts";
import type { CompetitionSnapshot, MedalChances, MedalKind, MedalOutcome } from "../../server/src/types/domain.ts";
import {
  ALL_BOULDER_ATOMS,
  BASIC_BOULDER_ATOMS,
  BOULDER_ATOMS,
  MAX_WORLDS,
  allOf,
  atomAt,
  auditConditions,
  boulderScoreAtLeast,
  boulderWorldCount,
  enumerateBoulderWorlds,
  enumerateLeadWorlds,
  leadScoreAtLeast,
  leadWorldCount,
  not,
  ranksAhead,
  winsMedal,
  worldEvidence,
  worldTruth,
  type BoulderReferenceAthlete,
  type BoulderReferenceScenario,
  type BoulderWorld,
  type ConditionSpec,
  type LeadWorld
} from "./referenceEngine.ts";
import {
  BOULDER_ALL_OPPONENTS,
  BOULDER_BOTH_OPPONENTS,
  BOULDER_ENDED_COUNTBACK,
  BOULDER_MIXED_STATUS,
  BOULDER_NOT_STARTED,
  BOULDER_PURE_OPPONENT,
  BOULDER_TWO_REMAINING,
  BOULDER_ZONE_CLIMBING,
  LEAD_DNS,
  LEAD_FINISHED_COUNTBACK,
  LEAD_NECESSARY_42_PLUS,
  LEAD_NECESSARY_43,
  LEAD_PURE_OPPONENT,
  LEAD_TOP_GATED,
  LEAD_WAITING_CLIMBING_FINISHED,
  boulderAthlete,
  boulderNecessaryBoundary,
  boulderSnapshot,
  finishedBoulderAthlete,
  fixedBoulderSlot,
  leadSnapshot,
  openBoulderSlot
} from "./fixtures/scenarios.ts";

function derive(snapshot: CompetitionSnapshot, diff009Fixed = false): MedalChances {
  const result = deriveMedalChances(snapshot, "connected", diff009Fixed);
  assert.ok(result, "A Final reference fixture must produce medal chances.");
  return result;
}

function outcome(chances: MedalChances, athleteId: string, medal: MedalKind): MedalOutcome {
  const athlete = chances.athletes.find((entry) => entry.athleteId === athleteId);
  assert.ok(athlete, `Missing formal result for ${athleteId}.`);
  const found = athlete.outcomes.find((entry) => entry.medal === medal);
  assert.ok(found, `Missing formal ${medal} result for ${athleteId}.`);
  return found;
}

function assertConditionAudit<W extends BoulderWorld | LeadWorld>(
  formal: MedalOutcome,
  worlds: readonly W[],
  athleteId: string,
  specs: readonly ConditionSpec<W>[]
): void {
  const failures = auditConditions(formal, worlds, athleteId, specs);
  if (failures.length > 0) {
    const detail = failures.map((failure) => ({
      kind: failure.kind,
      condition: failure.condition.summary,
      predicate: failure.specName,
      witness: failure.witness ? worldEvidence(failure.witness) : undefined
    }));
    assert.fail(`Independent condition audit failed:\n${JSON.stringify(detail, null, 2)}`);
  }
}

test("reference engine: explicit Boulder atoms preserve the 9/10/20/21 attempt boundaries", () => {
  assert.deepEqual(
    ["Z1", "Z2", "Z9", "Z10", "Z20", "Z21", "T1", "T2", "T9", "T10", "T20", "T21"].map((id) => {
      const atom = BOULDER_ATOMS[id as keyof typeof BOULDER_ATOMS];
      return [atom.id, atom.score10];
    }),
    [
      ["Z1", 100], ["Z2", 99], ["Z9", 92], ["Z10", 91], ["Z20", 81], ["Z21", 80],
      ["T1", 250], ["T2", 249], ["T9", 242], ["T10", 241], ["T20", 231], ["T21", 230]
    ]
  );
});

test("reference engine: MAX_WORLDS is a hard failure and never sampling", () => {
  const tooLarge: BoulderReferenceScenario = {
    name: "deliberately-over-limit",
    roundStatus: "scheduled",
    athletes: ["Ada", "Bea"].map((id, athleteIndex) => boulderAthlete(
      id,
      athleteIndex + 1,
      [1, 2, 3, 4].map((routeNo) => openBoulderSlot(
        id,
        routeNo as 1 | 2 | 3 | 4,
        { state: "waiting" },
        BASIC_BOULDER_ATOMS
      )) as unknown as BoulderReferenceAthlete["routes"]
    ))
  };
  assert.throws(
    () => boulderWorldCount(tooLarge),
    new RegExp(`Reference world limit exceeded: 390625 > MAX_WORLDS=${MAX_WORLDS}`)
  );
});

test("reference benchmark: every non-policy verdict in the named scenario matrix agrees with direct worlds", () => {
  const boulderScenarios = [
    BOULDER_ENDED_COUNTBACK,
    ...[
      BOULDER_ATOMS.T1, BOULDER_ATOMS.T2, BOULDER_ATOMS.T9, BOULDER_ATOMS.T10, BOULDER_ATOMS.T20, BOULDER_ATOMS.T21,
      BOULDER_ATOMS.Z1, BOULDER_ATOMS.Z2, BOULDER_ATOMS.Z9, BOULDER_ATOMS.Z10, BOULDER_ATOMS.Z20, BOULDER_ATOMS.Z21
    ].map(boulderNecessaryBoundary),
    BOULDER_ZONE_CLIMBING,
    BOULDER_TWO_REMAINING,
    BOULDER_PURE_OPPONENT,
    BOULDER_BOTH_OPPONENTS,
    BOULDER_ALL_OPPONENTS,
    BOULDER_MIXED_STATUS
  ];
  for (const scenario of boulderScenarios) {
    const worlds = enumerateBoulderWorlds(scenario);
    const formal = derive(boulderSnapshot(scenario));
    for (const athlete of formal.athletes) {
      for (const medal of athlete.outcomes) {
        const truth = worldTruth(worlds, athlete.athleteId, medal.medal);
        if (truth === "always") assert.equal(medal.verdict, "locked", `${scenario.name}/${athlete.athleteId}/${medal.medal}`);
        else if (truth === "never") assert.equal(medal.verdict, "eliminated", `${scenario.name}/${athlete.athleteId}/${medal.medal}`);
        else assert.ok(
          medal.verdict === "needs_conditions" || medal.verdict === "undecided",
          `${scenario.name}/${athlete.athleteId}/${medal.medal}: mixed worlds cannot be ${medal.verdict}`
        );
      }
    }
  }

  const leadScenarios = [
    LEAD_FINISHED_COUNTBACK,
    LEAD_NECESSARY_42_PLUS,
    LEAD_NECESSARY_43,
    LEAD_TOP_GATED,
    LEAD_DNS,
    LEAD_PURE_OPPONENT,
    LEAD_WAITING_CLIMBING_FINISHED
  ];
  for (const scenario of leadScenarios) {
    const worlds = enumerateLeadWorlds(scenario);
    const formal = derive(leadSnapshot(scenario));
    for (const athlete of formal.athletes) {
      for (const medal of athlete.outcomes) {
        const truth = worldTruth(worlds, athlete.athleteId, medal.medal);
        if (truth === "always") assert.equal(medal.verdict, "locked", `${scenario.name}/${athlete.athleteId}/${medal.medal}`);
        else if (truth === "never") assert.equal(medal.verdict, "eliminated", `${scenario.name}/${athlete.athleteId}/${medal.medal}`);
        else assert.ok(
          medal.verdict === "needs_conditions" || medal.verdict === "undecided",
          `${scenario.name}/${athlete.athleteId}/${medal.medal}: mixed worlds cannot be ${medal.verdict}`
        );
      }
    }
  }
});

test("Boulder: direct final ranking uses total score then larger startOrder countback", (t: TestContext) => {
  const worlds = enumerateBoulderWorlds(BOULDER_ENDED_COUNTBACK);
  assert.equal(worlds.length, 1);
  assert.deepEqual([...worlds[0].ranks.entries()].sort((left, right) => left[1] - right[1]), [
    ["Ada", 1], ["Bea", 2], ["Cia", 3], ["Dee", 4]
  ]);
  const formal = derive(boulderSnapshot(BOULDER_ENDED_COUNTBACK));
  assert.equal(outcome(formal, "Ada", "gold").verdict, "locked");
  assert.equal(outcome(formal, "Bea", "silver").verdict, "locked");
  assert.equal(outcome(formal, "Cia", "bronze").verdict, "locked");
  assert.equal(outcome(formal, "Dee", "bronze").verdict, "eliminated");
  t.diagnostic(`scenario=${BOULDER_ENDED_COUNTBACK.name} worlds=${worlds.length}`);
});

test("Boulder: all-waiting pre-start remains policy-undecided", (t: TestContext) => {
  const worlds = enumerateBoulderWorlds(BOULDER_NOT_STARTED);
  assert.equal(worlds.length, 256);
  assert.equal(worldTruth(worlds, "Ada", "gold"), "mixed");
  const formal = derive(boulderSnapshot(BOULDER_NOT_STARTED));
  for (const athlete of formal.athletes) {
    for (const medal of athlete.outcomes) assert.equal(medal.verdict, "undecided");
  }
  t.diagnostic(`scenario=${BOULDER_NOT_STARTED.name} worlds=${worlds.length} policy=pre-start`);
});

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
  test(`Boulder necessary condition is iff at the ${atom.id} last-line boundary`, (t: TestContext) => {
    const scenario = boulderNecessaryBoundary(atom);
    const worlds = enumerateBoulderWorlds(scenario);
    assert.equal(worlds.length, ALL_BOULDER_ATOMS.length);
    assert.equal(worldTruth(worlds, "Ada", "gold"), "mixed");
    const formal = outcome(derive(boulderSnapshot(scenario)), "Ada", "gold");
    assert.equal(formal.verdict, "needs_conditions");
    assert.equal(formal.conditions.length, 1);
    assert.match(formal.conditions[0].summary, /^Needs\b/);
    assertConditionAudit(formal, worlds, "Ada", [{
      name: `Ada final score >= Bea's fixed ${atom.id}`,
      summary: formal.conditions[0].summary,
      predicate: boulderScoreAtLeast("Ada", atom.score10)
    }]);
    t.diagnostic(`scenario=${scenario.name} worlds=${worlds.length}`);
  });
}

test("Boulder: climbing after a zone has a necessary absolute last-line threshold", (t: TestContext) => {
  const worlds = enumerateBoulderWorlds(BOULDER_ZONE_CLIMBING);
  assert.equal(worldTruth(worlds, "Ada", "gold"), "mixed");
  const formal = outcome(derive(boulderSnapshot(BOULDER_ZONE_CLIMBING)), "Ada", "gold");
  assert.equal(formal.verdict, "needs_conditions");
  assertConditionAudit(formal, worlds, "Ada", [{
    name: "Ada reaches at least T2's 24.9 on the last line",
    summary: formal.conditions[0].summary,
    predicate: boulderScoreAtLeast("Ada", BOULDER_ATOMS.T2.score10)
  }]);
  t.diagnostic(`scenario=${BOULDER_ZONE_CLIMBING.name} worlds=${worlds.length}`);
});

test("Boulder: two remaining routes require both flashes when that is the unique path", (t: TestContext) => {
  const worlds = enumerateBoulderWorlds(BOULDER_TWO_REMAINING);
  assert.equal(worlds.length, 4);
  const formal = outcome(derive(boulderSnapshot(BOULDER_TWO_REMAINING)), "Ada", "gold");
  assert.equal(formal.verdict, "needs_conditions");
  assertConditionAudit(formal, worlds, "Ada", [{
    name: "Ada flashes both remaining routes",
    summary: /^Needs to flash both remaining boulders(?: \(if that ties Bea, Ada takes it on the semi-final ranking\))?\.$/,
    predicate: allOf(atomAt("Ada.B3", "T1"), atomAt("Ada.B4", "T1"))
  }]);
  t.diagnostic(`scenario=${BOULDER_TWO_REMAINING.name} worlds=${worlds.length}`);
});

test("Boulder: a finished athlete can depend purely on one waiting opponent", (t: TestContext) => {
  const worlds = enumerateBoulderWorlds(BOULDER_PURE_OPPONENT);
  assert.equal(worldTruth(worlds, "Ada", "gold"), "mixed");
  const formal = outcome(derive(boulderSnapshot(BOULDER_PURE_OPPONENT)), "Ada", "gold");
  assert.equal(formal.verdict, "needs_conditions");
  assertConditionAudit(formal, worlds, "Ada", [{
    name: "Bea does not rank ahead of finished Ada",
    summary: formal.conditions[0].summary,
    predicate: not(ranksAhead("Bea", "Ada"))
  }]);
  t.diagnostic(`scenario=${BOULDER_PURE_OPPONENT.name} worlds=${worlds.length}`);
});

test("Boulder: silver for a finished athlete is lost only if both opponents rank ahead", (t: TestContext) => {
  const worlds = enumerateBoulderWorlds(BOULDER_BOTH_OPPONENTS);
  assert.equal(worlds.length, 25);
  const medalPredicate = not(allOf(ranksAhead<BoulderWorld>("Bea", "Ada"), ranksAhead<BoulderWorld>("Cia", "Ada")));
  assert.ok(worlds.every((world) => winsMedal(world, "Ada", "silver") === medalPredicate(world)));
  const formal = outcome(derive(boulderSnapshot(BOULDER_BOTH_OPPONENTS)), "Ada", "silver");
  assert.equal(formal.verdict, "needs_conditions");
  assertConditionAudit(formal, worlds, "Ada", [{
    name: "not both opponents rank ahead",
    summary: formal.conditions[0].summary,
    predicate: medalPredicate
  }]);
  t.diagnostic(`scenario=${BOULDER_BOTH_OPPONENTS.name} worlds=${worlds.length}`);
});

test("Boulder: all three opponents cardinality is exact but intentionally summarized as undecided", (t: TestContext) => {
  const worlds = enumerateBoulderWorlds(BOULDER_ALL_OPPONENTS);
  assert.equal(worlds.length, 8);
  const allAhead = allOf(
    ranksAhead<BoulderWorld>("Bea", "Ada"),
    ranksAhead<BoulderWorld>("Cia", "Ada"),
    ranksAhead<BoulderWorld>("Dee", "Ada")
  );
  assert.ok(worlds.every((world) => winsMedal(world, "Ada", "bronze") === !allAhead(world)));
  const formal = outcome(derive(boulderSnapshot(BOULDER_ALL_OPPONENTS)), "Ada", "bronze");
  assert.equal(formal.verdict, "undecided");
  assert.equal(formal.reason, "Too many ways this could still go — too early to call.");
  assert.deepEqual(formal.conditions, []);
  t.diagnostic(`scenario=${BOULDER_ALL_OPPONENTS.name} worlds=${worlds.length} policy=>=3-opponent-summary`);
});

test("Boulder: climbing + waiting + finished produces mixed self-and-opponent paths", (t: TestContext) => {
  const worlds = enumerateBoulderWorlds(BOULDER_MIXED_STATUS);
  assert.equal(worlds.length, 16);
  assert.equal(worldTruth(worlds, "Ada", "gold"), "mixed");
  const formal = outcome(derive(boulderSnapshot(BOULDER_MIXED_STATUS)), "Ada", "gold");
  assert.equal(formal.verdict, "needs_conditions");
  const specs: ConditionSpec<BoulderWorld>[] = [
    {
      name: "Ada flashes and finishes ahead of Cia",
      summary: /^(Flashes the boulder|Flashing the boulder).*(ranks ahead of Cia|Cia.*rank behind her|Cia does not flash her last boulder)/,
      predicate: allOf(atomAt("Ada.B4", "T1"), ranksAhead("Ada", "Cia"))
    },
    {
      name: "Ada tops in two and finishes ahead of Cia",
      summary: /^(Tops her last boulder in 2 attempts or fewer|Topping her last boulder in 2 attempts or fewer).*(ranks ahead of Cia|Cia.*rank behind her)/,
      predicate: allOf(atomAt("Ada.B4", "T1", "T2"), ranksAhead("Ada", "Cia"))
    }
  ];
  assertConditionAudit(formal, worlds, "Ada", specs);
  t.diagnostic(`scenario=${BOULDER_MIXED_STATUS.name} worlds=${worlds.length} conditions=${formal.conditions.length}`);
});

test.todo("KNOWN-ISSUE regression: nine failed attempts make flash-based best impossible", () => {
  const scenario: BoulderReferenceScenario = {
    name: "known-issue-in-progress-attempts-constrain-best",
    roundStatus: "active",
    athletes: [
      boulderAthlete("Ada", 2, [
        fixedBoulderSlot("Ada", 1, BOULDER_ATOMS.N),
        fixedBoulderSlot("Ada", 2, BOULDER_ATOMS.N),
        fixedBoulderSlot("Ada", 3, BOULDER_ATOMS.N),
        openBoulderSlot("Ada", 4, { state: "climbing_none", attemptsMade: 9 }, [
          BOULDER_ATOMS.N,
          BOULDER_ATOMS.Z10,
          BOULDER_ATOMS.Z20,
          BOULDER_ATOMS.Z21,
          BOULDER_ATOMS.T10,
          BOULDER_ATOMS.T20,
          BOULDER_ATOMS.T21
        ])
      ], "Ada Alto"),
      finishedBoulderAthlete("Bea", 1, [BOULDER_ATOMS.T2, BOULDER_ATOMS.N, BOULDER_ATOMS.N, BOULDER_ATOMS.N], "Bea Beta")
    ]
  };
  const worlds = enumerateBoulderWorlds(scenario);
  assert.equal(worlds.length, 7);
  assert.equal(worldTruth(worlds, "Ada", "gold"), "never", worldEvidence(worlds[0]));
  const formal = outcome(derive(boulderSnapshot(scenario)), "Ada", "gold");
  assert.equal(
    formal.verdict,
    "eliminated",
    `Counterexample fixture=${scenario.name}; all 7 legal terminals score <=24.1 after nine failed attempts, below Bea's 24.9, but formal returned ${formal.verdict}: ${JSON.stringify(formal)}`
  );
});

test("Lead: equal finished 42+ scores use larger startOrder countback", (t: TestContext) => {
  const worlds = enumerateLeadWorlds(LEAD_FINISHED_COUNTBACK);
  assert.deepEqual([...worlds[0].ranks.entries()].sort((left, right) => left[1] - right[1]), [["Ada", 1], ["Bea", 2]]);
  const formal = derive(leadSnapshot(LEAD_FINISHED_COUNTBACK));
  assert.equal(outcome(formal, "Ada", "gold").verdict, "locked");
  assert.equal(outcome(formal, "Bea", "gold").verdict, "eliminated");
  t.diagnostic(`scenario=${LEAD_FINISHED_COUNTBACK.name} worlds=${worlds.length}`);
});

for (const entry of [
  { scenario: LEAD_NECESSARY_42_PLUS, score4: 42 * 4 + 1, summary: "Needs at least 42+ on the final route." },
  { scenario: LEAD_NECESSARY_43, score4: 43 * 4, summary: "Needs at least 43 on the final route." }
]) {
  test(`Lead: ${entry.scenario.name} is a necessary-and-sufficient legal score threshold`, (t: TestContext) => {
    const worlds = enumerateLeadWorlds(entry.scenario);
    assert.equal(worldTruth(worlds, "Ada", "gold"), "mixed");
    const formal = outcome(derive(leadSnapshot(entry.scenario)), "Ada", "gold");
    assert.equal(formal.verdict, "needs_conditions");
    assertConditionAudit(formal, worlds, "Ada", [{
      name: `Ada reaches ${entry.summary}`,
      summary: entry.summary,
      predicate: leadScoreAtLeast("Ada", entry.score4)
    }]);
    t.diagnostic(`scenario=${entry.scenario.name} worlds=${worlds.length}`);
  });
}

test("Lead: TOP-only path remains undecided while DIFF-009 is not fixed", (t: TestContext) => {
  const worlds = enumerateLeadWorlds(LEAD_TOP_GATED);
  assert.equal(worldTruth(worlds, "Ada", "gold"), "mixed");
  assert.ok(worlds.every((world) => winsMedal(world, "Ada", "gold") === (world.assignments.get("Ada")?.id === "TOP")));
  const formal = outcome(derive(leadSnapshot(LEAD_TOP_GATED), false), "Ada", "gold");
  assert.equal(formal.verdict, "undecided");
  assert.match(formal.reason, /top that is not yet officially confirmed/);
  assert.deepEqual(formal.conditions, []);
  t.diagnostic(`scenario=${LEAD_TOP_GATED.name} worlds=${worlds.length} DIFF009_FIXED=false`);
});

test("Lead: a DNS terminal is settled in the world oracle", (t: TestContext) => {
  const worlds = enumerateLeadWorlds(LEAD_DNS);
  assert.equal(worlds.length, 1);
  assert.equal(worldTruth(worlds, "Ada", "gold"), "never");
  assert.equal(outcome(derive(leadSnapshot(LEAD_DNS)), "Ada", "gold").verdict, "eliminated");
  t.diagnostic(`scenario=${LEAD_DNS.name} worlds=${worlds.length}`);
});

test("Lead: finished subject can depend purely on a waiting opponent", (t: TestContext) => {
  const worlds = enumerateLeadWorlds(LEAD_PURE_OPPONENT);
  assert.equal(worldTruth(worlds, "Ada", "gold"), "mixed");
  const formal = outcome(derive(leadSnapshot(LEAD_PURE_OPPONENT)), "Ada", "gold");
  assert.equal(formal.verdict, "needs_conditions");
  assertConditionAudit(formal, worlds, "Ada", [{
    name: "Bea does not rank ahead of Ada",
    summary: formal.conditions[0].summary,
    predicate: not(ranksAhead("Bea", "Ada"))
  }]);
  t.diagnostic(`scenario=${LEAD_PURE_OPPONENT.name} worlds=${worlds.length}`);
});

test("Lead: waiting, climbing and finished states share one finite 12-world fixture", (t: TestContext) => {
  const worlds = enumerateLeadWorlds(LEAD_WAITING_CLIMBING_FINISHED);
  assert.equal(leadWorldCount(LEAD_WAITING_CLIMBING_FINISHED), 12);
  assert.equal(worldTruth(worlds, "Ada", "silver"), "mixed");
  const formal = outcome(derive(leadSnapshot(LEAD_WAITING_CLIMBING_FINISHED)), "Ada", "silver");
  assert.ok(formal.verdict === "needs_conditions" || formal.verdict === "undecided");
  t.diagnostic(`scenario=${LEAD_WAITING_CLIMBING_FINISHED.name} worlds=${worlds.length} verdict=${formal.verdict}`);
});
