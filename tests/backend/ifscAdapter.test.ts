import assert from "node:assert/strict";
import test from "node:test";
import { normalizeIfscPayload } from "../../server/src/adapters/IfscAdapter.js";
import { boulderPayload, leadPayload, twoAthleteLeadPayload } from "../fixtures/ifscPayloads.js";

const ENDPOINT = "https://ifsc.results.info/api/v1/category_rounds/10704/results";

for (const score of [69.4, "69.4"] as const) {
  test(`Boulder canonical score preserves ${typeof score} 69.4`, () => {
    const snapshot = normalizeIfscPayload(
      boulderPayload(score) as Parameters<typeof normalizeIfscPayload>[0],
      ENDPOINT
    );

    assert.equal(snapshot.discipline, "boulder");
    assert.equal(snapshot.athletes[0].score, 69.4);
    assert.equal(snapshot.ranking[0].score, 69.4);
    assert.equal(snapshot.athletes[0].score, snapshot.ranking[0].score);
    assert.equal(snapshot.athletes[0].rank, snapshot.ranking[0].rank);
  });
}

const boulderMatrix = [
  { raw: 69, expected: 69 },
  { raw: "69", expected: 69 },
  { raw: 0, expected: 0 },
  { raw: "0", expected: 0 },
  { raw: "DNS", expected: 0 },
  { raw: null, expected: 0 }
] as const;

for (const { raw, expected } of boulderMatrix) {
  test(`Boulder parser maps ${String(raw)} to ${expected}`, () => {
    const snapshot = normalizeIfscPayload(
      boulderPayload(raw) as Parameters<typeof normalizeIfscPayload>[0],
      ENDPOINT
    );
    assert.equal(snapshot.athletes[0].score, expected);
    assert.equal(snapshot.ranking[0].score, expected);
    assert.equal(snapshot.athletes[0].leadScoreText, undefined);
  });
}

const leadMatrix = [
  { raw: 42, expected: 42, text: "42", status: "fall" },
  { raw: "42", expected: 42, text: "42", status: "fall" },
  { raw: "42+", expected: 42.25, text: "42+", status: "fall" },
  { raw: 42.25, expected: 42.25, text: "42+", status: "fall" },
  { raw: "TOP", expected: 100, text: "TOP", status: "top" },
  { raw: "DNS", expected: 0, text: "DNS", status: "dns" }
] as const;

for (const row of leadMatrix) {
  test(`Lead parser preserves official ${String(row.raw)} semantics`, () => {
    const snapshot = normalizeIfscPayload(
      leadPayload(row.raw, row.status === "dns" ? "DNS" : "confirmed") as Parameters<typeof normalizeIfscPayload>[0],
      ENDPOINT
    );
    const athlete = snapshot.athletes[0];
    const ranking = snapshot.ranking[0];
    const lead = snapshot.lead!.genders[0].athletes[0];
    assert.equal(athlete.score, row.expected);
    assert.equal(ranking.score, row.expected);
    assert.equal(athlete.rank, ranking.rank);
    assert.equal(athlete.leadScoreText, row.text);
    assert.equal(lead.scoreText, row.text);
    assert.equal(lead.status, row.status);
    assert.equal(lead.hold + (lead.plus ? 0.25 : 0), row.expected);
    assert.notEqual(lead.scoreText, "42.3");
  });
}

test("every raw ranking athlete has one canonical score and rank", () => {
  const snapshot = normalizeIfscPayload(
    twoAthleteLeadPayload("42+") as Parameters<typeof normalizeIfscPayload>[0],
    ENDPOINT
  );
  for (const ranking of snapshot.ranking) {
    const athlete = snapshot.athletes.find((candidate) => candidate.athlete.id === ranking.athleteId);
    assert.ok(athlete);
    assert.equal(athlete.score, ranking.score);
    assert.equal(athlete.rank, ranking.rank);
  }
});

test("same-rank and unranked Lead fallbacks are deterministic", () => {
  const payload = twoAthleteLeadPayload("42", 999, 999);
  payload.ranking[1].score = "42+";
  const snapshot = normalizeIfscPayload(
    payload as Parameters<typeof normalizeIfscPayload>[0],
    ENDPOINT
  );
  assert.deepEqual(snapshot.lead!.genders[0].athletes.map((entry) => entry.athlete.id), ["202", "201"]);
});

test("equal-rank equal-score Lead fallback gives the larger startOrder countback priority", () => {
  const payload = twoAthleteLeadPayload("42", 999, 999);
  payload.ranking[0].start_order = 7;
  payload.ranking[1].score = "42";
  payload.ranking[1].start_order = 8;
  const snapshot = normalizeIfscPayload(
    payload as Parameters<typeof normalizeIfscPayload>[0],
    ENDPOINT
  );
  assert.deepEqual(snapshot.lead!.genders[0].athletes.map((entry) => entry.athlete.id), ["202", "201"]);
});

test("startlist-only athletes remain waiting and absent from official ranking", () => {
  const payload = boulderPayload(0);
  payload.ranking = [];
  const snapshot = normalizeIfscPayload(
    payload as Parameters<typeof normalizeIfscPayload>[0],
    ENDPOINT
  );
  assert.equal(snapshot.ranking.length, 0);
  assert.equal(snapshot.athletes[0].rank, 999);
  assert.equal(snapshot.athletes[0].score, 0);
  assert.equal(snapshot.athletes[0].sourceStatus, "waiting");
});

test("active Boulder attempts are preserved for state deltas and future best-bound validation", () => {
  const payload = boulderPayload(0);
  payload.ranking[0].ascents[0] = {
    ...payload.ranking[0].ascents[0],
    top: false,
    zone: false,
    top_tries: 3,
    zone_tries: 3,
    points: 0,
    status: "active"
  };
  const snapshot = normalizeIfscPayload(
    payload as Parameters<typeof normalizeIfscPayload>[0],
    ENDPOINT
  );
  assert.equal(snapshot.athletes[0].boulders[0].attemptsToTop, 3);
  assert.equal(snapshot.athletes[0].boulders[0].attemptsToZone, 3);
  assert.equal(snapshot.athletes[0].currentBoulder, 1);
});
