import cors from "@fastify/cors";
import Fastify from "fastify";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRoundSourceFromEnv, createRoundSourceFromUrl, IfscAdapter, type RoundSource } from "./adapters/IfscAdapter.js";
import { CompetitionStateMachine } from "./state/CompetitionStateMachine.js";
import { SnapshotStore } from "./state/SnapshotStore.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";

export interface ServerOptions {
  defaultSource?: RoundSource;
  roundSourceForUrl?: (roundUrl: string) => RoundSource;
  logger?: boolean;
}

export async function buildServer(options: ServerOptions = {}) {
  const app = Fastify({ logger: options.logger ?? true });
  const adapter = new IfscAdapter(options.defaultSource ?? createRoundSourceFromEnv());
  const machine = new CompetitionStateMachine();
  const store = new SnapshotStore();
  const runtimes = new Map<string, { adapter: IfscAdapter; machine: CompetitionStateMachine }>();

  await app.register(cors, { origin: true });

  const runtimeFor = (roundUrl: string) => {
    const existing = runtimes.get(roundUrl);
    if (existing) return existing;
    const source = options.roundSourceForUrl?.(roundUrl) ?? createRoundSourceFromUrl(roundUrl);
    const runtime = { adapter: new IfscAdapter(source), machine: new CompetitionStateMachine() };
    runtimes.set(roundUrl, runtime);
    return runtime;
  };

  app.get("/api/state", async (request, reply) => {
    try {
      const roundUrl = readRoundUrl(request.query as { roundUrl?: string | string[] } | undefined);
      if (roundUrl) {
        const runtime = runtimeFor(roundUrl);
        const snapshot = await runtime.adapter.fetchSnapshot();
        return runtime.machine.apply(snapshot, runtime.adapter.sourceName(), runtime.adapter.refreshMs());
      }
      const state = store.getState();
      if (!state) return reply.code(503).send({ error: "No competition state available yet." });
      return state;
    } catch (error) {
      return reply.code(500).send({
        error: error instanceof Error ? error.message : "Failed to update competition state"
      });
    }
  });

  app.get("/events", async (request, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*"
    });

    const send = (state: unknown) => {
      reply.raw.write("event: state\n");
      reply.raw.write(`data: ${JSON.stringify(state)}\n\n`);
    };
    const unsubscribe = store.subscribe(send);
    request.raw.on("close", unsubscribe);
  });

  const tick = async () => {
    try {
      const snapshot = await adapter.fetchSnapshot();
      const state = machine.apply(snapshot, adapter.sourceName(), adapter.refreshMs());
      store.setState(state);
    } catch (error) {
      app.log.error(error, "Failed to update competition state");
    }
  };

  await tick();
  return { app, tick, refreshMs: adapter.refreshMs() };
}

export async function startServer() {
  const server = await buildServer();
  setInterval(server.tick, server.refreshMs);
  await server.app.listen({ port, host });
}

export function readRoundUrl(query: { roundUrl?: string | string[] } | undefined) {
  const value = query?.roundUrl;
  const roundUrl = Array.isArray(value) ? value[0] : value;
  if (!roundUrl) return undefined;
  if (roundUrl === "https://ifsc.results.info/event/0/cr/0") {
    throw new Error("Demo error: this simulates a failed competition link.");
  }
  if (roundUrl === "demo:lead-semifinal" || roundUrl === "demo:lead-final") return roundUrl;
  if (!/^https:\/\/ifsc\.results\.info\/event\/\d+\/cr\/\d+\/?$/.test(roundUrl)) {
    throw new Error("Unsupported IFSC round URL. Use a URL like https://ifsc.results.info/event/1515/cr/10704");
  }
  return roundUrl;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  await startServer();
}
