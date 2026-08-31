import assert from "node:assert/strict";
import test from "node:test";
import { boulderScoreSemantic, formatBoulderScore, type BoulderScoreDisplayInput } from "../../src/lib/format.ts";

const score = (input: BoulderScoreDisplayInput) => formatBoulderScore(input);

test("Boulder score formatter preserves the canonical decimal value", () => {
  assert.equal(score({ score: 69.4, hasOfficialResult: true }), "69.4");
  assert.equal(score({ score: 69, hasOfficialResult: true }), "69.0");
  assert.notEqual(score({ score: 69, hasOfficialResult: true }), "69.4", "the UI must not invent a decimal lost upstream");
});

test("Boulder score formatter distinguishes zero, DNS, and no result", () => {
  const matrix: Array<{ input: BoulderScoreDisplayInput; semantic: ReturnType<typeof boulderScoreSemantic>; text: string }> = [
    { input: { score: 0, hasOfficialResult: true }, semantic: "score", text: "0.0" },
    { input: { score: 0, sourceStatus: "DNS", hasOfficialResult: true }, semantic: "dns", text: "DNS" },
    { input: { score: 0, sourceStatus: "Did Not Start", hasOfficialResult: true }, semantic: "dns", text: "DNS" },
    { input: { score: 0, hasOfficialResult: false }, semantic: "no-result", text: "-" },
    { input: { score: 0, sourceStatus: "waiting", hasOfficialResult: true }, semantic: "no-result", text: "-" },
    { input: { score: 0, sourceStatus: "unranked", hasOfficialResult: true }, semantic: "no-result", text: "-" },
    { input: { score: 0, sourceStatus: "startlist-only", hasOfficialResult: false }, semantic: "no-result", text: "-" }
  ];

  for (const row of matrix) {
    assert.equal(boulderScoreSemantic(row.input), row.semantic);
    assert.equal(score(row.input), row.text);
  }
});

test("DNS takes precedence over an absent official ranking entry", () => {
  const input = { score: 0, sourceStatus: "DNS", hasOfficialResult: false };
  assert.equal(boulderScoreSemantic(input), "dns");
  assert.equal(score(input), "DNS");
});
