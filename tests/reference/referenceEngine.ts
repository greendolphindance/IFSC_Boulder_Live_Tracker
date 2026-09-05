import type { MedalCondition, MedalKind, MedalOutcome } from "../../server/src/types/domain.ts";

export const MAX_WORLDS = 100_000;

export type BoulderAtomId =
  | "N"
  | "Z1"
  | "Z2"
  | "Z9"
  | "Z10"
  | "Z20"
  | "Z21"
  | "T1"
  | "T2"
  | "T9"
  | "T10"
  | "T20"
  | "T21";

export interface BoulderAtom {
  id: BoulderAtomId;
  result: "none" | "zone" | "top";
  attempts: number;
  /** Score in tenths of a point. */
  score10: number;
}

function boulderAtom(id: BoulderAtomId, result: BoulderAtom["result"], attempts: number): BoulderAtom {
  const base = result === "top" ? 250 : result === "zone" ? 100 : 0;
  return { id, result, attempts, score10: result === "none" ? 0 : base - Math.max(0, attempts - 1) };
}

export const BOULDER_ATOMS = {
  N: boulderAtom("N", "none", 0),
  Z1: boulderAtom("Z1", "zone", 1),
  Z2: boulderAtom("Z2", "zone", 2),
  Z9: boulderAtom("Z9", "zone", 9),
  Z10: boulderAtom("Z10", "zone", 10),
  Z20: boulderAtom("Z20", "zone", 20),
  Z21: boulderAtom("Z21", "zone", 21),
  T1: boulderAtom("T1", "top", 1),
  T2: boulderAtom("T2", "top", 2),
  T9: boulderAtom("T9", "top", 9),
  T10: boulderAtom("T10", "top", 10),
  T20: boulderAtom("T20", "top", 20),
  T21: boulderAtom("T21", "top", 21)
} as const satisfies Record<BoulderAtomId, BoulderAtom>;

export const ALL_BOULDER_ATOMS: readonly BoulderAtom[] = Object.values(BOULDER_ATOMS);
export const BASIC_BOULDER_ATOMS: readonly BoulderAtom[] = [
  BOULDER_ATOMS.N,
  BOULDER_ATOMS.Z1,
  BOULDER_ATOMS.Z2,
  BOULDER_ATOMS.T1,
  BOULDER_ATOMS.T2
];

export type BoulderObservation =
  | { state: "finished"; atom: BoulderAtom }
  | { state: "waiting" }
  | { state: "climbing_none"; attemptsMade: number }
  | { state: "climbing_zone"; zoneAttempts: number };

export interface BoulderSlot {
  key: string;
  routeNo: 1 | 2 | 3 | 4;
  observation: BoulderObservation;
  terminals: readonly BoulderAtom[];
}

export interface BoulderReferenceAthlete {
  id: string;
  name: string;
  startOrder: number;
  routes: readonly [BoulderSlot, BoulderSlot, BoulderSlot, BoulderSlot];
}

export interface BoulderReferenceScenario {
  name: string;
  athletes: readonly BoulderReferenceAthlete[];
  roundStatus: string;
}

export type LeadAtomId = "DNS" | "42" | "42+" | "43" | "TOP";

export interface LeadAtom {
  id: LeadAtomId;
  /** Score in quarter-hold units. TOP is supplied with the scenario routeTop. */
  score4: number;
}

export function leadAtoms(routeTop: number): Readonly<Record<LeadAtomId, LeadAtom>> {
  return {
    DNS: { id: "DNS", score4: 0 },
    "42": { id: "42", score4: 42 * 4 },
    "42+": { id: "42+", score4: 42 * 4 + 1 },
    "43": { id: "43", score4: 43 * 4 },
    TOP: { id: "TOP", score4: routeTop * 4 }
  };
}

export type LeadObservation =
  | { state: "waiting" }
  | { state: "climbing"; score: LeadAtom }
  | { state: "finished"; atom: LeadAtom };

export interface LeadReferenceAthlete {
  id: string;
  name: string;
  startOrder: number;
  observation: LeadObservation;
  terminals: readonly LeadAtom[];
}

export interface LeadReferenceScenario {
  name: string;
  athletes: readonly LeadReferenceAthlete[];
  routeTop: number;
  roundStatus: string;
}

export interface RankedWorld<A> {
  index: number;
  assignments: ReadonlyMap<string, A>;
  scores: ReadonlyMap<string, number>;
  ranks: ReadonlyMap<string, number>;
}

export type BoulderWorld = RankedWorld<BoulderAtom>;
export type LeadWorld = RankedWorld<LeadAtom>;

interface CartesianSlot<A> {
  key: string;
  terminals: readonly A[];
}

function checkedWorldCount<A>(slots: readonly CartesianSlot<A>[]): number {
  let count = 1;
  for (const slot of slots) {
    if (slot.terminals.length === 0) throw new Error(`Reference slot ${slot.key} has no terminal atoms.`);
    count *= slot.terminals.length;
    if (count > MAX_WORLDS) {
      throw new Error(`Reference world limit exceeded: ${count} > MAX_WORLDS=${MAX_WORLDS}. Split the scenario; sampling is forbidden.`);
    }
  }
  return count;
}

function cartesianAssignments<A>(slots: readonly CartesianSlot<A>[]): ReadonlyMap<string, A>[] {
  checkedWorldCount(slots);
  const worlds: ReadonlyMap<string, A>[] = [];
  const current = new Map<string, A>();

  const visit = (slotIndex: number): void => {
    if (slotIndex === slots.length) {
      worlds.push(new Map(current));
      return;
    }
    const slot = slots[slotIndex];
    for (const atom of slot.terminals) {
      current.set(slot.key, atom);
      visit(slotIndex + 1);
    }
    current.delete(slot.key);
  };

  visit(0);
  return worlds;
}

function directRanks(
  athletes: readonly { id: string; startOrder: number }[],
  scores: ReadonlyMap<string, number>
): ReadonlyMap<string, number> {
  const ordered = [...athletes].sort((left, right) => {
    const scoreDifference = (scores.get(right.id) ?? 0) - (scores.get(left.id) ?? 0);
    if (scoreDifference !== 0) return scoreDifference;
    const semifinalDifference = right.startOrder - left.startOrder;
    if (semifinalDifference !== 0) return semifinalDifference;
    return left.id.localeCompare(right.id);
  });
  return new Map(ordered.map((athlete, index) => [athlete.id, index + 1]));
}

function validateBoulderSlot(slot: BoulderSlot): void {
  if (slot.observation.state === "finished") {
    if (slot.terminals.length !== 1 || slot.terminals[0].id !== slot.observation.atom.id) {
      throw new Error(`${slot.key}: a finished route must have exactly its observed terminal atom.`);
    }
    return;
  }
  if (slot.observation.state === "climbing_none") {
    const minimumSuccessAttempt = slot.observation.attemptsMade + 1;
    const illegal = slot.terminals.find((atom) => atom.result !== "none" && atom.attempts < minimumSuccessAttempt);
    if (illegal) throw new Error(`${slot.key}: ${illegal.id} predates ${slot.observation.attemptsMade} failed attempts.`);
  }
  if (slot.observation.state === "climbing_zone") {
    const zoneAttempts = slot.observation.zoneAttempts;
    const illegal = slot.terminals.find((atom) => atom.result === "none" || atom.attempts < zoneAttempts);
    if (illegal) throw new Error(`${slot.key}: ${illegal.id} is incompatible with an observed Z${zoneAttempts}.`);
  }
}

export function boulderWorldCount(scenario: BoulderReferenceScenario): number {
  const slots = scenario.athletes.flatMap((athlete) => athlete.routes);
  slots.forEach(validateBoulderSlot);
  return checkedWorldCount(slots);
}

export function enumerateBoulderWorlds(scenario: BoulderReferenceScenario): BoulderWorld[] {
  const slots = scenario.athletes.flatMap((athlete) => athlete.routes);
  slots.forEach(validateBoulderSlot);
  return cartesianAssignments(slots).map((assignments, index) => {
    const scores = new Map<string, number>();
    for (const athlete of scenario.athletes) {
      const score10 = athlete.routes.reduce((sum, route) => sum + (assignments.get(route.key)?.score10 ?? 0), 0);
      scores.set(athlete.id, score10);
    }
    return { index, assignments, scores, ranks: directRanks(scenario.athletes, scores) };
  });
}

function validateLeadAthlete(athlete: LeadReferenceAthlete): void {
  if (athlete.observation.state === "finished") {
    if (athlete.terminals.length !== 1 || athlete.terminals[0].id !== athlete.observation.atom.id) {
      throw new Error(`${athlete.id}: a finished Lead result must have exactly its observed terminal atom.`);
    }
    return;
  }
  if (athlete.observation.state === "climbing") {
    const current = athlete.observation.score.score4;
    const illegal = athlete.terminals.find((atom) => atom.id === "DNS" || atom.score4 < current);
    if (illegal) throw new Error(`${athlete.id}: ${illegal.id} cannot follow an observed climbing score.`);
  }
}

export function leadWorldCount(scenario: LeadReferenceScenario): number {
  scenario.athletes.forEach(validateLeadAthlete);
  return checkedWorldCount(scenario.athletes.map((athlete) => ({ key: athlete.id, terminals: athlete.terminals })));
}

export function enumerateLeadWorlds(scenario: LeadReferenceScenario): LeadWorld[] {
  scenario.athletes.forEach(validateLeadAthlete);
  const slots = scenario.athletes.map((athlete) => ({ key: athlete.id, terminals: athlete.terminals }));
  return cartesianAssignments(slots).map((assignments, index) => {
    const scores = new Map(scenario.athletes.map((athlete) => [athlete.id, assignments.get(athlete.id)?.score4 ?? 0]));
    return { index, assignments, scores, ranks: directRanks(scenario.athletes, scores) };
  });
}

export function targetRank(medal: MedalKind): number {
  return medal === "gold" ? 1 : medal === "silver" ? 2 : 3;
}

export function winsMedal(world: RankedWorld<unknown>, athleteId: string, medal: MedalKind): boolean {
  return (world.ranks.get(athleteId) ?? Number.POSITIVE_INFINITY) <= targetRank(medal);
}

export type WorldTruth = "always" | "never" | "mixed";

export function worldTruth(worlds: readonly RankedWorld<unknown>[], athleteId: string, medal: MedalKind): WorldTruth {
  if (worlds.length === 0) throw new Error("A reference scenario must contain at least one world.");
  const medalWorlds = worlds.filter((world) => winsMedal(world, athleteId, medal)).length;
  if (medalWorlds === worlds.length) return "always";
  if (medalWorlds === 0) return "never";
  return "mixed";
}

export type WorldPredicate<W> = (world: W) => boolean;

export interface ConditionSpec<W> {
  name: string;
  summary: string | RegExp;
  predicate: WorldPredicate<W>;
}

export interface ConditionFailure<W> {
  condition: MedalCondition;
  specName: string;
  kind: "unmatched" | "ambiguous" | "vacuous" | "insufficient" | "not_necessary";
  witness?: W;
}

function summaryMatches(pattern: string | RegExp, summary: string): boolean {
  return typeof pattern === "string" ? pattern === summary : pattern.test(summary);
}

/**
 * Audit public condition text against independently-authored world predicates.
 * Every displayed condition is required to be sufficient. Only the deliberately
 * unique necessary wording beginning with “Needs…” is also required to be iff.
 */
export function auditConditions<W extends RankedWorld<unknown>>(
  outcome: MedalOutcome,
  worlds: readonly W[],
  athleteId: string,
  specs: readonly ConditionSpec<W>[]
): ConditionFailure<W>[] {
  const failures: ConditionFailure<W>[] = [];
  for (const condition of outcome.conditions) {
    const matches = specs.filter((spec) => summaryMatches(spec.summary, condition.summary));
    if (matches.length === 0) {
      failures.push({ condition, specName: "<none>", kind: "unmatched" });
      continue;
    }
    if (matches.length > 1) {
      failures.push({ condition, specName: matches.map((spec) => spec.name).join(", "), kind: "ambiguous" });
      continue;
    }
    const spec = matches[0];
    const selected = worlds.filter(spec.predicate);
    if (selected.length === 0 || selected.length === worlds.length) {
      failures.push({ condition, specName: spec.name, kind: "vacuous" });
    }
    const insufficient = selected.find((world) => !winsMedal(world, athleteId, outcome.medal));
    if (insufficient) failures.push({ condition, specName: spec.name, kind: "insufficient", witness: insufficient });
    if (/^Needs\b/.test(condition.summary)) {
      const notNecessary = worlds.find((world) => winsMedal(world, athleteId, outcome.medal) !== spec.predicate(world));
      if (notNecessary) failures.push({ condition, specName: spec.name, kind: "not_necessary", witness: notNecessary });
    }
  }
  return failures;
}

export function atomAt<W extends RankedWorld<BoulderAtom>>(slotKey: string, ...atomIds: BoulderAtomId[]): WorldPredicate<W> {
  return (world) => atomIds.includes(world.assignments.get(slotKey)?.id as BoulderAtomId);
}

export function boulderScoreAtLeast<W extends RankedWorld<BoulderAtom>>(athleteId: string, score10: number): WorldPredicate<W> {
  return (world) => (world.scores.get(athleteId) ?? Number.NEGATIVE_INFINITY) >= score10;
}

export function leadScoreAtLeast<W extends RankedWorld<LeadAtom>>(athleteId: string, score4: number): WorldPredicate<W> {
  return (world) => (world.scores.get(athleteId) ?? Number.NEGATIVE_INFINITY) >= score4;
}

export function ranksAhead<W extends RankedWorld<unknown>>(aheadId: string, behindId: string): WorldPredicate<W> {
  return (world) => (world.ranks.get(aheadId) ?? Number.POSITIVE_INFINITY) < (world.ranks.get(behindId) ?? Number.POSITIVE_INFINITY);
}

export function allOf<W>(...predicates: readonly WorldPredicate<W>[]): WorldPredicate<W> {
  return (world) => predicates.every((predicate) => predicate(world));
}

export function anyOf<W>(...predicates: readonly WorldPredicate<W>[]): WorldPredicate<W> {
  return (world) => predicates.some((predicate) => predicate(world));
}

export function not<W>(predicate: WorldPredicate<W>): WorldPredicate<W> {
  return (world) => !predicate(world);
}

export function worldEvidence(world: RankedWorld<unknown>): string {
  const assignments = [...world.assignments.entries()].map(([key, atom]) => `${key}=${String((atom as { id?: unknown }).id ?? atom)}`).join(", ");
  const standings = [...world.ranks.entries()]
    .sort((left, right) => left[1] - right[1])
    .map(([id, rank]) => `${rank}:${id}@${world.scores.get(id)}`)
    .join(", ");
  return `world#${world.index} [${assignments}] => ${standings}`;
}
