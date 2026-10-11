import { describe, expect, it } from 'vitest';
import type { HandoffNote, Slots } from '@/domain/types';
import type { ViewingRequestListItem } from '@/lib/db';
import type { HarnessTurn } from './harness';
import type { ScenarioRun } from './scenario';
import {
  baselineReachOf,
  checkStep,
  reachOf,
  scoreScenario,
  startedOutsideHours,
  summarizeScenarios,
  type ScenarioScore,
} from './scoreScenario';
import { EVAL_USD_JPY, type ScenarioCase, type ScenarioStep } from './types';

// ---------- 手で組み立てる小道具 ----------

function turn(partial: Partial<HarnessTurn> = {}): HarnessTurn {
  return {
    input: { kind: 'text', text: 'x' },
    texts: [],
    cardIds: [],
    quickReplies: [],
    state: 'hearing',
    slots: { tags: [] },
    shownPropertyIds: [],
    handoffAdded: [],
    viewingCreated: [],
    extraction: null,
    answers: [],
    latencyMs: null,
    costUsd: null,
    mustTotal: null,
    andTotal: null,
    error: null,
    ...partial,
  };
}

const note: HandoffNote = { text: '空いてますか', topic: 'vacancy', propertyIds: ['P0001'], at: '2026-10-15T12:30:00.000Z' };
const viewing = { id: 'v1', conversationId: 'c1', propertyId: 'P0001', candidateTimes: ['2026-10-16'] } as ViewingRequestListItem;

const withViewing = (partial: Partial<HarnessTurn> = {}): HarnessTurn => turn({ viewingCreated: [viewing], ...partial });
const withHandoff = (partial: Partial<HarnessTurn> = {}): HarnessTurn => turn({ handoffAdded: [note], ...partial });

function scenario(partial: Partial<ScenarioCase> = {}): ScenarioCase {
  return { id: 'sc-xx', title: 'テスト用', start: '2026-10-15T21:30:00+09:00', steps: [], expectedReach: 'viewing', ...partial };
}

/** 台本の手番（入力の種類だけ。expect は省略可） */
const steps = (...kinds: ScenarioStep['input']['kind'][]): ScenarioStep[] =>
  kinds.map((kind) => ({ input: kind === 'text' ? { kind, text: 'x' } : kind === 'follow' ? { kind } : { kind: 'tap', label: 'x' } }));

function run(s: ScenarioCase, turns: HarnessTurn[], aborted: ScenarioRun['aborted'] = null): ScenarioRun {
  return { scenario: s, pipeline: 'test', turns, aborted };
}

/** 営業時間内／外・到達・ベースラインの到達だけを決めた採点（集計のテスト用） */
function score(partial: Partial<ScenarioScore> = {}): ScenarioScore {
  return {
    id: 'sc-xx',
    title: 'テスト用',
    steps: { correct: 1, total: 1, rate: 1 },
    failures: [],
    aborted: null,
    expectedReach: 'viewing',
    reach: 'viewing',
    reachOk: true,
    startedOutsideHours: true,
    passed: true,
    textLatenciesMs: [],
    answerLatenciesMs: [],
    costUsd: 0,
    costJpy: 0,
    searches: [],
    baselineReach: 'viewing',
    ...partial,
  };
}

// ---------- checkStep ----------

describe('checkStep', () => {
  it('何も書かなければ合格（例外が無い限り）', () => {
    expect(checkStep({}, turn())).toEqual([]);
  });

  it('例外（API の障害など）は、期待に関わらず不合格にする', () => {
    expect(checkStep({}, turn({ error: '条件抽出: Error: 429' }))).toEqual(['例外: 条件抽出: Error: 429']);
  });

  it('状態・カード・引き継ぎメモ・内見の仮受付を見る', () => {
    const ok = withViewing({ state: 'handed_off', cardIds: ['P0001'] });
    expect(checkStep({ state: 'handed_off', cards: true, viewing: true, handoff: false }, ok)).toEqual([]);

    const problems = checkStep({ state: 'presenting', cards: true, viewing: false, handoff: true }, withViewing({ state: 'hearing' }));
    expect(problems).toHaveLength(4);
    expect(problems.join('\n')).toContain('状態: 期待 presenting / 実際 hearing');
    expect(problems.join('\n')).toContain('カード: 期待 あり / 実際 なし');
    expect(problems.join('\n')).toContain('内見の仮受付: 期待 保存されない / 実際 保存された');
    expect(problems.join('\n')).toContain('引き継ぎメモ: 期待 増える / 実際 増えない');

    expect(checkStep({ cards: false, handoff: true }, withHandoff({ cardIds: ['P0001', 'P0002'] }))).toEqual([
      'カード: 期待 なし / 実際 あり（2件）',
    ]);
  });

  it('must 通過件数は min・max の範囲で見る。エリアか予算が無くて数えられないときは不合格', () => {
    expect(checkStep({ total: { min: 5, max: 7 } }, turn({ mustTotal: 7 }))).toEqual([]);
    expect(checkStep({ total: { max: 0 } }, turn({ mustTotal: 0 }))).toEqual([]);
    expect(checkStep({ total: { min: 5, max: 7 } }, turn({ mustTotal: 8 }))).toEqual(['must 通過件数: 期待 5〜7 / 実際 8']);
    expect(checkStep({ total: { min: 5 } }, turn({ mustTotal: 4 }))).toEqual(['must 通過件数: 期待 5〜 / 実際 4']);
    expect(checkStep({ total: { min: 7, max: 7 } }, turn({ mustTotal: 0 }))).toEqual(['must 通過件数: 期待 7 / 実際 0']);
    expect(checkStep({ total: { max: 0 } }, turn({ mustTotal: null }))).toEqual(['must 通過件数: エリアか予算が無く数えられない']);
  });

  it('返信の文は、全部をつないだものに語が含まれる／含まれないで見る', () => {
    const t = turn({ texts: ['条件に合う物件が7件あります。', '候補が7件あります。'] });
    expect(checkStep({ includes: ['7件あります', '候補が'], excludes: ['営業時間外'] }, t)).toEqual([]);
    expect(checkStep({ includes: ['担当者'], excludes: ['候補が'] }, t)).toEqual(['返信に「担当者」が無い', '返信に「候補が」がある']);
  });

  it('条件は、あること（優先度を書けば優先度も）と、無いことを見る', () => {
    const slots: Slots = {
      area: { value: { stations: ['渋谷'], wards: [] }, priority: 'must' },
      rentMax: { value: 90000, priority: 'must' },
      tags: [{ value: 'オートロック', priority: 'want' }],
    };
    const t = turn({ slots });
    expect(
      checkStep(
        {
          conditions: [{ ref: { kind: 'tag', tag: 'オートロック' }, priority: 'want' }, { ref: { kind: 'slot', key: 'area' } }],
          absent: [{ kind: 'slot', key: 'walkMax' }, { kind: 'tag', tag: 'ペット可' }],
        },
        t,
      ),
    ).toEqual([]);
    expect(
      checkStep(
        {
          conditions: [
            { ref: { kind: 'tag', tag: 'オートロック' }, priority: 'must' },
            { ref: { kind: 'slot', key: 'floorMin' } },
          ],
          absent: [{ kind: 'slot', key: 'rentMax' }],
        },
        t,
      ),
    ).toEqual([
      '条件「オートロック」の優先度: 期待 外せない / 実際 できれば',
      '条件「階」が無い',
      '条件「予算」が残っている',
    ]);
  });

  it('クイックリプライは、ラベルの完全一致で見る', () => {
    const t = turn({ quickReplies: [{ label: '条件を変える', data: 'd1' }, { label: 'このままにする', data: 'd2' }] });
    expect(checkStep({ quickReplies: ['条件を変える'] }, t)).toEqual([]);
    expect(checkStep({ quickReplies: ['条件を'] }, t)).toEqual(['クイックリプライ「条件を」が無い（あるもの: 条件を変える / このままにする）']);
    expect(checkStep({ quickReplies: ['もっと見る'] }, turn())).toEqual(['クイックリプライ「もっと見る」が無い（あるもの: なし）']);
  });
});

// ---------- 到達 ----------

describe('reachOf', () => {
  it('内見の仮受付があれば viewing（引き継ぎもあっても）、無くて引き継ぎメモがあれば handoff、どちらも無ければ none', () => {
    expect(reachOf([turn(), withHandoff(), withViewing()])).toEqual({ reach: 'viewing', step: 2 });
    expect(reachOf([turn(), withHandoff(), turn(), withHandoff()])).toEqual({ reach: 'handoff', step: 1 });
    expect(reachOf([turn(), turn()])).toEqual({ reach: 'none', step: null });
    expect(reachOf([])).toEqual({ reach: 'none', step: null });
  });
});

describe('baselineReachOf（全条件 AND＋優先順位確認なし）', () => {
  it('到達した手番まで AND の件数が一度も 0 にならなければ、実際と同じ到達', () => {
    expect(baselineReachOf([turn({ mustTotal: 7, andTotal: 5 }), withViewing({ mustTotal: 7, andTotal: 5 })])).toBe('viewing');
    expect(baselineReachOf([turn({ mustTotal: 7, andTotal: 5 }), withHandoff({ mustTotal: 7, andTotal: 5 })])).toBe('handoff');
  });

  it('到達する前の手番で AND が 0 件になったら、そこで行き止まり（none）。優先順位つきで 7 件に増えても関係ない', () => {
    expect(
      baselineReachOf([
        turn({ mustTotal: 0, andTotal: 0 }),
        turn({ mustTotal: 7, andTotal: 0 }),
        withViewing({ mustTotal: 5, andTotal: 0 }),
      ]),
    ).toBe('none');
  });

  it('到達した手番そのものが 0 件でも行き止まり', () => {
    expect(baselineReachOf([turn({ mustTotal: 7, andTotal: 5 }), withViewing({ mustTotal: 3, andTotal: 0 })])).toBe('none');
  });

  it('到達したあとの手番で 0 件になっても影響しない', () => {
    expect(baselineReachOf([turn({ mustTotal: 7, andTotal: 5 }), withHandoff({ mustTotal: 7, andTotal: 5 }), turn({ mustTotal: 7, andTotal: 0 })])).toBe('handoff');
  });

  it('エリアか予算がまだ無い手番（件数が null）は行き止まりに数えない。実際に到達していなければ none', () => {
    expect(baselineReachOf([turn(), withViewing({ mustTotal: 4, andTotal: 4 })])).toBe('viewing');
    expect(baselineReachOf([turn({ mustTotal: 7, andTotal: 5 }), turn()])).toBe('none');
  });
});

describe('startedOutsideHours', () => {
  it('既定の営業カレンダー（10〜19時・水曜定休）で、夜・早朝・定休日は時間外、平日・土日の日中は時間内', () => {
    expect(startedOutsideHours('2026-10-15T21:30:00+09:00')).toBe(true); // 木の夜
    expect(startedOutsideHours('2026-10-16T07:30:00+09:00')).toBe(true); // 金の早朝
    expect(startedOutsideHours('2026-10-21T14:00:00+09:00')).toBe(true); // 水（定休日）の昼
    expect(startedOutsideHours('2026-10-16T13:30:00+09:00')).toBe(false); // 金の昼
    expect(startedOutsideHours('2026-10-17T11:30:00+09:00')).toBe(false); // 土の午前
    expect(startedOutsideHours('2026-10-18T15:00:00+09:00')).toBe(false); // 日の午後
  });

  it('開店ちょうどは時間内、閉店ちょうどは時間外。UTC のオフセット違いでも同じ瞬間なら同じ', () => {
    expect(startedOutsideHours('2026-10-15T10:00:00+09:00')).toBe(false);
    expect(startedOutsideHours('2026-10-15T19:00:00+09:00')).toBe(true);
    expect(startedOutsideHours('2026-10-15T01:00:00Z')).toBe(false);
  });
});

// ---------- scoreScenario ----------

describe('scoreScenario', () => {
  it('手番の合格数・不合格の理由・到達・期待との一致を出す', () => {
    const s = scenario({
      steps: [
        { input: { kind: 'follow' }, expect: { state: 'hearing' } },
        { input: { kind: 'text', text: 'x' }, expect: { state: 'presenting', cards: true } },
        { input: { kind: 'tap', label: 'x' }, expect: { viewing: true } },
      ],
    });
    const turns = [turn({ input: { kind: 'follow' } }), turn({ state: 'hearing' }), withViewing()];
    const result = scoreScenario(run(s, turns));
    expect(result.steps).toEqual({ correct: 2, total: 3, rate: 2 / 3 });
    expect(result.failures).toEqual([{ step: 1, problems: ['状態: 期待 presenting / 実際 hearing', 'カード: 期待 あり / 実際 なし'] }]);
    expect(result.reach).toBe('viewing');
    expect(result.reachOk).toBe(true);
    expect(result.passed).toBe(false); // 手番が1つ不合格
    expect(result.aborted).toBeNull();
  });

  it('全手番が合格で、到達が期待どおりなら合格。到達が期待と違えば不合格', () => {
    const s = scenario({ steps: [{ input: { kind: 'follow' }, expect: {} }, { input: { kind: 'text', text: 'x' }, expect: {} }] });
    expect(scoreScenario(run(s, [turn(), withViewing()])).passed).toBe(true);
    const missed = scoreScenario(run(s, [turn(), turn()]));
    expect(missed.reach).toBe('none');
    expect(missed.reachOk).toBe(false);
    expect(missed.passed).toBe(false);
    expect(missed.steps.correct).toBe(2); // 手番は合格でも、到達が違う
  });

  it('expect を書いていない手番は、例外が無ければ合格', () => {
    const s = scenario({ steps: steps('follow', 'text'), expectedReach: 'none' });
    expect(scoreScenario(run(s, [turn(), turn()])).passed).toBe(true);
    expect(scoreScenario(run(s, [turn(), turn({ error: '回答生成: Error: x' })])).failures).toEqual([
      { step: 1, problems: ['例外: 回答生成: Error: x'] },
    ]);
  });

  it('打ち切りは不合格。実行されなかった手番も母数に数え、打ち切られた手番の理由を失敗に載せる', () => {
    const s = scenario({ steps: steps('follow', 'text', 'tap', 'tap'), expectedReach: 'none' });
    const aborted = { step: 2, reason: 'クイックリプライ「条件を変える」が見つかりません（あるもの: なし）' };
    const result = scoreScenario(run(s, [turn(), turn()], aborted));
    expect(result.steps).toEqual({ correct: 2, total: 4, rate: 0.5 });
    expect(result.failures).toEqual([{ step: 2, problems: [`打ち切り: ${aborted.reason}`] }]);
    expect(result.aborted).toEqual(aborted);
    expect(result.reachOk).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('時間外に始まったかを、開始時刻から判定する', () => {
    expect(scoreScenario(run(scenario({ start: '2026-10-15T21:30:00+09:00' }), [])).startedOutsideHours).toBe(true);
    expect(scoreScenario(run(scenario({ start: '2026-10-16T13:30:00+09:00' }), [])).startedOutsideHours).toBe(false);
  });

  it('応答時間は、自由文の手番（latencyMs があるもの）と、回答生成を呼んだ手番だけを拾う', () => {
    const answer = { text: 'x', handoff: null, verification: 'ok' as const, latencyMs: 1, costUsd: 0.001 };
    const turns = [
      turn({ input: { kind: 'follow' }, latencyMs: 400 }),
      turn({ input: { kind: 'text', text: 'a' }, latencyMs: 3000 }),
      turn({ input: { kind: 'postback', data: 'd', label: 'x' }, latencyMs: 500 }),
      turn({ input: { kind: 'text', text: 'b' }, latencyMs: 5500, answers: [answer] }),
      turn({ input: { kind: 'text', text: 'c' }, latencyMs: null }), // 返信しなかった手番
    ];
    const result = scoreScenario(run(scenario({ steps: steps('follow', 'text', 'tap', 'text', 'text'), expectedReach: 'none' }), turns));
    expect(result.textLatenciesMs).toEqual([3000, 5500]);
    expect(result.answerLatenciesMs).toEqual([5500]);
  });

  it('1会話の費用は各手番の費用の合計（null は 0）。円には固定の為替で換算する', () => {
    const turns = [turn({ costUsd: 0.0025 }), turn({ costUsd: null }), turn({ costUsd: 0.0075 }), turn({ costUsd: 0.01 })];
    const result = scoreScenario(run(scenario({ steps: steps('text', 'tap', 'text', 'text'), expectedReach: 'none' }), turns));
    expect(result.costUsd).toBeCloseTo(0.02);
    expect(result.costJpy).toBeCloseTo(0.02 * EVAL_USD_JPY);
    expect(EVAL_USD_JPY).toBe(150);
  });

  it('検索できる条件が揃った手番ごとに、must 件数と AND 件数を並べる', () => {
    const turns = [turn(), turn({ mustTotal: 0, andTotal: 0 }), turn({ mustTotal: 7, andTotal: 0 }), turn({ mustTotal: 5, andTotal: 5 })];
    const result = scoreScenario(run(scenario({ steps: steps('follow', 'text', 'tap', 'text'), expectedReach: 'none' }), turns));
    expect(result.searches).toEqual([
      { step: 1, mustTotal: 0, andTotal: 0 },
      { step: 2, mustTotal: 7, andTotal: 0 },
      { step: 3, mustTotal: 5, andTotal: 5 },
    ]);
  });

  it('ベースラインの到達を載せる（0 件の手番があれば none）', () => {
    const s = scenario({ steps: steps('text', 'tap', 'tap') });
    const turns = [turn({ mustTotal: 0, andTotal: 0 }), turn({ mustTotal: 7, andTotal: 0 }), withViewing({ mustTotal: 7, andTotal: 0 })];
    const result = scoreScenario(run(s, turns));
    expect(result.reach).toBe('viewing');
    expect(result.baselineReach).toBe('none');
  });
});

// ---------- summarizeScenarios ----------

describe('summarizeScenarios', () => {
  it('到達率とベースラインの到達率を、全体・営業時間内・営業時間外で出す', () => {
    const summary = summarizeScenarios([
      score({ id: 'a', startedOutsideHours: true, reach: 'viewing', baselineReach: 'none' }),
      score({ id: 'b', startedOutsideHours: true, reach: 'handoff', baselineReach: 'handoff' }),
      score({ id: 'c', startedOutsideHours: true, reach: 'none', baselineReach: 'none' }),
      score({ id: 'd', startedOutsideHours: false, reach: 'viewing', baselineReach: 'viewing' }),
      score({ id: 'e', startedOutsideHours: false, reach: 'viewing', baselineReach: 'none' }),
    ]);
    expect(summary.scenarios).toBe(5);
    expect(summary.reach.all).toEqual({ correct: 4, total: 5, rate: 0.8 });
    expect(summary.reach.outsideHours).toEqual({ correct: 2, total: 3, rate: 2 / 3 });
    expect(summary.reach.inHours).toEqual({ correct: 2, total: 2, rate: 1 });
    expect(summary.baselineReach.all).toEqual({ correct: 2, total: 5, rate: 0.4 });
    expect(summary.baselineReach.outsideHours).toEqual({ correct: 1, total: 3, rate: 1 / 3 });
    expect(summary.baselineReach.inHours).toEqual({ correct: 1, total: 2, rate: 0.5 });
  });

  it('期待との一致率・手番の合格率・シナリオの合格率を出す', () => {
    const summary = summarizeScenarios([
      score({ reachOk: true, passed: true, steps: { correct: 4, total: 4, rate: 1 } }),
      score({ reachOk: false, passed: false, steps: { correct: 3, total: 5, rate: 0.6 } }),
      score({ reachOk: true, passed: false, steps: { correct: 2, total: 3, rate: 2 / 3 } }),
    ]);
    expect(summary.reachMatch).toEqual({ correct: 2, total: 3, rate: 2 / 3 });
    expect(summary.passed).toEqual({ correct: 1, total: 3, rate: 1 / 3 });
    expect(summary.steps).toEqual({ correct: 9, total: 12, rate: 0.75 });
  });

  it('自由文の手番と回答生成を呼んだ手番の応答時間を、p50/p95（最近傍順位法）で出す', () => {
    const latencies = Array.from({ length: 20 }, (_, i) => (i + 1) * 100); // 100〜2000ms
    const summary = summarizeScenarios([
      score({ textLatenciesMs: latencies.slice(0, 10), answerLatenciesMs: [4000, 6000] }),
      score({ textLatenciesMs: latencies.slice(10), answerLatenciesMs: [5000] }),
    ]);
    expect(summary.latency).toEqual({ n: 20, p50Ms: 1000, p95Ms: 1900 });
    expect(summary.answerLatency).toEqual({ n: 3, p50Ms: 5000, p95Ms: 6000 });
  });

  it('1会話の費用の平均と最大を USD と円で出す', () => {
    const summary = summarizeScenarios([score({ costUsd: 0.01 }), score({ costUsd: 0.03 }), score({ costUsd: 0.02 })]);
    expect(summary.cost.meanUsd).toBeCloseTo(0.02);
    expect(summary.cost.maxUsd).toBeCloseTo(0.03);
    expect(summary.cost.meanJpy).toBeCloseTo(0.02 * EVAL_USD_JPY);
    expect(summary.cost.maxJpy).toBeCloseTo(0.03 * EVAL_USD_JPY);
  });

  it('「AND では 0 件、優先順位つきでは N 件」の例を、シナリオごとに N が最大の手番で、N の大きい順に並べる', () => {
    const summary = summarizeScenarios([
      score({
        id: 'sc-01',
        searches: [
          { step: 1, mustTotal: 0, andTotal: 0 }, // 優先順位つきでも 0 件: 例にならない
          { step: 2, mustTotal: 7, andTotal: 0 },
          { step: 3, mustTotal: 5, andTotal: 0 },
        ],
      }),
      score({ id: 'sc-02', searches: [{ step: 0, mustTotal: 9, andTotal: 6 }] }), // AND でも出る: 例にならない
      score({
        id: 'sc-03',
        searches: [
          { step: 0, mustTotal: 8, andTotal: 0 },
          { step: 4, mustTotal: 8, andTotal: 0 }, // 同じ件数なら先の手番
        ],
      }),
    ]);
    expect(summary.andZeroExamples).toEqual([
      { id: 'sc-03', step: 0, mustTotal: 8 },
      { id: 'sc-01', step: 2, mustTotal: 7 },
    ]);
  });

  it('シナリオが無ければ、割合は null・費用も null', () => {
    const summary = summarizeScenarios([]);
    expect(summary.scenarios).toBe(0);
    expect(summary.reach.all).toEqual({ correct: 0, total: 0, rate: null });
    expect(summary.baselineReach.outsideHours.rate).toBeNull();
    expect(summary.steps.rate).toBeNull();
    expect(summary.latency).toEqual({ n: 0, p50Ms: null, p95Ms: null });
    expect(summary.cost).toEqual({ meanUsd: null, maxUsd: null, meanJpy: null, maxJpy: null });
    expect(summary.andZeroExamples).toEqual([]);
  });
});
