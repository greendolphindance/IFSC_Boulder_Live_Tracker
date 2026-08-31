import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import type { Athlete, AthleteRoundResult, CompetitionState, LeadResult } from "../../server/src/types/domain.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("desktop and mobile DOM preserve Boulder and Lead score semantics", async () => {
  const port = await availablePort();
  const vite = startVite(port);
  let browser: Browser | undefined;

  try {
    await waitForServer(`http://127.0.0.1:${port}`);
    browser = await chromium.launch(chromiumLaunchOptions());

    for (const viewport of [{ width: 1440, height: 1000 }, { width: 768, height: 900 }]) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      let state: CompetitionState = boulderState();
      await page.route("**/api/state**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state) }));
      await page.addInitScript(() => {
        window.localStorage.clear();
        window.sessionStorage.setItem("ifsc-round-url", "https://ifsc.results.info/event/score-test/cr/1");
      });

      await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "domcontentloaded" });
      await page.locator(".score-block").waitFor();
      assert.equal(await scoreIn(page, ".route-tile", "decimal"), "69.4", `${viewport.width}px route tile`);
      await assertBoulderRanking(page, viewport.width);

      await page.getByRole("button", { name: "Athletes" }).click();
      await page.locator(".route-summary-row").filter({ has: page.locator('a[href$="/athlete/decimal"]') }).waitFor({ state: viewport.width <= 1023 ? "attached" : "visible" });
      assert.equal(await scoreIn(page, ".route-summary-row", "decimal"), "69.4", `${viewport.width}px route summary`);
      await assertBoulderRanking(page, viewport.width);

      await page.getByRole("button", { name: "Event Feed" }).click();
      const eventText = (await page.locator(".event-row").first().textContent()) ?? "";
      assert.match(eventText, /Decimal Athlete \(69\.4\) passed Integer Athlete \(69\.0\)/, `${viewport.width}px event text`);

      state = leadState();
      await page.evaluate(() => window.localStorage.setItem("ifsc-live-tab", "columns"));
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator(".lead-ranking-list").waitFor();
      await assertLeadNotation(page, viewport.width, "columns");

      await page.getByRole("button", { name: "Axis" }).click();
      await page.locator(".lead-axis-point").first().waitFor();
      await assertLeadNotation(page, viewport.width, "axis");
      await context.close();
    }
  } finally {
    await browser?.close();
    stopVite(vite);
  }
});

async function assertBoulderRanking(page: Page, width: number) {
  const expected = new Map([
    ["decimal", "69.4"],
    ["integer", "69.0"],
    ["zero", "0.0"],
    ["dns", "DNS"],
    ["startlist", "-"],
    ["waiting", "-"],
    ["unranked", "-"]
  ]);
  for (const [athleteId, score] of expected) {
    assert.equal(await scoreIn(page, ".ranking-row", athleteId), score, `${width}px ranking ${athleteId}`);
  }
}

async function assertLeadNotation(page: Page, width: number, view: string) {
  const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  if (view === "columns") {
    const scores = await page.locator(".lead-ranking-row b").allTextContents();
    for (const notation of ["42+", "42", "TOP", "DNS"]) assert(scores.includes(notation), `${width}px ${view} ${notation}`);
  } else {
    for (const notation of ["42+", "42", "TOP"]) assert(body.includes(notation), `${width}px ${view} ${notation}`);
  }
  assert.doesNotMatch(body, /42\.25|42\.3/, `${width}px ${view} must not expose the numeric comparison value`);
}

async function scoreIn(page: Page, container: string, athleteId: string) {
  const row = page.locator(container).filter({ has: page.locator(`a[href$="/athlete/${athleteId}"]`) }).first();
  return ((await row.locator(container === ".route-tile" ? ".score-block span" : ".ranking-score").textContent()) ?? "").trim();
}

function boulderState(): CompetitionState {
  const athletes = [
    boulderResult("decimal", "Decimal Athlete", 1, 69.4, "active"),
    boulderResult("integer", "Integer Athlete", 2, 69),
    boulderResult("zero", "Zero Athlete", 3, 0),
    boulderResult("dns", "Dns Athlete", 999, 0, "DNS"),
    boulderResult("startlist", "Startlist Athlete", 999, 0),
    boulderResult("waiting", "Waiting Athlete", 999, 0, "waiting"),
    boulderResult("unranked", "Unranked Athlete", 999, 0, "unranked")
  ];
  return {
    snapshot: {
      sourceTimestamp: "2026-08-31T10:00:00.000Z",
      receivedAt: "2026-08-31T10:00:01.000Z",
      eventId: "score-test",
      categoryRoundId: "1",
      eventName: "Score Semantics Test",
      roundName: "Men Boulder Final",
      roundStatus: "active",
      discipline: "boulder",
      athletes,
      ranking: athletes.filter((result) => result.athlete.id !== "startlist").map((result) => ({ athleteId: result.athlete.id, rank: result.rank, score: result.score })),
      startlist: athletes.map((result, index) => ({ athleteId: result.athlete.id, order: index + 1 })),
      appeals: [],
      rawRef: "test://boulder"
    },
    liveStates: [],
    currentClimbers: [{
      athleteId: "decimal",
      states: ["ON_WALL"],
      currentBoulder: 1,
      currentAttempt: 1,
      rank: 1,
      score: 69.4,
      confidence: { value: 100, reason: "browser fixture", source: "official" }
    }],
    upNext: [],
    events: [{
      id: "rank-score-test",
      timestamp: "2026-08-31T10:00:01.000Z",
      type: "RANK_CHANGED",
      athleteId: "decimal",
      message: "Decimal Athlete (69.0) passed Integer Athlete (69.0)",
      priority: "high",
      reason: "Rank 2 -> 1",
      source: "official"
    }],
    rankChanges: [],
    connection: { source: "fixture", status: "connected", lastUpdate: "2026-08-31T10:00:01.000Z" },
    debug: { refreshMs: 2000, rawRef: "test://boulder", notes: [] }
  };
}

function boulderResult(id: string, name: string, rank: number, score: number, sourceStatus?: string): AthleteRoundResult {
  return {
    athlete: athlete(id, name, rank >= 999 ? 99 : rank),
    rank,
    score,
    sourceStatus,
    currentBoulder: id === "decimal" ? 1 : undefined,
    boulders: [1, 2, 3, 4].map((boulderNo) => ({ boulderNo, hasZone: false, hasTop: false, rawStatus: "" }))
  };
}

function leadState(): CompetitionState {
  const plus = leadResult("plus", "Plus Athlete", 1, 42, "42+", "climbing", true);
  const exact = leadResult("exact", "Exact Athlete", 2, 42, "42", "fall");
  const top = leadResult("top", "Top Athlete", 3, 100, "TOP", "top");
  const dns = leadResult("lead-dns", "Lead DNS Athlete", 0, 0, "DNS", "dns");
  const leadResults = [plus, exact, top, dns];
  return {
    snapshot: {
      sourceTimestamp: "2026-08-31T10:00:00.000Z",
      receivedAt: "2026-08-31T10:00:01.000Z",
      eventId: "lead-test",
      categoryRoundId: "2",
      eventName: "Lead Notation Test",
      roundName: "Women Lead Final",
      roundStatus: "active",
      discipline: "lead",
      lead: { roundType: "Final", routeTop: 50, genders: [{ gender: "Women", athletes: leadResults }] },
      athletes: leadResults.map((result) => ({ athlete: result.athlete, rank: result.rank || 999, score: result.hold + (result.plus ? 0.25 : 0), leadScoreText: result.scoreText, sourceStatus: result.status, boulders: [] })),
      ranking: leadResults.map((result) => ({ athleteId: result.athlete.id, rank: result.rank || 999, score: result.hold + (result.plus ? 0.25 : 0) })),
      startlist: leadResults.map((result, index) => ({ athleteId: result.athlete.id, order: index + 1 })),
      appeals: [],
      rawRef: "test://lead"
    },
    liveStates: [],
    currentClimbers: [],
    upNext: [],
    events: [],
    rankChanges: [],
    connection: { source: "fixture", status: "connected", lastUpdate: "2026-08-31T10:00:01.000Z" },
    debug: { refreshMs: 2000, rawRef: "test://lead", notes: [] }
  };
}

function leadResult(id: string, name: string, rank: number, hold: number, scoreText: string, status: LeadResult["status"], plus = false): LeadResult {
  return { athlete: athlete(id, name, rank || 99), rank, hold, plus, scoreText, status, elapsedSeconds: status === "climbing" ? 90 : undefined };
}

function athlete(id: string, name: string, startOrder: number): Athlete {
  return { id, name, country: "Test", countryCode: "US", startOrder };
}

function startVite(port: number) {
  return spawn(process.execPath, [resolve(repoRoot, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function chromiumLaunchOptions() {
  const configured = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  const executablePath = [
    configured,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  ].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
  return executablePath ? { headless: true, executablePath } : { headless: true };
}

function stopVite(process: ChildProcess) {
  if (!process.killed) process.kill("SIGTERM");
}

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return port;
}

async function waitForServer(url: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
  throw new Error(`Vite did not start at ${url}`);
}
