/**
 * 評価ランナーの純関数（引数の解析・絞り込み・採点のとりまとめ・レポートの整形）のテスト。I/O と実 API は使わない。
 */
import { describe, expect, it } from 'vitest';
import { baseSlots, makeProperty } from '@/domain/fixtures';
import type { ExtractionResult } from '@/domain/types';
import { fallbackExtraction } from '@/lib/llm/extract';
import { MODEL_FAST, MODEL_SMART } from '@/lib/llm/models';
import {
  DEFAULT_MAX_COST_USD,
  DEFAULT_OUT_DIR,
  EVAL_SET_ARGS,
  buildResultFile,
  countErrors,
  describeError,
  describeMismatch,
  formatExtractionReport,
  formatFraction,
  formatJst,
  formatLogEntry,
  formatProgress,
  formatRate,
  parseEvalArgs,
  resolveShown,
  resultFileName,
  scoreRun,
  selectCases,
  setsOf,
  summarizeRuns,
  type CaseRun,
  type ExtractionReportInput,
  type RawCaseRun,
} from './report';
import type { RunMeta } from './reportCommon';
import { ratio } from './score';
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

function makeRaw(c: ExtractionCase, actual: ExtractionResult, overrides: Partial<RawCaseRun> = {}): RawCaseRun {
  return { case: c, actual, latencyMs: 100, costUsd: 0.001, logs: [], error: null, ...overrides };
}

const AT = new Date('2026-10-15T21:30:00+09:00');

/** 実行の設定（本番の two-model・辞書あり・全件・実 API）。必要な項目だけ上書きする */
function makeMeta(overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    set: 'extraction',
    config: 'two-model',
    dictionary: true,
    models: { extract: MODEL_FAST, answer: null },
    modelOverride: false,
    fake: false,
    limit: null,
    ids: null,
    totalCases: 4,
    maxCostUsd: 2,
    cutoff: null,
    at: AT,
    ...overrides,
  };
}

// ---------- parseEvalArgs ----------

describe('parseEvalArgs', () => {
  it('省略時の既定: extraction・two-model・辞書あり・全件・実 API・費用上限 $2・eval/results', () => {
    expect(parseEvalArgs([])).toEqual({
      set: 'extraction',
      config: 'two-model',
      dictionary: true,
      model: null,
      limit: null,
      ids: null,
      fake: false,
      maxCostUsd: 2,
      out: 'eval/results',
    });
    expect(DEFAULT_OUT_DIR).toBe('eval/results');
    expect(DEFAULT_MAX_COST_USD).toBe(2);
  });

  it('すべてのオプションを読む', () => {
    expect(
      parseEvalArgs([
        '--set=extraction',
        '--config=haiku-answer',
        '--no-dictionary',
        '--model=claude-sonnet-5-5',
        '--limit=5',
        '--ids=ex-001,ex-002',
        '--fake',
        '--max-cost=0.5',
        '--out=tmp/out',
      ]),
    ).toEqual({
      set: 'extraction',
      config: 'haiku-answer',
      dictionary: false,
      model: 'claude-sonnet-5-5',
      limit: 5,
      ids: ['ex-001', 'ex-002'],
      fake: true,
      maxCostUsd: 0.5,
      out: 'tmp/out',
    });
  });

  it('--ids は空白を除いて読み、順を保つ', () => {
    expect(parseEvalArgs(['--ids=ex-010, ex-002 ,ex-001']).ids).toEqual(['ex-010', 'ex-002', 'ex-001']);
  });

  it('--set は extraction・attack・scenario・all', () => {
    for (const set of EVAL_SET_ARGS) expect(parseEvalArgs([`--set=${set}`]).set).toBe(set);
    expect(() => parseEvalArgs(['--set=answer'])).toThrow('--set');
    expect(() => parseEvalArgs(['--set='])).toThrow('--set');
    expect(() => parseEvalArgs(['--set'])).toThrow('--set');
  });

  it('setsOf: all は3つを extraction → attack → scenario の順に、ほかはそのセットだけ', () => {
    expect(setsOf('all')).toEqual(['extraction', 'attack', 'scenario']);
    expect(setsOf('attack')).toEqual(['attack']);
  });

  it('--config は定義された3つだけ', () => {
    for (const config of ['two-model', 'haiku-answer', 'one-model']) expect(parseEvalArgs([`--config=${config}`]).config).toBe(config);
    expect(() => parseEvalArgs(['--config=three-model'])).toThrow('--config');
    expect(() => parseEvalArgs(['--config='])).toThrow('--config');
    expect(() => parseEvalArgs(['--config'])).toThrow('--config');
  });

  it('--no-dictionary は one-model と組み合わせると引数の誤り（順は問わない）。two-model・haiku-answer なら通る', () => {
    expect(() => parseEvalArgs(['--no-dictionary', '--config=one-model'])).toThrow('--no-dictionary');
    expect(() => parseEvalArgs(['--config=one-model', '--no-dictionary'])).toThrow('one-model');
    expect(parseEvalArgs(['--no-dictionary']).dictionary).toBe(false);
    expect(parseEvalArgs(['--no-dictionary', '--config=haiku-answer']).dictionary).toBe(false);
    expect(parseEvalArgs(['--config=one-model']).dictionary).toBe(true);
  });

  it('--no-dictionary と --fake は値を取らない', () => {
    expect(() => parseEvalArgs(['--no-dictionary=true'])).toThrow('--no-dictionary');
    expect(() => parseEvalArgs(['--fake=true'])).toThrow('--fake');
  });

  it('--model は --set=extraction（省略時を含む）のときだけ。attack・scenario・all では誤り', () => {
    expect(parseEvalArgs(['--model=claude-sonnet-5-5']).model).toBe('claude-sonnet-5-5');
    expect(parseEvalArgs(['--set=extraction', '--model=x']).model).toBe('x');
    for (const set of ['attack', 'scenario', 'all']) expect(() => parseEvalArgs([`--set=${set}`, '--model=x']), set).toThrow('--model');
    expect(() => parseEvalArgs(['--model=x', '--set=attack'])).toThrow('--model');
  });

  it('--ids は --set=all では誤り（評価セットごとに id が違う）。--limit は all でも使える', () => {
    expect(() => parseEvalArgs(['--set=all', '--ids=ex-001'])).toThrow('--ids');
    expect(parseEvalArgs(['--set=all', '--limit=3']).limit).toBe(3);
    expect(parseEvalArgs(['--set=attack', '--ids=at-001']).ids).toEqual(['at-001']);
  });

  it('--max-cost は 0 より大きい数（USD）。小数も書ける', () => {
    expect(parseEvalArgs(['--max-cost=2']).maxCostUsd).toBe(2);
    expect(parseEvalArgs(['--max-cost=0.005']).maxCostUsd).toBe(0.005);
    expect(parseEvalArgs(['--max-cost=10.5']).maxCostUsd).toBe(10.5);
    const bads = ['--max-cost=0', '--max-cost=0.0', '--max-cost=-1', '--max-cost=abc', '--max-cost=', '--max-cost', '--max-cost=1e3', '--max-cost=.5', '--max-cost=$2'];
    for (const bad of bads) expect(() => parseEvalArgs([bad]), bad).toThrow('--max-cost');
  });

  it('未知のオプションと位置引数は例外', () => {
    expect(() => parseEvalArgs(['--unknown'])).toThrow('未知のオプション: --unknown');
    expect(() => parseEvalArgs(['--fake-mode'])).toThrow('未知のオプション');
    expect(() => parseEvalArgs(['--no-dict'])).toThrow('未知のオプション');
    expect(() => parseEvalArgs(['extraction'])).toThrow('未知のオプション: extraction');
    expect(() => parseEvalArgs(['-h'])).toThrow('未知のオプション');
  });

  it('--limit は 1 以上の整数だけ', () => {
    expect(parseEvalArgs(['--limit=1']).limit).toBe(1);
    expect(parseEvalArgs(['--limit=100']).limit).toBe(100);
    for (const bad of ['--limit=0', '--limit=-3', '--limit=1.5', '--limit=abc', '--limit=', '--limit', '--limit=3x', '--limit=03']) {
      expect(() => parseEvalArgs([bad]), bad).toThrow('--limit');
    }
  });

  it('--ids の空・空の要素・重複は例外', () => {
    expect(() => parseEvalArgs(['--ids='])).toThrow('--ids');
    expect(() => parseEvalArgs(['--ids=ex-001,,ex-002'])).toThrow('空の id');
    expect(() => parseEvalArgs(['--ids=ex-001,'])).toThrow('空の id');
    expect(() => parseEvalArgs(['--ids=ex-001,ex-002,ex-001'])).toThrow('重複');
  });

  it('値が要るオプションの値が空なら例外', () => {
    expect(() => parseEvalArgs(['--model='])).toThrow('--model');
    expect(() => parseEvalArgs(['--model'])).toThrow('--model');
    expect(() => parseEvalArgs(['--out='])).toThrow('--out');
  });

  it('同じオプションを2回書いたら後のものが勝つ', () => {
    expect(parseEvalArgs(['--limit=3', '--limit=5']).limit).toBe(5);
    expect(parseEvalArgs(['--config=one-model', '--config=two-model']).config).toBe('two-model');
  });
});

// ---------- selectCases ----------

describe('selectCases', () => {
  const cases = ['ex-001', 'ex-002', 'ex-003', 'ex-004'].map((id) => makeCase({ id }));
  const idsOf = (list: { id: string }[]) => list.map((c) => c.id);

  it('指定なしなら全件（別の配列で返す）', () => {
    const all = selectCases(cases);
    expect(idsOf(all)).toEqual(['ex-001', 'ex-002', 'ex-003', 'ex-004']);
    expect(all).not.toBe(cases);
    expect(idsOf(selectCases(cases, { limit: null, ids: null }))).toHaveLength(4);
  });

  it('limit は先頭から。件数より大きければ全件', () => {
    expect(idsOf(selectCases(cases, { limit: 2 }))).toEqual(['ex-001', 'ex-002']);
    expect(idsOf(selectCases(cases, { limit: 99 }))).toHaveLength(4);
  });

  it('ids は指定した順の部分集合', () => {
    expect(idsOf(selectCases(cases, { ids: ['ex-003', 'ex-001'] }))).toEqual(['ex-003', 'ex-001']);
  });

  it('評価セットに無い id は例外（無い id をすべて挙げる）', () => {
    expect(() => selectCases(cases, { ids: ['ex-001', 'ex-099', 'ex-100'] })).toThrow('ex-099, ex-100');
  });

  it('ids と limit を両方指定したら、ids で絞ったうえで先頭から limit 件', () => {
    expect(idsOf(selectCases(cases, { ids: ['ex-004', 'ex-002', 'ex-001'], limit: 2 }))).toEqual(['ex-004', 'ex-002']);
  });

  it('limit が 1 以上の整数でなければ例外', () => {
    expect(() => selectCases(cases, { limit: 0 })).toThrow('limit');
    expect(() => selectCases(cases, { limit: -1 })).toThrow('limit');
    expect(() => selectCases(cases, { limit: 1.5 })).toThrow('limit');
  });

  it('評価セットが空でも動く', () => {
    expect(selectCases([], { limit: 3 })).toEqual([]);
    expect(() => selectCases([], { ids: ['ex-001'] })).toThrow('ex-001');
  });
});

// ---------- resolveShown ----------

describe('resolveShown', () => {
  const a = makeProperty({ id: 'P-A' });
  const b = makeProperty({ id: 'P-B' });
  const hidden = makeProperty({ id: 'P-H', status: 'private' });

  it('shownIds を表示番号 1 から順につける', () => {
    const shown = resolveShown(['P-B', 'P-A'], [a, b, hidden]);
    expect(shown.map((s) => [s.position, s.property.id])).toEqual([
      [1, 'P-B'],
      [2, 'P-A'],
    ]);
    expect(shown[0].property).toBe(b);
  });

  it('省略・空なら空', () => {
    expect(resolveShown(undefined, [a])).toEqual([]);
    expect(resolveShown([], [a])).toEqual([]);
  });

  it('物件が無い id と、非公開の物件は例外', () => {
    expect(() => resolveShown(['P-X'], [a, b])).toThrow('P-X');
    expect(() => resolveShown(['P-A', 'P-H'], [a, hidden])).toThrow('P-H');
  });
});

// ---------- scoreRun・summarizeRuns ----------

describe('scoreRun・summarizeRuns', () => {
  it('正常なケースは scoreExtractionCase の結果をそのまま付ける', () => {
    const c = makeCase({ expected: { intent: 'showMore' } });
    const run = scoreRun(makeRaw(c, result({ intent: 'showMore' })));
    expect(run.score.exact).toBe(true);
    expect(run.case).toBe(c);
  });

  it('API エラーのケースは、正解が「何もしない offTopic」でも完全一致に数えない', () => {
    const c = makeCase({ expected: { intent: 'offTopic' } });
    const ok = scoreRun(makeRaw(c, fallbackExtraction()));
    expect(ok.score.exact).toBe(true);
    const failed = scoreRun(makeRaw(c, fallbackExtraction(), { latencyMs: null, costUsd: null, error: 'APIConnectionError: timeout' }));
    expect(failed.score.exact).toBe(false);
    expect(failed.score.intentOk).toBe(true); // 個別の指標は fallbackExtraction() で採点したまま
  });

  it('応答時間と費用は、計測できたケース（API エラーでないもの）だけで集計する', () => {
    const c = makeCase({ expected: { intent: 'offTopic' } });
    const runs = [
      scoreRun(makeRaw(c, fallbackExtraction(), { latencyMs: 100, costUsd: 0.001 })),
      scoreRun(makeRaw(c, fallbackExtraction(), { latencyMs: 300, costUsd: 0.003 })),
      scoreRun(makeRaw(c, fallbackExtraction(), { latencyMs: null, costUsd: null, error: 'boom' })),
    ];
    const { summary, measures } = summarizeRuns(runs);
    expect(summary.cases).toBe(3);
    expect(summary.exact).toEqual({ correct: 2, total: 3, rate: 2 / 3 });
    expect(measures.n).toBe(2);
    expect(measures.maxMs).toBe(300);
    expect(measures.totalCostUsd).toBeCloseTo(0.004, 10);
    expect(countErrors(runs)).toBe(1);
  });

  it('0 件でも落ちない', () => {
    const { summary, measures } = summarizeRuns([]);
    expect(summary.cases).toBe(0);
    expect(measures.n).toBe(0);
  });
});

// ---------- 小さな整形 ----------

describe('describeError・formatLogEntry・formatProgress', () => {
  it('describeError は Error なら「名前: 文言」、それ以外は文字列にする', () => {
    expect(describeError(new TypeError('bad'))).toBe('TypeError: bad');
    expect(describeError('oops')).toBe('oops');
    expect(describeError(42)).toBe('42');
  });

  it('formatLogEntry はメッセージと追加の引数を1行にする', () => {
    expect(formatLogEntry('[extract] 失敗', [])).toBe('[extract] 失敗');
    expect(formatLogEntry('[extract] 失敗', [{ attempt: 1, error: 'x' }, 'tail', new Error('e')])).toBe(
      '[extract] 失敗 {"attempt":1,"error":"x"} tail Error: e',
    );
  });

  it('formatLogEntry は JSON にできない値でも落ちない', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatLogEntry('m', [circular, undefined])).toBe('m [object Object] undefined');
  });

  it('formatProgress: ok（完全一致）・ng（不一致）・error（API エラー）', () => {
    const c = makeCase({ id: 'ex-003', expected: { intent: 'showMore' } });
    const ok = scoreRun(makeRaw(c, result({ intent: 'showMore' }), { latencyMs: 1234 }));
    const ng = scoreRun(makeRaw(c, result({ intent: 'offTopic' }), { latencyMs: 87 }));
    const err = scoreRun(makeRaw(c, fallbackExtraction(), { latencyMs: null, costUsd: null, error: 'RateLimitError: 429' }));
    expect(formatProgress(3, 32, ok)).toBe('[3/32] ex-003 ok 1234ms');
    expect(formatProgress(4, 32, ng)).toBe('[4/32] ex-003 ng 87ms');
    expect(formatProgress(5, 32, err)).toBe('[5/32] ex-003 error  RateLimitError: 429');
  });
});

describe('formatRate・formatFraction', () => {
  it('割合は % で小数1桁、正解数/母数。母数 0 は —', () => {
    expect(formatRate(ratio(3, 4))).toBe('75.0%');
    expect(formatRate(ratio(1, 3))).toBe('33.3%');
    expect(formatRate(ratio(2, 3))).toBe('66.7%');
    expect(formatRate(ratio(0, 5))).toBe('0.0%');
    expect(formatRate(ratio(5, 5))).toBe('100.0%');
    expect(formatFraction(ratio(3, 4))).toBe('3/4');
    expect(formatRate(ratio(0, 0))).toBe('—');
    expect(formatFraction(ratio(0, 0))).toBe('—');
  });
});

// ---------- 結果ファイル名・日時 ----------

describe('resultFileName・formatJst', () => {
  it('<set>-<config>-<JST の日付>-<JST の時分>.json', () => {
    expect(resultFileName('extraction', 'two-model', AT)).toBe('extraction-two-model-20261015-2130.json');
    expect(resultFileName('attack', 'one-model', AT)).toBe('attack-one-model-20261015-2130.json');
    expect(resultFileName('scenario', 'haiku-answer', AT)).toBe('scenario-haiku-answer-20261015-2130.json');
  });

  it('辞書なしは -nodict、--fake は -fake を、この順で日時の前に入れる', () => {
    expect(resultFileName('extraction', 'two-model', AT, { dictionary: false })).toBe('extraction-two-model-nodict-20261015-2130.json');
    expect(resultFileName('extraction', 'two-model', AT, { fake: true })).toBe('extraction-two-model-fake-20261015-2130.json');
    expect(resultFileName('extraction', 'haiku-answer', AT, { dictionary: false, fake: true })).toBe(
      'extraction-haiku-answer-nodict-fake-20261015-2130.json',
    );
    expect(resultFileName('attack', 'two-model', AT, { dictionary: true, fake: false })).toBe('attack-two-model-20261015-2130.json');
  });

  it('日時は JST（UTC の日付が違っても JST の日付）', () => {
    // 2026-10-15 20:00 UTC = 2026-10-16 05:00 JST
    expect(resultFileName('extraction', 'two-model', new Date('2026-10-15T20:00:00Z'))).toBe('extraction-two-model-20261016-0500.json');
    expect(formatJst(new Date('2026-10-15T20:00:00Z'))).toBe('2026-10-16 05:00');
    expect(formatJst(AT)).toBe('2026-10-15 21:30');
  });

  it('構成名にファイル名に使えない文字があれば _ にする', () => {
    expect(resultFileName('extraction', 'a/b:c', AT)).toBe('extraction-a_b_c-20261015-2130.json');
  });
});

// ---------- レポート ----------

describe('formatExtractionReport', () => {
  // ex-001: 完全一致 / ex-002: 意図・値・優先度・表示番号・日時・禁止トピックがすべて違う / ex-003: API エラー / ex-004: 完全一致
  const c1 = makeCase({
    id: 'ex-001',
    category: 'basic',
    utterance: '渋谷で8万以内',
    expected: {
      intent: 'conditions',
      ops: [
        { op: 'set', key: 'area', value: { stations: ['渋谷'], wards: [] } },
        { op: 'set', key: 'rentMax', value: 80000 },
      ],
    },
  });
  const c2 = makeCase({
    id: 'ex-002',
    category: 'priority',
    priorityCue: true,
    utterance: '2階以上は絶対で、\n静かな部屋がいい。予算は7万',
    slots: baseSlots({ floorMin: { value: 2, priority: 'want' } }),
    note: '「絶対」は must',
    expected: {
      intent: 'conditions',
      alsoAcceptIntents: ['propertyQuestion'],
      ops: [
        { op: 'setPriority', key: 'floorMin', priority: 'must' },
        { op: 'set', key: 'rentMax', value: 70000 },
        { op: 'addTag', tag: '静か' },
      ],
      targetPositions: [2],
      viewingTimes: ['2026-10-17T14:00'],
      forbiddenTopic: 'noise',
    },
  });
  const c3 = makeCase({ id: 'ex-003', category: 'basic', utterance: 'こんにちは', expected: { intent: 'offTopic' } });
  const c4 = makeCase({
    id: 'ex-004',
    category: 'change',
    utterance: '駅近で',
    expected: { intent: 'conditions', ops: [{ op: 'set', key: 'walkMax', value: 10 }] },
  });

  const raws: RawCaseRun[] = [
    makeRaw(c1, result({ ops: c1.expected.ops }), { latencyMs: 100, costUsd: 0.001 }),
    makeRaw(c2, result({ intent: 'offTopic', ops: [{ op: 'set', key: 'rentMax', value: 60000 }] }), {
      latencyMs: 300,
      costUsd: 0.003,
      logs: ['[extract] 出力の検証に失敗しました {"attempt":1}'],
    }),
    makeRaw(c3, fallbackExtraction(), { latencyMs: null, costUsd: null, error: 'APIConnectionError: Connection error.' }),
    makeRaw(c4, result({ ops: c4.expected.ops }), { latencyMs: 200, costUsd: 0.002 }),
  ];
  const runs = raws.map(scoreRun);
  const { summary, measures } = summarizeRuns(runs);
  const base: ExtractionReportInput = { ...makeMeta(), runs, summary, measures };
  const report = formatExtractionReport(base);
  const lines = report.split('\n');

  it('Markdown の見出しがそろい、末尾は改行1つ', () => {
    expect(lines[0]).toBe('# 条件抽出の評価レポート');
    expect(lines.filter((l) => l.startsWith('## '))).toEqual([
      '## 設定',
      '## 指標',
      '## 応答時間と費用',
      '## エラー',
      '## カテゴリ別の完全一致',
      '## 不一致のケース（2 件）',
    ]);
    expect(report.endsWith('\n')).toBe(true);
    expect(report.endsWith('\n\n')).toBe(false);
  });

  it('設定: モデル・件数・日時（JST）。--fake でない実行には --fake の注記を入れない', () => {
    expect(lines).toContain('- モデル: claude-haiku-4-5');
    expect(lines).toContain('- 件数: 4');
    expect(lines).toContain('- 日時: 2026-10-15 21:30 JST');
    expect(report).not.toContain('--fake');
  });

  it('--fake の実行には、実 API を呼んでいない旨を入れる', () => {
    expect(formatExtractionReport({ ...base, fake: true })).toContain('`--fake`: 実 API は呼んでいません');
  });

  it('指標の表: 割合は小数1桁の %、正解数/母数を併記、母数 0 は —', () => {
    expect(lines).toContain('| 指標 | 割合 | 正解数/母数 |');
    expect(lines).toContain('| 発話単位の完全一致 | 50.0% | 2/4 |'); // ex-003 は API エラーなので完全一致に数えない
    expect(lines).toContain('| 意図 | 75.0% | 3/4 |');
    expect(lines).toContain('| 条件抽出の正確さ（スロット単位） | 60.0% | 3/5 |');
    expect(lines).toContain('| 優先度判定の正確さ | 0.0% | 0/1 |');
    expect(lines).toContain('| 禁止トピックの再現率 | 0.0% | 0/1 |');
    expect(lines).toContain('| 表示番号 | 0.0% | 0/1 |');
    expect(lines).toContain('| 内見の日時 | 0.0% | 0/1 |');
    expect(lines).toContain('禁止トピックの誤検出: 0 件');
  });

  it('母数が 0 の指標は — になる', () => {
    const c = makeCase({ id: 'ex-001', expected: { intent: 'showMore' } });
    const only = [scoreRun(makeRaw(c, result({ intent: 'showMore' })))];
    const s = summarizeRuns(only);
    const text = formatExtractionReport({ ...base, runs: only, ...s });
    expect(text).toContain('| 条件抽出の正確さ（スロット単位） | — | — |');
    expect(text).toContain('| 優先度判定の正確さ | — | — |');
    expect(text).toContain('| 禁止トピックの再現率 | — | — |');
    expect(text).toContain('| 発話単位の完全一致 | 100.0% | 1/1 |');
  });

  it('応答時間（p50/p95/max・ms）と費用（1件平均と合計・USD）', () => {
    expect(lines).toContain('| p50 | p95 | max |');
    expect(lines).toContain('| 200 ms | 300 ms | 300 ms |');
    expect(lines).toContain('- 費用: 1件平均 $0.0020・合計 $0.0060');
    expect(lines).toContain('- 計測できたのは 3 件（API エラーのケースは含みません）');
  });

  it('エラー: API エラーの件数と id、抽出のログが出たケース', () => {
    expect(lines).toContain('- API エラー: 1 件（ex-003）');
    expect(lines).toContain('- 抽出のログ（検証の失敗など）が出たケース: 1 件（ex-002）');
  });

  it('カテゴリ別の完全一致（出てくるカテゴリだけ）', () => {
    expect(lines).toContain('| basic（単純な条件） | 50.0% | 1/2 |');
    expect(lines).toContain('| priority（優先度） | 0.0% | 0/1 |');
    expect(lines).toContain('| change（条件の変更） | 100.0% | 1/1 |');
    expect(report).not.toContain('| viewing');
  });

  it('不一致のケースだけを並べ、完全一致のケースは出さない', () => {
    expect(lines).toContain('### ex-002（priority）');
    expect(lines).toContain('### ex-003（basic）');
    expect(report).not.toContain('### ex-001');
    expect(report).not.toContain('### ex-004');
  });

  it('不一致の中身: 意図・値が違う単位・優先度だけ違う単位・表示番号・日時・禁止トピック', () => {
    expect(lines).toContain('- 発話: 「2階以上は絶対で、 静かな部屋がいい。予算は7万」'); // 改行は空白に
    expect(lines).toContain('- 意図: 期待 conditions（propertyQuestion も可） → 実際 offTopic');
    expect(lines).toContain('- 値が違う単位 rentMax: 期待 70000（must） → 実際 60000（must）');
    expect(lines).toContain('- 値が違う単位 tag:静か: 期待 あり（want） → 実際 なし');
    expect(lines).toContain('- 優先度だけ違う単位 floorMin: 期待 must → 実際 want（値 2）');
    expect(lines).toContain('- 表示番号: 期待 [2] → 実際 []');
    expect(lines).toContain('- 内見の日時: 期待 [2026-10-17T14:00] → 実際 []');
    expect(lines).toContain('- 禁止トピック: 期待 noise → 実際 なし');
    expect(lines).toContain('- 正解の根拠: 「絶対」は must');
  });

  it('API エラーのケースには、エラーの文言を出す', () => {
    expect(lines).toContain('- API エラー: APIConnectionError: Connection error.（fallbackExtraction で採点）');
  });

  it('一致している観点は不一致の中身に出さない', () => {
    const run2 = runs[1];
    const text = describeMismatch(run2).join('\n');
    expect(text).not.toContain('area'); // エリアは変わらない
    const run3 = describeMismatch(runs[2]);
    expect(run3).toEqual(['API エラー: APIConnectionError: Connection error.（fallbackExtraction で採点）']);
  });

  it('エリアと間取りは読める形で出す（並びを問わない比較のため、駅・区・間取りは並べ替えた形）', () => {
    const c = makeCase({
      expected: {
        ops: [
          { op: 'set', key: 'area', value: { stations: ['渋谷', '新宿'], wards: ['目黒区'] }, priority: 'must' },
          { op: 'set', key: 'layouts', value: ['1K', '1DK'] },
        ],
      },
    });
    const run = scoreRun(makeRaw(c, result()));
    const text = describeMismatch(run).join('\n');
    expect(text).toContain('値が違う単位 area: 期待 新宿・渋谷・目黒区（must） → 実際 なし');
    expect(text).toContain('値が違う単位 layouts: 期待 1DK・1K（want） → 実際 なし');
  });

  it('消すべき条件を残した／別の値に変えたときは「期待 なし」', () => {
    const c = makeCase({
      slots: baseSlots({ floorMin: { value: 2, priority: 'want' } }),
      expected: { ops: [{ op: 'unset', key: 'floorMin' }] },
    });
    const text = describeMismatch(scoreRun(makeRaw(c, result()))).join('\n');
    expect(text).toContain('値が違う単位 floorMin: 期待 なし → 実際 2（want）');
  });

  it('すべて一致なら「すべて一致しました」', () => {
    const only = [scoreRun(makeRaw(c1, result({ ops: c1.expected.ops })))];
    const text = formatExtractionReport({ ...base, runs: only, ...summarizeRuns(only) });
    expect(text).toContain('## 不一致のケース（0 件）');
    expect(text).toContain('すべて一致しました。');
    expect(text).not.toContain('### ');
  });

  it('優先度判定の正確さは、単発の手がかりとトレードオフへの答えに分けて出す', () => {
    // ex-002 は category=priority（単発）で値が合った単位の優先度が違う → 単発 0/1。トレードオフのケースは無いので —
    expect(lines).toContain('| 　うち単発の手がかり（トレードオフ以外） | 0.0% | 0/1 |');
    expect(lines).toContain('| 　うちトレードオフへの答え（tradeoff） | — | — |');
    const tradeoff = makeCase({
      id: 'ex-050',
      category: 'tradeoff',
      priorityCue: true,
      slots: baseSlots({ floorMin: { value: 2, priority: 'want' } }),
      expected: { intent: 'conditions', ops: [{ op: 'setPriority', key: 'floorMin', priority: 'must' }] },
    });
    const rs = [scoreRun(makeRaw(tradeoff, result({ ops: [{ op: 'setPriority', key: 'floorMin', priority: 'must' }] })))];
    const text = formatExtractionReport({ ...base, runs: rs, ...summarizeRuns(rs) });
    expect(text).toContain('| 優先度判定の正確さ | 100.0% | 1/1 |');
    expect(text).toContain('| 　うち単発の手がかり（トレードオフ以外） | — | — |');
    expect(text).toContain('| 　うちトレードオフへの答え（tradeoff） | 100.0% | 1/1 |');
  });

  it('設定: 構成・辞書なし・--model の上書き・費用の上限・全件でないときの件数', () => {
    const text = formatExtractionReport({
      ...base,
      ...makeMeta({
        config: 'haiku-answer',
        dictionary: false,
        modelOverride: true,
        models: { extract: MODEL_SMART, answer: null },
        totalCases: 100,
        maxCostUsd: 0.5,
      }),
    });
    expect(text).toContain('- 構成: haiku-answer');
    expect(text).toContain('- モデル: claude-sonnet-5-5');
    expect(text).toContain('- `--model` で抽出のモデルを上書きしています');
    expect(text).toContain('- 辞書: なし（`--no-dictionary`');
    expect(text).toContain('- 件数: 4（全 100 件のうち）');
    expect(text).toContain('- 費用の上限: $0.5（--max-cost');
    // haiku-answer の条件抽出は two-model と同じ呼び出し
    expect(text).toContain('haiku-answer の条件抽出は two-model と同じです');
    expect(report).not.toContain('haiku-answer の条件抽出');
    expect(report).toContain('- 構成: two-model');
    expect(report).not.toContain('辞書: なし');
  });

  it('費用の上限で打ち切った回は、設定に打ち切りの件数と累計の費用を出す', () => {
    const text = formatExtractionReport({
      ...base,
      ...makeMeta({ totalCases: 100, cutoff: { reason: 'maxCost', spentUsd: 0.0123, maxCostUsd: 0.01, completed: 4, planned: 100 } }),
    });
    expect(text).toContain('- **打ち切り**: 費用が上限 $0.01（--max-cost）に達したため、100 件のうち 4 件で止めました（累計 $0.0123）');
    expect(report).not.toContain('打ち切り');
  });

  it('ケースが 0 件でも整形できる（評価セットが空のとき）', () => {
    const text = formatExtractionReport({ ...base, runs: [], ...summarizeRuns([]) });
    expect(text).toContain('- 件数: 0');
    expect(text).toContain('評価するケースがありません');
    expect(text).toContain('| 発話単位の完全一致 | — | — |');
    expect(text).toContain('| — | — | — |'); // p50・p95・max
    expect(text).toContain('- 費用: 1件平均 —・合計 —');
    expect(text).not.toContain('すべて一致しました');
  });
});

// ---------- 結果の JSON ----------

describe('buildResultFile', () => {
  const c = makeCase({ id: 'ex-007', category: 'forbidden', utterance: '治安はどう？', expected: { intent: 'handoff', forbiddenTopic: 'safety' } });
  const ok = scoreRun(makeRaw(c, result({ intent: 'handoff', forbiddenTopic: 'safety' }), { logs: ['x'] }));
  const failed = scoreRun(makeRaw(c, fallbackExtraction(), { latencyMs: null, costUsd: null, error: 'boom' }));
  const runs: CaseRun[] = [ok, failed];

  it('設定・集計・計測・エラー件数・ケースごとの記録を持ち、JSON にできる', () => {
    const file = buildResultFile({
      ...makeMeta({ limit: 2, ids: ['ex-007'], totalCases: 100 }),
      runs,
      ...summarizeRuns(runs),
    }) as Record<string, unknown>;
    const parsed = JSON.parse(JSON.stringify(file)) as {
      config: Record<string, unknown>;
      summary: { cases: number };
      measures: { n: number };
      errors: number;
      cases: Record<string, unknown>[];
    };
    expect(parsed.config).toEqual({
      set: 'extraction',
      config: 'two-model',
      dictionary: true,
      models: { extract: 'claude-haiku-4-5', answer: null },
      model: 'claude-haiku-4-5',
      modelOverride: false,
      prompts: null,
      fake: false,
      limit: 2,
      ids: ['ex-007'],
      caseCount: 2,
      totalCases: 100,
      maxCostUsd: 2,
      cutoff: null,
      usdJpy: 150,
      at: '2026-10-15T12:30:00.000Z',
      atJst: '2026-10-15 21:30',
    });
    expect(parsed.summary.cases).toBe(2);
    expect(parsed.measures.n).toBe(1);
    expect(parsed.errors).toBe(1);
    expect(Object.keys(parsed.cases[0]).sort()).toEqual(
      ['actual', 'category', 'costUsd', 'error', 'expected', 'id', 'latencyMs', 'logs', 'score', 'utterance'].sort(),
    );
    expect(parsed.cases[0]).toMatchObject({ id: 'ex-007', category: 'forbidden', utterance: '治安はどう？', logs: ['x'], error: null });
    expect(parsed.cases[1]).toMatchObject({ error: 'boom', latencyMs: null, costUsd: null });
  });
});
