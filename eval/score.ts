/**
 * 評価の採点（純関数。DESIGN.md 7章）。LLM も I/O も呼ばない。ランナー（scripts/eval.ts）が実 API の結果を渡す。
 *
 * - 条件抽出の正確さ: スロット単位。発話の前のスロットから「正解か実際のどちらかで有無か値が変わった」単位（エリア・予算・…・タグごと）
 *   だけを母数にし、有無と値が一致した割合を出す（変わっていない単位や、優先度だけ変わった単位まで数えると一致率が水増しされるため）
 * - 優先度判定の正確さ: 優先度の手がかりを含む発話で、変わった単位（優先度だけの変更を含む）のうち値が一致したものについて、優先度も一致した割合
 */
import { applySlotOps } from '@/domain/slots';
import { SCALAR_SLOT_KEYS, type ExtractionResult, type Priority, type Slots } from '@/domain/types';
import type { CallMeasure, ExtractionCase, ExtractionCategory, Ratio } from './types';

export function ratio(correct: number, total: number): Ratio {
  return { correct, total, rate: total === 0 ? null : correct / total };
}

// ---------- スロットの比較 ----------

/** スロットの比較の単位。スカラーのスロットはキー（'area' など）、タグは 'tag:オートロック' */
export type UnitKey = string;

export interface SlotUnit {
  /** 値の正規形（エリアの駅・区と間取りは並びを問わない） */
  value: string;
  priority: Priority;
}

export function slotUnits(slots: Slots): Map<UnitKey, SlotUnit> {
  const units = new Map<UnitKey, SlotUnit>();
  for (const key of SCALAR_SLOT_KEYS) {
    const slot = slots[key];
    if (!slot) continue;
    let value: string;
    if (key === 'area') {
      const area = slot.value as { stations: string[]; wards: string[] };
      value = JSON.stringify({ stations: [...area.stations].sort(), wards: [...area.wards].sort() });
    } else if (key === 'layouts') {
      value = JSON.stringify([...(slot.value as string[])].sort());
    } else {
      value = String(slot.value);
    }
    units.set(key, { value, priority: slot.priority });
  }
  for (const tag of slots.tags) units.set(`tag:${tag.value}`, { value: 'あり', priority: tag.priority });
  return units;
}

const sameUnit = (a: SlotUnit | undefined, b: SlotUnit | undefined): boolean =>
  a === undefined || b === undefined ? a === b : a.value === b.value && a.priority === b.priority;
const sameValue = (a: SlotUnit | undefined, b: SlotUnit | undefined): boolean =>
  a === undefined || b === undefined ? a === b : a.value === b.value;

export interface SlotUnitResult {
  key: UnitKey;
  /** 発話の前 */
  before: SlotUnit | null;
  expected: SlotUnit | null;
  actual: SlotUnit | null;
  /** 正解か実際のどちらかで、有無か値が発話の前から変わった（優先度だけの変更は false）。条件抽出の正確さの母数 */
  valueChanged: boolean;
  /** 有無と値が一致（優先度は問わない） */
  valueOk: boolean;
  /** 有無・値・優先度が一致 */
  priorityOk: boolean;
}

/** 正解か実際のどちらかで、発話の前から（有無・値・優先度のどれかが）変わった単位だけを比べる */
export function compareSlots(before: Slots, expected: Slots, actual: Slots): SlotUnitResult[] {
  const b = slotUnits(before);
  const e = slotUnits(expected);
  const a = slotUnits(actual);
  const keys = [...new Set([...b.keys(), ...e.keys(), ...a.keys()])].sort();
  const results: SlotUnitResult[] = [];
  for (const key of keys) {
    const bu = b.get(key);
    const eu = e.get(key);
    const au = a.get(key);
    if (sameUnit(bu, eu) && sameUnit(bu, au)) continue;
    const valueOk = sameValue(eu, au);
    results.push({
      key,
      before: bu ?? null,
      expected: eu ?? null,
      actual: au ?? null,
      valueChanged: !sameValue(bu, eu) || !sameValue(bu, au),
      valueOk,
      priorityOk: valueOk && sameUnit(eu, au),
    });
  }
  return results;
}

// ---------- 1件の採点 ----------

const sameSet = <T>(a: readonly T[], b: readonly T[]): boolean =>
  a.length === b.length && a.every((x) => b.includes(x)) && b.every((x) => a.includes(x));

export interface ExtractionCaseScore {
  id: string;
  category: ExtractionCategory;
  priorityCue: boolean;
  intentOk: boolean;
  units: SlotUnitResult[];
  /** 変わった単位がすべて値・優先度とも一致 */
  slotsOk: boolean;
  targetsOk: boolean;
  viewingTimesOk: boolean;
  forbiddenOk: boolean;
  /** 上のすべてが一致 */
  exact: boolean;
}

export function scoreExtractionCase(c: ExtractionCase, actual: ExtractionResult): ExtractionCaseScore {
  const before = c.slots ?? { tags: [] };
  const units = compareSlots(before, applySlotOps(before, c.expected.ops), applySlotOps(before, actual.ops));
  const intentOk = [c.expected.intent, ...(c.expected.alsoAcceptIntents ?? [])].includes(actual.intent);
  const slotsOk = units.every((u) => u.priorityOk);
  const targetsOk = sameSet(c.expected.targetPositions ?? [], actual.targetPositions);
  const viewingTimesOk = sameSet(c.expected.viewingTimes ?? [], actual.viewingTimes);
  const forbiddenOk = (c.expected.forbiddenTopic ?? null) === actual.forbiddenTopic;
  return {
    id: c.id,
    category: c.category,
    priorityCue: c.priorityCue,
    intentOk,
    units,
    slotsOk,
    targetsOk,
    viewingTimesOk,
    forbiddenOk,
    exact: intentOk && slotsOk && targetsOk && viewingTimesOk && forbiddenOk,
  };
}

// ---------- 集計 ----------

export interface ExtractionSummary {
  cases: number;
  /** 発話単位の完全一致 */
  exact: Ratio;
  intent: Ratio;
  /** 条件抽出の正確さ（スロット単位・有無と値。有無か値が変わった単位が母数） */
  slotValue: Ratio;
  /** 優先度判定の正確さ（手がかりのある発話・変わった単位のうち値が一致したもの） */
  priority: Ratio;
  /** 正解が禁止トピックの発話で、同じ話題を返した割合 */
  forbiddenRecall: Ratio;
  /** 禁止トピックでない発話に禁止トピックを付けた件数 */
  forbiddenFalsePositives: number;
  /** 正解か実際のどちらかが表示番号を持つ発話で、番号が一致した割合 */
  targets: Ratio;
  /** 正解か実際のどちらかが日時を持つ発話で、日時が一致した割合 */
  viewingTimes: Ratio;
  /** カテゴリごとの完全一致 */
  byCategory: Partial<Record<ExtractionCategory, Ratio>>;
}

/** `cases`・`scores`・`actuals` は同じ順（i 番目どうしが対応） */
export function summarizeExtraction(
  cases: readonly ExtractionCase[],
  scores: readonly ExtractionCaseScore[],
  actuals: readonly ExtractionResult[],
): ExtractionSummary {
  if (cases.length !== scores.length || cases.length !== actuals.length) throw new Error('cases・scores・actuals の件数が合いません');
  const count = (ok: (i: number) => boolean, among: (i: number) => boolean = () => true): Ratio => {
    let correct = 0;
    let total = 0;
    for (let i = 0; i < scores.length; i++) {
      if (!among(i)) continue;
      total += 1;
      if (ok(i)) correct += 1;
    }
    return ratio(correct, total);
  };
  const expectedTopic = (i: number) => cases[i].expected.forbiddenTopic ?? null;
  const valueUnits = scores.flatMap((s) => s.units.filter((u) => u.valueChanged));
  const cueUnits = scores.filter((s) => s.priorityCue).flatMap((s) => s.units.filter((u) => u.valueOk && u.expected !== null));
  const byCategory: Partial<Record<ExtractionCategory, Ratio>> = {};
  for (const s of scores) {
    const r = byCategory[s.category] ?? ratio(0, 0);
    byCategory[s.category] = ratio(r.correct + (s.exact ? 1 : 0), r.total + 1);
  }
  return {
    cases: scores.length,
    exact: count((i) => scores[i].exact),
    intent: count((i) => scores[i].intentOk),
    slotValue: ratio(valueUnits.filter((u) => u.valueOk).length, valueUnits.length),
    priority: ratio(cueUnits.filter((u) => u.priorityOk).length, cueUnits.length),
    forbiddenRecall: count(
      (i) => scores[i].forbiddenOk,
      (i) => expectedTopic(i) !== null,
    ),
    forbiddenFalsePositives: scores.filter((_, i) => expectedTopic(i) === null && actuals[i].forbiddenTopic !== null).length,
    targets: count(
      (i) => scores[i].targetsOk,
      (i) => (cases[i].expected.targetPositions ?? []).length > 0 || actuals[i].targetPositions.length > 0,
    ),
    viewingTimes: count(
      (i) => scores[i].viewingTimesOk,
      (i) => (cases[i].expected.viewingTimes ?? []).length > 0 || actuals[i].viewingTimes.length > 0,
    ),
    byCategory,
  };
}

// ---------- 応答時間と費用 ----------

/** 最近傍順位法のパーセンタイル（p は 0〜100）。空なら null */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

export interface MeasureSummary {
  n: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  meanCostUsd: number | null;
  totalCostUsd: number;
}

export function summarizeMeasures(measures: readonly CallMeasure[]): MeasureSummary {
  const latencies = measures.map((m) => m.latencyMs);
  const total = measures.reduce((sum, m) => sum + m.costUsd, 0);
  return {
    n: measures.length,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    maxMs: latencies.length === 0 ? null : Math.max(...latencies),
    meanCostUsd: measures.length === 0 ? null : total / measures.length,
    totalCostUsd: total,
  };
}
