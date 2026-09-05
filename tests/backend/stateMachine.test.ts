import assert from "node:assert/strict";
import test from "node:test";
import { normalizeIfscPayload } from "../../server/src/adapters/IfscAdapter.js";
import { CompetitionStateMachine } from "../../server/src/state/CompetitionStateMachine.js";
import type { CompetitionSnapshot } from "../../server/src/types/domain.js";
import { boulderPayload, twoAthleteBoulderPayload, twoAthleteLeadPayload } from "../fixtures/ifscPayloads.js";

const ENDPOINT = "https://ifsc.results.info/api/v1/category_rounds/10704/results";

function normalize(payload: unknown, receivedAt: string): CompetitionSnapshot {
  const snapshot = normalizeIfscPayload(payload as Parameters<typeof normalizeIfscPayload>[0], ENDPOINT);
  snapshot.receivedAt = receivedAt;
  snapshot.sourceTimestamp = receivedAt;
  return snapshot;
}

test("canonical Boulder score survives snapshot into live state and rank event text", () => {
  const previous = normalize(twoAthleteBoulderPayload(68.9, 2, 1), "2026-08-31T10:00:00.000Z");
  const next = normalize(twoAthleteBoulderPayload(69.4, 1, 2), "2026-08-31T10:00:02.000Z");
  const machine = new CompetitionStateMachine();
  machine.apply(previous, "fixture", 2000);
  const state = machine.apply(next, "fixture", 2000);
  assert.equal(state.snapshot.athletes.find((row) => row.athlete.id === "101")!.score, 69.4);
  assert.equal(state.liveStates.find((row) => row.athleteId === "101")!.score, 69.4);
  const rankEvent = state.events.find((event) => event.type === "RANK_CHANGED" && event.athleteId === "101");
  assert.match(rankEvent?.message ?? "", /\(69\.4\)/);
});

test("Lead rank events use official score text rather than Boulder decimal formatting", () => {
  const previous = normalize(twoAthleteLeadPayload("41", 2, 1), "2026-08-31T10:00:00.000Z");
  const next = normalize(twoAthleteLeadPayload("42+", 1, 2), "2026-08-31T10:00:02.000Z");
  const machine = new CompetitionStateMachine();
  machine.apply(previous, "fixture", 2000);
  const state = machine.apply(next, "fixture", 2000);
  const rankEvent = state.events.find((event) => event.type === "RANK_CHANGED" && event.athleteId === "201");
  assert.match(rankEvent?.message ?? "", /\(42\+\)/);
  assert.doesNotMatch(rankEvent?.message ?? "", /42\.3/);
});

for (const status of ["unfinished", "not finished", "incomplete", "suspended"] as const) {
  test(`round status ${status} is not classified as finished`, () => {
    const payload = boulderPayload(69.4);
    payload.status = status;
    const state = new CompetitionStateMachine().apply(normalize(payload, "2026-08-31T10:00:00.000Z"), "fixture", 2000);
    assert.equal(state.events.some((event) => event.message === "Competition finished"), false);
  });
}

test("pending on an active round is not classified as round-not-started", () => {
  const payload = boulderPayload(69.4);
  payload.status = "pending";
  const state = new CompetitionStateMachine().apply(normalize(payload, "2026-08-31T10:00:00.000Z"), "fixture", 2000);
  assert.equal(state.events.some((event) => event.message === "Competition not started"), false);
  assert.equal(state.currentClimbers.length, 1);
});

for (const [status, message] of [["completed", "Competition finished"], ["not started", "Competition not started"]] as const) {
  test(`round status ${status} retains its exact state event`, () => {
    const payload = boulderPayload(69.4);
    payload.status = status;
    const state = new CompetitionStateMachine().apply(normalize(payload, "2026-08-31T10:00:00.000Z"), "fixture", 2000);
    assert.equal(state.events.some((event) => event.message === message), true);
  });
}

test("attempt changes produce an ATTEMPT_UPDATED event without changing canonical score", () => {
  const beforePayload = boulderPayload(69.4);
  const afterPayload = boulderPayload(69.4);
  for (const [payload, attempts] of [[beforePayload, 2], [afterPayload, 3]] as const) {
    payload.ranking[0].ascents[0] = {
      ...payload.ranking[0].ascents[0],
      top: false,
      zone: false,
      top_tries: attempts,
      zone_tries: attempts,
      points: 0,
      status: "active"
    };
  }
  const machine = new CompetitionStateMachine();
  machine.apply(normalize(beforePayload, "2026-08-31T10:00:00.000Z"), "fixture", 2000);
  const state = machine.apply(normalize(afterPayload, "2026-08-31T10:00:02.000Z"), "fixture", 2000);
  assert.equal(state.liveStates[0].score, 69.4);
  assert.equal(state.events.some((event) => event.type === "ATTEMPT_UPDATED" && /attempt 3/.test(event.message)), true);
});
