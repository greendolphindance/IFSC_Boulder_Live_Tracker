import type { MedalKind, MedalVerdict } from "../../server/src/types/domain";

/**
 * Medal Chances 展示层工具：四态 → class/glyph/label 映射、金银铜身份元数据、轮换计数文案。
 * 对齐 01.5-视觉规范 §四.1/四.2 与 demo 的 ST_META / MEDAL_META（视觉冻结契约）。
 */

export interface VerdictMeta {
  /** 状态 class（app.css 登记）· 状态点 .mdot / 结论徽章 .verdict 共用。 */
  cls: "st-locked" | "st-out" | "st-need" | "st-unknown";
  /** 内嵌符号（色弱可读）· ✓ ✕ ! ?。 */
  glyph: string;
  /** 英文结论词。 */
  label: string;
}

const VERDICT_META: Record<MedalVerdict, VerdictMeta> = {
  locked: { cls: "st-locked", glyph: "✓", label: "Condition met" },
  eliminated: { cls: "st-out", glyph: "✕", label: "Out of contention" },
  needs_conditions: { cls: "st-need", glyph: "!", label: "Needs conditions" },
  undecided: { cls: "st-unknown", glyph: "?", label: "Not yet decided" }
};

export function verdictMeta(verdict: MedalVerdict): VerdictMeta {
  return VERDICT_META[verdict];
}

export interface MedalMeta {
  key: MedalKind;
  /** 身份点 class 后缀 · .medal-id.gold / .ml-dot.gold 等。 */
  id: MedalKind;
  /** 展开区奖牌标签英文词。 */
  word: string;
}

/** 定长 3 · 顺序 gold / silver / bronze（与后端 outcomes 定长一致）。 */
export const MEDAL_META: MedalMeta[] = [
  { key: "gold", id: "gold", word: "Gold" },
  { key: "silver", id: "silver", word: "Silver" },
  { key: "bronze", id: "bronze", word: "Bronze" }
];

/** 图例四态（真实 UI · 左侧符号图例 · 顺序对齐 demo）。 */
export const LEGEND_ITEMS: { cls: VerdictMeta["cls"]; glyph: string; label: string }[] = [
  { cls: "st-locked", glyph: "✓", label: "Condition met" },
  { cls: "st-need", glyph: "!", label: "Needs conditions" },
  { cls: "st-out", glyph: "✕", label: "Out of contention" },
  { cls: "st-unknown", glyph: "?", label: "Not yet decided" }
];

/** 轮换计数文案 "N / M"（分子 1 起 · item10 秒数无空格不涉此处）。 */
export function rotationLabel(currentIndex: number, total: number): string {
  return `${currentIndex + 1} / ${total}`;
}
