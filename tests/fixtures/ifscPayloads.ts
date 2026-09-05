type Score = number | string | null;

export function boulderPayload(score: Score) {
  return {
    id: 10704,
    event: "Frozen IFSC Boulder Event",
    event_id: 1515,
    status: "active",
    status_as_of: "2026-08-31T10:00:00.000Z",
    category: "Women Boulder",
    round: "Final",
    format_identifier: "boulder-final",
    ranking: [{
      athlete_id: 101,
      name: "Test CLIMBER",
      firstname: "Test",
      lastname: "CLIMBER",
      country: "FRA",
      rank: 1,
      score,
      start_order: 8,
      active: true,
      ascents: [{
        route_id: 501,
        route_name: "1",
        top: true,
        top_tries: 1,
        zone: true,
        zone_tries: 1,
        points: 25,
        status: "confirmed"
      }]
    }],
    startlist: [{
      athlete_id: 101,
      name: "Test CLIMBER",
      firstname: "Test",
      lastname: "CLIMBER",
      country: "FRA",
      route_start_positions: [{ route_name: "1", route_id: 501, position: 8 }]
    }]
  };
}

export function twoAthleteBoulderPayload(firstScore: Score, firstRank = 1, secondRank = 2) {
  const payload = boulderPayload(firstScore);
  payload.ranking[0].rank = firstRank;
  payload.ranking.push({
    athlete_id: 102,
    name: "Second CLIMBER",
    firstname: "Second",
    lastname: "CLIMBER",
    country: "JPN",
    rank: secondRank,
    score: 60.2,
    start_order: 7,
    active: false,
    ascents: [{
      route_id: 501,
      route_name: "1",
      top: true,
      top_tries: 2,
      zone: true,
      zone_tries: 1,
      points: 24.9,
      status: "confirmed"
    }]
  });
  payload.startlist.push({
    athlete_id: 102,
    name: "Second CLIMBER",
    firstname: "Second",
    lastname: "CLIMBER",
    country: "JPN",
    route_start_positions: [{ route_name: "1", route_id: 501, position: 7 }]
  });
  return payload;
}

export function leadPayload(score: Score, status?: string) {
  return {
    id: 20704,
    event: "Frozen IFSC Lead Event",
    event_id: 2515,
    status: "active",
    status_as_of: "2026-08-31T10:00:00.000Z",
    category: "Women Lead",
    round: "Final",
    format_identifier: "lead-final",
    ranking: [{
      athlete_id: 201,
      name: "Lead CLIMBER",
      firstname: "Lead",
      lastname: "CLIMBER",
      country: "GBR",
      rank: 1,
      score,
      status,
      start_order: 8,
      active: false,
      ascents: []
    }],
    startlist: [{
      athlete_id: 201,
      name: "Lead CLIMBER",
      firstname: "Lead",
      lastname: "CLIMBER",
      country: "GBR",
      route_start_positions: [{ route_name: "Final", route_id: 601, position: 8 }]
    }]
  };
}

export function twoAthleteLeadPayload(firstScore: Score, firstRank = 1, secondRank = 2) {
  const payload = leadPayload(firstScore);
  payload.ranking[0].rank = firstRank;
  payload.ranking.push({
    athlete_id: 202,
    name: "Other LEADER",
    firstname: "Other",
    lastname: "LEADER",
    country: "USA",
    rank: secondRank,
    score: "41",
    status: "confirmed",
    start_order: 7,
    active: false,
    ascents: []
  });
  payload.startlist.push({
    athlete_id: 202,
    name: "Other LEADER",
    firstname: "Other",
    lastname: "LEADER",
    country: "USA",
    route_start_positions: [{ route_name: "Final", route_id: 601, position: 7 }]
  });
  return payload;
}
