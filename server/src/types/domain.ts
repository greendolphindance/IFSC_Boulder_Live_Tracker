export type BaseAthleteState = "WAITING" | "ON_WALL" | "ROTATING" | "FINISHED";
export type OverlayAthleteState = "UNDER_APPEAL";
export type AthleteState = BaseAthleteState | OverlayAthleteState;

export type AppealStatus = "Under Appeal" | "Pending" | "Accepted" | "Rejected";

export type EventType =
  | "SNAPSHOT_RECEIVED"
  | "CLIMBER_STARTED"
  | "ROTATION_DETECTED"
  | "ATTEMPT_UPDATED"
  | "ZONE_REACHED"
  | "TOP_REACHED"
  | "RANK_CHANGED"
  | "APPEAL_FILED"
  | "APPEAL_ACCEPTED"
  | "APPEAL_REJECTED"
  | "TIME_EXPIRED_ESTIMATED";

export type EventPriority = "normal" | "high" | "alert";

export interface Confidence {
  value: number;
  reason: string;
  source: "official" | "derived" | "estimated";
}

export interface Athlete {
  id: string;
  name: string;
  country: string;
  countryCode: string;
  bib?: number;
  startOrder: number;
}

export interface BoulderResult {
  boulderNo: number;
  attemptsToZone?: number;
  attemptsToTop?: number;
  hasZone: boolean;
  hasTop: boolean;
  rawStatus?: string;
}

export interface AthleteRoundResult {
  athlete: Athlete;
  rank: number;
  groupRank?: number;
  startingGroup?: string;
  currentBoulder?: number;
  nextBoulder?: number;
  score: number;
  leadScoreText?: string;
  boulders: BoulderResult[];
  sourceStatus?: string;
}

export type Discipline = "boulder" | "lead";
export type LeadRoundType = "Semi-final" | "Final";
export type LeadGender = "Women" | "Men";
export type LeadStatus = "waiting" | "climbing" | "fall" | "top" | "dns";

export interface LeadResult {
  athlete: Athlete;
  rank: number;
  hold: number;
  plus?: boolean;
  scoreText: string;
  status: LeadStatus;
  elapsedSeconds?: number;
  next?: boolean;
}

export interface LeadGenderRound {
  gender: LeadGender;
  athletes: LeadResult[];
}

export interface LeadRoundData {
  roundType: LeadRoundType;
  routeTop?: number;
  genders: LeadGenderRound[];
}

export interface AthleteLiveState {
  athleteId: string;
  states: AthleteState[];
  currentBoulder?: number;
  currentAttempt?: number;
  elapsedSeconds?: number;
  rank: number;
  groupRank?: number;
  startingGroup?: string;
  score: number;
  confidence: Confidence;
}

export interface Appeal {
  athleteId: string;
  status: AppealStatus;
  boulderNo?: number;
  filedAt?: string;
  resolvedAt?: string;
  sourceText: string;
  confidence: Confidence;
}

export interface RankingEntry {
  athleteId: string;
  rank: number;
  score: number;
}

export interface StartlistEntry {
  athleteId: string;
  order: number;
  routePositions?: {
    boulderNo: number;
    position: number;
  }[];
}

export interface CompetitionSnapshot {
  sourceTimestamp: string;
  receivedAt: string;
  eventId: string;
  categoryRoundId: string;
  eventName: string;
  roundName: string;
  roundStatus?: string;
  discipline?: Discipline;
  formatIdentifier?: string;
  lead?: LeadRoundData;
  athletes: AthleteRoundResult[];
  ranking: RankingEntry[];
  startlist: StartlistEntry[];
  appeals: Appeal[];
  rawRef: string;
}

export interface CompetitionEvent {
  id: string;
  timestamp: string;
  type: EventType;
  athleteId?: string;
  boulderNo?: number;
  message: string;
  priority: EventPriority;
  reason: string;
  source: "official" | "derived" | "estimated";
}

export interface RankChange {
  id: string;
  timestamp: string;
  athleteId: string;
  from: number;
  to: number;
  reason: string;
}

export interface UpNextEntry {
  athleteId: string;
  expectedBoulder: number;
  startingGroup?: string;
  station: "Waiting" | "Rotation";
  confidence: Confidence;
}

export type MedalKind = "gold" | "silver" | "bronze";

export type MedalVerdict = "locked" | "eliminated" | "undecided" | "needs_conditions";

export interface MedalCondition {
  /**
   * 一句话可读组合（英文）。needs_conditions 用"剩余还需分"下限口径
   * （"Needs at least X …"；PM 灰度决定1 已撤旧 "at best" 上界措辞）。
   * ⚠️ 同分 countback 临界时必须显式含 countback 要素、禁只给分数阈值：
   * 方向按 IFSC 官方半决赛排名（startOrder，大者胜）——占优打平即可 / 吃亏须超过；
   * ≥3 对手（含 countback 从句对手）概括时保留失手方向（见 03-PRD片段 §4.3.c · CONTRACT-DRIFT-1）。
   */
  summary: string;
  /** 条件级可信度 · 仅难度赛依赖登顶的那条置此（依赖 DIFF-009）。 */
  conditionLevelTrust?: "top_unconfirmed";
}

export interface MedalOutcome {
  medal: MedalKind;
  verdict: MedalVerdict;
  /** 一句话理由（英文）。 */
  reason: string;
  /** needs_conditions 时 ≤5 条（去重合并后）；其余态空数组。 */
  conditions: MedalCondition[];
  /** true = 组合超 5 退化为概括，conditions 只含 1 条概括句。 */
  degraded?: boolean;
}

export interface AthleteMedalChances {
  athleteId: string;
  /** 定长 3：gold / silver / bronze。 */
  outcomes: MedalOutcome[];
}

export interface MedalChances {
  discipline: Discipline;
  athletes: AthleteMedalChances[];
  /** 页面级可信度 · connection.status 非 connected 时置（依赖 DIFF-005 · 本期几乎不触发）。 */
  pageLevelTrust?: "stale";
  /** 抱石决赛 = 官方线路元数据 ?? 4（term-lock 锁定 · 禁用 max(boulders.length) 兜底）。 */
  totalRoutes: number;
  /** 是否还有未完成线路 · 用于 loading/empty 判定。 */
  routesRemaining: boolean;
}

export interface CompetitionState {
  snapshot: CompetitionSnapshot;
  liveStates: AthleteLiveState[];
  currentClimbers: AthleteLiveState[];
  upNext: UpNextEntry[];
  events: CompetitionEvent[];
  rankChanges: RankChange[];
  connection: {
    source: "fixture" | "ifsc-network";
    status: "connected" | "degraded" | "offline";
    lastUpdate: string;
  };
  debug: {
    refreshMs: number;
    rawRef: string;
    notes: string[];
  };
  /** 决赛轮奖牌条件推演（CHG-001 · 可选 → 非决赛轮为 undefined，前端据此不渲染 tab）。 */
  medalChances?: MedalChances;
}
