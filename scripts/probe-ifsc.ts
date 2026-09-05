import { chromium, type Request, type Response, type WebSocket } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TARGET = "https://ifsc.results.info/event/1480/cr/10385";
const DEFAULT_OUT_DIR = "docs/network-captures";

export interface ProbeOptions {
  target: string;
  outDir: string;
  durationMs: number;
  pollMs: number;
}

export interface SemanticSnapshot {
  roundStatus?: unknown;
  statusAsOf?: unknown;
  athletes: Array<{
    athleteId: string;
    rank?: unknown;
    score?: unknown;
    status?: unknown;
    active?: unknown;
    ascents: Array<{
      routeId?: unknown;
      routeName?: unknown;
      top?: unknown;
      topTries?: unknown;
      zone?: unknown;
      zoneTries?: unknown;
      status?: unknown;
      modified?: unknown;
    }>;
  }>;
}

export function parseProbeArgs(args: string[]): ProbeOptions {
  const options: ProbeOptions = {
    target: DEFAULT_TARGET,
    outDir: DEFAULT_OUT_DIR,
    durationMs: 15_000,
    pollMs: 2_000
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const [flag, inlineValue] = arg.split("=", 2);
    const nextValue = inlineValue ?? args[index + 1];
    if (flag === "--duration-ms" || flag === "--poll-ms" || flag === "--out-dir") {
      if (inlineValue === undefined) index += 1;
      if (!nextValue) throw new Error(`${flag} requires a value.`);
      if (flag === "--out-dir") options.outDir = nextValue;
      else if (flag === "--duration-ms") options.durationMs = positiveInteger(nextValue, flag);
      else options.pollMs = positiveInteger(nextValue, flag);
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    options.target = arg;
  }
  if (!/^https:\/\/ifsc\.results\.info\/event\/\d+\/cr\/\d+\/?$/.test(options.target)) {
    throw new Error("Target must be an official IFSC round URL.");
  }
  return options;
}

export function summarizeIfscPayload(payload: unknown): SemanticSnapshot {
  const root = unwrapRoundPayload(payload);
  const rows = findRankingRows(root);
  return {
    roundStatus: root.status,
    statusAsOf: root.status_as_of,
    athletes: rows.map((row) => ({
      athleteId: String(row.athlete_id ?? nestedRecord(row.athlete).id ?? row.athleteId ?? "unknown"),
      rank: row.rank ?? row.route_rank ?? row.result_rank,
      score: row.lead_score_text ?? row.score ?? row.result ?? row.height ?? row.points,
      status: row.status ?? row.display_status,
      active: row.active,
      ascents: Array.isArray(row.ascents) ? row.ascents.map((value) => {
        const ascent = asRecord(value);
        return {
          routeId: ascent.route_id,
          routeName: ascent.route_name,
          top: ascent.top,
          topTries: ascent.top_tries,
          zone: ascent.zone,
          zoneTries: ascent.zone_tries,
          status: ascent.status,
          modified: ascent.modified
        };
      }) : []
    }))
  };
}

export function diffSemanticSamples(previous: SemanticSnapshot | undefined, current: SemanticSnapshot) {
  if (!previous) return ["initial-sample"];
  const changes: string[] = [];
  if (previous.roundStatus !== current.roundStatus) changes.push("roundStatus");
  if (previous.statusAsOf !== current.statusAsOf) changes.push("statusAsOf");
  const beforeByAthlete = new Map(previous.athletes.map((athlete) => [athlete.athleteId, athlete]));
  for (const athlete of current.athletes) {
    const before = beforeByAthlete.get(athlete.athleteId);
    if (!before || JSON.stringify(before) !== JSON.stringify(athlete)) changes.push(`athlete:${athlete.athleteId}`);
  }
  for (const athlete of previous.athletes) {
    if (!current.athletes.some((candidate) => candidate.athleteId === athlete.athleteId)) changes.push(`athlete-removed:${athlete.athleteId}`);
  }
  return changes;
}

export async function runProbe(options: ProbeOptions) {
  await mkdir(options.outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    extraHTTPHeaders: { "accept-language": "en-US,en;q=0.9" }
  });
  const captures: unknown[] = [];
  const jsonUrls = new Set<string>();
  const previousByUrl = new Map<string, SemanticSnapshot>();

  const record = (kind: string, payload: unknown) => {
    captures.push({ kind, capturedAt: new Date().toISOString(), payload });
  };

  page.on("request", (request: Request) => {
    const type = request.resourceType();
    if (["xhr", "fetch", "websocket"].includes(type)) {
      void request.allHeaders().then((headers) => {
        record("request", { method: request.method(), url: request.url(), resourceType: type, headers: redactHeaders(headers), postData: request.postData() });
      });
    }
  });

  page.on("response", async (response: Response) => {
    const request = response.request();
    const type = request.resourceType();
    if (!["xhr", "fetch"].includes(type)) return;
    const contentType = response.headers()["content-type"] ?? "";
    let body: unknown;
    if (contentType.includes("json")) {
      try {
        body = await response.json();
        if (isRelevantJsonUrl(response.url())) jsonUrls.add(response.url());
      } catch {
        body = "<json parse failed>";
      }
    } else {
      body = (await response.text().catch(() => "")).slice(0, 2000);
    }
    record("response", { url: response.url(), status: response.status(), contentType, headers: redactHeaders(response.headers()), body });
  });

  page.on("websocket", (socket: WebSocket) => {
    record("websocket-open", { url: socket.url() });
    socket.on("framereceived", (frame) => record("websocket-frame-received", { url: socket.url(), payload: frame.payload.toString().slice(0, 4000) }));
    socket.on("framesent", (frame) => record("websocket-frame-sent", { url: socket.url(), payload: frame.payload.toString().slice(0, 4000) }));
  });

  try {
    await gotoWithRetry(page, options.target, 3, record);
    await page.waitForTimeout(Math.min(1500, options.durationMs));
    jsonUrls.add(resultsEndpoint(options.target));
    const deadline = Date.now() + options.durationMs;
    let sampleIndex = 0;
    while (Date.now() < deadline) {
      sampleIndex += 1;
      for (const url of [...jsonUrls]) {
        const result = await page.evaluate(async (endpoint) => {
          try {
            const response = await fetch(endpoint, {
              credentials: "include",
              headers: { accept: "application/json, text/plain, */*", "x-requested-with": "XMLHttpRequest" }
            });
            return { status: response.status, body: await response.json().catch(() => undefined) };
          } catch (error) {
            return { status: 0, error: error instanceof Error ? error.message : String(error) };
          }
        }, url);
        if (result.body !== undefined) {
          const semantic = summarizeIfscPayload(result.body);
          const changes = diffSemanticSamples(previousByUrl.get(url), semantic);
          previousByUrl.set(url, semantic);
          record("semantic-sample", { sampleIndex, url, status: result.status, changes, semantic });
        } else {
          record("semantic-sample-error", { sampleIndex, url, status: result.status, error: result.error });
        }
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) await page.waitForTimeout(Math.min(options.pollMs, remaining));
    }
  } finally {
    await browser.close();
  }

  const filename = join(options.outDir, `ifsc-${Date.now()}.json`);
  await writeFile(filename, JSON.stringify({ options, captures }, null, 2));
  console.log(`Wrote ${filename}`);
  return filename;
}

function positiveInteger(value: string, flag: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer.`);
  return parsed;
}

function resultsEndpoint(roundUrl: string) {
  const url = new URL(roundUrl);
  const categoryRoundId = url.pathname.match(/\/cr\/(\d+)/)?.[1];
  if (!categoryRoundId) throw new Error(`Unsupported IFSC round URL: ${roundUrl}`);
  return `${url.origin}/api/v1/category_rounds/${categoryRoundId}/results`;
}

function isRelevantJsonUrl(url: string) {
  return /^https:\/\/ifsc\.results\.info\/api\/v1\/(?:category_rounds|events|routes)\//.test(url);
}

function redactHeaders(headers: Record<string, string>) {
  const sensitive = new Set(["authorization", "cookie", "set-cookie", "x-csrf-token"]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !sensitive.has(name.toLowerCase())));
}

function unwrapRoundPayload(payload: unknown): Record<string, unknown> {
  const root = asRecord(payload);
  if (Array.isArray(root.ranking) || Array.isArray(root.startlist)) return root;
  for (const key of ["data", "category_round", "categoryRound", "result", "round"]) {
    const nested = asRecord(root[key]);
    if (Object.keys(nested).length > 0) return nested;
  }
  return root;
}

function findRankingRows(root: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(root.ranking)) return root.ranking.map(asRecord);
  const candidates: Record<string, unknown>[][] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      const rows = value.map(asRecord).filter((row) => row.athlete_id !== undefined || row.athleteId !== undefined || nestedRecord(row.athlete).id !== undefined);
      if (rows.length > 0) candidates.push(rows);
      value.forEach(visit);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(visit);
    }
  };
  visit(root);
  return candidates.sort((left, right) => right.length - left.length)[0] ?? [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nestedRecord(value: unknown) {
  return asRecord(value);
}

async function gotoWithRetry(
  page: { goto: (url: string, options: { waitUntil: "domcontentloaded"; timeout: number }) => Promise<unknown>; waitForTimeout: (ms: number) => Promise<void> },
  url: string,
  attempts: number,
  record: (kind: string, payload: unknown) => void
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      return;
    } catch (error) {
      lastError = error;
      record("navigation-error", { attempt, message: error instanceof Error ? error.message : String(error) });
      await page.waitForTimeout(1500 * attempt);
    }
  }
  throw lastError;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  await runProbe(parseProbeArgs(process.argv.slice(2)));
}
