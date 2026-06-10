import { fixtureSnapshots } from "../fixtures/roundSnapshots.js";
import type { Appeal, Athlete, BoulderResult, CompetitionSnapshot, LeadGender, LeadRoundType, LeadStatus, StartlistEntry } from "../types/domain.js";
import type { Browser, Page } from "playwright";

const DEFAULT_IFSC_ROUND_URL = "https://ifsc.results.info/event/1515/cr/10704";
const OLD_DEFAULT_IFSC_ROUND_URLS = new Set([
  "https://ifsc.results.info/event/1480/cr/10677"
]);

export interface RoundSource {
  nextSnapshot(): Promise<CompetitionSnapshot>;
  sourceName(): "fixture" | "ifsc-network";
  refreshMs(): number;
}

export class FixtureRoundSource implements RoundSource {
  private index = 0;

  async nextSnapshot(): Promise<CompetitionSnapshot> {
    const snapshot = fixtureSnapshots[this.index % fixtureSnapshots.length];
    this.index += 1;
    return {
      ...snapshot,
      receivedAt: new Date().toISOString()
    };
  }

  sourceName(): "fixture" {
    return "fixture";
  }

  refreshMs(): number {
    return 2_000;
  }
}

interface IfscRoutePosition {
  route_name: string;
  route_id: number;
  position: number;
}

interface IfscStartlistEntry {
  athlete_id: number;
  name: string;
  firstname?: string;
  lastname?: string;
  bib?: string;
  country: string;
  route_start_positions?: IfscRoutePosition[];
}

interface IfscAscent {
  route_id: number;
  route_name: string;
  top: boolean;
  top_tries?: number | null;
  zone: boolean;
  zone_tries?: number | null;
  points?: number | null;
  modified?: string | null;
  status?: string | null;
}

interface IfscRankingEntry {
  athlete_id: number;
  name: string;
  firstname?: string;
  lastname?: string;
  country: string;
  bib?: string;
  status?: string | null;
  rank?: number | string | null;
  score?: number | string | null;
  start_order?: number | string | null;
  group_rank?: number | string | null;
  starting_group?: string | null;
  ascents?: IfscAscent[];
  active?: boolean;
  under_appeal?: boolean;
  lead_score_text?: string;
}

interface IfscRoundPayload {
  id: number;
  event: string;
  event_id: number;
  status: string;
  status_as_of?: string;
  category: string;
  round: string;
  format_identifier?: string;
  ranking?: IfscRankingEntry[];
  startlist?: IfscStartlistEntry[];
}

interface IfscEventRouteMeta {
  id: number;
  name: string;
  startlist?: unknown;
  ranking?: unknown;
  [key: string]: unknown;
}

interface IfscEventRoundMeta {
  category_round_id?: number;
  id?: number;
  kind?: string;
  format_identifier?: string;
  routes?: IfscEventRouteMeta[];
}

interface LeadRouteResult {
  athleteId: number;
  scoreText?: string;
  rank?: number;
  status?: string;
}

export class IfscRestRoundSource implements RoundSource {
  private readonly endpoint: string;
  private readonly origin: string;
  private readonly roundUrl: string;
  private readonly eventId: string;
  private readonly categoryRoundId: string;
  private cookieHeader = process.env.IFSC_COOKIE ?? "";
  private csrfToken = "";
  private routeStartlistCache?: IfscStartlistEntry[];
  private routeRankingCache?: Map<string, LeadRouteResult>;

  constructor(roundUrl: string) {
    const parsed = parseRoundUrl(roundUrl);
    this.origin = parsed.origin;
    this.roundUrl = roundUrl;
    this.eventId = parsed.eventId;
    this.categoryRoundId = parsed.categoryRoundId;
    this.endpoint = `${parsed.origin}/api/v1/category_rounds/${parsed.categoryRoundId}/results`;
  }

  async nextSnapshot(): Promise<CompetitionSnapshot> {
    if (!this.cookieHeader) await this.initializeSession();
    let response = await fetch(this.endpoint, { headers: this.apiHeaders() });
    if (response.status === 401) {
      this.cookieHeader = "";
      this.csrfToken = "";
      await this.initializeSession();
      response = await fetch(this.endpoint, { headers: this.apiHeaders() });
    }
    if (!response.ok) throw new Error(`IFSC request failed ${response.status}: ${this.endpoint}`);
    const payload = unwrapIfscPayload(await response.json());
    return normalizeIfscPayload(await this.enrichLeadStartlist(payload), this.endpoint);
  }

  sourceName(): "ifsc-network" {
    return "ifsc-network";
  }

  refreshMs(): number {
    return 2_000;
  }

  private async initializeSession() {
    const page = await fetch(this.roundUrl, { headers: this.pageHeaders() });
    this.captureCookies(page);
    const html = await page.text().catch(() => "");
    this.csrfToken = extractCsrfToken(html);

    const entrypoint = await fetch(`${this.origin}/entrypoint`, { headers: this.apiHeaders() });
    this.captureCookies(entrypoint);

    const info = await fetch(`${this.origin}/api/v1/info`, { headers: this.apiHeaders() });
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
      referer: this.roundUrl,
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

  private async enrichLeadStartlist(payload: IfscRoundPayload): Promise<IfscRoundPayload> {
    if (disciplineFromPayload(payload) !== "lead") return payload;
    const { startlist, ranking } = await this.fetchLeadRouteData().catch(() => ({ startlist: [], ranking: new Map<string, LeadRouteResult>() }));
    const routeStartlist = startlist.length > 0 ? startlist : this.routeStartlistCache ?? [];
    const routeRanking = ranking.size > 0 ? ranking : this.routeRankingCache ?? new Map<string, LeadRouteResult>();
    if (startlist.length > 0) this.routeStartlistCache = startlist;
    if (ranking.size > 0) this.routeRankingCache = ranking;
    if (routeStartlist.length === 0 && routeRanking.size === 0) return payload;
    return {
      ...payload,
      startlist: mergeStartlists(payload.startlist ?? [], routeStartlist),
      ranking: mergeLeadRanking(payload.ranking ?? [], routeRanking, routeStartlist)
    };
  }

  private async fetchLeadRouteData(): Promise<{ startlist: IfscStartlistEntry[]; ranking: Map<string, LeadRouteResult> }> {
    const eventResponse = await fetch(`${this.origin}/api/v1/events/${this.eventId}`, { headers: this.apiHeaders() });
    this.captureCookies(eventResponse);
    if (!eventResponse.ok) return { startlist: [], ranking: new Map() };
    const eventPayload = await eventResponse.json();
    const round = findEventRoundMeta(eventPayload, this.categoryRoundId);
    const routes = round?.routes ?? [];
    const entries: IfscStartlistEntry[] = [];
    const rankings = new Map<string, LeadRouteResult>();
    for (const route of routes) {
      for (const url of routeUrls(route, "startlist", this.origin)) {
        const response = await fetch(url, { headers: this.apiHeaders() });
        this.captureCookies(response);
        if (response.ok) entries.push(...routeStartlistEntriesFromPayload(await response.json(), route));
      }
      for (const url of routeUrls(route, "ranking", this.origin)) {
        const response = await fetch(url, { headers: this.apiHeaders() });
        this.captureCookies(response);
        if (response.ok) {
          for (const result of leadRouteResultsFromPayload(await response.json())) {
            rankings.set(String(result.athleteId), result);
          }
        }
      }
    }
    return { startlist: mergeStartlists([], entries), ranking: rankings };
  }
}

export class IfscBrowserRoundSource implements RoundSource {
  private readonly endpoint: string;
  private readonly roundUrl: string;
  private browser?: Browser;
  private page?: Page;

  constructor(roundUrl: string) {
    const parsed = parseRoundUrl(roundUrl);
    this.roundUrl = roundUrl;
    this.endpoint = `${parsed.origin}/api/v1/category_rounds/${parsed.categoryRoundId}/results`;
  }

  async nextSnapshot(): Promise<CompetitionSnapshot> {
    const page = await this.ensurePage();
    const payload = await page.evaluate(async (url) => {
      const response = await fetch(url, {
        credentials: "include",
        headers: {
          accept: "application/json, text/plain, */*",
          "x-requested-with": "XMLHttpRequest"
        }
      });
      if (!response.ok) throw new Error(`Browser IFSC request failed ${response.status}: ${url}`);
      return response.json();
    }, this.endpoint) as IfscRoundPayload;
    return normalizeIfscPayload(unwrapIfscPayload(payload), this.endpoint);
  }

  sourceName(): "ifsc-network" {
    return "ifsc-network";
  }

  refreshMs(): number {
    return 2_000;
  }

  private async ensurePage() {
    if (this.page) return this.page;
    const { chromium } = await import("playwright");
    this.browser = await chromium.launch({ headless: true });
    const context = await this.browser.newContext({
      userAgent: browserUserAgent(),
      extraHTTPHeaders: {
        "accept-language": "en-US,en;q=0.9"
      }
    });
    const page = await context.newPage();
    this.page = page;
    await gotoWithRetry(page, this.roundUrl, 3);
    await page.waitForTimeout(1_500);
    return page;
  }
}

export class IfscAdapter {
  constructor(private readonly source: RoundSource = new FixtureRoundSource()) {}

  async fetchSnapshot(): Promise<CompetitionSnapshot> {
    return this.source.nextSnapshot();
  }

  sourceName() {
    return this.source.sourceName();
  }

  refreshMs() {
    return this.source.refreshMs();
  }
}

export function createRoundSourceFromEnv(): RoundSource {
  if (process.env.COMP_SOURCE === "demo-lead-semifinal") {
    return new DemoLeadRoundSource("Semi-final");
  }
  if (process.env.COMP_SOURCE === "demo-lead-final") {
    return new DemoLeadRoundSource("Final");
  }
  if (process.env.COMP_SOURCE === "demo-qualification") {
    return new DemoQualificationRoundSource();
  }
  if (process.env.COMP_SOURCE === "demo-semifinal") {
    return new DemoSingleGroupRoundSource("Semi-final", 24, [1, 3, 5, 7]);
  }
  if (process.env.COMP_SOURCE === "demo-final") {
    return new DemoSingleGroupRoundSource("Final", 8, [1, 5]);
  }
  if (process.env.COMP_SOURCE === "ifsc-browser") {
    return new IfscBrowserRoundSource(defaultIfscRoundUrl());
  }
  if (process.env.COMP_SOURCE === "ifsc" || process.env.IFSC_ROUND_URL) {
    return new IfscRestRoundSource(defaultIfscRoundUrl());
  }
  return new IfscRestRoundSource(DEFAULT_IFSC_ROUND_URL);
}

export function createRoundSourceFromUrl(roundUrl: string): RoundSource {
  if (roundUrl === "demo:lead-semifinal") return new DemoLeadRoundSource("Semi-final");
  if (roundUrl === "demo:lead-final") return new DemoLeadRoundSource("Final");
  return new IfscRestRoundSource(roundUrl);
}

function defaultIfscRoundUrl() {
  const configured = process.env.IFSC_ROUND_URL?.trim();
  if (!configured || OLD_DEFAULT_IFSC_ROUND_URLS.has(configured)) return DEFAULT_IFSC_ROUND_URL;
  return configured;
}

export class DemoQualificationRoundSource implements RoundSource {
  private tick = 0;

  async nextSnapshot(): Promise<CompetitionSnapshot> {
    this.tick += 1;
    const now = new Date().toISOString();
    const appealAccepted = this.tick % 2 === 0;
    const activeNames = [
      ["qa01", "Oriane BERTONE", "FRA", "Group A", 1, 3, 2, true, false],
      ["qa02", "Mao NAKAMURA", "JPN", "Group A", 2, 4, 1, true, true],
      ["qa03", "Oceania MACKENZIE", "AUS", "Group A", 3, 5, 3, true, appealAccepted],
      ["qb01", "Erin MCNEICE", "GBR", "Group B", 1, 3, 1, true, false],
      ["qb02", "Ayala KEREM", "ISR", "Group B", 2, 4, 1, true, true],
      ["qb03", "Yuetong ZHANG", "CHN", "Group B", 3, 5, 2, true, false]
    ] as const;
    const nextNames = [
      ...demoQualificationEntries("qa", "Group A").filter((entry) => Number(entry[4]) > 3),
      ...demoQualificationEntries("qb", "Group B").filter((entry) => Number(entry[4]) > 3)
    ] as const;

    const activeResults = activeNames.map(([id, name, country, group, order, boulder, attempt, zone, top]) => {
      const boulders = demoBoulders(boulder, attempt, zone, top);
      if (id === "qa01") markExpired(boulders, 2);
      if (id === "qb01") markExpired(boulders, 1);
      return {
        athlete: demoAthlete(id, name, country, order),
        rank: 999,
        groupRank: 999,
        startingGroup: group,
        currentBoulder: boulder,
        score: scoreBoulders(boulders),
        boulders,
        sourceStatus: "active"
      };
    });
    const waitingResults = nextNames.map(([id, name, country, group, order, boulder]) => ({
      athlete: demoAthlete(id, name, country, order),
      rank: 999,
      groupRank: 999,
      startingGroup: group,
      nextBoulder: boulder,
      score: 0,
      boulders: emptyDemoBoulders(),
      sourceStatus: "waiting"
    }));
    assignDemoRanks([...activeResults, ...waitingResults]);

    return {
      sourceTimestamp: now,
      receivedAt: now,
      eventId: "demo",
      categoryRoundId: "demo-qualification",
      eventName: "Demo IFSC Boulder Qualification",
      roundName: "Women Qualification",
      formatIdentifier: "boulder_two_groups_ifsc_2026",
      athletes: [...activeResults, ...waitingResults],
      ranking: [...activeResults, ...waitingResults].map((result) => ({ athleteId: result.athlete.id, rank: result.rank, score: result.score })),
      startlist: [...activeResults, ...waitingResults].map((result, index) => ({ athleteId: result.athlete.id, order: index + 1 })),
      appeals: [{
        athleteId: "qa03",
        status: appealAccepted ? "Accepted" : "Under Appeal",
        boulderNo: 3,
        sourceText: appealAccepted ? "Appeal Accepted" : "Under Appeal",
        confidence: { value: 96, reason: "Demo appeal state.", source: "official" }
      }],
      rawRef: "demo://qualification-active"
    };
  }

  sourceName(): "fixture" {
    return "fixture";
  }

  refreshMs(): number {
    return 2_000;
  }
}

export class DemoSingleGroupRoundSource implements RoundSource {
  constructor(private readonly roundName: "Semi-final" | "Final", private readonly fieldSize: number, private readonly activeOrders: number[]) {}

  async nextSnapshot(): Promise<CompetitionSnapshot> {
    const now = new Date().toISOString();
    const names = [
      "Erin MCNEICE", "Oriane BERTONE", "Mao NAKAMURA", "Miho NONAKA", "Melody SEKIKAWA", "Oceania MACKENZIE", "Annie SANDERS", "Ayala KEREM",
      "Camilla MORONI", "Chaehyun SEO", "Futaba ITO", "Zelia AVEZOU", "Yuetong ZHANG", "Stella GIACANI", "Geila MACIA", "Lucile SAUREL",
      "Madison RICHARDSON", "Nekaia SANDERS", "Anon MATSUFUJI", "Jennifer BUCKLEY", "Chloe CAULIER", "Emma EDWARDS", "Melina COSTANZA", "Giorgia TESIO", "Selma ELHADJ"
    ].slice(0, this.fieldSize);
    const countries = ["GBR", "FRA", "JPN", "JPN", "JPN", "AUS", "USA", "ISR", "ITA", "KOR", "JPN", "FRA", "CHN", "ITA", "ESP", "FRA", "GBR", "USA", "JPN", "SLO", "FRA", "GBR", "ITA", "ITA", "FRA"];
    const activeSet = new Set(this.activeOrders);

    const results = names.map((name, index) => {
      const startOrder = index + 1;
      const isActive = activeSet.has(startOrder);
      const activeIndex = this.activeOrders.indexOf(startOrder);
      const nextBoulder = isActive ? activeIndex + 1 : undefined;
      const waitingNextBoulder = !isActive ? this.expectedWaitingBoulder(startOrder) : undefined;
      const boulders = isActive ? demoBouldersForCount(4, nextBoulder ?? 1, 1 + activeIndex, activeIndex % 2 === 0, false) : emptyDemoBoulders(4);
      if (isActive && activeIndex === this.activeOrders.length - 1) markExpired(boulders, nextBoulder ?? 1);
      return {
        athlete: demoAthlete(`sg${startOrder}`, name, countries[index], startOrder),
        rank: 999,
        score: isActive || startOrder < Math.min(...this.activeOrders) ? scoreBoulders(boulders) : 0,
        nextBoulder: nextBoulder ?? waitingNextBoulder,
        currentBoulder: nextBoulder,
        boulders,
        sourceStatus: isActive ? "active" : "waiting"
      };
    });
    assignDemoRanks(results);

    return {
      sourceTimestamp: now,
      receivedAt: now,
      eventId: "demo",
      categoryRoundId: `demo-${this.roundName.toLowerCase()}`,
      eventName: `Demo IFSC Boulder ${this.roundName}`,
      roundName: `Women ${this.roundName}`,
      formatIdentifier: this.roundName === "Final" ? "boulder_finals_ifsc_2026" : "boulder_one_group_ifsc_2026",
      athletes: results,
      ranking: results.map((result) => ({ athleteId: result.athlete.id, rank: result.rank, score: result.score })),
      startlist: results.map((result) => ({ athleteId: result.athlete.id, order: result.athlete.startOrder })),
      appeals: [],
      rawRef: `demo://${this.roundName.toLowerCase()}-active`
    };
  }

  sourceName(): "fixture" {
    return "fixture";
  }

  refreshMs(): number {
    return 2_000;
  }

  private expectedWaitingBoulder(startOrder: number) {
    if (this.roundName === "Semi-final") {
      const index = [9, 11, 13, 15].indexOf(startOrder);
      return index >= 0 ? index + 1 : undefined;
    }
    const index = [2, 6].indexOf(startOrder);
    return index >= 0 ? index + 1 : undefined;
  }
}

export class DemoLeadRoundSource implements RoundSource {
  constructor(private readonly roundType: LeadRoundType) {}

  async nextSnapshot(): Promise<CompetitionSnapshot> {
    const now = new Date().toISOString();
    const fieldSize = this.roundType === "Final" ? 8 : 24;
    const leadResults = demoLeadResults("Women", fieldSize, this.roundType === "Final" ? 3 : 8);
    const athletes = leadResults.map((result) => ({
      athlete: result.athlete,
      rank: result.rank,
      score: leadScore(result.hold, result.plus),
      boulders: [],
      sourceStatus: result.status === "climbing" ? "active" : result.status
    }));

    return {
      sourceTimestamp: now,
      receivedAt: now,
      eventId: "demo",
      categoryRoundId: `demo-lead-${this.roundType.toLowerCase()}`,
      eventName: `Demo IFSC Lead ${this.roundType}`,
      roundName: `Lead ${this.roundType}`,
      roundStatus: "live",
      discipline: "lead",
      formatIdentifier: this.roundType === "Final" ? "lead_finals_ifsc_2026" : "lead_semifinals_ifsc_2026",
      lead: {
        roundType: this.roundType,
        routeTop: 50,
        genders: [{ gender: "Women", athletes: leadResults }]
      },
      athletes,
      ranking: athletes.map((result) => ({ athleteId: result.athlete.id, rank: result.rank, score: result.score })),
      startlist: athletes.map((result) => ({ athleteId: result.athlete.id, order: result.athlete.startOrder })),
      appeals: [{
        athleteId: leadResults.find((result) => result.status === "fall")?.athlete.id ?? leadResults[0].athlete.id,
        status: "Under Appeal",
        sourceText: "Demo lead score under appeal",
        confidence: { value: 96, reason: "Demo lead appeal.", source: "official" }
      }],
      rawRef: `demo://lead-${this.roundType.toLowerCase()}`
    };
  }

  sourceName(): "fixture" {
    return "fixture";
  }

  refreshMs(): number {
    return 2_000;
  }
}

function demoAthlete(id: string, name: string, country: string, startOrder: number): Athlete {
  return { id, name, country, countryCode: iso3ToIso2(country), bib: startOrder, startOrder };
}

function demoLeadResults(gender: LeadGender, fieldSize: number, activeOrder: number) {
  const routeTop = 50;
  const countries = ["GBR", "FRA", "JPN", "JPN", "JPN", "AUS", "USA", "ISR", "ITA", "KOR", "CHN", "SLO", "ESP", "AUT", "GER", "SUI", "BEL", "CZE", "POL", "CAN", "BRA", "NOR", "SWE", "NZL"];
  const results = Array.from({ length: fieldSize }, (_, index) => {
    const order = index + 1;
    const active = order === activeOrder;
    const dns = order === fieldSize;
    const top = order === 1 && fieldSize === 8;
    const fallScores = [44, 43, 42, 39, 38, 37, 36, 32, 30, 29, 28, 26, 25, 23, 22, 21, 19, 18, 16, 15, 13, 12, 10, 8];
    const hold = dns ? 0 : top ? routeTop : active ? 38 : fallScores[index % fallScores.length];
    const plus = active || index % 4 === 0;
    const status: LeadStatus = dns ? "dns" : active ? "climbing" : top ? "top" : order < activeOrder ? "fall" : "waiting";
    return {
      athlete: demoAthlete(`lead-${gender[0].toLowerCase()}-${order}`, `${gender[0]}. ${demoName(index)}`, countries[index % countries.length], order),
      rank: order,
      hold,
      plus: status === "top" || status === "dns" ? false : plus,
      scoreText: status === "dns" ? "DNS" : status === "waiting" ? "-" : leadScoreText(hold, status === "top" ? false : plus, routeTop),
      status,
      elapsedSeconds: active ? 184 : undefined,
      next: order === activeOrder + 1
    };
  });
  return results
    .sort((a, b) => leadScore(b.hold, b.plus) - leadScore(a.hold, a.plus) || a.athlete.startOrder - b.athlete.startOrder)
    .map((result, index) => ({ ...result, rank: result.status === "dns" ? 0 : result.status === "waiting" ? result.athlete.startOrder : index + 1 }))
    .sort((a, b) => rankSortValue(a.rank) - rankSortValue(b.rank) || a.athlete.startOrder - b.athlete.startOrder);
}

function rankSortValue(rank: number) {
  return rank > 0 ? rank : 9999;
}

function leadScore(hold: number, plus?: boolean) {
  return hold + (plus ? 0.25 : 0);
}

function leadScoreText(hold: number, plus?: boolean, routeTop = 100) {
  if (hold >= routeTop) return "TOP";
  return `${Math.floor(hold)}${plus ? "+" : ""}`;
}

function demoQualificationEntries(prefix: "qa" | "qb", group: "Group A" | "Group B"): [string, string, string, "Group A" | "Group B", number, number][] {
  return Array.from({ length: 40 }, (_, index) => {
    const order = index + 1;
    return [
      `${prefix}${String(order).padStart(2, "0")}`,
      `${prefix === "qa" ? "A" : "B"} CLIMBER${String(order).padStart(2, "0")}`,
      demoCountry(index + (prefix === "qb" ? 40 : 0)),
      group,
      order,
      ((order - 1) % 5) + 1
    ];
  });
}

function demoName(index: number) {
  const names = [
    "Jennifer BUCKLEY", "Futaba ITO", "Chaehyun SEO", "Stella GIACANI", "Geila MACIA", "Zelia AVEZOU", "Anon MATSUFUJI", "Madison RICHARDSON",
    "Lucile SAUREL", "Nekaia SANDERS", "Melody SEKIKAWA", "Camilla MORONI", "Miho NONAKA", "Annie SANDERS", "Ayala KEREM", "Yuetong ZHANG",
    "Erin MCNEICE", "Oriane BERTONE", "Mao NAKAMURA", "Oceania MACKENZIE", "Chloe CAULIER", "Emma EDWARDS", "Melina COSTANZA", "Giorgia TESIO",
    "Selma ELHADJ", "Molly THOMPSON-SMITH", "Natalia GROSSMAN", "Brooke RABOUTOU", "Seo CHAEHYUN", "Laura ROGORA", "Janja GARNBRET", "Jessica PILZ",
    "Mia KRAMPL", "Margo HAYES", "Luo ZHILU", "Ai MORI", "Ievgeniia KAZBEKOVA", "Hannah MEUL", "Lena DRAPER", "Elnaz REKABI"
  ];
  return names[index % names.length];
}

function demoCountry(index: number) {
  const countries = ["SLO", "JPN", "KOR", "ITA", "ESP", "FRA", "JPN", "GBR", "FRA", "USA", "JPN", "ITA", "JPN", "USA", "ISR", "CHN", "GBR", "FRA", "JPN", "AUS"];
  return countries[index % countries.length];
}

function demoBoulders(current: number, attempt: number, zone: boolean, top: boolean): BoulderResult[] {
  return demoBouldersForCount(5, current, attempt, zone, top);
}

function demoBouldersForCount(count: number, current: number, attempt: number, zone: boolean, top: boolean): BoulderResult[] {
  return Array.from({ length: count }, (_, index) => index + 1).map((boulderNo) => ({
    boulderNo,
    attemptsToZone: boulderNo === current ? attempt : boulderNo < current ? 1 : undefined,
    attemptsToTop: boulderNo < current ? 1 : top ? attempt : undefined,
    hasZone: boulderNo < current || (boulderNo === current && zone),
    hasTop: boulderNo < current || (boulderNo === current && top),
    rawStatus: boulderNo === current ? `A${attempt}` : boulderNo < current ? "confirmed" : ""
  }));
}

function markExpired(boulders: BoulderResult[], boulderNo: number) {
  const boulder = boulders.find((item) => item.boulderNo === boulderNo);
  if (!boulder) return;
  boulder.hasZone = false;
  boulder.hasTop = false;
  boulder.attemptsToZone = undefined;
  boulder.attemptsToTop = undefined;
  boulder.rawStatus = "expired";
}

function scoreBoulders(boulders: BoulderResult[]) {
  return Number(boulders.reduce((total, boulder) => {
    if (boulder.hasTop) return total + 25 - 0.1 * Math.max(0, (boulder.attemptsToTop ?? 1) - 1);
    if (boulder.hasZone) return total + 10 - 0.1 * Math.max(0, (boulder.attemptsToZone ?? 1) - 1);
    return total;
  }, 0).toFixed(1));
}

function assignDemoRanks<T extends { score: number; rank: number; groupRank?: number; startingGroup?: string; athlete: Athlete }>(results: T[]) {
  const groups = [...new Set(results.map((result) => result.startingGroup ?? "All"))];
  for (const group of groups) {
    const sorted = results
      .filter((result) => (result.startingGroup ?? "All") === group)
      .sort((a, b) => b.score - a.score || a.athlete.startOrder - b.athlete.startOrder);
    sorted.forEach((result, index) => {
      result.rank = index + 1;
      if (result.startingGroup) result.groupRank = index + 1;
    });
  }
}

function emptyDemoBoulders(count = 5): BoulderResult[] {
  return Array.from({ length: count }, (_, index) => index + 1).map((boulderNo) => ({ boulderNo, hasZone: false, hasTop: false, rawStatus: "" }));
}

function parseRoundUrl(roundUrl: string) {
  const url = new URL(roundUrl);
  const match = url.pathname.match(/\/event\/(\d+)\/cr\/(\d+)/);
  if (!match) throw new Error(`Unsupported IFSC round URL: ${roundUrl}`);
  return { origin: url.origin, eventId: match[1], categoryRoundId: match[2] };
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

async function gotoWithRetry(page: { goto: (url: string, options: { waitUntil: "domcontentloaded"; timeout: number }) => Promise<unknown>; waitForTimeout: (ms: number) => Promise<void> }, url: string, attempts: number) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(1_500 * attempt);
    }
  }
  throw lastError;
}

export function normalizeIfscPayload(payload: IfscRoundPayload, endpoint: string): CompetitionSnapshot {
  const receivedAt = new Date().toISOString();
  const ranking = payload.ranking ?? [];
  const startlist = payload.startlist ?? [];
  const startlistAthletes = new Map(startlist.map((entry) => [String(entry.athlete_id), toAthlete(entry, startOrderFromStartlist(entry))]));
  const rankingAthletes = ranking.map((entry) => toAthlete(entry, numberOrFallback(entry.start_order, startlistAthletes.get(String(entry.athlete_id))?.startOrder ?? 999)));
  const athleteIds = new Set([...ranking.map((entry) => String(entry.athlete_id)), ...startlist.map((entry) => String(entry.athlete_id))]);

  const rankingById = new Map(ranking.map((entry) => [String(entry.athlete_id), entry]));
  const athletes = [...athleteIds].map((id) => {
    const ranking = rankingById.get(id);
    const athlete = ranking ? toAthlete(ranking, numberOrFallback(ranking.start_order, startlistAthletes.get(id)?.startOrder ?? 999)) : startlistAthletes.get(id)!;
    const resultStatus = ranking ? rankingStatus(ranking) : undefined;
    const currentBoulder = ranking?.active ? activeBoulderFromAscents(ranking.ascents) : undefined;
    const boulders = ranking?.ascents?.map(toBoulderResult).sort((a, b) => a.boulderNo - b.boulderNo) ?? emptyBouldersFromStartlist(startlist.find((entry) => String(entry.athlete_id) === id));
    return {
      athlete,
      rank: numberOrFallback(ranking?.rank, 999),
      groupRank: ranking?.group_rank === undefined || ranking?.group_rank === null ? undefined : numberOrFallback(ranking.group_rank, 999),
      startingGroup: ranking?.starting_group ?? undefined,
      currentBoulder,
      score: leadScoreNumber(ranking?.lead_score_text ?? ranking?.score),
      leadScoreText: ranking?.lead_score_text ?? (typeof ranking?.score === "string" ? ranking.score : undefined),
      boulders: normalizeBoulderStatuses(boulders, resultStatus, currentBoulder),
      sourceStatus: ranking?.active ? "active" : ranking?.under_appeal ? "under_appeal" : resultStatus
    };
  });

  return {
    sourceTimestamp: toIso(payload.status_as_of) ?? receivedAt,
    receivedAt,
    eventId: String(payload.event_id),
    categoryRoundId: String(payload.id),
    eventName: payload.event ?? "IFSC Boulder Competition",
    roundName: `${payload.category ?? "Category"} ${payload.round ?? "Round"}`,
    roundStatus: payload.status,
    discipline: disciplineFromPayload(payload),
    formatIdentifier: payload.format_identifier,
    lead: disciplineFromPayload(payload) === "lead" ? leadDataFromPayload(payload, athletes) : undefined,
    athletes,
    ranking: ranking.map((entry) => ({
      athleteId: String(entry.athlete_id),
      rank: numberOrFallback(entry.rank, 999),
      score: numberOrFallback(entry.score, 0)
    })),
    startlist: buildStartlist(startlist, rankingAthletes),
    appeals: buildAppeals(ranking),
    rawRef: endpoint
  };
}

function disciplineFromPayload(payload: IfscRoundPayload) {
  const text = `${payload.format_identifier ?? ""} ${payload.category ?? ""} ${payload.round ?? ""}`.toLowerCase();
  return text.includes("lead") ? "lead" : "boulder";
}

function leadDataFromPayload(payload: IfscRoundPayload, athletes: CompetitionSnapshot["athletes"]): CompetitionSnapshot["lead"] {
  const roundText = `${payload.round ?? ""}`.toLowerCase();
  const roundType: LeadRoundType = roundText.includes("final") && !roundText.includes("semi") ? "Final" : "Semi-final";
  const categoryText = `${payload.category ?? ""}`.toLowerCase();
  const gender: LeadGender = categoryText.includes("men") && !categoryText.includes("women") ? "Men" : "Women";
  const leadAthletes = athletes
    .sort((a, b) => a.rank - b.rank || b.score - a.score || a.athlete.startOrder - b.athlete.startOrder)
    .map((result) => {
      const parsedScore = parseLeadScore(result.leadScoreText ?? result.score);
      const hold = parsedScore.hold > 0 ? parsedScore.hold : leadHoldFromBoulders(result.boulders);
      const plus = parsedScore.plus;
      const status: LeadStatus = isDnsStatus(result.sourceStatus) ? "dns" : result.sourceStatus === "active" ? "climbing" : hold >= 100 ? "top" : hold > 0 ? "fall" : "waiting";
      return {
        athlete: result.athlete,
        rank: status === "dns" ? 0 : result.rank,
        hold,
        plus,
        scoreText: status === "dns" ? "DNS" : status === "waiting" ? "-" : leadScoreTextFromParsed(result.leadScoreText, hold, plus),
        status,
        elapsedSeconds: status === "climbing" ? 148 : undefined,
        next: result.sourceStatus === "waiting"
      };
    });
  return {
    roundType,
    genders: [{ gender, athletes: leadAthletes }]
  };
}

function leadScoreNumber(value: number | string | null | undefined) {
  const parsed = parseLeadScore(value ?? 0);
  if (parsed.dns) return 0;
  return parsed.hold + (parsed.plus ? 0.25 : 0);
}

function parseLeadScore(value: number | string) {
  const text = String(value);
  if (/\bDNS\b|did not start/i.test(text)) return { hold: 0, plus: false, dns: true };
  if (/TOP/i.test(text)) return { hold: 100, plus: false, dns: false };
  const hold = Number(text.match(/\d+/)?.[0] ?? 0);
  return { hold: Number.isFinite(hold) ? hold : 0, plus: /\+/.test(text), dns: false };
}

function leadScoreTextFromParsed(raw: string | undefined, hold: number, plus?: boolean) {
  if (raw) {
    if (/\bDNS\b/i.test(raw)) return "DNS";
    if (/TOP/i.test(raw)) return "TOP";
    const match = raw.match(/\d+\+?/);
    if (match) return match[0];
  }
  return leadScoreText(hold, plus);
}

function leadHoldFromBoulders(boulders: BoulderResult[]) {
  return Math.max(0, ...boulders.map((boulder) => Number(boulder.rawStatus?.match(/\d+(?:\.\d+)?/)?.[0] ?? 0)));
}

function findEventRoundMeta(value: unknown, categoryRoundId: string): IfscEventRoundMeta | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as IfscEventRoundMeta & Record<string, unknown>;
  const id = record.category_round_id ?? record.id;
  if (String(id) === categoryRoundId && Array.isArray(record.routes)) return record;
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = findEventRoundMeta(item, categoryRoundId);
        if (found) return found;
      }
    } else if (child && typeof child === "object") {
      const found = findEventRoundMeta(child, categoryRoundId);
      if (found) return found;
    }
  }
  return undefined;
}

function routeUrls(route: IfscEventRouteMeta, kind: "startlist" | "ranking", origin: string) {
  const keys = kind === "startlist"
    ? ["startlist", "startlist_url", "startlistUrl", "start_list", "start_list_url"]
    : ["ranking", "ranking_url", "rankingUrl", "result", "result_url", "resultUrl", "results", "results_url", "resultsUrl"];
  const urls = new Set<string>();
  for (const key of keys) {
    for (const value of urlValues(route[key])) urls.add(normalizeIfscUrl(value, origin));
  }
  if (route.id) {
    const base = `${origin}/api/v1/routes/${route.id}`;
    if (kind === "startlist") {
      urls.add(`${base}/startlist`);
      urls.add(`${base}/starters`);
    } else {
      urls.add(`${base}/ranking`);
      urls.add(`${base}/results`);
    }
  }
  return [...urls];
}

function urlValues(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (Array.isArray(value)) return value.flatMap(urlValues);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return ["url", "href", "path", "api", "endpoint"].flatMap((key) => urlValues(record[key]));
}

function normalizeIfscUrl(value: string, origin: string) {
  if (/^https?:\/\//.test(value)) return value;
  return `${origin}${value.startsWith("/") ? "" : "/"}${value}`;
}

function routeStartlistEntriesFromPayload(payload: unknown, route: IfscEventRouteMeta): IfscStartlistEntry[] {
  return candidateArrays(payload)
    .flatMap((items) => items.map((item, index) => startlistEntryFromRouteItem(item, index, route)).filter(Boolean) as IfscStartlistEntry[])
    .filter((entry, index, entries) => entries.findIndex((candidate) => candidate.athlete_id === entry.athlete_id) === index);
}

function leadRouteResultsFromPayload(payload: unknown): LeadRouteResult[] {
  return candidateArrays(payload)
    .flatMap((items) => items.map(leadRouteResultFromItem).filter(Boolean) as LeadRouteResult[])
    .filter((entry, index, entries) => entries.findIndex((candidate) => candidate.athleteId === entry.athleteId) === index);
}

function leadRouteResultFromItem(value: unknown): LeadRouteResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const athleteId = startlistAthleteId(record);
  if (athleteId === undefined) return undefined;
  const scoreText = leadScoreTextFromRouteRecord(record);
  const rank = numberOrUndefined(record.rank) ?? numberOrUndefined(record.route_rank) ?? numberOrUndefined(record.result_rank);
  const status = stringValue(record.status) ?? stringValue(record.result) ?? stringValue(record.display_status);
  return { athleteId, scoreText, rank, status };
}

function leadScoreTextFromRouteRecord(record: Record<string, unknown>): string | undefined {
  for (const key of ["score", "result", "height", "hold", "points", "display_score", "displayScore", "scoreText", "result_text"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return String(value);
  }
  const nested = typeof record.ascent === "object" && record.ascent ? record.ascent as Record<string, unknown> : undefined;
  return nested ? leadScoreTextFromRouteRecord(nested) : undefined;
}

function numberOrUndefined(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function candidateArrays(value: unknown): unknown[][] {
  const arrays: unknown[][] = [];
  const visit = (item: unknown) => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) {
      if (item.some((entry) => startlistAthleteId(entry) !== undefined)) arrays.push(item);
      item.forEach(visit);
      return;
    }
    Object.values(item).forEach(visit);
  };
  visit(value);
  return arrays;
}

function startlistEntryFromRouteItem(value: unknown, index: number, route: IfscEventRouteMeta): IfscStartlistEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const athlete = typeof record.athlete === "object" && record.athlete ? record.athlete as Record<string, unknown> : {};
  const athleteId = startlistAthleteId(record);
  if (athleteId === undefined) return undefined;
  const firstname = stringValue(record.firstname) ?? stringValue(athlete.firstname);
  const lastname = stringValue(record.lastname) ?? stringValue(athlete.lastname);
  const name = stringValue(record.name) ?? stringValue(athlete.name) ?? [firstname, lastname].filter(Boolean).join(" ");
  const country = stringValue(record.country) ?? stringValue(athlete.country) ?? stringValue(athlete.nationality) ?? "";
  const position = numberOrFallback(record.position as number | string | null | undefined, numberOrFallback(record.start_order as number | string | null | undefined, numberOrFallback(record.order as number | string | null | undefined, index + 1)));
  return {
    athlete_id: athleteId,
    name: name || `Athlete ${athleteId}`,
    firstname,
    lastname,
    bib: stringValue(record.bib) ?? stringValue(athlete.bib),
    country,
    route_start_positions: [{
      route_name: route.name,
      route_id: route.id,
      position
    }]
  };
}

function startlistAthleteId(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const athlete = typeof record.athlete === "object" && record.athlete ? record.athlete as Record<string, unknown> : {};
  const id = record.athlete_id ?? athlete.id ?? record.athleteId;
  const parsed = Number(id);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function mergeStartlists(primary: IfscStartlistEntry[], fallback: IfscStartlistEntry[]) {
  const entries = new Map<string, IfscStartlistEntry>();
  for (const entry of [...fallback, ...primary]) {
    const id = String(entry.athlete_id);
    const existing = entries.get(id);
    entries.set(id, {
      ...entry,
      route_start_positions: mergeRoutePositions(existing?.route_start_positions ?? [], entry.route_start_positions ?? [])
    });
  }
  return [...entries.values()].sort((a, b) => startOrderFromStartlist(a) - startOrderFromStartlist(b) || a.name.localeCompare(b.name));
}

function mergeRoutePositions(left: IfscRoutePosition[], right: IfscRoutePosition[]) {
  const positions = new Map<string, IfscRoutePosition>();
  for (const position of [...left, ...right]) positions.set(String(position.route_id || position.route_name), position);
  return [...positions.values()].sort((a, b) => a.position - b.position);
}

function mergeLeadRanking(primary: IfscRankingEntry[], fallback: Map<string, LeadRouteResult>, startlist: IfscStartlistEntry[]) {
  const ranking = new Map(primary.map((entry) => [String(entry.athlete_id), { ...entry }]));
  const startlistById = new Map(startlist.map((entry) => [String(entry.athlete_id), entry]));
  for (const [athleteId, result] of fallback) {
    const existing = ranking.get(athleteId);
    const start = startlistById.get(athleteId);
    const startOrder = start ? startOrderFromStartlist(start) : 999;
    const mergedScore = hasMeaningfulLeadScore(existing?.score) ? existing?.score : result.scoreText ?? existing?.score ?? 0;
    ranking.set(athleteId, {
      athlete_id: result.athleteId,
      name: existing?.name ?? start?.name ?? `Athlete ${athleteId}`,
      firstname: existing?.firstname ?? start?.firstname,
      lastname: existing?.lastname ?? start?.lastname,
      country: existing?.country ?? start?.country ?? "",
      bib: existing?.bib ?? start?.bib,
      status: existing?.status ?? result.status,
      rank: existing?.rank ?? result.rank ?? startOrder,
      score: mergedScore,
      start_order: existing?.start_order ?? startOrder,
      active: existing?.active,
      under_appeal: existing?.under_appeal,
      ascents: existing?.ascents,
      lead_score_text: existing?.lead_score_text ?? result.scoreText
    });
  }
  for (const start of startlist) {
    const id = String(start.athlete_id);
    if (ranking.has(id)) continue;
    ranking.set(id, {
      athlete_id: start.athlete_id,
      name: start.name,
      firstname: start.firstname,
      lastname: start.lastname,
      country: start.country,
      bib: start.bib,
      rank: startOrderFromStartlist(start),
      score: 0,
      start_order: startOrderFromStartlist(start),
      status: "waiting"
    });
  }
  return [...ranking.values()];
}

function hasMeaningfulLeadScore(value: unknown) {
  if (value === undefined || value === null) return false;
  const text = String(value).trim();
  return text !== "" && text !== "-" && text !== "0" && text !== "0.0";
}

function unwrapIfscPayload(payload: unknown): IfscRoundPayload {
  if (isRoundPayload(payload)) return payload;
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["data", "category_round", "categoryRound", "result", "round"]) {
      if (isRoundPayload(record[key])) return record[key];
    }
  }
  throw new Error("Unsupported IFSC payload shape. The round may use a different results endpoint.");
}

function isRoundPayload(value: unknown): value is IfscRoundPayload {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<IfscRoundPayload>;
  return Array.isArray(record.ranking) || Array.isArray(record.startlist);
}

function numberOrFallback(value: number | string | null | undefined, fallback: number) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toAthlete(entry: IfscRankingEntry | IfscStartlistEntry, startOrder: number): Athlete {
  return {
    id: String(entry.athlete_id),
    name: displayName(entry),
    country: entry.country,
    countryCode: iso3ToIso2(entry.country),
    bib: entry.bib ? Number(entry.bib) : undefined,
    startOrder
  };
}

function displayName(entry: IfscRankingEntry | IfscStartlistEntry) {
  if (entry.firstname && entry.lastname) return `${entry.firstname} ${entry.lastname}`;
  return entry.name;
}

function toBoulderResult(ascent: IfscAscent): BoulderResult {
  const status = ascent.status ?? "";
  const noScoreStatus = !ascent.top && !ascent.zone && (ascent.points === 0 || ascent.modified) ? "no score" : "";
  return {
    boulderNo: routeNoFromAscent(ascent),
    attemptsToZone: ascent.zone_tries ?? undefined,
    attemptsToTop: ascent.top_tries ?? undefined,
    hasZone: Boolean(ascent.zone),
    hasTop: Boolean(ascent.top),
    rawStatus: status || (ascent.top ? `T${ascent.top_tries ?? ""}` : ascent.zone ? `Z${ascent.zone_tries ?? ""}` : noScoreStatus)
  };
}

function normalizeBoulderStatuses(boulders: BoulderResult[], resultStatus: string | undefined, currentBoulder: number | undefined) {
  if (isDnsStatus(resultStatus)) {
    return boulders.map((boulder) => ({ ...boulder, rawStatus: boulder.rawStatus || "DNS" }));
  }
  return boulders.map((boulder) => {
    if (currentBoulder === boulder.boulderNo && /no score/i.test(boulder.rawStatus ?? "")) {
      return { ...boulder, rawStatus: "" };
    }
    return boulder;
  });
}

function rankingStatus(entry: IfscRankingEntry) {
  const candidates = [entry.status, entry.rank, entry.score].map((value) => String(value ?? ""));
  return candidates.find((value) => isDnsStatus(value)) ?? entry.status ?? undefined;
}

function isDnsStatus(value?: string) {
  return /\bDNS\b|did not start/i.test(value ?? "");
}

function activeBoulderFromAscents(ascents?: IfscAscent[]) {
  const activeAscents = (ascents ?? []).filter((ascent) => ascent.status !== "confirmed");
  const latestModified = activeAscents
    .map((ascent) => ({ ascent, timestamp: ascent.modified ? Date.parse(ascent.modified) : Number.NaN }))
    .filter((entry) => Number.isFinite(entry.timestamp))
    .sort((a, b) => b.timestamp - a.timestamp)[0]?.ascent;
  const active = latestModified ?? activeAscents[0];
  if (!active) return undefined;
  return routeNoFromAscent(active);
}

function routeNoFromAscent(ascent: IfscAscent) {
  const routeNo = Number(ascent.route_name);
  if (Number.isFinite(routeNo)) return routeNo;
  const embedded = String(ascent.route_name ?? "").match(/\d+/)?.[0];
  if (embedded) return Number(embedded);
  return ascent.route_id;
}

function emptyBouldersFromStartlist(entry?: IfscStartlistEntry): BoulderResult[] {
  const routes = entry?.route_start_positions?.map((route) => Number(route.route_name)).filter(Number.isFinite) ?? [1, 2, 3, 4, 5];
  return routes.map((boulderNo) => ({ boulderNo, hasZone: false, hasTop: false, rawStatus: "" }));
}

function buildStartlist(startlist: IfscStartlistEntry[], rankingAthletes: Athlete[]): StartlistEntry[] {
  if (startlist.length > 0) {
    return startlist
      .map((entry) => ({ athleteId: String(entry.athlete_id), order: startOrderFromStartlist(entry), routePositions: routePositionsFromStartlist(entry) }))
      .sort((a, b) => a.order - b.order || Number(a.athleteId) - Number(b.athleteId));
  }
  return rankingAthletes.map((athlete) => ({ athleteId: athlete.id, order: athlete.startOrder }));
}

function startOrderFromStartlist(entry: IfscStartlistEntry) {
  const positions = entry.route_start_positions?.map((position) => position.position) ?? [];
  return Math.min(...positions, 999);
}

function routePositionsFromStartlist(entry: IfscStartlistEntry) {
  return entry.route_start_positions
    ?.map((position) => ({
      boulderNo: routeNoFromRoutePosition(position),
      position: position.position
    }))
    .filter((position) => Number.isFinite(position.boulderNo) && Number.isFinite(position.position))
    .sort((a, b) => a.boulderNo - b.boulderNo);
}

function routeNoFromRoutePosition(position: IfscRoutePosition) {
  const routeNo = Number(position.route_name);
  if (Number.isFinite(routeNo)) return routeNo;
  const embedded = String(position.route_name ?? "").match(/\d+/)?.[0];
  if (embedded) return Number(embedded);
  return position.route_id;
}

function buildAppeals(ranking: IfscRankingEntry[]): Appeal[] {
  return ranking.flatMap((entry) => {
    const appealAscents = (entry.ascents ?? []).filter((ascent) => /appeal|accepted|rejected/i.test(ascent.status ?? ""));
    if (!entry.under_appeal && appealAscents.length === 0) return [];
    const ascent = appealAscents[0];
    const sourceText = ascent?.status ?? (entry.under_appeal ? "Under Appeal" : "Appeal");
    return [{
      athleteId: String(entry.athlete_id),
      status: appealStatusFromText(sourceText),
      boulderNo: ascent ? Number(ascent.route_name) : undefined,
      sourceText,
      confidence: {
        value: ascent ? 96 : 90,
        reason: ascent ? "Appeal status found on official ascent status." : "Official athlete under_appeal flag is true.",
        source: "official"
      }
    } satisfies Appeal];
  });
}

function appealStatusFromText(text: string): Appeal["status"] {
  if (/accepted/i.test(text)) return "Accepted";
  if (/rejected/i.test(text)) return "Rejected";
  if (/pending/i.test(text)) return "Pending";
  return "Under Appeal";
}

function toIso(value?: string | null) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function iso3ToIso2(code: string) {
  const map: Record<string, string> = {
    AUS: "AU", AUT: "AT", BEL: "BE", BRA: "BR", CAN: "CA", CHN: "CN", CZE: "CZ", ESP: "ES", FRA: "FR", GBR: "GB",
    GER: "DE", HUN: "HU", ISR: "IL", ITA: "IT", JPN: "JP", KOR: "KR", NED: "NL", POL: "PL", SLO: "SI", SUI: "CH",
    UKR: "UA", USA: "US"
  };
  return map[code] ?? code.slice(0, 2);
}
