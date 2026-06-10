import { createRoundSourceFromEnv, createRoundSourceFromUrl, IfscAdapter, type RoundSource } from "../server/src/adapters/IfscAdapter.js";
import { CompetitionStateMachine } from "../server/src/state/CompetitionStateMachine.js";

const runtimes = new Map<string, { adapter: IfscAdapter; machine: CompetitionStateMachine }>();

export default async function handler(request: { query?: { roundUrl?: string | string[] } }, response: {
  status: (code: number) => { json: (body: unknown) => void };
  setHeader: (name: string, value: string) => void;
}) {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  try {
    const roundUrl = readRoundUrl(request);
    const { adapter, machine } = runtimeFor(roundUrl);
    const snapshot = await adapter.fetchSnapshot();
    const state = machine.apply(snapshot, adapter.sourceName(), adapter.refreshMs());
    response.status(200).json(state);
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Failed to update competition state"
    });
  }
}

function readRoundUrl(request: { query?: { roundUrl?: string | string[] } }) {
  const value = request.query?.roundUrl;
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

function runtimeFor(roundUrl: string | undefined) {
  const key = roundUrl ?? "__env__";
  const existing = runtimes.get(key);
  if (existing) return existing;
  const source: RoundSource = roundUrl ? createRoundSourceFromUrl(roundUrl) : createRoundSourceFromEnv();
  const runtime = {
    adapter: new IfscAdapter(source),
    machine: new CompetitionStateMachine()
  };
  runtimes.set(key, runtime);
  return runtime;
}
