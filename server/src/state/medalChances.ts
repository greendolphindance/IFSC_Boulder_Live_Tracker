import type {
  AthleteMedalChances,
  BoulderResult,
  CompetitionSnapshot,
  CompetitionState,
  Discipline,
  LeadResult,
  MedalChances,
  MedalCondition,
  MedalKind,
  MedalOutcome,
  MedalVerdict
} from "../types/domain.js";
import { compareSemifinalRank } from "./countback.js";

/**
 * 决赛奖牌条件推演（CHG-001）· 纯快照函数：只读入参 snapshot，不读状态机历史态（上一快照 / 事件流），
 * 同一快照必产同一结论（双后端一致性 · 黑名单 #4）。计算失败由本函数 try/catch 吞掉、返回 undefined，
 * 不拖垮整个 CompetitionState（04-接口契约 § 三错误路径 · TC-MEDAL-020）。
 *
 * 事实源：03-PRD片段.md（四态口径 + term-lock 计分表）· 04-接口契约.md § 四（字段级契约）。
 */

const MEDALS: MedalKind[] = ["gold", "silver", "bronze"];
/** 关键对手剪枝上限：联合判定后威胁对手数 > 此值 → 该名次项判 undecided（PM 2026-07-07 · TC-MEDAL-045）。 */
const PRUNE_K = 4;
/** 可行组合展示上限：去重合并后 > 此值 → degraded 退化为一句概括（TC-MEDAL-006/035）。 */
const MAX_COMBINATIONS = 5;
/** 抱石决赛线路数兜底：官方线路元数据缺失时回退 4（term-lock 锁定 · 禁按已渲染线路条数反推 · TC-MEDAL-009）。 */
const BOULDER_FINAL_ROUTES = 4;
/** 浮点比较容差（计分含 0.1 惩罚步长）。 */
const EPS = 1e-6;
/**
 * 轮次已结束判定 · 对齐 CompetitionStateMachine.roundStatusKind 的 finished 词表
 * （该函数未导出；CSM 授权仅限 apply() 挂点、不加导出，故此处同词表复刻——两处需同步维护）。
 * 已结束轮次必须把全员 best/worst 区间收敛为当前实得分：比赛结束后不存在"还能改善"，
 * 否则会对已定名次误产 needs_conditions（真实案例：Meishan 女子决赛 Melody 银牌 · ROUND-3）。
 */
const ROUND_FINISHED_RE = /finished|complete|closed|archived|ended/;
/** 轮次未开始词表 · 对齐 CompetitionStateMachine.roundStatusKind 的 not-started 分支。 */
const ROUND_NOT_STARTED_RE = /not started|not_started|upcoming|scheduled|pending/;
/** 未开始态统一理由（四态口径 · 03-PRD §4.4 empty 之②"比赛刚开始"）。 */
const NOT_STARTED_REASON = "The final has not started yet — nothing can be decided until climbing begins.";

function isRoundFinished(snapshot: CompetitionSnapshot): boolean {
  return ROUND_FINISHED_RE.test(String(snapshot.roundStatus ?? "").toLowerCase());
}

/**
 * 轮次未开始 → 强制全员 undecided（硬约束 · PM 2026-07-08 · ROUND-5）。
 * 理由：开场前无法预知退赛/DNS，即便 2 人场也不得提前判 locked/eliminated
 * （不能靠 k>pruneK 剪枝"碰巧"全 undecided——那只在 ≥6 人成立）。
 * 判定：显式 roundStatus 未开始词，或全场无任何进展（无人有 top/zone/出手 · 抱石）
 * 且无人已上场（难度赛全员 waiting）。"无进展"优先于结束态兜底 finished+零攀爬的退化情形。
 */
function isRoundNotStarted(snapshot: CompetitionSnapshot): boolean {
  if (ROUND_NOT_STARTED_RE.test(String(snapshot.roundStatus ?? "").toLowerCase())) return true;
  const boulderStarted = snapshot.athletes.some((result) => result.boulders.some(hasBoulderProgress));
  const leadStarted = (snapshot.lead?.genders ?? []).some((group) => group.athletes.some((athlete) => athlete.status !== "waiting"));
  return !boulderStarted && !leadStarted;
}

function hasBoulderProgress(boulder: BoulderResult): boolean {
  return boulder.hasTop || boulder.hasZone || (boulder.attemptsToTop ?? 0) > 0 || (boulder.attemptsToZone ?? 0) > 0;
}

/** 未开始态：全员金银铜三项 undecided。 */
function notStartedChances(
  snapshot: CompetitionSnapshot,
  discipline: Discipline,
  pageLevelTrust: "stale" | undefined
): MedalChances {
  const ids = discipline === "lead"
    ? snapshot.lead?.genders.flatMap((group) => group.athletes.map((athlete) => athlete.athlete.id)) ?? []
    : snapshot.athletes.map((result) => result.athlete.id);
  return {
    discipline,
    athletes: ids.map((athleteId) => ({
      athleteId,
      outcomes: MEDALS.map((medal) => ({ medal, verdict: "undecided" as MedalVerdict, reason: NOT_STARTED_REASON, conditions: [] }))
    })),
    pageLevelTrust,
    totalRoutes: discipline === "lead" ? BOULDER_FINAL_ROUTES : boulderTotalRoutes(snapshot),
    routesRemaining: true
  };
}

export function deriveMedalChances(
  snapshot: CompetitionSnapshot,
  connectionStatus: CompetitionState["connection"]["status"],
  diff009Fixed: boolean
): MedalChances | undefined {
  try {
    if (!isFinalRound(snapshot)) return undefined;
    const discipline = disciplineOf(snapshot);
    const pageLevelTrust = connectionStatus === "connected" ? undefined : "stale";
    // 未开始硬约束：无视人数与分差，全员 undecided（不得开场前预判 · 退赛/DNS 不可预知）。
    if (isRoundNotStarted(snapshot)) return notStartedChances(snapshot, discipline, pageLevelTrust);
    return discipline === "lead"
      ? deriveLeadMedalChances(snapshot, pageLevelTrust, diff009Fixed)
      : deriveBoulderMedalChances(snapshot, pageLevelTrust);
  } catch {
    // 前瞻推演失败不得让整个 state 500：吞掉异常、置 undefined，成绩主视图不受拖累。
    return undefined;
  }
}

// ============================================================================
// 决赛轮门控 + 赛制判定
// ============================================================================

function disciplineOf(snapshot: CompetitionSnapshot): Discipline {
  if (snapshot.discipline) return snapshot.discipline;
  const text = `${snapshot.formatIdentifier ?? ""} ${snapshot.roundName ?? ""}`.toLowerCase();
  return text.includes("lead") ? "lead" : "boulder";
}

function isFinalRound(snapshot: CompetitionSnapshot): boolean {
  const text = `${snapshot.formatIdentifier ?? ""} ${snapshot.roundName ?? ""}`.toLowerCase();
  if (!/final/.test(text)) return false;
  // "semi-final" 含 final 子串但不是决赛；资格赛同样排除。
  if (/semi|qualif/.test(text)) return false;
  if (disciplineOf(snapshot) === "lead") {
    // 难度赛以 lead.roundType 为准（更可靠）。
    return snapshot.lead?.roundType === "Final" || /final/.test(text);
  }
  return true;
}

// ============================================================================
// 抱石决赛
// ============================================================================

interface Projection {
  athleteId: string;
  name: string;
  firstName: string;
  /** 保底下界：已完成实得 + 当前线保留分 + 未来线×0（TC-MEDAL-011）。 */
  worst: number;
  /** 乐观上界：已完成实得 + 当前线最好可达 + 未来线×25（TC-MEDAL-010）。 */
  best: number;
  /** 还能改善的线路数（best>worst 的线数）· 0 = 已完赛。 */
  liveRoutes: number;
  /** 决赛出场顺序 = 半决赛排名逆序（startOrder 大 = 半决赛好 = 同分占优）· 官方破平主判据。 */
  startOrder: number;
}

function deriveBoulderMedalChances(
  snapshot: CompetitionSnapshot,
  pageLevelTrust: "stale" | undefined
): MedalChances {
  const totalRoutes = boulderTotalRoutes(snapshot);
  const finished = isRoundFinished(snapshot);
  const projections = snapshot.athletes.map((result) => boulderProjection(result, totalRoutes, finished));
  const athletes: AthleteMedalChances[] = projections.map((subject) => ({
    athleteId: subject.athleteId,
    outcomes: MEDALS.map((medal) => boulderOutcome(medal, subject, projections))
  }));

  return {
    discipline: "boulder",
    athletes,
    pageLevelTrust,
    totalRoutes,
    routesRemaining: projections.some((projection) => projection.liveRoutes > 0)
  };
}

function boulderTotalRoutes(snapshot: CompetitionSnapshot): number {
  // 官方线路元数据 ?? 4。现状 IFSC 摄取层无单一官方线路数字段（term-lock 实证）→ 恒走兜底 4。
  // ⚠️ 禁按每选手已渲染线路条数反推：缺 ascents 的选手会被 emptyBouldersFromStartlist 填成 5 条，会误算成 5（TC-MEDAL-009）。
  return officialRouteCount(snapshot) ?? BOULDER_FINAL_ROUTES;
}

function officialRouteCount(_snapshot: CompetitionSnapshot): number | undefined {
  // 预留：未来上游若下发官方线路元数据字段，在此读取；当前无 → undefined 走兜底。
  return undefined;
}

function boulderProjection(
  result: CompetitionSnapshot["athletes"][number],
  totalRoutes: number,
  roundFinished: boolean
): Projection {
  const byBoulder = new Map(result.boulders.map((boulder) => [boulder.boulderNo, boulder]));
  let best = 0;
  let worst = 0;
  let liveRoutes = 0;
  for (let boulderNo = 1; boulderNo <= totalRoutes; boulderNo += 1) {
    const boulder = byBoulder.get(boulderNo);
    if (boulder?.hasTop) {
      // 已登顶：封顶、已定。
      const score = topScore(boulder.attemptsToTop);
      best += score;
      worst += score;
    } else if (roundFinished) {
      // 轮次已结束：一切停在现状（到区分或 0），不存在"还能改善"。
      const score = boulder?.hasZone ? zoneScore(boulder.attemptsToZone) : 0;
      best += score;
      worst += score;
    } else if (boulder && isSettledNoTop(boulder)) {
      // 已结束但未登顶（confirmed/expired 停在现状）：停在到区分或 0。
      const score = boulder.hasZone ? zoneScore(boulder.attemptsToZone) : 0;
      best += score;
      worst += score;
    } else if (boulder && boulder.hasZone) {
      // 当前线已到区未登顶（进行中，还能加一手登顶）：best 计入该线登顶分，worst 保留到区分。
      best += topFromZone(boulder.attemptsToZone);
      worst += zoneScore(boulder.attemptsToZone);
      liveRoutes += 1;
    } else {
      // 当前线未到区 / 未来线（全空）：best 假设 flash 登顶(25)，worst 假设 0。
      best += 25;
      worst += 0;
      liveRoutes += 1;
    }
  }
  return {
    athleteId: result.athlete.id,
    name: result.athlete.name,
    firstName: firstNameOf(result.athlete.name),
    worst: round1(worst),
    best: round1(best),
    liveRoutes,
    startOrder: result.athlete.startOrder
  };
}

function isSettledNoTop(boulder: BoulderResult): boolean {
  // "locked" = 上游 IFSC ascent 的"成绩已定"标记（真实源实测 · 与本模块 MedalVerdict "locked" 无关）
  return /confirmed|locked|expired|no score|timeout|time expired/i.test(boulder.rawStatus ?? "");
}

// —— 抱石计分权重（term-lock：Top 25 / Zone 10 · 每多一手 −0.1；与 scoreBoulders 同款，不另设魔法数）——
function topScore(attemptsToTop?: number): number {
  return 25 - 0.1 * Math.max(0, (attemptsToTop ?? 1) - 1);
}
function zoneScore(attemptsToZone?: number): number {
  return 10 - 0.1 * Math.max(0, (attemptsToZone ?? 1) - 1);
}
/** 当前线已到区、再加一手登顶可达分（attemptsToTop = attemptsToZone + 1）· TC-MEDAL-010：zone 用 1 手 → 24.9。 */
function topFromZone(attemptsToZone?: number): number {
  return 25 - 0.1 * Math.max(0, (attemptsToZone ?? 0));
}

// —— 抱石单奖牌项判定 ——
function boulderOutcome(medal: MedalKind, subject: Projection, all: Projection[]): MedalOutcome {
  const targetRank = medalRank(medal);
  const opponents = all.filter((projection) => projection.athleteId !== subject.athleteId);

  // 一定排在 subject 前的对手：worst_i 已压过 subject 的 best。
  const sureAhead = opponents.filter((opponent) => beats(opponent.worst, opponent.startOrder, subject.best, subject.startOrder));
  // 可能排在 subject 前的对手：best_i 能压过 subject 的 worst。
  const maybeAhead = opponents.filter((opponent) => beats(opponent.best, opponent.startOrder, subject.worst, subject.startOrder));
  const bestRank = 1 + sureAhead.length; // subject 的最好名次
  const worstRank = 1 + maybeAhead.length; // subject 的最差名次

  if (worstRank <= targetRank) {
    // worstRank = 保底名次（已完赛时 = 最终名次）· 传入以判"该项是否为其实际锁定的最高名次"（问题三 · ROUND-4）。
    return { medal, verdict: "locked", reason: lockedReason(medal, subject, worstRank), conditions: [] };
  }
  if (bestRank > targetRank) {
    return { medal, verdict: "eliminated", reason: eliminatedReason(medal, subject), conditions: [] };
  }

  // 争牌中：摆动对手 = 可能在前但不一定在前的对手。
  const swing = maybeAhead.filter((opponent) => !sureAhead.includes(opponent));
  if (swing.length > PRUNE_K) {
    // 关键对手过多 → 禁静默丢对手产出"看似完整实则漏对手"的条件（TC-MEDAL-045）。
    return {
      medal,
      verdict: "undecided",
      reason: "Too many contenders in play — check back soon.",
      conditions: []
    };
  }

  const slack = targetRank - 1 - sureAhead.length; // 还能容许几名摆动对手排在她前面
  return buildNeedsConditions(medal, subject, swing, slack);
}

/**
 * 组合生成（PM 2026-07-08 候选 A · "剩余还需分"下限口径 · ROUND-5）· 名次阶梯法。
 * 只对"摆动对手"（swing = 可能在前但不必然在前的边界对手）排阶梯——已锁定在她前面的对手
 * （sureAhead，如争铜时的金/银得主）是"允许在前"的名额，不进"需失手"从句。
 * X = 挤进第 targetRank 名的最低总分 − 已完成实得(banked=worst)，均三态口径 · 末线必 ≤25。
 * 阶梯：k=0 压过第 (slack+1) 名摆动对手（纯靠自己，最可控，排最前）；k 递增 = 让最强的 k 名摆动
 * 对手失手、自己少拿一点（X 递减）。四类：a=k0 无从句 · b=k≥1 带从句 · c=a、b 并存都产出轮换 ·
 * d=自己已爬完(routesLeft=0)只写对手从句 "Takes {medal} unless …"。
 * 注：新口径豁免字面 "at best"（下限语义与"上界"提示相斥）；数据不确定性由两层可信度承载
 * （页面级 stale + 条件级 top_unconfirmed），不随词一起删。
 */
function buildNeedsConditions(
  medal: MedalKind,
  subject: Projection,
  swing: Projection[],
  slack: number
): MedalOutcome {
  const banked = round1(subject.worst);
  const remainingMax = round1(subject.best - banked); // 自身剩余线还能加的上界
  const routesLeft = subject.liveRoutes;
  const done = routesLeft === 0;
  const reason = needsReason(medal, subject);
  const allow = Math.max(0, slack); // 允许在前的摆动对手数
  const ranked = [...swing].sort((a, b) => b.best - a.best); // 摆动对手按上界降序
  const combos: MedalCondition[] = [];
  const seen = new Set<string>();
  const add = (summary: string) => { if (summary && !seen.has(summary)) { seen.add(summary); combos.push({ summary }); } };

  if (done) {
    // d 类：自己已爬完，无自身动作。她保住第 targetRank 名，除非 > allow 名能反超者(best>banked)反超。
    const overtakers = ranked.filter((o) => o.best - banked > EPS);
    if (overtakers.length === 0) {
      add(`Takes ${medalWord(medal)} — the remaining climbers can no longer catch her.`);
    } else {
      // 命名"再多 1 名反超即丢牌"的关键对手（第 allow+1 名及其同档）。
      add(dependsOnlyCombo(medal, subject, overtakers.slice(0, allow + 1), "Takes"));
    }
    return { medal, verdict: "needs_conditions", reason, conditions: combos };
  }

  // 非 done：名次阶梯。idx = 要压过的摆动对手序号（allow..ranked.length，末级 undefined=纯防守）。
  //   每级取一个"目标总分 target"（压过 ranked[idx] 及其以下所有人），idx 越大 target 越低、越靠对手失手。
  //   Bug B 修复（问题一·B）：只保留 X 严格递减的级——分数相同却依赖更多对手 = 冗余，跳过（前级已用更少对手覆盖）。
  //   Bug A 修复（问题一·A · 铁律）：某级"需失手"对手 = 该 target 下仍能反超她的【全部】摆动对手（beats，含同分靠
  //     countback 反超者）扣掉允许在前的 allow 名——按构造覆盖名次线上所有威胁，绝不靠"分数隐式压过"而漏列。
  let lastX = Number.POSITIVE_INFINITY;
  for (let idx = allow; idx <= ranked.length && combos.length <= MAX_COMBINATIONS + 1; idx += 1) {
    const bar = idx < ranked.length ? ranked[idx] : undefined; // 名次线上要压过的 binding 对手
    // 决定 2 · countback 方向判定（官方口径 · CONTRACT-DRIFT-1）：bar 成绩已定 + 区间真重叠 →
    //   方向由半决赛排名(startOrder)定：A 出场更晚(startOrder 大)同分 A 胜(打平即可)，否则 A 输(须超过 +0.1)。
    const barSettled = !!bar && Math.abs(bar.best - bar.worst) <= EPS;
    const canTie = barSettled && subject.best + EPS >= bar!.best && bar!.best + EPS >= subject.worst;
    const tieWin = canTie && bar ? compareSemifinalRank(subject.startOrder, bar.startOrder) > 0 : false;
    const target = bar ? round1(bar.best + (tieWin ? 0 : 0.1)) : banked; // 压过 bar 的最低总分（A 胜同分→打平）
    const x = round1(target - banked);
    if (x < -EPS || x > remainingMax + EPS) continue; // 负=已够(应已locked) / 超上界=够不着
    if (x >= lastX - EPS) continue; // Bug B：X 未严格低于上一保留级 → 冗余，跳过
    // 该目标分 target 下的威胁划分（问题一铁律：只产出【可行且完整】的条件）：
    //   threats   = 上界能反超她的摆动对手（含同分靠 countback 反超者）= 名次线上全部威胁；
    //   certainly = 连下界(worst)都已反超她的 target = 成绩已定/保底已够 → 无法再靠"失手"劝退。
    const threats = ranked.filter((o) => beats(o.best, o.startOrder, target, subject.startOrder));
    const certainly = threats.filter((o) => beats(o.worst, o.startOrder, target, subject.startOrder));
    if (certainly.length > allow) continue; // 铁定在前者已超过允许数 → 该分数拿不到该名次 = 不可行，跳过（绝不写"让已定选手失手"的假条件）
    const removable = threats.filter((o) => !certainly.includes(o)); // 可能反超但仍能被劝退（还在爬）的威胁
    const holdOff = removable.slice(Math.max(0, allow - certainly.length)); // 允许名额先扣给铁定者，其余可劝退威胁必须全部失手
    lastX = x;
    const cb: CountbackNote | undefined = canTie && bar
      ? { kind: tieWin ? "win" : "lose", opponent: bar.firstName, subject: subject.firstName }
      : undefined;
    if (x <= EPS) {
      // 防守级（自身无需再拿分）：能守住(certainly ≤ allow 已在上面校验)，纯靠这些还能反超者别追上。
      if (holdOff.length > 0) add(dependsOnlyCombo(medal, subject, holdOff, "Holds"));
      continue;
    }
    add(holdOff.length === 0 ? selfCombo(subject, x, routesLeft, cb) : helpCombo(subject, x, holdOff, routesLeft, cb));
  }
  if (combos.length === 0) {
    // 理论兜底：压过第 allow 名（若存在）纯靠自己。
    const idx = Math.min(allow, ranked.length - 1);
    const x = idx >= 0 && ranked[idx] ? Math.max(0, round1(ranked[idx].best + 0.1 - banked)) : 0;
    add(selfCombo(subject, Math.min(x, remainingMax), routesLeft));
  }
  // ROUND-6：degraded(组合>5→概括) 死分支已移除——名次阶梯下 swing≤PRUNE_K(4)（否则 boulderOutcome 已判 undecided），
  // 故组合恒 ≤ ranked.length−allow+1 ≤ 5，degraded 永不触发（PM 灰度决定 3 确认）。
  return { medal, verdict: "needs_conditions", reason, conditions: combos.slice(0, MAX_COMBINATIONS) };
}

/** countback 方向说明（官方半决赛排名破平 · CONTRACT-DRIFT-1）。 */
interface CountbackNote {
  kind: "win" | "lose"; // win = A 同分占优（半决赛更好）· lose = A 同分吃亏
  opponent: string; // binding 对手 first name
  subject: string; // 目标选手 A first name（"you"→A 名字 · PM 2026-07-08）
}

/** countback 说明短语（决定 2 · 官方口径 · A 用 first name 保持人称统一）。 */
function countbackPhrase(cb: CountbackNote): string {
  return cb.kind === "win"
    ? ` — a points tie with ${cb.opponent} then goes to ${cb.subject} (better semi-final ranking)`
    : ` — even matching ${cb.opponent}'s score isn't enough, ${cb.opponent} takes it on semi-final ranking`;
}

// —— 末线"第几把内登顶"精确临界（PM 灰度：top 分随出手数变化，非单一值）——
//   第 att 把登顶 = 25 − 0.1×(att−1)：flash=25、2 把=24.9、3 把=24.8…；zone 上限=10。
//   末线登顶现实把数上限：决赛一条线多在数把内登顶，超过即视作"任何现实登顶都够"，把数不再是有效约束
//   → 退回分数（自身）/ 笼统 "tops"（对手）。
const MAX_TOP_ATTEMPTS = 8;
/** 达到末线分数线 lc 所需"第几把内登顶"——仅当 lc 必须靠登顶(>zone 上限 10)且把数在现实范围(≤MAX)才返回；否则 null。 */
function topAttemptsFor(lc: number): number | null {
  if (lc <= 10 + EPS || lc > 25 + EPS) return null; // ≤zone 可达（非登顶阈值）/ >flash 不可达 → 不用把数
  const n = 1 + Math.floor((25 - lc) / 0.1 + EPS);
  return n >= 1 && n <= MAX_TOP_ATTEMPTS ? n : null;
}
/** 对手末线达到某分数线才反超 → 若只剩末线一条 + 必须登顶且把数有效，返回精确"第几把内"；否则 null。 */
function opponentTopAttempts(subject: Projection, opponent: Projection, subjectLine: number): number | null {
  if (opponent.liveRoutes !== 1) return null; // 变量不止末线一条（多条未爬）→ 把数框架不适用
  const oppWinsTie = compareSemifinalRank(opponent.startOrder, subject.startOrder) > 0;
  const lc = round1(subjectLine - opponent.worst + (oppWinsTie ? 0 : 0.1)); // 反超 subjectLine 所需末线分（含同分方向）
  return topAttemptsFor(lc);
}

/** 自身达线句主体（末线登顶→"第几把内"；否则下限 X 分 / 多线两句式）+ 触发时的方向 countback 说明。 */
function selfMilestone(x: number, routesLeft: number, cb?: CountbackNote): string {
  const n = routesLeft === 1 ? topAttemptsFor(x) : null;
  let need: string;
  if (n !== null) {
    // 末线必须登顶且把数是有效约束 → 用"第几把内登顶"表达（比分数直观 · PM 灰度点 3）。
    need = n === 1 ? "Flashes her last boulder" : `Tops her last boulder in ${n} attempts or fewer`;
  } else {
    need = routesLeft === 1
      ? `Needs at least ${formatScore(x)} on the last boulder`
      : `Needs at least ${formatScore(x)} more across the remaining ${routesLeft} boulders`;
  }
  return cb ? `${need}${countbackPhrase(cb)}` : need;
}

/** a 类：纯靠自己。 */
function selfCombo(subject: Projection, x: number, routesLeft: number, cb?: CountbackNote): string {
  return `${selfMilestone(x, routesLeft, cb)}.`;
}

/**
 * b 类：自己达线 + 对手失手。
 * PM 灰度决定 3：单条组合内对手从句 ≥3 → 概括为 "needs [A], [B] and [C] to all fall short."
 * （保留"全都失手"逻辑方向，不用暧昧的 "depends on the performance of …"）。
 */
function helpCombo(subject: Projection, x: number, holdOff: Projection[], routesLeft: number, cb?: CountbackNote): string {
  const need = selfMilestone(x, routesLeft, cb);
  // 决定 3 + 问题二修复：对手计数含 countback 从句涉及的对手（cb 里的 bar 也算一名）。
  //   合计（holdOff + cb）≥3 → 把"需失手"从句概括为 "needs [A], [B] … to (all) fall short"（保留失手方向）。
  const mentioned = holdOff.length + (cb ? 1 : 0);
  if (mentioned >= 3) {
    const tail = holdOff.length >= 3 ? "to all fall short" : "to fall short";
    return `${need}, and needs ${nameList(holdOff)} ${tail}.`;
  }
  const subjectLine = round1(subject.worst + x); // 该组合下 subject 的达线总分（对手须落在其下）
  return `${need}, and ${holdOff.map((o) => holdClause(subject, o, subjectLine)).join(", and ")}.`;
}

/**
 * d 类：无自身达线部分，纯看对手不反超（done → "Takes"；还在爬但已达线 → "Holds"）。
 * 决定 3：≥3 反超者 → 概括为 "unless any of [A], [B] and [C] catches her."（方向=他们反超）。
 */
function dependsOnlyCombo(medal: MedalKind, subject: Projection, holdOff: Projection[], verb: "Takes" | "Holds"): string {
  if (holdOff.length >= 3) {
    return `${verb} ${medalWord(medal)} unless any of ${nameList(holdOff)} catches her.`;
  }
  // done(worst=best=最终分) 与防守级(x=0，停在 banked) 下 subject 最终分均 = subject.worst。
  const subjectLine = subject.worst;
  return `${verb} ${medalWord(medal)} unless ${holdOff.map((o) => overtakeClause(subject, o, subjectLine)).join(" or ")}.`;
}

/**
 * 对手"别反超"从句（PM 灰度：top 分随出手数变化，非单一值）——优先精确到"第几把内登顶"：
 *   对手只剩末线一条 + 反超须登顶且把数有效 → "does not top … in N attempts or fewer"（或 flash）；
 *   否则退回：能登顶才超过 → 要求别登顶；再否则看同分方向——
 *   对手半决赛占优(startOrder 大 → 同分即反超) → 严格落后 "finishes below her"；否则(subject 破平胜) → "does not out-score her"。
 *   （不区分方向会把"对手打平即夺牌"漏写成可打平 = 假条件，违反问题一铁律。）
 */
function holdClause(subject: Projection, opponent: Projection, subjectLine: number): string {
  const n = opponentTopAttempts(subject, opponent, subjectLine);
  if (n !== null) return n === 1 ? `${opponent.firstName} does not flash her last boulder` : `${opponent.firstName} does not top her last boulder in ${n} attempts or fewer`;
  if (opponent.best - subject.best > EPS) return `${opponent.firstName} does not top her last boulder`;
  return compareSemifinalRank(opponent.startOrder, subject.startOrder) > 0
    ? `${opponent.firstName} finishes below her`
    : `${opponent.firstName} does not out-score her`;
}

/** d 类反向从句：对手"反超"才让 subject 丢牌（精确把数优先 · 同分方向同 holdClause）。 */
function overtakeClause(subject: Projection, opponent: Projection, subjectLine: number): string {
  const n = opponentTopAttempts(subject, opponent, subjectLine);
  if (n !== null) return n === 1 ? `${opponent.firstName} flashes her last boulder` : `${opponent.firstName} tops her last boulder in ${n} attempts or fewer`;
  if (opponent.best - subject.best > EPS) return `${opponent.firstName} tops her last boulder`;
  return compareSemifinalRank(opponent.startOrder, subject.startOrder) > 0
    ? `${opponent.firstName} catches her`
    : `${opponent.firstName} out-scores her`;
}

/** first-name 列表："A"、"A and B"、"A, B and C"。 */
function nameList(opponents: Projection[]): string {
  const names = opponents.map((o) => o.firstName);
  if (names.length <= 1) return names.join("");
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// ============================================================================
// 难度决赛（Lead）
// ============================================================================

interface LeadProjection {
  athleteId: string;
  name: string;
  firstName: string;
  worst: number;
  best: number;
  live: boolean;
  /** best 上界是否依赖"能登顶"（waiting/climbing 才有登顶可能）。 */
  canTop: boolean;
  /** 决赛出场顺序 = 半决赛排名逆序（startOrder 大 = 半决赛好 = 同分占优）· 官方 §7.3 第一级破平。 */
  startOrder: number;
}

function deriveLeadMedalChances(
  snapshot: CompetitionSnapshot,
  pageLevelTrust: "stale" | undefined,
  diff009Fixed: boolean
): MedalChances {
  const routeTop = snapshot.lead?.routeTop ?? 100;
  const finished = isRoundFinished(snapshot);
  const leadAthletes = snapshot.lead?.genders.flatMap((group) => group.athletes) ?? [];
  const projections = leadAthletes.map((athlete) => leadProjection(athlete, routeTop, finished));
  const athletes: AthleteMedalChances[] = projections.map((subject) => ({
    athleteId: subject.athleteId,
    outcomes: MEDALS.map((medal) => leadOutcome(medal, subject, projections, routeTop, diff009Fixed))
  }));

  return {
    discipline: "lead",
    athletes,
    pageLevelTrust,
    // 难度赛无"线路数"概念，沿用抱石字段语义给 4（前端不据此渲染难度赛线路）。
    totalRoutes: BOULDER_FINAL_ROUTES,
    routesRemaining: projections.some((projection) => projection.live)
  };
}

function leadProjection(athlete: LeadResult, routeTop: number, roundFinished: boolean): LeadProjection {
  const current = leadScore(athlete);
  const settled = roundFinished || athlete.status === "fall" || athlete.status === "dns" || athlete.status === "top";
  const live = !settled && (athlete.status === "waiting" || athlete.status === "climbing");
  const best = settled ? current : routeTop; // 未爬完 → 上界=登顶满分
  const worst = athlete.status === "climbing" ? current : settled ? current : 0;
  return {
    athleteId: athlete.athlete.id,
    name: athlete.athlete.name,
    firstName: firstNameOf(athlete.athlete.name),
    worst: round1(worst),
    best: round1(best),
    live,
    canTop: live,
    startOrder: athlete.athlete.startOrder
  };
}

function leadScore(athlete: LeadResult): number {
  return athlete.hold + (athlete.plus ? 0.25 : 0);
}

function leadOutcome(
  medal: MedalKind,
  subject: LeadProjection,
  all: LeadProjection[],
  routeTop: number,
  diff009Fixed: boolean
): MedalOutcome {
  const targetRank = medalRank(medal);
  const opponents = all.filter((projection) => projection.athleteId !== subject.athleteId);
  // 同分破平用半决赛排名（startOrder · 官方 §7.3 第一级 · 与抱石一致）。
  const sureAhead = opponents.filter((opponent) => beats(opponent.worst, opponent.startOrder, subject.best, subject.startOrder));
  const maybeAhead = opponents.filter((opponent) => beats(opponent.best, opponent.startOrder, subject.worst, subject.startOrder));
  const bestRank = 1 + sureAhead.length;
  const worstRank = 1 + maybeAhead.length;

  if (worstRank <= targetRank) {
    return { medal, verdict: "locked", reason: lockedReasonLead(medal), conditions: [] };
  }
  if (bestRank > targetRank) {
    return { medal, verdict: "eliminated", reason: eliminatedReasonLead(medal), conditions: [] };
  }

  const swing = maybeAhead.filter((opponent) => !sureAhead.includes(opponent));
  if (swing.length > PRUNE_K) {
    return { medal, verdict: "undecided", reason: "Too many contenders in play — check back soon.", conditions: [] };
  }

  // 目标分数线 X = 压过当前第 targetRank 名所需 leadScore（只看自身数值分，不依赖他人登顶 · TC-MEDAL-012）。
  // 决定 4：难度赛口径保持"总分"（Score at least X · 不换剩余分）· 去字面 "at best"。
  const blocker = [...opponents].sort((a, b) => b.worst - a.worst)[targetRank - 1]; // 名次线上的 binding 对手
  const threshold = leadThreshold(subject, opponents, targetRank);
  const conditions: MedalCondition[] = [];
  if (threshold !== undefined) {
    const dependsOnTop = threshold >= routeTop - EPS; // 达线需接近/达到登顶 → 依赖登顶判定
    if (!dependsOnTop) {
      // 纯分数线（自身数值分 · 不依赖他人登顶）：始终产出（TC-MEDAL-012）· 决定 4：保持"总分"口径、去 at best。
      // 决定 2 · countback 方向（官方 §7.3 第一级 = 半决赛排名 · CONTRACT-DRIFT-1）：blocker 成绩已定 +
      //   区间可同分时，方向由 startOrder 定（A 出场更晚则同分 A 胜、否则须彻底超过）。§7.3 第二级"时间"是
      //   硬编码估计值、不可用，但半决赛排名（startOrder 不重复）已破全部平、时间级不触达。
      const blockerSettled = blocker && Math.abs(blocker.best - blocker.worst) <= EPS;
      const canTie = blockerSettled && subject.best + EPS >= blocker!.worst && blocker!.worst + EPS >= subject.worst;
      const tieWin = canTie && blocker ? compareSemifinalRank(subject.startOrder, blocker.startOrder) > 0 : false;
      const score = tieWin ? Math.max(subject.worst, blocker!.worst) : threshold; // A 胜同分 → 打平即可
      const cb: CountbackNote | undefined = canTie && blocker
        ? { kind: tieWin ? "win" : "lose", opponent: blocker.firstName, subject: subject.firstName }
        : undefined;
      conditions.push({ summary: `Score at least ${formatScore(score)} on the final route${cb ? countbackPhrase(cb) : ""}.` });
    } else if (subject.canTop && diff009Fixed) {
      // 依赖登顶：DIFF-009 修好后才产出，并带条件级"登顶待官方确认"括注（TC-MEDAL-014/016）。
      conditions.push({
        summary: `Top the final route at best — a sub-top score is not enough.`,
        conditionLevelTrust: "top_unconfirmed"
      });
    }
    // diff009Fixed=false 且依赖登顶 → 不产出该条（TC-MEDAL-013）。
  }

  if (conditions.length === 0) {
    // 唯一可行路径依赖登顶但 DIFF-009 未修 → 该项降级 undecided（不产出存疑条件）。
    return {
      medal,
      verdict: "undecided",
      reason: "The remaining outcome depends on a top that is not yet officially confirmed.",
      conditions: []
    };
  }
  return { medal, verdict: "needs_conditions", reason: needsReasonLead(medal), conditions };
}

/** subject 要挤进第 targetRank 名，需超过当前第 targetRank 名对手的保底分。 */
function leadThreshold(subject: LeadProjection, opponents: LeadProjection[], targetRank: number): number | undefined {
  const ahead = [...opponents].sort((a, b) => b.worst - a.worst);
  const blocker = ahead[targetRank - 1]; // 第 targetRank 名位置的对手（0-indexed）
  if (!blocker) return subject.worst; // 对手不足 → 现状即可
  // 需比该对手保底分高一个最小步长（0.1）；若已够则维持现状。
  return subject.best >= blocker.worst + EPS ? Math.max(subject.worst, blocker.worst + 0.1) : blocker.worst + 0.1;
}

// ============================================================================
// 名次判定通用工具
// ============================================================================

function medalRank(medal: MedalKind): number {
  return medal === "gold" ? 1 : medal === "silver" ? 2 : 3;
}

/** 分数 + 半决赛排名联合判定：scoreX 是否排在 scoreY 前面（同分由半决赛排名破平 · startOrder 大者胜 · 官方 §7.1）。 */
function beats(scoreX: number, startOrderX: number, scoreY: number, startOrderY: number): boolean {
  if (scoreX > scoreY + EPS) return true;
  if (Math.abs(scoreX - scoreY) <= EPS) return compareSemifinalRank(startOrderX, startOrderY) > 0;
  return false;
}

/** 从 k 个元素中选 count 个的全部子集（count<=k）· 用于组合枚举，超上限交由上层 degrade。 */
function chooseSubsets<T>(items: T[], count: number): T[][] {
  if (count <= 0) return [[]];
  if (count >= items.length) return [items.slice()];
  const result: T[][] = [];
  const backtrack = (start: number, chosen: T[]) => {
    if (chosen.length === count) {
      result.push(chosen.slice());
      return;
    }
    for (let i = start; i < items.length; i += 1) {
      chosen.push(items[i]);
      backtrack(i + 1, chosen);
      chosen.pop();
      if (result.length > MAX_COMBINATIONS) return; // 早停：超上限即够触发 degrade
    }
  };
  backtrack(0, []);
  return result;
}

// ============================================================================
// 文案（英文 · 引用他人用 first name）
// ============================================================================

function lockedReason(medal: MedalKind, subject: Projection, guaranteedRank: number): string {
  if (subject.liveRoutes === 0) {
    // 问题三：已定结果不应有 "or better"——仅当该奖牌项 = 选手实际锁定的最高名次（medalRank === 保底名次）
    // 时去掉；低于其最终名次的奖牌项保留 "or better"（如金牌得主的银/铜项仍是"银牌或更好"）。
    const suffix = medalRank(medal) === guaranteedRank ? "" : " or better";
    return `Her final score already secures ${medalWord(medal)}${suffix}.`;
  }
  return `Cannot drop below ${ordinal(medalRank(medal))} even in the worst case.`;
}
function eliminatedReason(medal: MedalKind, subject: Projection): string {
  return `Even at her best she can no longer reach ${ordinal(medalRank(medal))} — ${medalWord(medal)} is out of reach.`;
}
function needsReason(medal: MedalKind, subject: Projection): string {
  return `${medalWord(medal)} is still in play with ${subject.liveRoutes} boulder${subject.liveRoutes === 1 ? "" : "s"} left.`;
}
function lockedReasonLead(medal: MedalKind): string {
  return `Cannot drop below ${ordinal(medalRank(medal))} — ${medalWord(medal)} is secured.`;
}
function eliminatedReasonLead(medal: MedalKind): string {
  return `Even topping the route cannot reach ${ordinal(medalRank(medal))} — ${medalWord(medal)} is out of contention.`;
}
function needsReasonLead(medal: MedalKind): string {
  return `${medalWord(medal)} depends on her score on the final route.`;
}

function medalWord(medal: MedalKind): string {
  return medal.charAt(0).toUpperCase() + medal.slice(1);
}
function ordinal(n: number): string {
  return n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;
}
function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
function formatScore(value: number): string {
  const rounded = round1(value);
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
