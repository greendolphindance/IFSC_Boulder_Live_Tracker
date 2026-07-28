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
// 必修3：三个状态判定统一用【精确白名单集合 · 全等比较】，不用无边界 test()——
//   旧无边界子串匹配会把 "unfinished"/"not finished"/"incomplete"/"suspended"(含 ended) 误判成已结束（最高危：
//   一击收敛全场区间、比赛中途误产 locked/eliminated），"rescheduled"(含 scheduled)/"pending review"(含 pending)
//   误判未开始，"unlocked"/"not confirmed" 误判成绩已定。全等比较把这些否定/前缀词干净排除。
const FINISHED_STATUSES = new Set(["finished", "complete", "completed", "closed", "archived", "ended"]);
// 核实1（真实数据 · Chamonix Lead SF）：上游"pending"是【选手级】"这个人还没上场"，不是【轮次级】未开始
//   （进行中的轮里后面没上场的选手全是 pending，轮次级 roundStatus 却是 "active"）。故从轮次未开始词表移除
//   "pending"，避免与选手级混淆；真正的轮次未开始由下方"全场无任何进展"兜底判（不依赖此词）。
const NOT_STARTED_STATUSES = new Set(["not started", "not_started", "upcoming", "scheduled"]);
/** 归一化：去首尾空白 + 小写 + 内部连续空白折叠为单空格（下划线保留原样，匹配 "not_started" 这类原始 token）。 */
function normalizeStatus(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}
/** 未开始态统一理由（四态口径 · 03-PRD §4.4 empty 之②"比赛刚开始"）。 */
const NOT_STARTED_REASON = "The final has not started yet — nothing can be decided until climbing begins.";

function isRoundFinished(snapshot: CompetitionSnapshot): boolean {
  return FINISHED_STATUSES.has(normalizeStatus(snapshot.roundStatus));
}

/**
 * 轮次未开始 → 强制全员 undecided（硬约束 · PM 2026-07-08 · ROUND-5）。
 * 理由：开场前无法预知退赛/DNS，即便 2 人场也不得提前判 locked/eliminated
 * （不能靠 k>pruneK 剪枝"碰巧"全 undecided——那只在 ≥6 人成立）。
 * 判定：显式 roundStatus 未开始词，或全场无任何进展（无人有 top/zone/出手 · 抱石）
 * 且无人已上场（难度赛全员 waiting）。"无进展"优先于结束态兜底 finished+零攀爬的退化情形。
 */
function isRoundNotStarted(snapshot: CompetitionSnapshot): boolean {
  if (NOT_STARTED_STATUSES.has(normalizeStatus(snapshot.roundStatus))) return true;
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
  /** 单条 live 线时（liveRoutes===1）那条线当前已入账的 worst 贡献（已到区=zoneScore，未到区=0）。
   *  必修4/7：把数框架按【绝对末线目标分 = x + lastLineFloor】换算，不减已得 zone 分。 */
  lastLineFloor: number;
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
  let lastLineFloor = 0; // 最近一条 live 线的 worst 贡献（liveRoutes===1 时即那条唯一末线的 floor）
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
      lastLineFloor = zoneScore(boulder.attemptsToZone); // 该 live 线已入账到区分
    } else {
      // 当前线未到区 / 未来线（全空）：best 假设 flash 登顶(25)，worst 假设 0。
      // TODO(KNOWN-ISSUE · ROUND-10 · PM 决定暂不修)：当前【正在爬】的线若已出手几次仍未到区，
      //   现实最好可达只是 topScore(已出手数+1) < 25，但此处一律按 flash(25) → best 偏高、可能漏判 eliminated。
      //   数据可拿"进行中已出手数"(attemptsToTop/attemptsToZone 或 rawStatus="A{n}")，但需真实进行中比赛数据验证，
      //   当前无比赛。待有进行中真实数据后按已出手数收敛 best。详见 08-修复历史 [TODO/KNOWN-ISSUE-1]。
      best += 25;
      worst += 0;
      liveRoutes += 1;
      lastLineFloor = 0; // 该 live 线未到区，无入账
    }
  }
  return {
    athleteId: result.athlete.id,
    name: result.athlete.name,
    firstName: firstNameOf(result.athlete.name),
    worst: round1(worst),
    best: round1(best),
    liveRoutes,
    lastLineFloor: round1(lastLineFloor),
    startOrder: result.athlete.startOrder
  };
}

/** 单条抱石线"成绩已定"状态词（精确集合 · 必修3）。"locked" 已实测确认为上游成绩已锁定标记
 *  （evidence/upstream-ascent-status-probe.md · 与本模块 MedalVerdict "locked" 无关）；timeout/time expired 为防御性保留。 */
const SETTLED_NOTOP_STATUSES = new Set(["confirmed", "locked", "expired", "no score", "timeout", "time expired"]);
function isSettledNoTop(boulder: BoulderResult): boolean {
  // 全等比较：不会把 "unlocked"/"not confirmed"/"unconfirmed" 误判成已定（旧无边界 test 会）。
  return SETTLED_NOTOP_STATUSES.has(normalizeStatus(boulder.rawStatus));
}

// —— 抱石计分权重（term-lock：Top 25 / Zone 10 · 每多一手 −0.1；与 scoreBoulders 同款，不另设魔法数）——
function topScore(attemptsToTop?: number): number {
  return 25 - 0.1 * Math.max(0, (attemptsToTop ?? 1) - 1);
}
function zoneScore(attemptsToZone?: number): number {
  return 10 - 0.1 * Math.max(0, (attemptsToZone ?? 1) - 1);
}
/**
 * 当前线已到区、仍在墙上时的【最好可达】分（best 上界口径）· 必修6。
 * IFSC 同一把可从到区直接登顶（flash：zone=1,top=1），故最好可达 = `topScore(attemptsToZone)`
 * （attemptsToTop = attemptsToZone），而非旧口径假设"登顶必比到区多一把"的 `25−0.1·z`（少 0.1）。
 * 少算 0.1 会在同分临界翻转（误判 eliminated）。数据无法区分"到区后已脱落 / 仍在墙上"，按规格
 * best=乐观上界一律取本把登顶（TC-MEDAL-010 随此从 24.9 修正为 25：到区 1 手的乐观上界=flash top）。
 */
function topFromZone(attemptsToZone?: number): number {
  return topScore(attemptsToZone);
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
  // 第二组·信息量重构：每条 combo 附带其【涉及对手数 opp】——≤2 有价值(照常展示)，≥3 无价值
  //   (所有无价值路径并入轮换里的一格；若全部路径都无价值则整项降级 undecided)。见 finalizeNeeds。
  const combos: ScoredCombo[] = [];
  const seen = new Set<string>();
  const add = (entry: ScoredCombo) => { if (entry.summary && !seen.has(entry.summary)) { seen.add(entry.summary); combos.push(entry); } };

  if (done) {
    // d 类：自己已爬完（best=worst=banked），无自身动作。
    // 必修1：overtakers = 仍能反超她 banked 的【全部】摆动对手，判定用 beats（含"同分且对手半决赛占优"的反超者）。
    const overtakers = ranked.filter((o) => beats(o.best, o.startOrder, banked, subject.startOrder));
    if (overtakers.length <= allow) {
      add({ summary: `Takes ${medalWord(medal)} — the remaining climbers can no longer catch her.`, opp: 0 });
    } else {
      add({ summary: dependsOnlyCombo(medal, subject, overtakers, "Takes", allow), opp: overtakers.length });
    }
  } else {

  // 修复2 · 充要门：所有还能威胁该名次的摆动对手都已定死（best==worst），只剩 subject 自己是变量 → 存在唯一
  //   门槛"达到 X 即拿牌、达不到即拿不到"（观众最想要的答案）。只出这一条【必要式】，不出充分阶梯（其余档都是
  //   它的特例，冗余且误导）。门槛 = 压过"获准在前的 allow 名之后"最强的已定对手（含 countback）；出界则兜底走阶梯。
  if (swing.every((o) => o.best - o.worst <= EPS)) {
    const mustBeat = ranked.slice(allow); // 须真正压过的已定对手；前 allow 名最强者获准在前
    let targetFinal = banked;
    for (const o of mustBeat) {
      const win = compareSemifinalRank(subject.startOrder, o.startOrder) > 0; // 平分我赢 → 达其分即够；否则须 +0.1
      const need = round1(o.best + (win ? 0 : 0.1));
      if (need > targetFinal) targetFinal = need;
    }
    const x = round1(targetFinal - banked);
    if (x > EPS && x <= remainingMax + EPS) {
      // 门槛点恰为同分（targetFinal 正好等于某已定对手分）→ 必是"我胜同分"（否则会是 +0.1）→ 标 countback。
      const tiePeer = mustBeat.find((o) => Math.abs(o.best - targetFinal) <= EPS);
      const cb: CountbackNote | undefined = tiePeer ? { kind: "win", opponent: tiePeer.firstName, subject: subject.firstName } : undefined;
      return finalizeNeeds(medal, reason, [{ summary: `${selfNeedMilestone(subject, x)}${cbNote(cb)}.`, opp: cb ? 1 : 0 }], false);
    }
  }

  // 非 done 且无充要（对手仍在变）：名次阶梯 = 候选目标分枚举 + 可行性 + 冗余过滤。
  //   每个 bar 产候选：①"保证压过 bar"（bar 已定可同分且胜 countback → 打平其上界；否则 +0.1 · barSettled 保守口径不变）；
  //   ② 问题2b 补漏：bar 已定、同分吃亏、且有 allow 名额时——"打平 bar 上界"也是真实路径（同分 bar 在前、吃掉
  //      一个名额，其余威胁须失手，如 zone-flash 追平 + 次强失手 → 银）。漏产会让唯一显示的充分条件被误读成必要。
  //   可行性/完整性（问题一铁律）：threats = 该 target 下仍能反超的全部摆动对手；certainly（保底已反超）> allow → 不可行；
  //   冗余：X 严格递减（Bug B）+ 支配过滤（更低 X 且对手要求不更严的级支配更高 X 级）。
  const cands: { target: number; cb?: CountbackNote }[] = [];
  for (let idx = allow; idx < ranked.length; idx += 1) {
    const bar = ranked[idx];
    const barSettled = Math.abs(bar.best - bar.worst) <= EPS;
    const canTie = barSettled && subject.best + EPS >= bar.best && bar.best + EPS >= subject.worst;
    const tieWin = canTie ? compareSemifinalRank(subject.startOrder, bar.startOrder) > 0 : false;
    const cb: CountbackNote | undefined = canTie ? { kind: tieWin ? "win" : "lose", opponent: bar.firstName, subject: subject.firstName } : undefined;
    // Frame5-2：countback 说明只在【该级路径内确有同分可能】时附着——胜同分级 target=bar.best（打平在路径内 ✓）；
    //   吃亏 +0.1 级的打平在阈值之外（打平即失败），不附着 tie 说明。
    cands.push({ target: round1(bar.best + (tieWin ? 0 : 0.1)), cb: tieWin ? cb : undefined });
    if (canTie && !tieWin && allow >= 1) cands.push({ target: round1(bar.best), cb }); // ② 同分吃亏但可用名额吸收 bar（tie 即路径机制 → 说明保留）
  }
  // Frame7-1：自身上限级——当所有"压过 bar"级都够不到（bar 在爬 best 更高）时，
  //   "打满自身上限 + 其余威胁排后面"是仅剩的最高自身路径（可行性/冗余由下方统一闸过滤）。
  cands.push({ target: round1(subject.best) });
  cands.push({ target: banked }); // 防守级（纯靠对手）
  cands.sort((a, b) => b.target - a.target);

  interface Rung { x: number; cb?: CountbackNote; removable: Projection[]; freeSlots: number; mustFall: number; }
  const rungs: Rung[] = [];
  let lastX = Number.POSITIVE_INFINITY;
  for (const cand of cands) {
    const x = round1(cand.target - banked);
    if (x < -EPS || x > remainingMax + EPS) continue; // 负=已够(应已locked) / 超上界=够不着
    if (x >= lastX - EPS) continue; // Bug B：X 未严格低于上一保留级 → 冗余
    const threats = ranked.filter((o) => beats(o.best, o.startOrder, cand.target, subject.startOrder));
    const certainly = threats.filter((o) => beats(o.worst, o.startOrder, cand.target, subject.startOrder));
    if (certainly.length > allow) continue; // 不可行：铁定在前者超过允许数（绝不写"让已定选手失手"的假条件）
    const removable = threats.filter((o) => !certainly.includes(o));
    const freeSlots = allow - certainly.length;
    lastX = x;
    // Frame6-3：胜同分说明的通用补挂——该 target 恰有【已定】对手同分且 subject 胜 countback（如自身上限级
    //   正好追平已定对手），tie 真实可能且分胜负 → 补 win 说明（bar 级已带的 cb 优先）。
    const winPeer = ranked.find((o) => Math.abs(o.best - o.worst) <= EPS && Math.abs(o.best - cand.target) <= EPS && compareSemifinalRank(subject.startOrder, o.startOrder) > 0);
    const cb = cand.cb ?? (winPeer ? { kind: "win" as const, opponent: winPeer.firstName, subject: subject.firstName } : undefined);
    rungs.push({ x, cb, removable, freeSlots, mustFall: Math.max(0, removable.length - freeSlots) });
  }
  // 支配过滤（修复1）：只有【纯自身级】(mustFall===0，无对手条件) 才支配一切更高分级——低分能纯靠自己拿牌，
  //   更高分且带对手条件的级必然冗余。而带对手条件的级(mustFall>0)其从句是【动态 "ranks ahead of X"】：自身分
  //   越高、对对手要求越松，故低分级与高分级是 Pareto 不可比，【不得】用低分级支配高分级（原按对手名字集合
  //   蕴含判支配是把动态从句误当静态"X must fall"，会漏列如 Cara"到区就安全"这类更稳健的中间路径）。
  const kept = rungs.filter((a) => !rungs.some((b) =>
    b !== a && b.x < a.x - EPS && b.mustFall === 0 && a.mustFall >= b.mustFall
  ));
  for (const r of kept) {
    if (combos.length > MAX_COMBINATIONS + 1) break;
    if (r.x <= EPS) {
      // 防守级（自身无需再拿分）：她只在【超过 freeSlots 名】removable 排到她前面时丢牌（必修5 计数约束）。
      if (r.mustFall > 0) add({ summary: dependsOnlyCombo(medal, subject, r.removable, "Holds", r.freeSlots), opp: r.removable.length });
      continue;
    }
    if (r.mustFall === 0) add({ ...selfComboParts(selfMilestone(subject, r.x), r.cb), opp: r.cb ? 1 : 0 });
    else {
      // 修复3 · premise(b)：该档自身动作是 flash（精确钉死末线分）→ 对手上限可静态算出 → "ranks ahead of X"
      //   展开成对手侧三档具体动作（capClause，传该档钉死分 banked+x）；区间档（top/zone 多把、分数档）分数
      //   随把数浮动 → 不钉死 → 保留动态 "ranks ahead of X"。
      const subjectFinal = round1(banked + r.x);
      const clauseFor = selfScorePinned(subject, r.x) ? (o: SemiRanked) => capClause(subject, o as Projection, subjectFinal) : undefined;
      add({ summary: helpCombo(selfMilestone(subject, r.x), subject, r.removable, r.freeSlots, r.cb, clauseFor), opp: r.removable.length + (r.cb ? 1 : 0) });
    }
  }
  }
  // 根本问题·充分 vs 必要：替代路径存在 ⇔ 任一摆动对手还没定（还能失手 → 门槛可下移）。
  const alternatives = swing.some((o) => o.best - o.worst > EPS);
  return finalizeNeeds(medal, reason, combos, alternatives);
}

// —— 第二组·信息量重构措辞（候选 · PM 待定稿）——
//   降级 undecided（所有路径都 ≥3 对手、无清晰自路径）：
const TOO_COMPLEX_REASON = "Too many ways this could still go — too early to call.";
//   无价值路径合并格（保留在轮换里，告诉用户"还有别的路，只是变数太多"）：
const TOO_COMPLEX_CELL = "Other paths exist too, but with too many variables to spell out.";

/**
 * 第二组·信息量重构收口：needs_conditions 只在条件对观众有信息量时详细写。
 *   每条 combo 带 opp（涉及对手数）：≤2 有价值（清晰自路径/≤2 对手，照常逐条展示）；≥3 无价值（变数太多）。
 *   - 全部路径都无价值 → 整项降级 undecided（与"未开始→undecided""k>PRUNE_K→undecided"同源：变数太多不给无意义条件）；
 *   - 否则 → 有价值路径逐条列，所有无价值路径【合并成轮换里的一格】（共用一句），保留在轮换里避免把清晰路径误当必要条件。
 */
interface ScoredCombo {
  summary: string;
  opp: number;
  trust?: MedalCondition["conditionLevelTrust"];
  /** 纯自身路径部件：多路径展示时由 finalizeNeeds 换"确保"式（问题2a · 充分≠必要，防误读为唯一出路）。 */
  self?: { action: string; cbTail?: string };
}
const GERUNDS: Record<string, string> = { Flashes: "Flashing", Tops: "Topping", Zones: "Zoning", Scores: "Scoring", Score: "Scoring" };
/** 根本问题·确保式改写——"Tops her last boulder" → "Topping her last boulder would secure Silver outright"。 */
function secureForm(medal: MedalKind, self: { action: string; cbTail?: string }): string {
  const [head, ...restWords] = self.action.split(" ");
  const gerund = [GERUNDS[head] ?? head, ...restWords].join(" ");
  return `${gerund} would secure ${medalWord(medal)} outright${self.cbTail ? ` (${self.cbTail})` : ""}.`;
}
/**
 * 根本问题·充分 vs 必要的代码判定：`alternatives` = 是否存在替代路径 = 【任一摆动对手还没定
 * （best>worst，还能失手）】。全部对手已定 → 分数线是硬门槛（必要）→ 保留行为描述（单条=唯一路径）；
 * 存在还能失手的对手 → 纯自身条件只是充分（对手失手可让门槛下移）→ 一律换 "would secure … outright"。
 */
function finalizeNeeds(medal: MedalKind, reason: string, combos: ScoredCombo[], alternatives: boolean): MedalOutcome {
  const valuable = combos.filter((c) => c.opp <= 2);
  const nonValuable = combos.filter((c) => c.opp >= 3);
  if (valuable.length === 0) {
    return nonValuable.length > 0
      ? { medal, verdict: "undecided", reason: TOO_COMPLEX_REASON, conditions: [] }
      : { medal, verdict: "needs_conditions", reason, conditions: [] }; // 理论兜底（combos 恒 ≥1，不至于此）
  }
  const shown = valuable.slice(0, MAX_COMBINATIONS);
  const conditions: MedalCondition[] = shown.map((c) => {
    const summary = c.self && alternatives ? secureForm(medal, c.self) : c.summary;
    return c.trust ? { summary, conditionLevelTrust: c.trust } : { summary };
  });
  if (nonValuable.length > 0) conditions.push({ summary: TOO_COMPLEX_CELL });
  return { medal, verdict: "needs_conditions", reason, conditions };
}

/** countback 方向说明（官方半决赛排名破平 · CONTRACT-DRIFT-1）。 */
interface CountbackNote {
  kind: "win" | "lose"; // win = A 同分占优（半决赛更好）· lose = A 同分吃亏
  opponent: string; // binding 对手 first name
  subject: string; // 目标选手 A first name（"you"→A 名字 · PM 2026-07-08）
}

/**
 * countback 内文（不含破折号 · 由调用方按位置成对包裹 · 第三组C/D）。
 * 第三组C：countback 只在"正好打平"那个点生效——达线更快/更高是直接赢，故 win 用 "if that ties …"（仅打平时）。
 * 第三组D语法：去 "a points tie"（改条件从句）；破折号成对由调用方处理。
 */
function cbInner(cb: CountbackNote): string {
  // 问题2a：lose 方向去掉 "even matching … isn't enough"（必要式措辞，会把"超过对手"的必要条件误读成
  //   "拿牌"的必要条件）——改中性事实句，只陈述同分归属（解释阈值为何是 +0.1）。
  return cb.kind === "win"
    ? `if that ties ${cb.opponent}, ${cb.subject} takes it on the semi-final ranking`
    : `a tie on points would go to ${cb.opponent} on the semi-final ranking`;
}
/** countback 说明统一用括号（Frame6-2 格式统一 · 取代破折号插入语）。 */
function cbNote(cb?: CountbackNote): string {
  return cb ? ` (${cbInner(cb)})` : "";
}

// ══ 末线单条时的【所需把数】三档文案（必修4）· 以该线【绝对目标分 L】为准（不减已得 zone 分 · 必修7）══
//   L>10 → top 侧（须登顶）；L≤10 → zone 侧（到区即可）。第 N 把：top=25−0.1(N−1)、zone=10−0.1(N−1)。
//   档1 ≤9 把（把数直观）· 档2 10~20 把（说分数）· 档3 ≥21 把（只说要 top/zone）。
const TIER1_MAX_ATTEMPTS = 9;   // ≤9 把 → 档1
const TIER2_MAX_ATTEMPTS = 20;  // 10~20 把 → 档2；≥21 把 → 档3
/** 绝对末线目标分 L → 侧别 + 第几把 + 档位。 */
function lineTier(L: number): { side: "top" | "zone"; n: number; tier: 1 | 2 | 3 } {
  const top = L > 10 + EPS;
  const base = top ? 25 : 10;
  const n = Math.max(1, 1 + Math.round((base - L) / 0.1)); // 第 n 把达到 L
  const tier = n <= TIER1_MAX_ATTEMPTS ? 1 : n <= TIER2_MAX_ATTEMPTS ? 2 : 3;
  return { side: top ? "top" : "zone", n, tier };
}
/** 自身末线三档句（top/zone 侧）。中间档说绝对分 L；flash 区分 boulder（登顶）/ zone（到区）。 */
function selfLinePhrase(L: number): string {
  const { side, n, tier } = lineTier(L);
  if (tier === 1) {
    if (side === "top") return n === 1 ? "Flashes the boulder" : `Tops her last boulder in ${n} attempts or fewer`;
    return n === 1 ? "Flashes the zone" : `Zones her last boulder in ${n} attempts or fewer`;
  }
  if (tier === 2) return `Scores ${formatScore(L)} points on her last boulder`; // 第三组A：行为描述、去 "Needs"
  return side === "top" ? "Tops her last boulder" : "Zones her last boulder";   // 第三组A：去 "Needs to"（唯一性由有无轮换体现）
}
/**
 * 修复2 · 充要（必要式）末线三档句——对手全定死时唯一门槛，措辞用【必要性 needs】（与充分式 selfLinePhrase
 * 同一套 lineTier 换算，只是 secure→needs）。tier1 说把数、tier2 说分数、tier3 只说 top/zone。
 */
function selfLineNeedPhrase(L: number): string {
  const { side, n, tier } = lineTier(L);
  if (tier === 1) {
    if (side === "top") return n === 1 ? "Needs to flash the boulder" : `Needs to top her last boulder in ${n} attempts or fewer`;
    return n === 1 ? "Needs to flash the zone" : `Needs to zone her last boulder in ${n} attempts or fewer`;
  }
  if (tier === 2) return `Needs at least ${formatScore(L)} points on her last boulder`;
  return side === "top" ? "Needs to top her last boulder" : "Needs to zone her last boulder";
}
/** 修复2 · 充要必要式（末线单条 → 三档；多线 → 全 flash / 跨线还需 X 分）。 */
function selfNeedMilestone(subject: Projection, x: number): string {
  const routesLeft = subject.liveRoutes;
  if (routesLeft === 1) return selfLineNeedPhrase(round1(x + subject.lastLineFloor));
  if (x >= round1(25 * routesLeft) - EPS) return routesLeft === 2 ? "Needs to flash both remaining boulders" : `Needs to flash all ${routesLeft} remaining boulders`;
  return `Needs at least ${formatScore(x)} more points across the remaining ${routesLeft} boulders`;
}
/**
 * 修复3 · premise(b)：该档自身最终分是否被【钉死成精确值】。仅当自身动作是 flash（末线单条 flash=精确 25/10、
 * 或多线全 flash=精确 25×N）时成立——此时对手上限可静态算出、可展开 "ranks ahead of X"。
 * 区间档（top/zone 需多把、"at least X 分"、跨线还需 X 分）分数随把数浮动 → 不钉死 → 保留动态 "ranks ahead of X"。
 */
function selfScorePinned(subject: Projection, x: number): boolean {
  const routesLeft = subject.liveRoutes;
  if (routesLeft === 1) return lineTier(round1(x + subject.lastLineFloor)).n === 1; // flash = 精确单值
  return x >= round1(25 * routesLeft) - EPS; // 多线全 flash = 精确
}
/** 对手末线绝对目标分 L（反超 subject 所需）——仅对手只剩末线一条才用把数框架，否则 null。 */
function opponentLineTarget(subject: Projection, opponent: Projection, subjectLine: number): number | null {
  if (opponent.liveRoutes !== 1) return null; // 变量不止末线一条 → 把数框架不适用
  const oppWinsTie = compareSemifinalRank(opponent.startOrder, subject.startOrder) > 0;
  const oppBankedOther = round1(opponent.worst - opponent.lastLineFloor); // 对手除末线外已得（必修7：加回末线 floor 才是绝对线分）
  const L = round1(subjectLine - oppBankedOther + (oppWinsTie ? 0 : 0.1)); // 对手末线须达到的绝对分（含同分方向）
  return L;
}
/**
 * 需求改进 · 对手"达不到 L"三档否定句（与 lineTier/自身侧同一套换算 · 展开 "ranks ahead of" 用）。
 * 修复3 · 最小阻挡集：zone 侧门槛（L≤10）除了到区，【登顶也越过】——登顶分恒 ≥ 到区门槛，故 zone 侧封顶
 *   必须并列 "neither tops … nor zones …"（漏掉登顶 = 放走真会挡住的结果 = 假条件的反面）。tier2 用分数口径
 *   已天然含登顶（"reach L points" 包含登顶），无需并列。top 侧门槛（L>10）只有登顶能达，单说即可。
 */
function opponentCapPhrase(firstName: string, L: number): string {
  const { side, n, tier } = lineTier(L);
  if (side === "top") {
    if (tier === 1) return n === 1 ? `${firstName} does not flash her last boulder` : `${firstName} does not top her last boulder in ${n} attempts or fewer`;
    if (tier === 2) return `${firstName} does not reach ${formatScore(L)} points on her last boulder`;
    return `${firstName} does not top her last boulder`;
  }
  // zone 侧：到区 或 登顶 都能越过 → 并列否定（tier2 分数口径除外，已含登顶）。
  if (tier === 2) return `${firstName} does not reach ${formatScore(L)} points on her last boulder`;
  if (tier === 1) return n === 1 ? `${firstName} neither tops nor flashes the zone on her last boulder` : `${firstName} neither tops her last boulder nor zones it in ${n} attempts or fewer`;
  return `${firstName} neither tops nor zones her last boulder`;
}

/**
 * 需求改进 · "ranks ahead of X" 的具体化展开——前提：①自身最终分被该级动作钉死（上限级，x=remainingMax，
 * 如"双 flash"/"flash 末线"）②对手只剩 1 条线。此时对手上限 = 我的最终分 − 对手其余已有分（countback 方向
 * ±0.1），用三档换算翻译成"对手做不到什么"。同分判定（补充要求）：对手胜同分 → 反超线 L=tieLine，动作条件
 * 已把同分排除 → 不提 countback；我胜同分 → 对手打平仍可能（且归我）→ 保留括号说明。
 * 前提不满足（对手 ≥2 条线在变 / 上限出界）→ 退回 "ranks ahead of X" 动态表达。
 */
function capClause(subject: Projection, opponent: Projection, subjectFinal: number): string {
  if (opponent.liveRoutes !== 1) return holdClause(subject, opponent); // 对手多线在变 → 无法翻成单一动作
  const oppBankedOther = round1(opponent.worst - opponent.lastLineFloor);
  const tieLine = round1(subjectFinal - oppBankedOther); // 对手末线恰好追平我的线分（钉死值 = banked + 该档 x，非 best）
  const oppWinsTie = compareSemifinalRank(opponent.startOrder, subject.startOrder) > 0;
  const L = round1(tieLine + (oppWinsTie ? 0 : 0.1)); // 对手末线反超我所需最低分
  if (L <= EPS || L > 25 + EPS) return holdClause(subject, opponent); // 理论兜底（removable 构造下不应触达）
  const phrase = opponentCapPhrase(opponent.firstName, L);
  return oppWinsTie ? phrase : `${phrase} (a tie on points would go to ${subject.firstName} on the semi-final ranking)`;
}

/**
 * 对手"达到 L 即反超"三档句（d 类 · 仅 subject 已定时使用——阈值固定，把数精确 · 问题1）。
 * 修复3 · 最小阻挡集：zone 侧门槛（L≤10）登顶也越过 → 并列 "tops … or [flashes/zones] the zone"（漏登顶 = 漏
 *   真反超者）。tier2 用分数口径 "reaches L points"（已含登顶），比旧 "out-scores her" 精确。
 */
function opponentOvertakePhrase(firstName: string, L: number): string {
  const { side, n, tier } = lineTier(L);
  if (side === "top") {
    if (tier === 1) return n === 1 ? `${firstName} flashes the boulder` : `${firstName} tops her last boulder in ${n} attempts or fewer`;
    if (tier === 2) return `${firstName} reaches ${formatScore(L)} points on her last boulder`;
    return `${firstName} tops her last boulder`;
  }
  if (tier === 2) return `${firstName} reaches ${formatScore(L)} points on her last boulder`;
  if (tier === 1) return n === 1 ? `${firstName} tops her last boulder or flashes the zone` : `${firstName} tops her last boulder or zones it in ${n} attempts or fewer`;
  return `${firstName} tops or zones her last boulder`;
}

/** 自身达线句主体（末线单条→三档制以绝对目标分为准；多线→跨线还需 X 分）+ 触发时的方向 countback 说明。 */
function selfMilestone(subject: Projection, x: number): string {
  const routesLeft = subject.liveRoutes;
  if (routesLeft === 1) {
    const L = round1(x + subject.lastLineFloor); // 绝对末线目标分（不减已得 zone 分 · 必修4/7）
    return selfLinePhrase(L);
  }
  // Frame7-1：所需分 = 剩余线理论满分（25×N，全部 flash 登顶才凑够）→ 直接说"全部 flash"，不说分数
  //   （说分数会让人以为还有别的凑法）。
  if (x >= round1(25 * routesLeft) - EPS) {
    return routesLeft === 2 ? "Flashes both remaining boulders" : `Flashes all ${routesLeft} remaining boulders`;
  }
  return `Scores at least ${formatScore(x)} more across the remaining ${routesLeft} boulders`; // 第三组A：行为描述
}

/** 半决赛排名可比的最小结构（抱石 Projection 与难度赛 LeadProjection 通用）。 */
interface SemiRanked { firstName: string; startOrder: number; }

/** a 类部件：纯靠自己。summary=必要（唯一路径）时原样；self 部件供"存在替代路径"时换"确保"式（根本问题）。 */
function selfComboParts(action: string, cb?: CountbackNote): { summary: string; self: { action: string; cbTail?: string } } {
  return { summary: `${action}${cbNote(cb)}.`, self: { action, cbTail: cb ? cbInner(cb) : undefined } };
}

/**
 * b 类：自己达线 + 对手别反超（抱石/难度赛共用 · action 为自身达线句）。
 * 问题1：自身还在爬时，与同样在爬的 removable 对手是【最终总分+countback】的动态关系——≤2 名时对手
 * 从句一律用笼统但正确的 "finishes ahead of X"（含同分方向括注），不得用"对手是否 top/达某分"这类按
 * 自身【下限】校准的粗糙代理（既不必要也不充分 = 假条件）。计数/概括从句（fall short = 最终排在她
 * 后面）本就是动态语义，保留。
 */
function helpCombo(action: string, subject: SemiRanked, removable: SemiRanked[], freeSlots: number, cb?: CountbackNote, clauseFor?: (opp: SemiRanked) => string): string {
  const mustFall = removable.length - freeSlots; // 至少需排她后面的人数（>0，否则不会进 helpCombo）
  let rest: string;
  if (freeSlots >= 1) {
    // 必修5：allow 尚有余额 → 计数约束（不指定是谁）。freeSlots≥1 时 mustFall<removable，天然非"N of N"。
    rest = `needs at least ${mustFall} of ${nameList(removable)} to rank behind her`;
  } else {
    // freeSlots=0：全部 removable 必须排她后面。对手计数含 countback 从句对手（cb 的 bar）→ 合计 ≥3 概括（问题二）。
    const mentioned = removable.length + (cb ? 1 : 0);
    if (mentioned >= 3) {
      const tail = removable.length >= 3 ? "to all rank behind her" : "to rank behind her";
      rest = `needs ${nameList(removable)} ${tail}`;
    } else {
      const clause = clauseFor ?? ((o: SemiRanked) => holdClause(subject, o)); // 需求改进：可注入展开条款（capClause）
      rest = removable.map(clause).join(", and ");
    }
  }
  return `${action}${cbNote(cb)}, and ${rest}.`; // Frame6-2：countback 说明统一括号
}

/**
 * d 类：无自身达线部分，纯看对手不反超（done → "Takes"；还在爬但已达线 → "Holds"）。
 * 决定 3：≥3 反超者 → 概括为 "unless any of [A], [B] and [C] catches her."（方向=他们反超）。
 */
function dependsOnlyCombo(medal: MedalKind, subject: Projection, threats: Projection[], verb: "Takes" | "Holds", allowCount: number): string {
  // done(worst=best=最终分) 与防守级(x=0，停在 banked) 下 subject 最终分均 = subject.worst。
  const subjectLine = subject.worst;
  if (allowCount >= 1) {
    // 必修1/5：容许 allowCount 名反超 → 需 allowCount+1 名反超才丢牌。
    // 第三组B：当 allowCount+1 == 列表全数（"N of N"冗余）→ 改 both/all 直接列名，不说 "at least N of 全部"。
    const need = allowCount + 1;
    if (need >= threats.length) {
      return threats.length === 2
        ? `${verb} ${medalWord(medal)} unless both ${threats[0].firstName} and ${threats[1].firstName} rank ahead of her.`
        : `${verb} ${medalWord(medal)} unless all of ${nameList(threats)} rank ahead of her.`;
    }
    return `${verb} ${medalWord(medal)} unless at least ${need} of ${nameList(threats)} rank ahead of her.`;
  }
  // allowCount=0：任一反超即丢牌。
  if (threats.length >= 3) {
    return `${verb} ${medalWord(medal)} unless any of ${nameList(threats)} ranks ahead of her.`;
  }
  const subjectFinal = verb === "Takes"; // Takes=已爬完（阈值固定 → 可精确把数）· Holds=还在爬（动态从句 · 问题1）
  return `${verb} ${medalWord(medal)} unless ${threats.map((o) => overtakeClause(subject, o, subjectLine, subjectFinal)).join(" or ")}.`;
}

/**
 * 问题1 · 对手"别反超"从句（自身还在爬 → 与在爬对手是【最终总分+countback】的动态关系）：
 * Frame6-1 统一用词 "ranks ahead of"（显式指【排名】而非分数 · 定义见页面 ℹ️：分数更高，或同分但半决赛
 * 排名更好），并补同分方向括注。绝不用"对手是否 top/达某分"按自身下限校准的代理（假条件）。
 */
function holdClause(subject: SemiRanked, opponent: SemiRanked): string {
  const winner = compareSemifinalRank(opponent.startOrder, subject.startOrder) > 0 ? opponent.firstName : subject.firstName;
  return `ranks ahead of ${opponent.firstName} (a tie on points would go to ${winner} on the semi-final ranking)`;
}

/** 问题1 · 对手"反超"动态从句（Holds 防守级 · 自身还在爬）· Frame6-1 rank 显式化。 */
function overtakeDynamic(subject: SemiRanked, opponent: SemiRanked): string {
  const winner = compareSemifinalRank(opponent.startOrder, subject.startOrder) > 0 ? opponent.firstName : subject.firstName;
  return `${opponent.firstName} ranks ahead of her (a tie on points would go to ${winner} on the semi-final ranking)`;
}

/** d 类反向从句：subject 已定(Takes) → 阈值固定，可用精确三档把数；还在爬(Holds) → 动态从句（问题1）。 */
function overtakeClause(subject: Projection, opponent: Projection, subjectLine: number, subjectFinal: boolean): string {
  if (subjectFinal) {
    const L = opponentLineTarget(subject, opponent, subjectLine);
    const oppWinsTie = compareSemifinalRank(opponent.startOrder, subject.startOrder) > 0;
    if (L !== null && L > EPS && L <= 25 + EPS) {
      // 其余3 · 通则：临界点恰为同分（对手胜同分 → L=打平线，达到即以 countback 反超）→ 必标 countback；
      //   对手输同分（L=打平线+0.1，严格越过，不经同分）→ 不标。
      const phrase = opponentOvertakePhrase(opponent.firstName, L);
      return oppWinsTie ? `${phrase} (a tie on points would then go to ${opponent.firstName} on the semi-final ranking)` : phrase;
    }
    return oppWinsTie ? `${opponent.firstName} catches her` : `${opponent.firstName} out-scores her`;
  }
  return overtakeDynamic(subject, opponent);
}

/** first-name 列表："A"、"A and B"、"A, B and C"（抱石/难度赛投影通用）。 */
function nameList(opponents: { firstName: string }[]): string {
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

/**
 * 其余1 · 难度赛显示层官方记法：内部分数 = hold + plus*0.25（如 45+ 存为 45.25）；显示恒用 "X+"（控制到 X
 * 且有向 X+1 的有效动作）或整数 "X"，绝不暴露内部小数（旧 "42.1" 错在把 boulder 的 0.1 惩罚步长套到难度赛）。
 */
function formatLeadScore(value: number): string {
  const hold = Math.floor(round1(value) + EPS);
  return round1(value) - hold >= 0.25 - EPS ? `${hold}+` : `${hold}`;
}
/**
 * 其余1 · 难度赛"严格超过 score 的最小合法分"——难度赛只有整数或 +（0.25），故 42 → 42+（42.25）、42+ → 43。
 * 取代 boulder 的 "+0.1"（难度赛没有 0.1 步长，用它会算出 42.1 这种非法内部分）。
 */
function leadBeatTarget(score: number): number {
  const hold = Math.floor(round1(score) + EPS);
  const hasPlus = round1(score) - hold >= 0.25 - EPS;
  return hasPlus ? hold + 1 : hold + 0.25;
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

  // 必修2b：subject 已爬完（settled → !live，无自身动作）→ 纯靠对手条文（类比抱石 done 分支）。
  //   她掉不掉名次只取决于还没爬的 swing 对手是否反超，不应显示"Score at least X"自身动作。
  if (!subject.live) {
    const allowLead = Math.max(0, targetRank - 1 - sureAhead.length);
    // 第二组：done 纯靠对手路径 opp = swing 反超者数（≥3 无价值 → finalizeNeeds 降级/合并）。
    const combos: ScoredCombo[] = swing.length <= allowLead
      ? [{ summary: `Takes ${medalWord(medal)} — the remaining climbers can no longer catch her.`, opp: 0 }]
      : [{ summary: leadDependsOnly(medal, subject, swing, allowLead, routeTop, "Takes"), opp: swing.length }];
    return finalizeNeeds(medal, needsReasonLead(medal), combos, swing.some((o) => o.best - o.worst > EPS));
  }

  // 问题2b（逻辑 bug）：难度赛补全名次阶梯——原先只产一条"自身分数线"，漏了【靠对手失手/防守】路径，
  //   会让唯一显示的充分条件被误读成必要条件。阶梯与抱石同构：阈值严格递减 · threats/certainly 可行性 ·
  //   计数约束 · 防守级；对手从句按问题1 用动态 "finishes ahead" 表达（自身在爬，与在爬对手是动态关系）。
  //   决定 4 保留：难度赛自身分数线用"总分"口径（Score at least X on the final route）。
  const allowL = Math.max(0, targetRank - 1 - sureAhead.length);
  const rankedL = [...swing].sort((a, b) => b.best - a.best); // 必修2a：按 best 上界排（未爬高种子 best=routeTop 在前）
  const banked = round1(subject.worst);

  // 修复2 · 充要门（难度赛版）：还能威胁的对手全已定死、只剩 subject 是变量 → 唯一门槛，只出必要式一条。
  if (swing.every((o) => o.best - o.worst <= EPS)) {
    const mustBeat = rankedL.slice(allowL);
    let targetFinal = banked;
    for (const o of mustBeat) {
      const win = compareSemifinalRank(subject.startOrder, o.startOrder) > 0;
      const need = win ? round1(o.best) : leadBeatTarget(o.best);
      if (need > targetFinal) targetFinal = need;
    }
    if (targetFinal > banked + EPS && targetFinal <= subject.best + EPS) {
      const needsTop = targetFinal >= routeTop - EPS;
      if (needsTop && !(subject.canTop && diff009Fixed)) {
        return { medal, verdict: "undecided", reason: "The remaining outcome depends on a top that is not yet officially confirmed.", conditions: [] };
      }
      const tiePeer = mustBeat.find((o) => Math.abs(o.best - targetFinal) <= EPS); // 门槛点同分 → 我胜（否则会是下一分）→ 标 countback
      const cb: CountbackNote | undefined = tiePeer ? { kind: "win", opponent: tiePeer.firstName, subject: subject.firstName } : undefined;
      const summary = needsTop
        ? `Needs to top the final route${cbNote(cb)}.`
        : `Needs at least ${formatLeadScore(targetFinal)} on the final route${cbNote(cb)}.`;
      const combo: ScoredCombo = { summary, opp: cb ? 1 : 0 };
      if (needsTop) combo.trust = "top_unconfirmed";
      return finalizeNeeds(medal, needsReasonLead(medal), [combo], false);
    }
  }

  const combos: ScoredCombo[] = [];
  let topGated = false; // 有路径因"依赖登顶但 DIFF-009 未修"被拦（TC-MEDAL-013）
  // 候选目标分：①保证压过 bar（bar 已定可同分且胜 countback → 打平上界；否则 +0.1）②同分吃亏但有名额吸收 bar（问题2b 同款）。
  const candsL: { target: number; cb?: CountbackNote }[] = [];
  for (let idx = allowL; idx < rankedL.length; idx += 1) {
    const bar = rankedL[idx];
    const barSettled = Math.abs(bar.best - bar.worst) <= EPS;
    const canTie = barSettled && subject.best + EPS >= bar.best && bar.best + EPS >= subject.worst;
    const tieWin = canTie ? compareSemifinalRank(subject.startOrder, bar.startOrder) > 0 : false;
    const cb: CountbackNote | undefined = canTie ? { kind: tieWin ? "win" : "lose", opponent: bar.firstName, subject: subject.firstName } : undefined;
    // Frame5-2：胜同分级（打平在路径内）才附 tie 说明；吃亏级不附（打平在阈值外）。
    //   其余1：严格反超用 leadBeatTarget（难度赛下一合法分），不用 boulder 的 +0.1。
    candsL.push({ target: tieWin ? round1(bar.best) : leadBeatTarget(bar.best), cb: tieWin ? cb : undefined });
    if (canTie && !tieWin && allowL >= 1) candsL.push({ target: round1(bar.best), cb }); // 吸收级：tie 即路径机制 → 说明保留
  }
  candsL.push({ target: round1(subject.best) }); // Frame7-1 同款：自身上限级
  candsL.push({ target: banked }); // 防守级
  candsL.sort((a, b) => b.target - a.target);

  interface RungL { x: number; target: number; cb?: CountbackNote; removable: LeadProjection[]; freeSlots: number; mustFall: number; }
  const rungsL: RungL[] = [];
  let lastT = Number.POSITIVE_INFINITY;
  for (const cand of candsL) {
    const target = cand.target;
    if (target > subject.best + EPS) continue; // 上界都够不到（如 bar 在爬 best=routeTop）→ 靠后续"对手失手"级
    if (target >= lastT - EPS) continue; // 阈值严格递减去冗余（同抱石口径）
    const needsTop = target > banked + EPS && target >= routeTop - EPS; // 达线需登顶（DIFF-009 门控 · TC-MEDAL-013/014/016）
    if (needsTop && !(subject.canTop && diff009Fixed)) { topGated = true; continue; }
    const threats = rankedL.filter((o) => beats(o.best, o.startOrder, target, subject.startOrder));
    const certainly = threats.filter((o) => beats(o.worst, o.startOrder, target, subject.startOrder));
    if (certainly.length > allowL) continue; // 不可行：铁定在前者超过允许数
    const removable = threats.filter((o) => !certainly.includes(o));
    const freeSlots = allowL - certainly.length;
    lastT = target;
    // Frame6-3：该 target 恰有已定对手同分且 subject 胜 countback → 补 win 说明（同抱石）。
    const winPeer = rankedL.find((o) => Math.abs(o.best - o.worst) <= EPS && Math.abs(o.best - target) <= EPS && compareSemifinalRank(subject.startOrder, o.startOrder) > 0);
    const cb = cand.cb ?? (winPeer ? { kind: "win" as const, opponent: winPeer.firstName, subject: subject.firstName } : undefined);
    rungsL.push({ x: round1(target - banked), target, cb, removable, freeSlots, mustFall: Math.max(0, removable.length - freeSlots) });
  }
  // 修复1（同抱石口径）：只有纯自身级(mustFall===0)才支配更高分级；带动态 "ranks ahead of X" 从句的级
  //   (mustFall>0) 自身分越高对对手要求越松、Pareto 不可比，低分级不得支配高分级。
  const keptL = rungsL.filter((a) => !rungsL.some((b) =>
    b !== a && b.x < a.x - EPS && b.mustFall === 0 && a.mustFall >= b.mustFall
  ));
  for (const r of keptL) {
    const needsTop = r.target >= routeTop - EPS;
    if (r.x <= EPS) {
      // 防守级：当前分已达线，纯靠还能反超者别追上（动态从句 · 问题1）。
      if (r.mustFall > 0) combos.push({ summary: leadDependsOnly(medal, subject, r.removable, r.freeSlots, routeTop, "Holds"), opp: r.removable.length });
      continue;
    }
    if (r.mustFall === 0) {
      // 纯靠自己（充分路径）：多路径时由 finalizeNeeds 换"确保"式措辞（问题2a）。
      if (needsTop) combos.push({ summary: `Top the final route at best — a sub-top score is not enough.`, opp: r.cb ? 1 : 0, trust: "top_unconfirmed" });
      else combos.push({ ...selfComboParts(`Score at least ${formatLeadScore(r.target)} on the final route`, r.cb), opp: r.cb ? 1 : 0 });
    } else {
      // 其余2 · premise(b)：只有登顶档自身分被钉死（=routeTop）→ 展开对手"does not top the final route"
      //   （removable 在登顶档必是胜同分者 → 无 countback 括号）；非登顶档是区间 → 保留动态 "ranks ahead of X"。
      const action = needsTop ? "Tops the final route" : `Score at least ${formatLeadScore(r.target)} on the final route`;
      const clauseFor = needsTop ? (o: SemiRanked) => `${o.firstName} does not top the final route` : undefined;
      const entry: ScoredCombo = { summary: helpCombo(action, subject, r.removable, r.freeSlots, r.cb, clauseFor), opp: r.removable.length + (r.cb ? 1 : 0) };
      if (needsTop) entry.trust = "top_unconfirmed";
      combos.push(entry);
    }
  }

  if (combos.length === 0) {
    // 全部可行路径都依赖未确认的登顶（TC-MEDAL-013）→ 降级 undecided；其余空态兜底同口径降级。
    return {
      medal,
      verdict: "undecided",
      reason: topGated ? "The remaining outcome depends on a top that is not yet officially confirmed." : TOO_COMPLEX_REASON,
      conditions: []
    };
  }
  return finalizeNeeds(medal, needsReasonLead(medal), combos, swing.some((o) => o.best - o.worst > EPS));
}

/** 难度赛"纯靠对手"条文（Takes=已爬完 · Holds=防守级还在爬）：计数约束不指定谁；≤2 时 Takes 用精确阈值从句、Holds 用动态从句（问题1）。 */
function leadDependsOnly(medal: MedalKind, subject: LeadProjection, overtakers: LeadProjection[], allowCount: number, routeTop: number, verb: "Takes" | "Holds"): string {
  if (allowCount >= 1) {
    // 第三组B：allowCount+1 == 列表全数 → both/all，不说 "at least N of 全部"。计数从句用方向安全的 "catch her"（=最终排到她前面）。
    const need = allowCount + 1;
    if (need >= overtakers.length) {
      return overtakers.length === 2
        ? `${verb} ${medalWord(medal)} unless both ${overtakers[0].firstName} and ${overtakers[1].firstName} rank ahead of her.`
        : `${verb} ${medalWord(medal)} unless all of ${nameList(overtakers)} rank ahead of her.`;
    }
    return `${verb} ${medalWord(medal)} unless at least ${need} of ${nameList(overtakers)} rank ahead of her.`;
  }
  if (overtakers.length >= 3) {
    return `${verb} ${medalWord(medal)} unless any of ${nameList(overtakers)} ranks ahead of her.`;
  }
  const clause = verb === "Takes"
    ? (o: LeadProjection) => leadOvertakeClause(subject, o, routeTop)
    : (o: LeadProjection) => overtakeDynamic(subject, o);
  return `${verb} ${medalWord(medal)} unless ${overtakers.map(clause).join(" or ")}.`;
}

/**
 * 单个对手反超【已爬完】subject 的条件：其余2——说具体门槛分（官方 X+ 记法），不再用含糊 "out-scores her"；
 * ≥满分 → 须登顶。其余3——对手胜同分时门槛 = subject.worst（打平即反超），临界点恰为同分 → 补 countback 括号；
 * 对手输同分时门槛 = 下一合法分（严格越过，不经同分）→ 不补。
 */
function leadOvertakeClause(subject: LeadProjection, opponent: LeadProjection, routeTop: number): string {
  const oppWinsTie = compareSemifinalRank(opponent.startOrder, subject.startOrder) > 0;
  const need = oppWinsTie ? round1(subject.worst) : leadBeatTarget(subject.worst); // 对手反超所需最低分（含同分方向）
  if (need >= routeTop - EPS) {
    return oppWinsTie
      ? `${opponent.firstName} tops the final route (a tie on points would then go to ${opponent.firstName} on the semi-final ranking)`
      : `${opponent.firstName} tops the final route`;
  }
  const phrase = `${opponent.firstName} reaches ${formatLeadScore(need)} on the final route`;
  return oppWinsTie ? `${phrase} (a tie on points would then go to ${opponent.firstName} on the semi-final ranking)` : phrase;
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
