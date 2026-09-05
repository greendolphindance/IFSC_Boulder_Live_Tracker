import { createRoundSourceFromEnv, createRoundSourceFromUrl, IfscAdapter, type RoundSource } from "../server/src/adapters/IfscAdapter.js";
import { CompetitionStateMachine } from "../server/src/state/CompetitionStateMachine.js";

interface RequestLike {
  query?: { roundUrl?: string | string[] };
}

interface ResponseLike {
  status: (code: number) => { json: (body: unknown) => void };
  setHeader: (name: string, value: string) => void;
}

export interface StateHandlerOptions {
  defaultSource?: RoundSource;
  roundSourceForUrl?: (roundUrl: string) => RoundSource;
}

export function createStateHandler(options: StateHandlerOptions = {}) {
  const runtimes = new Map<string, { adapter: IfscAdapter; machine: CompetitionStateMachine }>();

  const runtimeFor = (roundUrl: string | undefined) => {
    const key = roundUrl ?? "__env__";
    const existing = runtimes.get(key);
    if (existing) return existing;
    const source = roundUrl
      ? options.roundSourceForUrl?.(roundUrl) ?? createRoundSourceFromUrl(roundUrl)
      : options.defaultSource ?? createRoundSourceFromEnv();
    const runtime = { adapter: new IfscAdapter(source), machine: new CompetitionStateMachine() };
    runtimes.set(key, runtime);
    return runtime;
  };

  return async function handler(request: RequestLike, response: ResponseLike) {
    response.setHeader("Cache-Control", "no-store, max-age=0");
    try {
      const roundUrl = readRoundUrl(request);
      const runtime = runtimeFor(roundUrl);
      const snapshot = await runtime.adapter.fetchSnapshot();
      const state = runtime.machine.apply(snapshot, runtime.adapter.sourceName(), runtime.adapter.refreshMs());
      response.status(200).json(state);
    } catch (error) {
      response.status(500).json({
        error: error instanceof Error ? error.message : "Failed to update competition state"
      });
    }
  };
}

export function readRoundUrl(request: RequestLike) {
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

export default createStateHandler();
