/**
 * 評価セットの正解そのものの検査（LLM は呼ばない）。正解が本番の語彙・物件データと食い違っていると、
 * 抽出が正しくても不正解に数えられるので、ここで落とす。
 */
import { describe, expect, it } from 'vitest';
import { canonicalizeOpsWithReport, canonicalizeViewingTime } from '@/domain/normalize';
import { applySlotOps } from '@/domain/slots';
import { STATIONS, WARDS } from '@/domain/stations';
import type { SlotOp, Slots } from '@/domain/types';
import { loadDemoProperties } from '../data';
import { slotUnits } from '../score';
import { EVAL_NOW, EXTRACTION_CATEGORIES } from '../types';
import { EXTRACTION_CASES } from './extraction';

/**
 * DESIGN.md 7章: 単発発話 80 件（ex-001〜ex-080。うち優先度の手がかりを含むもの 40 件以上）と、
 * トレードオフの質問への答え 20 件（ex-081〜ex-100。全件が優先度の手がかりを含む）
 */
const SINGLE_CASES = 80;
const MIN_PRIORITY_CUE_IN_SINGLE = 40;
const TRADEOFF_CASES = 20;

const singleCases = EXTRACTION_CASES.filter((c) => c.category !== 'tradeoff');
const tradeoffCases = EXTRACTION_CASES.filter((c) => c.category === 'tradeoff');

const properties = loadDemoProperties();
const publicIds = new Set(properties.filter((p) => p.status === 'public').map((p) => p.id));
const stationNames = new Set(STATIONS.map((s) => s.name));
const wardNames = new Set(WARDS);

function areaProblems(slots: Slots): string[] {
  const area = slots.area?.value;
  if (!area) return [];
  return [
    ...area.stations.filter((s) => !stationNames.has(s)).map((s) => `駅マスタに無い駅: ${s}`),
    ...area.wards.filter((w) => !wardNames.has(w)).map((w) => `区・市の一覧に無い: ${w}`),
  ];
}

/** setPriority / setTagPriority は対象が無いと何もしない（applySlotOps）。正解の書き損じを拾う */
function noOpPriorityChanges(before: Slots, ops: readonly SlotOp[]): string[] {
  const problems: string[] = [];
  let slots = before;
  for (const op of ops) {
    if (op.op === 'setPriority' && !slots[op.key]) problems.push(`setPriority の対象が無い: ${op.key}`);
    if (op.op === 'setTagPriority' && !slots.tags.some((t) => t.value === op.tag)) problems.push(`setTagPriority の対象が無い: ${op.tag}`);
    slots = applySlotOps(slots, [op]);
  }
  return problems;
}

describe('抽出の評価セット（eval/datasets/extraction.ts）', () => {
  it(`単発発話が ${SINGLE_CASES} 件、トレードオフの答えが ${TRADEOFF_CASES} 件あり、全カテゴリがある`, () => {
    expect(singleCases.length).toBe(SINGLE_CASES);
    expect(tradeoffCases.length).toBe(TRADEOFF_CASES);
    for (const category of EXTRACTION_CATEGORIES) {
      expect(EXTRACTION_CASES.some((c) => c.category === category), category).toBe(true);
    }
  });

  it(`単発発話のうち優先度の手がかりを含むものが ${MIN_PRIORITY_CUE_IN_SINGLE} 件以上ある`, () => {
    expect(singleCases.filter((c) => c.priorityCue).length).toBeGreaterThanOrEqual(MIN_PRIORITY_CUE_IN_SINGLE);
  });

  it('ID は ex-NNN で重複せず、ex-001 から連番。単発が ex-001〜ex-080、トレードオフが ex-081〜ex-100', () => {
    const ids = EXTRACTION_CASES.map((c) => c.id);
    expect(ids.filter((id) => !/^ex-\d{3}$/.test(id))).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(EXTRACTION_CASES.map((_, i) => `ex-${String(i + 1).padStart(3, '0')}`));
    expect(singleCases.map((c) => c.id)).toEqual(ids.slice(0, SINGLE_CASES));
    expect(tradeoffCases.map((c) => c.id)).toEqual(ids.slice(SINGLE_CASES));
  });

  it('トレードオフの答えは、全件が優先度の手がかりを含み、must と want の混在したスロットを前提に、直前の質問を note に持つ', () => {
    for (const c of tradeoffCases) {
      expect(c.priorityCue, c.id).toBe(true);
      expect(c.slots, `${c.id}: slots`).toBeDefined();
      const priorities = new Set([...slotUnits(c.slots ?? { tags: [] }).values()].map((u) => u.priority));
      expect(priorities.has('must') && priorities.has('want'), `${c.id}: must と want が混在`).toBe(true);
      expect(c.note?.includes('直前の質問'), `${c.id}: note に直前の質問`).toBe(true);
      expect(c.expected.intent, c.id).toBe('conditions');
      expect(c.expected.ops.length, `${c.id}: ops`).toBeGreaterThan(0);
    }
  });

  it('トレードオフの答えの正解は、発話の前の優先度を実際に変える（変わらない正解は採点の母数にならない）', () => {
    for (const c of tradeoffCases) {
      const before = slotUnits(c.slots ?? { tags: [] });
      const after = slotUnits(applySlotOps(c.slots ?? { tags: [] }, c.expected.ops));
      const changed = [...after].some(([key, unit]) => before.get(key)?.priority !== unit.priority);
      expect(changed, c.id).toBe(true);
    }
  });

  it('発話が空でない・現在時刻が日時として読める', () => {
    for (const c of EXTRACTION_CASES) {
      expect(c.utterance.trim().length, c.id).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(c.now ?? EVAL_NOW)), c.id).toBe(false);
    }
  });

  it('提示済みの物件は架空データの公開物件で、表示番号は提示の範囲内', () => {
    for (const c of EXTRACTION_CASES) {
      const shown = c.shownIds ?? [];
      expect(shown.filter((id) => !publicIds.has(id)), c.id).toEqual([]);
      expect(new Set(shown).size, c.id).toBe(shown.length);
      for (const n of c.expected.targetPositions ?? []) {
        expect(Number.isInteger(n) && n >= 1 && n <= shown.length, `${c.id}: 表示番号 ${n}`).toBe(true);
      }
    }
  });

  it('内見の日時は正規形（YYYY-MM-DD か YYYY-MM-DDTHH:mm）で、評価の日より後', () => {
    for (const c of EXTRACTION_CASES) {
      const today = (c.now ?? EVAL_NOW).slice(0, 10);
      for (const t of c.expected.viewingTimes ?? []) {
        expect(canonicalizeViewingTime(t), `${c.id}: ${t}`).toBe(t);
        expect(t.slice(0, 10) > today, `${c.id}: ${t} は ${today} より後`).toBe(true);
      }
    }
  });

  it('発話の前のスロットと正解のスロットは、駅マスタ・区の一覧にある値だけ', () => {
    for (const c of EXTRACTION_CASES) {
      const before = c.slots ?? { tags: [] };
      expect(areaProblems(before), `${c.id}（発話の前）`).toEqual([]);
      expect(areaProblems(applySlotOps(before, c.expected.ops)), `${c.id}（正解）`).toEqual([]);
    }
  });

  it('正解の差分は、本番の正規化（canonicalizeOps）を通しても捨てられず、同じスロットになる', () => {
    for (const c of EXTRACTION_CASES) {
      const before = c.slots ?? { tags: [] };
      const { ops, dropped } = canonicalizeOpsWithReport(c.expected.ops);
      expect(dropped, c.id).toEqual([]);
      expect(slotUnits(applySlotOps(before, ops)), c.id).toEqual(slotUnits(applySlotOps(before, c.expected.ops)));
    }
  });

  it('優先度だけを変える差分は、対象の条件があるときだけ（無いと何も起きない）', () => {
    for (const c of EXTRACTION_CASES) {
      expect(noOpPriorityChanges(c.slots ?? { tags: [] }, c.expected.ops), c.id).toEqual([]);
    }
  });
});
