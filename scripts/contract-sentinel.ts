/**
 * 上游契约哨兵（contract sentinel）
 *
 * ifsc.results.info 是无文档内部接口，改版不通知，而
 * server/src/adapters/IfscAdapter.ts 强依赖它的 REST 结构。
 * 本脚本每天拉一个"冻结基准轮次"（已结束赛事，结构不再变化），
 * 递归提取结构指纹（字段路径 + 类型，只看结构不看值），与
 * scripts/contract-baseline.json 比对：
 *   - 缺失字段 / 类型变化 → FAIL（exit 1，打印逐字段 diff）
 *   - 新增字段            → WARN（不 fail）
 *
 * 用法：
 *   npx tsx scripts/contract-sentinel.ts                    # 核查
 *   npx tsx scripts/contract-sentinel.ts --update-baseline  # 重新生成基线
 *
 * 会话逻辑镜像 IfscAdapter.ts 中 IfscRestRoundSource 的实现
 * （initializeSession / apiHeaders / captureCookies / browserUserAgent），
 * 那些方法是私有的且本脚本不改现有代码，故在此复刻。若 Adapter 的
 * 会话流程变了，这里需要同步。
 *
 * TODO(v2) 赛事日增强：先拉 /api/v1/events 判断当天是否有进行中赛事，
 * 有则对该 live 轮次的 results endpoint 同样跑一次指纹核查
 * （live 轮次允许出现基线没有的字段，仍只对缺失/类型变化报 FAIL）。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 冻结基准：event 1515 的 category_round 10704（已结束，结构稳定）。
const ROUND_URL = "https://ifsc.results.info/event/1515/cr/10704";
const ORIGIN = "https://ifsc.results.info";
const ENDPOINT = `${ORIGIN}/api/v1/category_rounds/10704/results`;
const BASELINE_PATH = join(dirname(fileURLToPath(import.meta.url)), "contract-baseline.json");

type Fingerprint = Record<string, string>;

interface Baseline {
  endpoint: string;
  generatedAt: string;
  fields: Fingerprint;
}

// ---- 会话（镜像 IfscRestRoundSource） ----

class IfscSession {
  private cookieHeader = process.env.IFSC_COOKIE ?? "";
  private csrfToken = "";

  async fetchRoundPayload(): Promise<unknown> {
    if (!this.cookieHeader) await this.initializeSession();
    let response = await fetch(ENDPOINT, { headers: this.apiHeaders() });
    if (response.status === 401) {
      this.cookieHeader = "";
      this.csrfToken = "";
      await this.initializeSession();
      response = await fetch(ENDPOINT, { headers: this.apiHeaders() });
    }
    if (!response.ok) throw new Error(`IFSC request failed ${response.status}: ${ENDPOINT}`);
    return response.json();
  }

  private async initializeSession() {
    const page = await fetch(ROUND_URL, { headers: this.pageHeaders() });
    this.captureCookies(page);
    const html = await page.text().catch(() => "");
    this.csrfToken = extractCsrfToken(html);

    const entrypoint = await fetch(`${ORIGIN}/entrypoint`, { headers: this.apiHeaders() });
    this.captureCookies(entrypoint);

    const info = await fetch(`${ORIGIN}/api/v1/info`, { headers: this.apiHeaders() });
    this.captureCookies(info);
  }

  private pageHeaders(): Record<string, string> {
    return {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      "user-agent": browserUserAgent()
    };
  }

  private apiHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      accept: "application/json, text/plain, */*",
      "accept-language": "en-US,en;q=0.9",
      referer: ROUND_URL,
      "user-agent": browserUserAgent(),
      "x-requested-with": "XMLHttpRequest"
    };
    if (this.cookieHeader) headers.cookie = this.cookieHeader;
    if (this.csrfToken) headers["x-csrf-token"] = this.csrfToken;
    return headers;
  }

  private captureCookies(response: Response) {
    const cookies = getSetCookies(response.headers);
    if (cookies.length === 0) return;
    const jar = new Map(this.cookieHeader.split(";").map((cookie) => cookie.trim()).filter(Boolean).map((cookie) => {
      const [name, ...value] = cookie.split("=");
      return [name, value.join("=")] as const;
    }));
    for (const cookie of cookies) {
      const [pair] = cookie.split(";");
      const [name, ...value] = pair.split("=");
      if (name && value.length > 0) jar.set(name.trim(), value.join("=").trim());
    }
    this.cookieHeader = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

function browserUserAgent() {
  return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
}

function getSetCookies(headers: Headers) {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  const values = withGetSetCookie.getSetCookie?.();
  if (values && values.length > 0) return values;
  const combined = headers.get("set-cookie");
  return combined ? splitSetCookie(combined) : [];
}

function splitSetCookie(value: string) {
  return value.split(/,(?=\s*[^;,\s]+=)/g).map((cookie) => cookie.trim()).filter(Boolean);
}

function extractCsrfToken(html: string) {
  return html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? "";
}

// ---- 结构指纹 ----

/**
 * 递归提取所有字段路径 + 类型；数组只取首元素，路径记为 `field[]`。
 * 例：ranking[].ascents[].top_tries -> "number"。只看结构，不看值。
 */
function extractFingerprint(value: unknown, path = "", out: Fingerprint = {}): Fingerprint {
  if (Array.isArray(value)) {
    if (path) out[path] = "array";
    if (value.length > 0) extractFingerprint(value[0], `${path}[]`, out);
    return out;
  }
  if (value === null) {
    if (path) out[path] = "null";
    return out;
  }
  if (typeof value === "object") {
    if (path) out[path] = "object";
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      extractFingerprint(child, path ? `${path}.${key}` : key, out);
    }
    return out;
  }
  if (path) out[path] = typeof value;
  return out;
}

function sortedFingerprint(fingerprint: Fingerprint): Fingerprint {
  return Object.fromEntries(Object.entries(fingerprint).sort(([a], [b]) => a.localeCompare(b)));
}

// ---- 比对 ----

interface Diff {
  missing: { path: string; baselineType: string }[];
  changed: { path: string; baselineType: string; currentType: string }[];
  added: { path: string; currentType: string }[];
}

function diffFingerprints(baseline: Fingerprint, current: Fingerprint): Diff {
  const diff: Diff = { missing: [], changed: [], added: [] };
  for (const [path, baselineType] of Object.entries(baseline)) {
    const currentType = current[path];
    if (currentType === undefined) diff.missing.push({ path, baselineType });
    else if (currentType !== baselineType) diff.changed.push({ path, baselineType, currentType });
  }
  for (const [path, currentType] of Object.entries(current)) {
    if (!(path in baseline)) diff.added.push({ path, currentType });
  }
  return diff;
}

// ---- 主流程 ----

async function fetchPayloadWithRetry(): Promise<unknown> {
  // 网络失败重试 1 次再报错，防偶发抖动误报。
  try {
    return await new IfscSession().fetchRoundPayload();
  } catch (error) {
    console.warn(`First attempt failed (${error instanceof Error ? error.message : String(error)}), retrying in 5s...`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    return new IfscSession().fetchRoundPayload();
  }
}

async function main() {
  const updateBaseline = process.argv.includes("--update-baseline");

  console.log(`Fetching frozen baseline round: ${ENDPOINT}`);
  const payload = await fetchPayloadWithRetry();
  const current = sortedFingerprint(extractFingerprint(payload));
  console.log(`Extracted ${Object.keys(current).length} field paths.`);

  if (updateBaseline) {
    const baseline: Baseline = {
      endpoint: ENDPOINT,
      generatedAt: new Date().toISOString(),
      fields: current
    };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`Baseline written to ${BASELINE_PATH}`);
    return;
  }

  const baseline = loadBaseline();
  const diff = diffFingerprints(baseline.fields, current);

  for (const entry of diff.added) {
    console.warn(`WARN  new field       ${entry.path}: ${entry.currentType}`);
  }
  for (const entry of diff.missing) {
    console.error(`FAIL  missing field   ${entry.path} (baseline: ${entry.baselineType})`);
  }
  for (const entry of diff.changed) {
    console.error(`FAIL  type changed    ${entry.path}: ${entry.baselineType} -> ${entry.currentType}`);
  }

  const failures = diff.missing.length + diff.changed.length;
  if (failures > 0) {
    console.error(`\nContract check FAILED: ${diff.missing.length} missing, ${diff.changed.length} type-changed (baseline ${baseline.generatedAt}).`);
    console.error("The upstream IFSC REST structure has changed — review server/src/adapters/IfscAdapter.ts.");
    process.exit(1);
  }
  const warnSuffix = diff.added.length > 0 ? ` (${diff.added.length} new fields, warn only)` : "";
  console.log(`Contract check PASSED: ${Object.keys(baseline.fields).length} baseline fields intact${warnSuffix}.`);
}

function loadBaseline(): Baseline {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    console.error(`Cannot read baseline at ${BASELINE_PATH}. Run with --update-baseline first.`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`Contract sentinel errored: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
