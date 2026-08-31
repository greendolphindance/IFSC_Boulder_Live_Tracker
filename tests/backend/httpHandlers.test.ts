import assert from "node:assert/strict";
import test from "node:test";
import { createStateHandler } from "../../api/state.js";
import { normalizeIfscPayload, type RoundSource } from "../../server/src/adapters/IfscAdapter.js";
import { buildServer } from "../../server/src/index.js";
import type { CompetitionSnapshot } from "../../server/src/types/domain.js";
import { boulderPayload } from "../fixtures/ifscPayloads.js";

const ENDPOINT = "https://ifsc.results.info/api/v1/category_rounds/10704/results";
const ROUND_URL = "https://ifsc.results.info/event/1515/cr/10704";

class FrozenRoundSource implements RoundSource {
  constructor(private readonly snapshot: CompetitionSnapshot) {}

  async nextSnapshot() {
    return structuredClone(this.snapshot);
  }

  sourceName(): "fixture" {
    return "fixture";
  }

  refreshMs() {
    return 2000;
  }
}

function frozenSnapshot() {
  const snapshot = normalizeIfscPayload(
    boulderPayload("69.4") as Parameters<typeof normalizeIfscPayload>[0],
    ENDPOINT
  );
  snapshot.receivedAt = "2026-08-31T10:00:00.000Z";
  snapshot.sourceTimestamp = snapshot.receivedAt;
  return snapshot;
}

async function invokeVercel(handler: ReturnType<typeof createStateHandler>, roundUrl?: string) {
  let statusCode = 0;
  let body: unknown;
  const headers = new Map<string, string>();
  await handler(
    { query: roundUrl ? { roundUrl } : undefined },
    {
      setHeader(name, value) {
        headers.set(name.toLowerCase(), value);
      },
      status(code) {
        statusCode = code;
        return {
          json(value) {
            body = JSON.parse(JSON.stringify(value));
          }
        };
      }
    }
  );
  return { statusCode, body, headers };
}

test("Fastify and Vercel return identical core JSON for one frozen payload", async () => {
  const snapshot = frozenSnapshot();
  const server = await buildServer({ defaultSource: new FrozenRoundSource(snapshot), logger: false });
  try {
    const fastifyResponse = await server.app.inject({ method: "GET", url: "/api/state" });
    const fastifyBody = JSON.parse(fastifyResponse.body);
    const vercel = await invokeVercel(createStateHandler({ defaultSource: new FrozenRoundSource(snapshot) }));

    assert.equal(fastifyResponse.statusCode, 200);
    assert.equal(vercel.statusCode, 200);
    assert.deepEqual(vercel.body, fastifyBody);
    assert.equal((fastifyBody as { snapshot: CompetitionSnapshot }).snapshot.athletes[0].score, 69.4);
    assert.equal((fastifyBody as { liveStates: { score: number }[] }).liveStates[0].score, 69.4);
    assert.equal(vercel.headers.get("cache-control"), "no-store, max-age=0");
  } finally {
    await server.app.close();
  }
});

test("both handlers accept the same official round URL and use the injected source", async () => {
  const snapshot = frozenSnapshot();
  const fastifyUrls: string[] = [];
  const vercelUrls: string[] = [];
  const server = await buildServer({
    defaultSource: new FrozenRoundSource(snapshot),
    roundSourceForUrl: (url) => {
      fastifyUrls.push(url);
      return new FrozenRoundSource(snapshot);
    },
    logger: false
  });
  try {
    const fastifyResponse = await server.app.inject({ method: "GET", url: `/api/state?roundUrl=${encodeURIComponent(ROUND_URL)}` });
    const vercel = await invokeVercel(createStateHandler({
      defaultSource: new FrozenRoundSource(snapshot),
      roundSourceForUrl: (url) => {
        vercelUrls.push(url);
        return new FrozenRoundSource(snapshot);
      }
    }), ROUND_URL);
    assert.equal(fastifyResponse.statusCode, 200);
    assert.equal(vercel.statusCode, 200);
    assert.deepEqual(fastifyUrls, [ROUND_URL]);
    assert.deepEqual(vercelUrls, [ROUND_URL]);
  } finally {
    await server.app.close();
  }
});

test("both handlers reject non-IFSC links without calling a source", async () => {
  const snapshot = frozenSnapshot();
  let sourceCalls = 0;
  const server = await buildServer({
    defaultSource: new FrozenRoundSource(snapshot),
    roundSourceForUrl: () => {
      sourceCalls += 1;
      return new FrozenRoundSource(snapshot);
    },
    logger: false
  });
  try {
    const badUrl = "https://example.com/event/1515/cr/10704";
    const fastifyResponse = await server.app.inject({ method: "GET", url: `/api/state?roundUrl=${encodeURIComponent(badUrl)}` });
    const vercel = await invokeVercel(createStateHandler({
      defaultSource: new FrozenRoundSource(snapshot),
      roundSourceForUrl: () => {
        sourceCalls += 1;
        return new FrozenRoundSource(snapshot);
      }
    }), badUrl);
    assert.equal(fastifyResponse.statusCode, 500);
    assert.equal(vercel.statusCode, 500);
    assert.equal(sourceCalls, 0);
    assert.match(fastifyResponse.body, /Unsupported IFSC round URL/);
    assert.match(JSON.stringify(vercel.body), /Unsupported IFSC round URL/);
  } finally {
    await server.app.close();
  }
});
