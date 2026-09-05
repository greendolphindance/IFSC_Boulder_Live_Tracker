import type {
  Athlete,
  AthleteRoundResult,
  BoulderResult,
  CompetitionSnapshot,
  LeadResult
} from "../../../server/src/types/domain.ts";
import {
  ALL_BOULDER_ATOMS,
  BASIC_BOULDER_ATOMS,
  BOULDER_ATOMS,
  type BoulderAtom,
  type BoulderObservation,
  type BoulderReferenceAthlete,
  type BoulderReferenceScenario,
  type BoulderSlot,
  type LeadAtom,
  type LeadObservation,
  type LeadReferenceAthlete,
  type LeadReferenceScenario,
  leadAtoms
} from "../referenceEngine.ts";

const FIXED_N = BOULDER_ATOMS.N;

export function fixedBoulderSlot(athleteId: string, routeNo: 1 | 2 | 3 | 4, atom: BoulderAtom): BoulderSlot {
  return {
    key: `${athleteId}.B${routeNo}`,
    routeNo,
    observation: { state: "finished", atom },
    terminals: [atom]
  };
}

export function openBoulderSlot(
  athleteId: string,
  routeNo: 1 | 2 | 3 | 4,
  observation: Exclude<BoulderObservation, { state: "finished" }>,
  terminals: readonly BoulderAtom[]
): BoulderSlot {
  return { key: `${athleteId}.B${routeNo}`, routeNo, observation, terminals };
}

export function boulderAthlete(
  id: string,
  startOrder: number,
  routes: readonly [BoulderSlot, BoulderSlot, BoulderSlot, BoulderSlot],
  name = `${id} Athlete`
): BoulderReferenceAthlete {
  return { id, name, startOrder, routes };
}

export function finishedBoulderAthlete(
  id: string,
  startOrder: number,
  atoms: readonly [BoulderAtom, BoulderAtom, BoulderAtom, BoulderAtom],
  name = `${id} Athlete`
): BoulderReferenceAthlete {
  return boulderAthlete(id, startOrder, atoms.map((atom, index) => fixedBoulderSlot(id, (index + 1) as 1 | 2 | 3 | 4, atom)) as unknown as BoulderReferenceAthlete["routes"], name);
}

function athlete(id: string, name: string, startOrder: number): Athlete {
  return { id, name, startOrder, country: "Testland", countryCode: "TST" };
}

function observedBoulder(slot: BoulderSlot): BoulderResult {
  const { routeNo: boulderNo, observation } = slot;
  if (observation.state === "finished") {
    const atom = observation.atom;
    if (atom.result === "top") {
      return { boulderNo, hasZone: true, hasTop: true, attemptsToZone: atom.attempts, attemptsToTop: atom.attempts, rawStatus: "confirmed" };
    }
    if (atom.result === "zone") {
      return { boulderNo, hasZone: true, hasTop: false, attemptsToZone: atom.attempts, rawStatus: "confirmed" };
    }
    return { boulderNo, hasZone: false, hasTop: false, rawStatus: "confirmed" };
  }
  if (observation.state === "climbing_zone") {
    return {
      boulderNo,
      hasZone: true,
      hasTop: false,
      attemptsToZone: observation.zoneAttempts,
      attemptsToTop: observation.zoneAttempts,
      rawStatus: "climbing"
    };
  }
  if (observation.state === "climbing_none") {
    return {
      boulderNo,
      hasZone: false,
      hasTop: false,
      attemptsToZone: observation.attemptsMade || undefined,
      attemptsToTop: observation.attemptsMade || undefined,
      rawStatus: "climbing"
    };
  }
  return { boulderNo, hasZone: false, hasTop: false, rawStatus: "waiting" };
}

function observedBoulderScore10(routes: readonly BoulderSlot[]): number {
  return routes.reduce((sum, route) => {
    const observation = route.observation;
    if (observation.state === "finished") return sum + observation.atom.score10;
    if (observation.state === "climbing_zone") return sum + 100 - Math.max(0, observation.zoneAttempts - 1);
    return sum;
  }, 0);
}

export function boulderSnapshot(scenario: BoulderReferenceScenario): CompetitionSnapshot {
  const results: AthleteRoundResult[] = scenario.athletes.map((entry, index) => ({
    athlete: athlete(entry.id, entry.name, entry.startOrder),
    rank: index + 1,
    score: observedBoulderScore10(entry.routes) / 10,
    boulders: entry.routes.map(observedBoulder)
  }));
  return {
    sourceTimestamp: "2026-08-31T00:00:00.000Z",
    receivedAt: "2026-08-31T00:00:00.000Z",
    eventId: `reference-${scenario.name}`,
    categoryRoundId: "reference-boulder-final",
    eventName: "Reference Boulder Final",
    roundName: "Boulder Final",
    roundStatus: scenario.roundStatus,
    discipline: "boulder",
    formatIdentifier: "boulder-final",
    athletes: results,
    ranking: results.map((result) => ({ athleteId: result.athlete.id, rank: result.rank, score: result.score })),
    startlist: results.map((result) => ({ athleteId: result.athlete.id, order: result.athlete.startOrder })),
    appeals: [],
    rawRef: `reference://${scenario.name}`
  };
}

export function leadAthlete(
  id: string,
  startOrder: number,
  observation: LeadObservation,
  terminals: readonly LeadAtom[],
  name = `${id} Athlete`
): LeadReferenceAthlete {
  return { id, name, startOrder, observation, terminals };
}

function leadText(atom: LeadAtom, routeTop: number): string {
  if (atom.id === "DNS") return "DNS";
  if (atom.id === "TOP" || atom.score4 >= routeTop * 4) return "TOP";
  return atom.id;
}

function observedLead(entry: LeadReferenceAthlete, routeTop: number, index: number): LeadResult {
  const observation = entry.observation;
  const observed = observation.state === "finished" ? observation.atom : observation.state === "climbing" ? observation.score : { id: "DNS", score4: 0 } as LeadAtom;
  const hold = Math.floor(observed.score4 / 4);
  const plus = observed.score4 % 4 > 0;
  const status = observation.state === "waiting"
    ? "waiting"
    : observation.state === "climbing"
      ? "climbing"
      : observed.id === "DNS"
        ? "dns"
        : observed.id === "TOP"
          ? "top"
          : "fall";
  return {
    athlete: athlete(entry.id, entry.name, entry.startOrder),
    rank: index + 1,
    hold,
    plus,
    scoreText: observation.state === "waiting" ? "-" : leadText(observed, routeTop),
    status
  };
}

export function leadSnapshot(scenario: LeadReferenceScenario): CompetitionSnapshot {
  const leadResults = scenario.athletes.map((entry, index) => observedLead(entry, scenario.routeTop, index));
  return {
    sourceTimestamp: "2026-08-31T00:00:00.000Z",
    receivedAt: "2026-08-31T00:00:00.000Z",
    eventId: `reference-${scenario.name}`,
    categoryRoundId: "reference-lead-final",
    eventName: "Reference Lead Final",
    roundName: "Lead Final",
    roundStatus: scenario.roundStatus,
    discipline: "lead",
    formatIdentifier: "lead-final",
    lead: {
      roundType: "Final",
      routeTop: scenario.routeTop,
      genders: [{ gender: "Women", athletes: leadResults }]
    },
    athletes: [],
    ranking: leadResults.map((result) => ({ athleteId: result.athlete.id, rank: result.rank, score: result.hold + (result.plus ? 0.25 : 0) })),
    startlist: leadResults.map((result) => ({ athleteId: result.athlete.id, order: result.athlete.startOrder })),
    appeals: [],
    rawRef: `reference://${scenario.name}`
  };
}

export const BOULDER_ENDED_COUNTBACK: BoulderReferenceScenario = {
  name: "round-ended-four-way-countback",
  roundStatus: "finished",
  athletes: [
    finishedBoulderAthlete("Ada", 4, [BOULDER_ATOMS.T1, FIXED_N, FIXED_N, FIXED_N], "Ada Alto"),
    finishedBoulderAthlete("Bea", 3, [BOULDER_ATOMS.T1, FIXED_N, FIXED_N, FIXED_N], "Bea Beta"),
    finishedBoulderAthlete("Cia", 2, [BOULDER_ATOMS.T1, FIXED_N, FIXED_N, FIXED_N], "Cia Core"),
    finishedBoulderAthlete("Dee", 1, [BOULDER_ATOMS.T1, FIXED_N, FIXED_N, FIXED_N], "Dee Delta")
  ]
};

export const BOULDER_NOT_STARTED: BoulderReferenceScenario = {
  name: "two-athletes-all-waiting",
  roundStatus: "scheduled",
  athletes: ["Ada", "Bea"].map((id, athleteIndex) => boulderAthlete(
    id,
    athleteIndex + 1,
    [1, 2, 3, 4].map((routeNo) => openBoulderSlot(id, routeNo as 1 | 2 | 3 | 4, { state: "waiting" }, [BOULDER_ATOMS.N, BOULDER_ATOMS.T1])) as unknown as BoulderReferenceAthlete["routes"]
  ))
};

export function boulderNecessaryBoundary(atom: BoulderAtom): BoulderReferenceScenario {
  const subject = boulderAthlete("Ada", 2, [
    fixedBoulderSlot("Ada", 1, FIXED_N),
    fixedBoulderSlot("Ada", 2, FIXED_N),
    fixedBoulderSlot("Ada", 3, FIXED_N),
    openBoulderSlot("Ada", 4, { state: "waiting" }, ALL_BOULDER_ATOMS)
  ], "Ada Alto");
  const opponent = finishedBoulderAthlete("Bea", 1, [atom, FIXED_N, FIXED_N, FIXED_N], "Bea Beta");
  return { name: `necessary-last-line-${atom.id}`, roundStatus: "active", athletes: [subject, opponent] };
}

export const BOULDER_ZONE_CLIMBING: BoulderReferenceScenario = {
  name: "zone-climbing-vs-finished",
  roundStatus: "active",
  athletes: [
    boulderAthlete("Ada", 2, [
      fixedBoulderSlot("Ada", 1, FIXED_N),
      fixedBoulderSlot("Ada", 2, FIXED_N),
      fixedBoulderSlot("Ada", 3, FIXED_N),
      openBoulderSlot("Ada", 4, { state: "climbing_zone", zoneAttempts: 1 }, [BOULDER_ATOMS.Z1, BOULDER_ATOMS.Z2, BOULDER_ATOMS.T1, BOULDER_ATOMS.T2, BOULDER_ATOMS.T9])
    ], "Ada Alto"),
    finishedBoulderAthlete("Bea", 1, [BOULDER_ATOMS.T2, FIXED_N, FIXED_N, FIXED_N], "Bea Beta")
  ]
};

export const BOULDER_TWO_REMAINING: BoulderReferenceScenario = {
  name: "two-remaining-routes-necessary-both-flashes",
  roundStatus: "active",
  athletes: [
    boulderAthlete("Ada", 2, [
      fixedBoulderSlot("Ada", 1, FIXED_N),
      fixedBoulderSlot("Ada", 2, FIXED_N),
      openBoulderSlot("Ada", 3, { state: "waiting" }, [BOULDER_ATOMS.N, BOULDER_ATOMS.T1]),
      openBoulderSlot("Ada", 4, { state: "waiting" }, [BOULDER_ATOMS.N, BOULDER_ATOMS.T1])
    ], "Ada Alto"),
    finishedBoulderAthlete("Bea", 1, [BOULDER_ATOMS.T1, BOULDER_ATOMS.T1, FIXED_N, FIXED_N], "Bea Beta")
  ]
};

export const BOULDER_PURE_OPPONENT: BoulderReferenceScenario = {
  name: "finished-subject-pure-opponent-path",
  roundStatus: "active",
  athletes: [
    finishedBoulderAthlete("Ada", 1, [BOULDER_ATOMS.T1, FIXED_N, FIXED_N, FIXED_N], "Ada Alto"),
    boulderAthlete("Bea", 2, [
      fixedBoulderSlot("Bea", 1, FIXED_N),
      fixedBoulderSlot("Bea", 2, FIXED_N),
      fixedBoulderSlot("Bea", 3, FIXED_N),
      openBoulderSlot("Bea", 4, { state: "waiting" }, BASIC_BOULDER_ATOMS)
    ], "Bea Beta")
  ]
};

export const BOULDER_BOTH_OPPONENTS: BoulderReferenceScenario = {
  name: "finished-subject-both-opponents-cardinality",
  roundStatus: "active",
  athletes: [
    finishedBoulderAthlete("Ada", 1, [BOULDER_ATOMS.T1, FIXED_N, FIXED_N, FIXED_N], "Ada Alto"),
    ...["Bea", "Cia"].map((id, index) => boulderAthlete(id, index + 2, [
      fixedBoulderSlot(id, 1, FIXED_N),
      fixedBoulderSlot(id, 2, FIXED_N),
      fixedBoulderSlot(id, 3, FIXED_N),
      openBoulderSlot(id, 4, { state: "waiting" }, BASIC_BOULDER_ATOMS)
    ], `${id} Athlete`))
  ]
};

export const BOULDER_ALL_OPPONENTS: BoulderReferenceScenario = {
  name: "finished-subject-all-three-opponents-complexity",
  roundStatus: "active",
  athletes: [
    finishedBoulderAthlete("Ada", 1, [BOULDER_ATOMS.T1, FIXED_N, FIXED_N, FIXED_N], "Ada Alto"),
    ...["Bea", "Cia", "Dee"].map((id, index) => boulderAthlete(id, index + 2, [
      fixedBoulderSlot(id, 1, FIXED_N),
      fixedBoulderSlot(id, 2, FIXED_N),
      fixedBoulderSlot(id, 3, FIXED_N),
      openBoulderSlot(id, 4, { state: "waiting" }, [BOULDER_ATOMS.N, BOULDER_ATOMS.T1])
    ], `${id} Athlete`))
  ]
};

export const BOULDER_MIXED_STATUS: BoulderReferenceScenario = {
  name: "climbing-subject-waiting-opponent-finished-opponent",
  roundStatus: "active",
  athletes: [
    boulderAthlete("Ada", 2, [
      fixedBoulderSlot("Ada", 1, BOULDER_ATOMS.T1),
      fixedBoulderSlot("Ada", 2, FIXED_N),
      fixedBoulderSlot("Ada", 3, FIXED_N),
      openBoulderSlot("Ada", 4, { state: "climbing_none", attemptsMade: 0 }, [BOULDER_ATOMS.N, BOULDER_ATOMS.Z1, BOULDER_ATOMS.T2, BOULDER_ATOMS.T1])
    ], "Ada Alto"),
    finishedBoulderAthlete("Bea", 1, [BOULDER_ATOMS.T1, BOULDER_ATOMS.T2, FIXED_N, FIXED_N], "Bea Beta"),
    boulderAthlete("Cia", 3, [
      fixedBoulderSlot("Cia", 1, BOULDER_ATOMS.T1),
      fixedBoulderSlot("Cia", 2, FIXED_N),
      fixedBoulderSlot("Cia", 3, FIXED_N),
      openBoulderSlot("Cia", 4, { state: "waiting" }, [BOULDER_ATOMS.N, BOULDER_ATOMS.Z1, BOULDER_ATOMS.T2, BOULDER_ATOMS.T1])
    ], "Cia Core")
  ]
};

const LEAD_100 = leadAtoms(100);

export const LEAD_NECESSARY_42_PLUS: LeadReferenceScenario = {
  name: "lead-climbing-needs-42-plus",
  routeTop: 100,
  roundStatus: "active",
  athletes: [
    leadAthlete("Ada", 1, { state: "climbing", score: LEAD_100["42"] }, [LEAD_100["42"], LEAD_100["42+"], LEAD_100["43"], LEAD_100.TOP], "Ada Alto"),
    leadAthlete("Bea", 2, { state: "finished", atom: LEAD_100["42"] }, [LEAD_100["42"]], "Bea Beta")
  ]
};

export const LEAD_NECESSARY_43: LeadReferenceScenario = {
  name: "lead-climbing-needs-integer-43",
  routeTop: 100,
  roundStatus: "active",
  athletes: [
    leadAthlete("Ada", 1, { state: "climbing", score: LEAD_100["42+"] }, [LEAD_100["42+"], LEAD_100["43"], LEAD_100.TOP], "Ada Alto"),
    leadAthlete("Bea", 2, { state: "finished", atom: LEAD_100["42+"] }, [LEAD_100["42+"]], "Bea Beta")
  ]
};

export const LEAD_TOP_GATED: LeadReferenceScenario = {
  name: "lead-top-only-remains-diff009-gated",
  routeTop: 100,
  roundStatus: "active",
  athletes: [
    leadAthlete("Ada", 2, { state: "climbing", score: LEAD_100["42"] }, [LEAD_100["42"], LEAD_100["42+"], LEAD_100.TOP], "Ada Alto"),
    leadAthlete("Bea", 1, { state: "finished", atom: LEAD_100.TOP }, [LEAD_100.TOP], "Bea Beta")
  ]
};

export const LEAD_DNS: LeadReferenceScenario = {
  name: "lead-dns-is-settled-and-cannot-climb",
  routeTop: 100,
  roundStatus: "active",
  athletes: [
    leadAthlete("Ada", 2, { state: "finished", atom: LEAD_100.DNS }, [LEAD_100.DNS], "Ada Alto"),
    leadAthlete("Bea", 1, { state: "finished", atom: LEAD_100["42"] }, [LEAD_100["42"]], "Bea Beta")
  ]
};

export const LEAD_FINISHED_COUNTBACK: LeadReferenceScenario = {
  name: "lead-finished-equal-score-countback",
  routeTop: 100,
  roundStatus: "finished",
  athletes: [
    leadAthlete("Ada", 2, { state: "finished", atom: LEAD_100["42+"] }, [LEAD_100["42+"]], "Ada Alto"),
    leadAthlete("Bea", 1, { state: "finished", atom: LEAD_100["42+"] }, [LEAD_100["42+"]], "Bea Beta")
  ]
};

export const LEAD_PURE_OPPONENT: LeadReferenceScenario = {
  name: "lead-finished-subject-waiting-opponent",
  routeTop: 100,
  roundStatus: "active",
  athletes: [
    leadAthlete("Ada", 2, { state: "finished", atom: LEAD_100["42"] }, [LEAD_100["42"]], "Ada Alto"),
    leadAthlete("Bea", 1, { state: "waiting" }, [LEAD_100.DNS, LEAD_100["42"], LEAD_100["42+"], LEAD_100.TOP], "Bea Beta")
  ]
};

export const LEAD_WAITING_CLIMBING_FINISHED: LeadReferenceScenario = {
  name: "lead-waiting-climbing-finished",
  routeTop: 100,
  roundStatus: "active",
  athletes: [
    leadAthlete("Ada", 2, { state: "climbing", score: LEAD_100["42"] }, [LEAD_100["42"], LEAD_100["42+"], LEAD_100.TOP], "Ada Alto"),
    leadAthlete("Bea", 1, { state: "finished", atom: LEAD_100["43"] }, [LEAD_100["43"]], "Bea Beta"),
    leadAthlete("Cia", 3, { state: "waiting" }, [LEAD_100.DNS, LEAD_100["42"], LEAD_100["42+"], LEAD_100.TOP], "Cia Core")
  ]
};
