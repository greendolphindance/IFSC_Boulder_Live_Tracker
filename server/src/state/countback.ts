/**
 * 同分破平（IFSC 官方现行规则 · 2025 积分制）· CONTRACT-DRIFT-1 修订（PM 2026-07-08 授权）。
 *
 * 抱石 §7.1 / 难度赛 §7.3（IFSC《Competition Regulations — World Cup Events》）：
 *   总分（积分）相等 → **count-back to the General Ranking after the preceding round**
 *   = 半决赛排名。决赛出场顺序 = Rank Descending（regs "Final … Rank Descending"）
 *   = 最好种子最后出场 → **startOrder 越大 = 半决赛排名越好 = 同分占优**。
 *
 * ⚠️ 旧实现的 "Top 数 → Zone 数 → 总出手数" 三级链是 2025 前赛制——2025 积分制里
 *   top=25 / zone=10 − 0.1×出手 已把出手惩罚编进点数，同分后**直接**看半决赛排名，
 *   无 top/zone/出手中间级（见 08 CONTRACT-DRIFT-1）。
 *
 * 半决赛排名来源字段：`Athlete.startOrder`（真实值 = route 最小 position · IfscAdapter.ts）。
 */

/**
 * 同分时比较半决赛排名（= 出场顺序）：
 *   返回 > 0 → startOrderX 更优（出场更晚 / 半决赛更好），同分则 X 胜；
 *   返回 < 0 → Y 更优；= 0 → 出场顺序也相同（真实决赛不会发生 · 兜底）。
 */
export function compareSemifinalRank(startOrderX: number, startOrderY: number): number {
  return startOrderX - startOrderY;
}
