import assert from "node:assert/strict";
import test from "node:test";
import { diffSemanticSamples, parseProbeArgs, summarizeIfscPayload } from "../../scripts/probe-ifsc.js";

test("probe accepts an executable continuous-capture plan", () => {
  assert.deepEqual(parseProbeArgs([
    "https://ifsc.results.info/event/1515/cr/10704",
    "--duration-ms=600000",
    "--poll-ms", "2000",
    "--out-dir", "/tmp/ifsc-evidence"
  ]), {
    target: "https://ifsc.results.info/event/1515/cr/10704",
    durationMs: 600000,
    pollMs: 2000,
    outDir: "/tmp/ifsc-evidence"
  });
});

test("probe semantic summary records attempts and TOP transitions", () => {
  const before = summarizeIfscPayload({
    status: "active",
    status_as_of: "2026-08-31T10:00:00Z",
    ranking: [{
      athlete_id: 101,
      rank: 2,
      score: 0,
      active: true,
      ascents: [{ route_id: 501, route_name: "4", top: false, top_tries: 9, zone: false, zone_tries: 9, status: "active", modified: "2026-08-31T10:00:00Z" }]
    }]
  });
  const after = summarizeIfscPayload({
    status: "active",
    status_as_of: "2026-08-31T10:00:02Z",
    ranking: [{
      athlete_id: 101,
      rank: 1,
      score: "TOP",
      active: false,
      ascents: [{ route_id: 501, route_name: "4", top: true, top_tries: 10, zone: true, zone_tries: 9, status: "confirmed", modified: "2026-08-31T10:00:02Z" }]
    }]
  });
  assert.equal(before.athletes[0].ascents[0].topTries, 9);
  assert.equal(after.athletes[0].score, "TOP");
  assert.deepEqual(diffSemanticSamples(before, after), ["statusAsOf", "athlete:101"]);
});
