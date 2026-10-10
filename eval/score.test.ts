/**
 * 採点の純関数のテスト（LLM は呼ばない）。採点が甘いと評価の数字が水増しされ、厳しすぎると良い抽出が不正解になるので、
 * 「何を数えて何を数えないか」をここで固定する。
 */
import { describe, expect, it } from 'vitest';
import { baseSlots } from '@/domain/fixtures';
import type { ExtractionResult, Slots } from '@/domain/types';
import {
  compareSlots,
  percentile,
  ratio,
  scoreExtractionCase,
  summarizeExtraction,
  summarizeMeasures,
  type ExtractionCaseScore,
} from './score';
import type { ExtractionCase } from './types';

// ---------- 小道具 ----------

const result = (overrides: Partial<ExtractionResult> = {}): ExtractionResult => ({
  intent: 'conditions',
  ops: [],
  targetPositions: [],
  viewingTimes: [],
  forbiddenTopic: null,
  ...overrides,
});

type CaseOverrides = Omit<Partial<ExtractionCase>, 'expected'> & { expected?: Partial<ExtractionCase['expected']> };

function makeCase(overrides: CaseOverrides = {}): ExtractionCase {
  const { expected, ...rest } = overrides;
  return {
    id: 'ex-001',
    category: 'basic',
    priorityCue: false,
    utterance: 'テスト',
    expected: { intent: 'conditions', ops: [], ...expected },
    ...rest,
  };
}

/** スロットの一部だけ差し替えた baseSlots（渋谷・9万 must）。 */
const slots = (overrides: Partial<Slots> = {}): Slots => baseSlots(overrides);

/** 1ケースを採点して、集計に渡す組にする */
function run(overrides: CaseOverrides, actual: ExtractionResult) {
  const c = makeCase(overrides);
  return { c, actual, score: scoreExtractionCase(c, actual) };
}
function summarize(runs: ReturnType<typeof run>[]) {
  return summarizeExtraction(
    runs.map((r) => r.c),
    runs.map((r) => r.score),
    runs.map((r) => r.actual),
  );
}

// ---------- ratio ----------

describe('ratio', () => {
  it('割合は正解数/母数。母数 0 は null', () => {
    expect(ratio(3, 4)).toEqual({ correct: 3, total: 4, rate: 0.75 });
    expect(ratio(0, 0)).toEqual({ correct: 0, total: 0, rate: null });
  });
});

// ---------- compareSlots ----------

describe('compareSlots', () => {
  it('どれも変わらない単位は数えない（タグも）', () => {
    const before = slots({ tags: [{ value: 'オートロック', priority: 'want' }] });
    expect(compareSlots(before, before, before)).toEqual([]);
  });

  it('正解も実際も同じに足した単位は、値も優先度も一致として数える', () => {
    const before = slots();
    const after = slots({ walkMax: { value: 10, priority: 'want' } });
    const [unit, ...rest] = compareSlots(before, after, after);
    expect(rest).toEqual([]);
    expect(unit).toMatchObject({ key: 'walkMax', before: null, valueOk: true, priorityOk: true });
    expect(unit.expected).toEqual({ value: '10', priority: 'want' });
    expect(unit.actual).toEqual({ value: '10', priority: 'want' });
  });

  it('正解が足したのに実際が足さなかった単位は不一致（実際は null）', () => {
    const before = slots();
    const expected = slots({ walkMax: { value: 10, priority: 'want' } });
    const [unit] = compareSlots(before, expected, before);
    expect(unit).toMatchObject({ key: 'walkMax', actual: null, valueOk: false, priorityOk: false });
  });

  it('値が違う単位は不一致（優先度が同じでも）', () => {
    const before = slots();
    const expected = slots({ rentMax: { value: 70000, priority: 'must' } });
    const actual = slots({ rentMax: { value: 60000, priority: 'must' } });
    const units = compareSlots(before, expected, actual);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ key: 'rentMax', valueOk: false, priorityOk: false });
  });

  it('正解も実際も消した単位は一致、実際だけ消し損ねたら不一致', () => {
    const before = slots();
    const removed = slots();
    delete removed.rentMax;
    const [both] = compareSlots(before, removed, removed);
    expect(both).toMatchObject({ key: 'rentMax', expected: null, actual: null, valueOk: true, priorityOk: true });
    const [missed] = compareSlots(before, removed, before);
    expect(missed).toMatchObject({ key: 'rentMax', expected: null, valueOk: false, priorityOk: false });
  });

  it('消すべきだった単位を、実際が別の値に変えたら不一致', () => {
    const before = slots();
    const removed = slots();
    delete removed.rentMax;
    const changed = slots({ rentMax: { value: 80000, priority: 'must' } });
    const [unit] = compareSlots(before, removed, changed);
    expect(unit).toMatchObject({ key: 'rentMax', expected: null, valueOk: false });
  });

  it('優先度だけ変えた単位は数える。優先度だけの差は valueOk: true, priorityOk: false', () => {
    const before = slots({ floorMin: { value: 2, priority: 'want' } });
    const expected = slots({ floorMin: { value: 2, priority: 'must' } });
    // 実際は優先度を変え損ねた
    const [missed] = compareSlots(before, expected, before);
    expect(missed).toMatchObject({ key: 'floorMin', valueOk: true, priorityOk: false });
    expect(missed.expected?.priority).toBe('must');
    expect(missed.actual?.priority).toBe('want');
    // 優先度を正しく変えた
    const [done] = compareSlots(before, expected, expected);
    expect(done).toMatchObject({ key: 'floorMin', valueOk: true, priorityOk: true });
  });

  it('正解に無い単位を実際が足したら誤検出（valueOk: false）', () => {
    const before = slots();
    const actual = slots({ floorMin: { value: 3, priority: 'want' } });
    const [unit] = compareSlots(before, before, actual);
    expect(unit).toMatchObject({ key: 'floorMin', expected: null, valueOk: false, priorityOk: false });
    expect(unit.actual).toEqual({ value: '3', priority: 'want' });
  });

  it('正解が変えない単位を、実際が優先度だけ変えても数える（valueOk: true, priorityOk: false）', () => {
    const before = slots();
    const actual = slots({ rentMax: { value: 90000, priority: 'nice' } });
    const [unit] = compareSlots(before, before, actual);
    expect(unit).toMatchObject({ key: 'rentMax', valueOk: true, priorityOk: false });
  });

  it('エリアの駅・区の並びと間取りの並びは問わない', () => {
    const before = slots();
    const expected = slots({
      area: { value: { stations: ['渋谷', '新宿'], wards: ['目黒区', '世田谷区'] }, priority: 'must' },
      layouts: { value: ['1K', '1DK'], priority: 'want' },
    });
    const actual = slots({
      area: { value: { stations: ['新宿', '渋谷'], wards: ['世田谷区', '目黒区'] }, priority: 'must' },
      layouts: { value: ['1DK', '1K'], priority: 'want' },
    });
    const units = compareSlots(before, expected, actual);
    expect(units.map((u) => u.key)).toEqual(['area', 'layouts']);
    expect(units.every((u) => u.valueOk && u.priorityOk)).toBe(true);
  });

  it('エリアの駅が1つ違えば不一致', () => {
    const before = slots();
    const expected = slots({ area: { value: { stations: ['渋谷', '新宿'], wards: [] }, priority: 'must' } });
    const actual = slots({ area: { value: { stations: ['渋谷'], wards: [] }, priority: 'must' } });
    const [unit] = compareSlots(before, expected, actual);
    expect(unit).toMatchObject({ key: 'area', valueOk: false });
  });

  it('タグはタグごとの単位（tag:名前）。足した・外した・優先度を変えた、を別々に数える', () => {
    const before = slots({
      tags: [
        { value: 'オートロック', priority: 'want' },
        { value: 'ペット可', priority: 'want' },
      ],
    });
    const expected = slots({
      tags: [
        { value: 'オートロック', priority: 'must' }, // 優先度だけ上げる
        { value: '南向き', priority: 'want' }, // 足す
        // ペット可は外す
      ],
    });
    // 実際: 南向きは足せたが、オートロックの優先度は上げ損ね、ペット可は外し損ねた
    const actual = slots({
      tags: [
        { value: 'オートロック', priority: 'want' },
        { value: 'ペット可', priority: 'want' },
        { value: '南向き', priority: 'want' },
      ],
    });
    const byKey = Object.fromEntries(compareSlots(before, expected, actual).map((u) => [u.key, u]));
    expect(Object.keys(byKey).sort()).toEqual(['tag:オートロック', 'tag:ペット可', 'tag:南向き']);
    expect(byKey['tag:オートロック']).toMatchObject({ valueOk: true, priorityOk: false });
    expect(byKey['tag:ペット可']).toMatchObject({ expected: null, valueOk: false });
    expect(byKey['tag:南向き']).toMatchObject({ valueOk: true, priorityOk: true });
  });

  it('タグの並びは問わない', () => {
    const before = slots();
    const a = slots({
      tags: [
        { value: 'オートロック', priority: 'want' },
        { value: '南向き', priority: 'want' },
      ],
    });
    const b = slots({
      tags: [
        { value: '南向き', priority: 'want' },
        { value: 'オートロック', priority: 'want' },
      ],
    });
    expect(compareSlots(before, a, b).every((u) => u.valueOk && u.priorityOk)).toBe(true);
  });
});

// ---------- scoreExtractionCase ----------

describe('scoreExtractionCase', () => {
  it('set に priority を付ける書き方と、set ＋ setPriority の書き方は同じ（差分の書き方で不正解にしない）', () => {
    const c = makeCase({
      expected: {
        ops: [{ op: 'set', key: 'floorMin', value: 2, priority: 'must' }],
      },
    });
    const viaSet = scoreExtractionCase(c, result({ ops: [{ op: 'set', key: 'floorMin', value: 2, priority: 'must' }] }));
    const viaSetPriority = scoreExtractionCase(
      c,
      result({
        ops: [
          { op: 'set', key: 'floorMin', value: 2 },
          { op: 'setPriority', key: 'floorMin', priority: 'must' },
        ],
      }),
    );
    expect(viaSet.exact).toBe(true);
    expect(viaSetPriority.exact).toBe(true);
    expect(viaSetPriority.units).toHaveLength(1);
  });

  it('既存の条件の優先度だけを変える正解は、setPriority でも set（priority つき）でも一致する', () => {
    const before = slots({ floorMin: { value: 2, priority: 'want' } });
    const c = makeCase({ slots: before, expected: { ops: [{ op: 'setPriority', key: 'floorMin', priority: 'must' }] } });
    expect(scoreExtractionCase(c, result({ ops: [{ op: 'set', key: 'floorMin', value: 2, priority: 'must' }] })).slotsOk).toBe(true);
    // 優先度を変えなかった（既存の優先度を保つ set）なら不一致
    const unchanged = scoreExtractionCase(c, result({ ops: [{ op: 'set', key: 'floorMin', value: 2 }] }));
    expect(unchanged.slotsOk).toBe(false);
    expect(unchanged.units[0]).toMatchObject({ valueOk: true, priorityOk: false });
  });

  it('priority を省略した op は既定の優先度（エリア・予算は must、ほかは want）で比べる', () => {
    const c = makeCase({
      expected: {
        ops: [
          { op: 'set', key: 'rentMax', value: 70000 },
          { op: 'set', key: 'walkMax', value: 10 },
        ],
      },
    });
    const actual = result({
      ops: [
        { op: 'set', key: 'rentMax', value: 70000, priority: 'must' },
        { op: 'set', key: 'walkMax', value: 10, priority: 'want' },
      ],
    });
    expect(scoreExtractionCase(c, actual).slotsOk).toBe(true);
  });

  it('変更なしの正解に、実際が余計な条件を足したら不一致', () => {
    const c = makeCase({ expected: { intent: 'showMore' } });
    const s = scoreExtractionCase(c, result({ intent: 'showMore', ops: [{ op: 'set', key: 'walkMax', value: 10 }] }));
    expect(s.intentOk).toBe(true);
    expect(s.slotsOk).toBe(false);
    expect(s.exact).toBe(false);
  });

  it('発話の前のスロットがあるとき、変わらない条件は数えない', () => {
    const c = makeCase({
      slots: slots(),
      expected: { ops: [{ op: 'set', key: 'rentMax', value: 70000 }] },
    });
    const s = scoreExtractionCase(c, result({ ops: [{ op: 'set', key: 'rentMax', value: 70000 }] }));
    expect(s.units.map((u) => u.key)).toEqual(['rentMax']);
    expect(s.exact).toBe(true);
  });

  it('意図は正解と、alsoAcceptIntents のどれかなら一致', () => {
    const c = makeCase({ expected: { intent: 'conditions', alsoAcceptIntents: ['showMore'] } });
    expect(scoreExtractionCase(c, result({ intent: 'conditions' })).intentOk).toBe(true);
    expect(scoreExtractionCase(c, result({ intent: 'showMore' })).intentOk).toBe(true);
    expect(scoreExtractionCase(c, result({ intent: 'offTopic' })).intentOk).toBe(false);
    // alsoAcceptIntents が無ければ正解の意図だけ
    const strict = makeCase({ expected: { intent: 'conditions' } });
    expect(scoreExtractionCase(strict, result({ intent: 'showMore' })).intentOk).toBe(false);
  });

  it('targetPositions は集合として比べる（順不同）', () => {
    const c = makeCase({ expected: { intent: 'propertyQuestion', targetPositions: [2, 1] } });
    const intent = 'propertyQuestion' as const;
    expect(scoreExtractionCase(c, result({ intent, targetPositions: [1, 2] })).targetsOk).toBe(true);
    expect(scoreExtractionCase(c, result({ intent, targetPositions: [1] })).targetsOk).toBe(false);
    expect(scoreExtractionCase(c, result({ intent, targetPositions: [1, 2, 3] })).targetsOk).toBe(false);
    expect(scoreExtractionCase(c, result({ intent, targetPositions: [1, 3] })).targetsOk).toBe(false);
  });

  it('viewingTimes は集合として比べる（順不同）。日付だけと日時は別物', () => {
    const c = makeCase({
      expected: { intent: 'viewingRequest', viewingTimes: ['2026-10-17T14:00', '2026-10-18'] },
    });
    const intent = 'viewingRequest' as const;
    expect(scoreExtractionCase(c, result({ intent, viewingTimes: ['2026-10-18', '2026-10-17T14:00'] })).viewingTimesOk).toBe(true);
    expect(scoreExtractionCase(c, result({ intent, viewingTimes: ['2026-10-17T14:00'] })).viewingTimesOk).toBe(false);
    expect(scoreExtractionCase(c, result({ intent, viewingTimes: ['2026-10-17', '2026-10-18'] })).viewingTimesOk).toBe(false);
  });

  it('省略した targetPositions・viewingTimes・forbiddenTopic は []・[]・null として比べる', () => {
    const c = makeCase({ expected: { intent: 'offTopic' } });
    expect(scoreExtractionCase(c, result({ intent: 'offTopic' })).exact).toBe(true);
    expect(scoreExtractionCase(c, result({ intent: 'offTopic', targetPositions: [1] })).targetsOk).toBe(false);
    expect(scoreExtractionCase(c, result({ intent: 'offTopic', viewingTimes: ['2026-10-16'] })).viewingTimesOk).toBe(false);
    expect(scoreExtractionCase(c, result({ intent: 'offTopic', forbiddenTopic: 'noise' })).forbiddenOk).toBe(false);
  });

  it('禁止トピックは同じ話題のときだけ一致（null どうしも一致）', () => {
    const c = makeCase({ expected: { intent: 'handoff', forbiddenTopic: 'noise' } });
    expect(scoreExtractionCase(c, result({ intent: 'handoff', forbiddenTopic: 'noise' })).forbiddenOk).toBe(true);
    expect(scoreExtractionCase(c, result({ intent: 'handoff', forbiddenTopic: 'safety' })).forbiddenOk).toBe(false);
    expect(scoreExtractionCase(c, result({ intent: 'handoff', forbiddenTopic: null })).forbiddenOk).toBe(false);
    const none = makeCase({ expected: { intent: 'conditions', forbiddenTopic: null } });
    expect(scoreExtractionCase(none, result()).forbiddenOk).toBe(true);
  });

  it('exact は、意図・スロット・表示番号・日時・禁止トピックのすべてが一致したときだけ true', () => {
    const c = makeCase({
      expected: {
        intent: 'handoff',
        ops: [{ op: 'set', key: 'rentMax', value: 70000 }],
        targetPositions: [1],
        viewingTimes: ['2026-10-16'],
        forbiddenTopic: 'vacancy',
      },
    });
    const good = result({
      intent: 'handoff',
      ops: [{ op: 'set', key: 'rentMax', value: 70000 }],
      targetPositions: [1],
      viewingTimes: ['2026-10-16'],
      forbiddenTopic: 'vacancy',
    });
    expect(scoreExtractionCase(c, good).exact).toBe(true);
    const broken: Partial<ExtractionResult>[] = [
      { intent: 'conditions' },
      { ops: [{ op: 'set', key: 'rentMax', value: 60000 }] },
      { targetPositions: [2] },
      { viewingTimes: [] },
      { forbiddenTopic: null },
    ];
    for (const override of broken) {
      expect(scoreExtractionCase(c, { ...good, ...override }).exact, JSON.stringify(override)).toBe(false);
    }
  });

  it('id・category・priorityCue を引き継ぐ', () => {
    const s = scoreExtractionCase(makeCase({ id: 'ex-009', category: 'priority', priorityCue: true }), result());
    expect(s).toMatchObject({ id: 'ex-009', category: 'priority', priorityCue: true });
  });
});

// ---------- summarizeExtraction ----------

describe('summarizeExtraction', () => {
  it('スロットの一致率は、変わった単位の合計で数える（ケースの平均ではない）', () => {
    const runs = [
      // 2 単位とも正解
      run(
        { id: 'ex-001', expected: { ops: [{ op: 'set', key: 'rentMax', value: 70000 }, { op: 'set', key: 'walkMax', value: 10 }] } },
        result({ ops: [{ op: 'set', key: 'rentMax', value: 70000 }, { op: 'set', key: 'walkMax', value: 10 }] }),
      ),
      // 4 単位のうち 1 つだけ正解
      run(
        {
          id: 'ex-002',
          expected: {
            ops: [
              { op: 'set', key: 'rentMax', value: 70000 },
              { op: 'set', key: 'walkMax', value: 10 },
              { op: 'set', key: 'floorMin', value: 2 },
              { op: 'addTag', tag: 'オートロック' },
            ],
          },
        },
        result({ ops: [{ op: 'set', key: 'rentMax', value: 70000 }] }),
      ),
    ];
    const summary = summarize(runs);
    // 全体: 2 + 4 = 6 単位のうち 3 単位が一致（ケースの平均なら (1 + 0.25) / 2 = 62.5%）
    expect(summary.slotValue).toEqual({ correct: 3, total: 6, rate: 0.5 });
    expect(summary.cases).toBe(2);
  });

  it('変わっていない条件は母数に入らない', () => {
    const before = slots({ walkMax: { value: 10, priority: 'want' }, floorMin: { value: 2, priority: 'want' } });
    const summary = summarize([
      run(
        { slots: before, expected: { ops: [{ op: 'set', key: 'rentMax', value: 70000 }] } },
        result({ ops: [{ op: 'set', key: 'rentMax', value: 70000 }] }),
      ),
    ]);
    expect(summary.slotValue).toEqual({ correct: 1, total: 1, rate: 1 });
  });

  it('優先度だけ変わった単位はスロットの母数に入れず、優先度の母数に入れる（値の一致率の水増しを防ぐ）', () => {
    const before = slots({ floorMin: { value: 2, priority: 'want' } });
    const summary = summarize([
      run(
        {
          priorityCue: true,
          slots: before,
          expected: { ops: [{ op: 'setPriority', key: 'floorMin', priority: 'must' }, { op: 'set', key: 'rentMax', value: 70000 }] },
        },
        result({ ops: [{ op: 'set', key: 'rentMax', value: 70000 }] }),
      ),
    ]);
    expect(summary.slotValue).toEqual({ correct: 1, total: 1, rate: 1 });
    // floorMin（優先度の取りこぼし）と rentMax（既定の must で一致）
    expect(summary.priority).toEqual({ correct: 1, total: 2, rate: 0.5 });
  });

  it('実際が余計な条件を足した分（誤検出）は母数に入って不一致に数える', () => {
    const summary = summarize([
      run(
        { expected: { ops: [{ op: 'set', key: 'rentMax', value: 70000 }] } },
        result({ ops: [{ op: 'set', key: 'rentMax', value: 70000 }, { op: 'set', key: 'walkMax', value: 5 }] }),
      ),
    ]);
    expect(summary.slotValue).toEqual({ correct: 1, total: 2, rate: 0.5 });
  });

  it('変わる条件が何もないケースだけなら、スロットの母数は 0（rate は null）', () => {
    const summary = summarize([run({ expected: { intent: 'showMore' } }, result({ intent: 'showMore' }))]);
    expect(summary.slotValue).toEqual({ correct: 0, total: 0, rate: null });
    expect(summary.exact).toEqual({ correct: 1, total: 1, rate: 1 });
  });

  it('優先度は、priorityCue: true の発話で値が一致した単位だけを母数にする', () => {
    const summary = summarize([
      // 手がかりあり・値一致・優先度一致 → 分子 1・母数 1
      run(
        { id: 'ex-001', priorityCue: true, expected: { ops: [{ op: 'set', key: 'rentMax', value: 70000, priority: 'must' }] } },
        result({ ops: [{ op: 'set', key: 'rentMax', value: 70000, priority: 'must' }] }),
      ),
      // 手がかりあり・値一致・優先度不一致（want のまま）→ 母数に入って不一致
      run(
        { id: 'ex-002', priorityCue: true, expected: { ops: [{ op: 'set', key: 'floorMin', value: 2, priority: 'must' }] } },
        result({ ops: [{ op: 'set', key: 'floorMin', value: 2 }] }),
      ),
      // 手がかりあり・値が不一致 → 母数に入らない
      run(
        { id: 'ex-003', priorityCue: true, expected: { ops: [{ op: 'addTag', tag: 'オートロック', priority: 'must' }] } },
        result({ ops: [{ op: 'addTag', tag: '南向き', priority: 'must' }] }),
      ),
      // 手がかりなし・優先度不一致 → 母数に入らない
      run(
        { id: 'ex-004', priorityCue: false, expected: { ops: [{ op: 'set', key: 'walkMax', value: 10, priority: 'must' }] } },
        result({ ops: [{ op: 'set', key: 'walkMax', value: 10 }] }),
      ),
    ]);
    expect(summary.priority).toEqual({ correct: 1, total: 2, rate: 0.5 });
  });

  it('優先度の母数に、正解が「外す」で実際も外した単位は入らない（優先度が無い）', () => {
    const before = slots({ floorMin: { value: 2, priority: 'want' } });
    const summary = summarize([
      run(
        { priorityCue: true, slots: before, expected: { ops: [{ op: 'unset', key: 'floorMin' }] } },
        result({ ops: [{ op: 'unset', key: 'floorMin' }] }),
      ),
    ]);
    expect(summary.priority).toEqual({ correct: 0, total: 0, rate: null });
    // 値（有無）としては一致に数える
    expect(summary.slotValue).toEqual({ correct: 1, total: 1, rate: 1 });
  });

  it('優先度だけを変える発話（setPriority）は、優先度の母数に入る', () => {
    const before = slots({ floorMin: { value: 2, priority: 'want' } });
    const summary = summarize([
      run(
        { priorityCue: true, slots: before, expected: { ops: [{ op: 'setPriority', key: 'floorMin', priority: 'must' }] } },
        result({ ops: [{ op: 'setPriority', key: 'floorMin', priority: 'must' }] }),
      ),
      run(
        { priorityCue: true, slots: before, expected: { ops: [{ op: 'setPriority', key: 'floorMin', priority: 'nice' }] } },
        result({ ops: [{ op: 'setPriority', key: 'floorMin', priority: 'want' }] }),
      ),
    ]);
    expect(summary.priority).toEqual({ correct: 1, total: 2, rate: 0.5 });
  });

  it('禁止トピック: 正解が禁止トピックの発話での再現率と、禁止トピックでない発話への誤検出の件数', () => {
    const summary = summarize([
      run({ expected: { intent: 'handoff', forbiddenTopic: 'noise' } }, result({ intent: 'handoff', forbiddenTopic: 'noise' })), // 再現
      run({ expected: { intent: 'handoff', forbiddenTopic: 'safety' } }, result({ intent: 'handoff', forbiddenTopic: null })), // 見逃し
      run({ expected: { intent: 'handoff', forbiddenTopic: 'vacancy' } }, result({ intent: 'handoff', forbiddenTopic: 'noise' })), // 別の話題
      run({ expected: { intent: 'conditions' } }, result({ forbiddenTopic: 'screening' })), // 誤検出
      run({ expected: { intent: 'conditions' } }, result()), // 正しく null
      run({ expected: { intent: 'conditions', forbiddenTopic: null } }, result({ forbiddenTopic: 'neighbors' })), // 誤検出（null を明示）
    ]);
    expect(summary.forbiddenRecall).toEqual({ correct: 1, total: 3, rate: 1 / 3 });
    expect(summary.forbiddenFalsePositives).toBe(2);
  });

  it('禁止トピックが正解にないセットでは、再現率の母数は 0', () => {
    const summary = summarize([run({}, result())]);
    expect(summary.forbiddenRecall).toEqual({ correct: 0, total: 0, rate: null });
    expect(summary.forbiddenFalsePositives).toBe(0);
  });

  it('表示番号は、正解か実際のどちらかが持つ発話だけが母数（どちらも空の発話は入らない）', () => {
    const intent = 'propertyQuestion' as const;
    const summary = summarize([
      run({ expected: { intent, targetPositions: [2] } }, result({ intent, targetPositions: [2] })), // 一致
      run({ expected: { intent, targetPositions: [1, 2] } }, result({ intent, targetPositions: [2, 1] })), // 順不同で一致
      run({ expected: { intent, targetPositions: [1] } }, result({ intent })), // 実際が空 → 母数に入って不一致
      run({ expected: { intent: 'conditions' } }, result({ targetPositions: [3] })), // 正解が空で実際が持つ → 母数に入って不一致
      run({ expected: { intent: 'conditions' } }, result()), // どちらも空 → 母数に入らない
    ]);
    expect(summary.targets).toEqual({ correct: 2, total: 4, rate: 0.5 });
  });

  it('内見の日時は、正解か実際のどちらかが持つ発話だけが母数', () => {
    const intent = 'viewingRequest' as const;
    const summary = summarize([
      run({ expected: { intent, viewingTimes: ['2026-10-17T14:00'] } }, result({ intent, viewingTimes: ['2026-10-17T14:00'] })), // 一致
      run({ expected: { intent, viewingTimes: ['2026-10-17'] } }, result({ intent, viewingTimes: ['2026-10-18'] })), // 不一致
      run({ expected: { intent: 'conditions' } }, result({ viewingTimes: ['2026-10-16'] })), // 実際だけ持つ → 不一致
      run({ expected: { intent } }, result({ intent })), // どちらも空（日時を聞き返す発話）→ 母数に入らない
    ]);
    expect(summary.viewingTimes).toEqual({ correct: 1, total: 3, rate: 1 / 3 });
  });

  it('意図の一致率と、発話単位の完全一致', () => {
    const summary = summarize([
      run({ expected: { intent: 'showMore' } }, result({ intent: 'showMore' })),
      run({ expected: { intent: 'showMore' } }, result({ intent: 'conditions' })),
      run({ expected: { intent: 'conditions', ops: [{ op: 'set', key: 'rentMax', value: 70000 }] } }, result({ intent: 'conditions' })), // 意図は合うがスロットが違う
    ]);
    expect(summary.intent).toEqual({ correct: 2, total: 3, rate: 2 / 3 });
    expect(summary.exact).toEqual({ correct: 1, total: 3, rate: 1 / 3 });
  });

  it('カテゴリ別の完全一致', () => {
    const summary = summarize([
      run({ category: 'basic', expected: { intent: 'showMore' } }, result({ intent: 'showMore' })),
      run({ category: 'basic', expected: { intent: 'showMore' } }, result({ intent: 'offTopic' })),
      run({ category: 'forbidden', expected: { intent: 'handoff', forbiddenTopic: 'noise' } }, result({ intent: 'handoff', forbiddenTopic: 'noise' })),
    ]);
    expect(summary.byCategory).toEqual({
      basic: { correct: 1, total: 2, rate: 0.5 },
      forbidden: { correct: 1, total: 1, rate: 1 },
    });
  });

  it('件数が合わなければ例外', () => {
    const r = run({}, result());
    expect(() => summarizeExtraction([r.c, r.c], [r.score], [r.actual])).toThrow('件数');
    expect(() => summarizeExtraction([r.c], [r.score, r.score], [r.actual])).toThrow('件数');
    expect(() => summarizeExtraction([r.c], [r.score], [])).toThrow('件数');
  });

  it('0 件でも落ちない（どの割合も rate は null）', () => {
    const empty: ExtractionCaseScore[] = [];
    const summary = summarizeExtraction([], empty, []);
    expect(summary.cases).toBe(0);
    for (const r of [summary.exact, summary.intent, summary.slotValue, summary.priority, summary.forbiddenRecall, summary.targets, summary.viewingTimes]) {
      expect(r).toEqual({ correct: 0, total: 0, rate: null });
    }
    expect(summary.forbiddenFalsePositives).toBe(0);
    expect(summary.byCategory).toEqual({});
  });
});

// ---------- percentile・summarizeMeasures ----------

describe('percentile', () => {
  it('空なら null', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([], 95)).toBeNull();
  });

  it('最近傍順位法: 順位 = ceil(p/100 × n)、その順位の値', () => {
    const values = [15, 20, 35, 40, 50];
    expect(percentile(values, 30)).toBe(20); // ceil(1.5) = 2 位
    expect(percentile(values, 40)).toBe(20); // ceil(2.0) = 2 位
    expect(percentile(values, 50)).toBe(35); // ceil(2.5) = 3 位
    expect(percentile(values, 100)).toBe(50);
  });

  it('p0 は最小、p100 は最大。値が1つならそれ', () => {
    expect(percentile([30, 10, 20], 0)).toBe(10);
    expect(percentile([30, 10, 20], 100)).toBe(30);
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });

  it('p95: 20 件なら 19 位、10 件なら 10 位（最大）', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
    expect(percentile(twenty, 95)).toBe(1900);
    expect(percentile(twenty, 50)).toBe(1000);
    const ten = Array.from({ length: 10 }, (_, i) => (i + 1) * 100);
    expect(percentile(ten, 95)).toBe(1000);
  });

  it('並びが不順でもよく、渡した配列を並べ替えない', () => {
    const values = [300, 100, 200];
    expect(percentile(values, 50)).toBe(200);
    expect(values).toEqual([300, 100, 200]);
  });
});

describe('summarizeMeasures', () => {
  it('空なら件数 0・パーセンタイルと平均は null・合計 0', () => {
    expect(summarizeMeasures([])).toEqual({ n: 0, p50Ms: null, p95Ms: null, maxMs: null, meanCostUsd: null, totalCostUsd: 0 });
  });

  it('p50・p95・max・費用の平均と合計', () => {
    const measures = [
      { latencyMs: 400, costUsd: 0.004 },
      { latencyMs: 100, costUsd: 0.001 },
      { latencyMs: 300, costUsd: 0.003 },
      { latencyMs: 200, costUsd: 0.002 },
    ];
    const s = summarizeMeasures(measures);
    expect(s.n).toBe(4);
    expect(s.p50Ms).toBe(200); // ceil(2.0) = 2 位
    expect(s.p95Ms).toBe(400); // ceil(3.8) = 4 位
    expect(s.maxMs).toBe(400);
    expect(s.totalCostUsd).toBeCloseTo(0.01, 10);
    expect(s.meanCostUsd).toBeCloseTo(0.0025, 10);
  });

  it('1件だけなら、その値がそのまま p50・p95・max', () => {
    const s = summarizeMeasures([{ latencyMs: 1234, costUsd: 0.002 }]);
    expect(s).toMatchObject({ n: 1, p50Ms: 1234, p95Ms: 1234, maxMs: 1234, meanCostUsd: 0.002, totalCostUsd: 0.002 });
  });
});
