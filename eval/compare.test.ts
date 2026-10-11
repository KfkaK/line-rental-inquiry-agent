/**
 * 結果ファイルの比較表（eval/compare.ts）のテスト。結果ファイルの読み込み（古い形式を含む）・最新の回の選択・表の整形を、
 * 手で組み立てた結果と、ランナーの --fake が実際に書く結果ファイル（書き手と読み手がつながっているか）で確かめる。
 */
import { describe, expect, it } from 'vitest';
import {
  formatCompareTables,
  modelText,
  parseResultFile,
  resultKey,
  rowLabel,
  selectLatest,
  type AttackRow,
  type CompareResult,
  type ExtractionRow,
  type ParseOutcome,
  type ResultBase,
  type ScenarioRow,
} from './compare';
import { loadDemoProperties } from './data';
import { buildResultFile, parseEvalArgs } from './report';
import { buildAttackResultFile } from './reportAttack';
import { buildScenarioResultFile } from './reportScenario';
import { createBudget, fakeFactories, runAttackSet, runExtractionSet, runScenarioSet, type SetContext } from './runSets';
import { ratio } from './score';

// ---------- 小道具 ----------

const OK = (outcome: ParseOutcome): CompareResult => {
  if (!outcome.ok) throw new Error(`読めませんでした: ${outcome.reason}`);
  return outcome.result;
};

/** 古い形式（2026-10-10）の extraction の結果ファイル: config に config・dictionary・models が無く、summary に優先度の分割が無い */
function legacyFile(): unknown {
  const unit = (valueOk: boolean, priorityOk: boolean) => ({ key: 'rentMax', valueOk, priorityOk, expected: { value: '70000', priority: 'must' } });
  return {
    config: { set: 'extraction', model: 'claude-haiku-4-5', fake: false, limit: null, ids: null, caseCount: 3, at: '2026-10-10T14:50:45.760Z', atJst: '2026-10-10 23:50' },
    summary: {
      cases: 3,
      exact: { correct: 2, total: 3, rate: 2 / 3 },
      intent: { correct: 3, total: 3, rate: 1 },
      slotValue: { correct: 4, total: 5, rate: 0.8 },
      priority: { correct: 2, total: 3, rate: 2 / 3 },
    },
    measures: { n: 3, p50Ms: 1508, p95Ms: 2587, maxMs: 2644, meanCostUsd: 0.00245, totalCostUsd: 0.00735 },
    errors: 0,
    cases: [
      { id: 'ex-001', score: { category: 'priority', priorityCue: true, units: [unit(true, true)] } },
      { id: 'ex-002', score: { category: 'priority', priorityCue: true, units: [unit(true, false)] } },
      { id: 'ex-003', score: { category: 'tradeoff', priorityCue: true, units: [unit(true, true)] } },
    ],
  };
}

const AT = (iso: string) => new Date(iso);

/** 表の整形を確かめるための手組みの結果。共通の項目と、集計の行（rowの一部）を上書きできる */
type Overrides<R> = Partial<ResultBase> & { row?: Partial<R> };

function extraction({ row, ...rest }: Overrides<ExtractionRow> = {}): CompareResult {
  return {
    file: 'extraction.json',
    config: 'two-model',
    dictionary: true,
    modelOverride: false,
    extractModel: 'claude-haiku-4-5',
    answerModel: null,
    prompt: '',
    at: AT('2026-10-15T12:30:00Z'),
    caseCount: 100,
    partial: false,
    ...rest,
    set: 'extraction',
    row: {
      exact: ratio(90, 100),
      slotValue: ratio(95, 100),
      priorityCue: ratio(38, 41),
      priorityTradeoff: ratio(18, 20),
      intent: ratio(99, 100),
      p50Ms: 1500,
      p95Ms: 2600,
      meanCostUsd: 0.0025,
      ...row,
    },
  };
}

function attack({ row, ...rest }: Overrides<AttackRow> = {}): CompareResult {
  return {
    file: 'attack.json',
    config: 'two-model',
    dictionary: true,
    modelOverride: false,
    extractModel: 'claude-haiku-4-5',
    answerModel: 'claude-sonnet-5-5',
    prompt: '',
    at: AT('2026-10-15T12:30:00Z'),
    caseCount: 40,
    partial: false,
    ...rest,
    set: 'attack',
    row: { actual: ratio(40, 40), promptOnly: ratio(36, 40), rescued: 4, ...row },
  };
}

function scenario({ row, ...rest }: Overrides<ScenarioRow> = {}): CompareResult {
  return {
    file: 'scenario.json',
    config: 'two-model',
    dictionary: true,
    modelOverride: false,
    extractModel: 'claude-haiku-4-5',
    answerModel: 'claude-sonnet-5-5',
    prompt: '',
    at: AT('2026-10-15T12:30:00Z'),
    caseCount: 15,
    partial: false,
    ...rest,
    set: 'scenario',
    row: {
      reach: ratio(13, 15),
      reachOutside: ratio(9, 10),
      baseline: ratio(9, 15),
      baselineOutside: ratio(6, 10),
      latencyP50Ms: 1800,
      latencyP95Ms: 3200,
      answerP50Ms: 4300,
      answerP95Ms: 5900,
      meanCostUsd: 0.012,
      ...row,
    },
  };
}

// ---------- 結果ファイルの解析 ----------

describe('parseResultFile: 古い形式', () => {
  const result = OK(parseResultFile(legacyFile(), 'extraction-claude-haiku-4-5-20261010-2350.json'));

  it('config が無い古い形式は two-model・辞書あり・上書きなし・全件 として読む', () => {
    expect(result).toMatchObject({
      file: 'extraction-claude-haiku-4-5-20261010-2350.json',
      set: 'extraction',
      config: 'two-model',
      dictionary: true,
      modelOverride: false,
      extractModel: 'claude-haiku-4-5',
      answerModel: null,
      prompt: '', // 古い形式にはプロンプトの版が無い
      caseCount: 3,
      partial: false,
    });
    expect(result.at.toISOString()).toBe('2026-10-10T14:50:45.760Z');
  });

  it('数字を読む（割合は correct/total から再計算）', () => {
    if (result.set !== 'extraction') throw new Error('extraction のはず');
    expect(result.row).toMatchObject({
      exact: { correct: 2, total: 3 },
      slotValue: { correct: 4, total: 5, rate: 0.8 },
      intent: { correct: 3, total: 3, rate: 1 },
      p50Ms: 1508,
      p95Ms: 2587,
      meanCostUsd: 0.00245,
    });
  });

  it('優先度の単発／トレードオフは、ケースごとの採点から再計算する（古い結果には分けた集計が無い）', () => {
    if (result.set !== 'extraction') throw new Error('extraction のはず');
    expect(result.row.priorityCue).toEqual({ correct: 1, total: 2, rate: 0.5 });
    expect(result.row.priorityTradeoff).toEqual({ correct: 1, total: 1, rate: 1 });
  });
});

describe('parseResultFile: 読めないもの', () => {
  it('--fake の結果は fake: true で除く', () => {
    const file = legacyFile() as { config: Record<string, unknown> };
    file.config.fake = true;
    expect(parseResultFile(file, 'x.json')).toEqual({ ok: false, reason: '--fake の結果', fake: true });
  });

  it('config が無い・評価セットが未知・構成が未知・日時が壊れている・0 件の回は理由つきで除く', () => {
    const reason = (json: unknown): string => {
      const outcome = parseResultFile(json, 'x.json');
      if (outcome.ok) throw new Error('読めてしまった');
      expect(outcome.fake).toBe(false);
      return outcome.reason;
    };
    expect(reason(null)).toContain('config');
    expect(reason({})).toContain('config');
    const withConfig = (patch: Record<string, unknown>) => {
      const file = legacyFile() as { config: Record<string, unknown> };
      Object.assign(file.config, patch);
      return file;
    };
    expect(reason(withConfig({ set: 'answer' }))).toContain('評価セット');
    expect(reason(withConfig({ config: 'three-model' }))).toContain('構成');
    expect(reason(withConfig({ at: 'いつか' }))).toContain('config.at');
    expect(reason(withConfig({ caseCount: 0, totalCases: undefined }))).toContain('0 件');
  });

  it('summary の数字が欠けていたら、どこが読めないかを理由にする', () => {
    const file = legacyFile() as { summary: Record<string, unknown> };
    delete file.summary.exact;
    const outcome = parseResultFile(file, 'x.json');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain('summary.exact');
  });
});

describe('parseResultFile: 全件でない回（partial）', () => {
  const withConfig = (patch: Record<string, unknown>): CompareResult => {
    const file = legacyFile() as { config: Record<string, unknown> };
    Object.assign(file.config, patch);
    return OK(parseResultFile(file, 'x.json'));
  };

  it('--limit・--ids・費用上限での打ち切り・件数が全件に満たない回は partial', () => {
    expect(withConfig({}).partial).toBe(false);
    expect(withConfig({ limit: 5 }).partial).toBe(true);
    expect(withConfig({ ids: ['ex-001'] }).partial).toBe(true);
    expect(withConfig({ cutoff: { reason: 'maxCost', spentUsd: 2, maxCostUsd: 2, completed: 3, planned: 100 } }).partial).toBe(true);
    expect(withConfig({ totalCases: 100 }).partial).toBe(true);
    expect(withConfig({ totalCases: 3 }).partial).toBe(false);
  });
});

describe('結果ファイルの書き手（--fake の実行）と読み手がつながっている', () => {
  const args = parseEvalArgs(['--fake', '--config=haiku-answer', '--no-dictionary', '--limit=3']);
  const ctx: SetContext = {
    args,
    properties: loadDemoProperties(),
    budget: createBudget(args.maxCostUsd),
    progress: () => {},
    factories: fakeFactories(args),
  };
  /** --fake の結果ファイルは fake: true で書かれる。実 API の結果と同じ形で読めるかを見るため、fake を外して読む */
  const asReal = (file: unknown): unknown => {
    const copy = JSON.parse(JSON.stringify(file)) as { config: Record<string, unknown> };
    copy.config.fake = false;
    return copy;
  };

  it('そのままでは fake として除かれる', async () => {
    const run = await runExtractionSet(ctx);
    expect(parseResultFile(JSON.parse(JSON.stringify(buildResultFile(run!))), 'x.json')).toMatchObject({ ok: false, fake: true });
  });

  it('extraction: 構成・辞書なし・件数・全件数・優先度の分割を読める', async () => {
    const run = await runExtractionSet(ctx);
    const result = OK(parseResultFile(asReal(buildResultFile(run!)), 'x.json'));
    expect(result).toMatchObject({
      set: 'extraction',
      config: 'haiku-answer',
      dictionary: false,
      modelOverride: false,
      extractModel: 'claude-haiku-4-5',
      answerModel: null,
      prompt: expect.stringMatching(/^[0-9a-f]{8}$/), // 抽出のプロンプトの版（回答は呼ばないので入らない）
      caseCount: 3,
      partial: true, // --limit=3 は全件ではない
    });
    if (result.set !== 'extraction') throw new Error('extraction のはず');
    expect(result.row.exact).toEqual(run!.summary.exact);
    expect(result.row.priorityCue).toEqual(run!.summary.priorityCue);
    expect(result.row.priorityTradeoff).toEqual(run!.summary.priorityTradeoff);
  });

  it('attack: 検出率（本番とプロンプト指示のみ）と救った件数', async () => {
    const run = await runAttackSet(ctx);
    const result = OK(parseResultFile(asReal(buildAttackResultFile(run!)), 'x.json'));
    expect(result).toMatchObject({ set: 'attack', config: 'haiku-answer', dictionary: false, answerModel: 'claude-haiku-4-5', caseCount: 3, partial: true });
    if (result.set !== 'attack') throw new Error('attack のはず');
    expect(result.row.actual).toEqual(run!.summary.detection.actual);
    expect(result.row.promptOnly).toEqual(run!.summary.detection.promptOnly);
    expect(result.row.rescued).toBe(run!.summary.rescuedByVerification.length);
  });

  it('scenario: 到達率（全体・時間外）・ベースライン・応答時間・費用', async () => {
    const run = await runScenarioSet(ctx);
    const result = OK(parseResultFile(asReal(buildScenarioResultFile(run!)), 'x.json'));
    expect(result).toMatchObject({ set: 'scenario', caseCount: 3, partial: true });
    if (result.set !== 'scenario') throw new Error('scenario のはず');
    expect(result.row.reach).toEqual({ correct: run!.summary.reach.all.correct, total: 3, rate: run!.summary.reach.all.rate });
    expect(result.row.reachOutside).toEqual(run!.summary.reach.outsideHours);
    expect(result.row.baseline).toEqual(run!.summary.baselineReach.all);
    expect(result.row.latencyP50Ms).toBe(run!.summary.latency.p50Ms);
    expect(result.row.answerP95Ms).toBe(run!.summary.answerLatency.p95Ms);
    expect(result.row.meanCostUsd).toBe(run!.summary.cost.meanUsd);
  });

  it('費用の上限で打ち切った回は partial', async () => {
    const small = parseEvalArgs(['--fake', '--max-cost=0.005']);
    const run = await runScenarioSet({ ...ctx, args: small, budget: createBudget(small.maxCostUsd), factories: fakeFactories(small) });
    const result = OK(parseResultFile(asReal(buildScenarioResultFile(run!)), 'x.json'));
    expect(result.caseCount).toBe(2);
    expect(result.partial).toBe(true);
  });
});

// ---------- 最新の回を選ぶ ----------

describe('selectLatest', () => {
  it('(評価セット, 構成, 辞書の有無) ごとに最新の1つ。入力の順は問わない', () => {
    const old = extraction({ file: 'old.json', at: AT('2026-10-10T00:00:00Z') });
    const recent = extraction({ file: 'recent.json', at: AT('2026-10-14T00:00:00Z') });
    const nodict = extraction({ file: 'nodict.json', dictionary: false, at: AT('2026-10-12T00:00:00Z') });
    const haiku = extraction({ file: 'haiku.json', config: 'haiku-answer' });
    const other = attack({ file: 'attack.json' });
    for (const input of [[old, recent, nodict, haiku, other], [recent, nodict, other, haiku, old], [other, old, haiku, nodict, recent]]) {
      expect(
        selectLatest(input)
          .map((r) => r.file)
          .sort(),
      ).toEqual(['attack.json', 'haiku.json', 'nodict.json', 'recent.json']);
    }
  });

  it('同時刻ならファイル名が後のもの', () => {
    const a = extraction({ file: 'extraction-two-model-20261015-2130.json' });
    const b = extraction({ file: 'extraction-two-model-20261015-2130-2.json' });
    expect(selectLatest([a, b]).map((r) => r.file)).toEqual(['extraction-two-model-20261015-2130.json']);
  });

  it('--model で抽出のモデルを上書きした回は、モデルごとに別の行（構成の既定の行を置き換えない）', () => {
    const base = extraction({ file: 'base.json' });
    const sonnet = extraction({ file: 'sonnet.json', modelOverride: true, extractModel: 'claude-sonnet-5-5', at: AT('2026-10-16T00:00:00Z') });
    expect(selectLatest([base, sonnet]).map((r) => r.file).sort()).toEqual(['base.json', 'sonnet.json']);
    expect(resultKey(base)).not.toBe(resultKey(sonnet));
  });

  it('プロンプトの版が違う回は別の行（プロンプトを直す前後を「改善前後」として並べる）', () => {
    const before = extraction({ file: 'before.json', prompt: '705832aa' });
    const after = extraction({ file: 'after.json', prompt: '1b2c3d4e', at: AT('2026-10-16T00:00:00Z') });
    expect(selectLatest([before, after]).map((r) => r.file).sort()).toEqual(['after.json', 'before.json']);
    expect(modelText(after)).toBe('claude-haiku-4-5（プロンプト 1b2c3d4e）');
  });

  it('結果ファイルの config.prompts を抽出（＋回答）の版として読む。無ければ空', () => {
    const json = legacyFile() as { config: Record<string, unknown> };
    const withPrompts = { ...json, config: { ...json.config, prompts: { extract: 'aaaa1111', answer: null } } };
    expect(parseResultFile(withPrompts, 'x.json')).toMatchObject({ ok: true, result: { prompt: 'aaaa1111' } });
    expect(parseResultFile(json, 'y.json')).toMatchObject({ ok: true, result: { prompt: '' } });
  });
});

// ---------- 表の整形 ----------

describe('rowLabel・modelText', () => {
  it('構成名・辞書なし・--model の上書き・（一部）', () => {
    expect(rowLabel(extraction())).toBe('two-model');
    expect(rowLabel(extraction(), { showDictionary: true })).toBe('two-model・辞書あり');
    expect(rowLabel(extraction({ dictionary: false }), { showDictionary: true })).toBe('two-model・辞書なし');
    expect(rowLabel(extraction({ partial: true }), { showDictionary: true })).toBe('two-model・辞書あり（一部）');
    expect(rowLabel(extraction({ modelOverride: true, extractModel: 'claude-sonnet-5-5' }))).toBe('two-model（--model=claude-sonnet-5-5）');
    // one-model は辞書の有無を切り替えられないので「辞書あり」とは書かない
    expect(rowLabel(extraction({ config: 'one-model' }), { showDictionary: true })).toBe('one-model');
  });

  it('モデルは、抽出と回答が別なら「抽出 / 回答生成」、1つだけなら1つ', () => {
    expect(modelText(extraction())).toBe('claude-haiku-4-5');
    expect(modelText(attack())).toBe('claude-haiku-4-5 / claude-sonnet-5-5');
    expect(modelText(attack({ config: 'one-model', extractModel: 'claude-sonnet-5-5' }))).toBe('claude-sonnet-5-5');
    expect(modelText(attack({ config: 'haiku-answer', answerModel: 'claude-haiku-4-5' }))).toBe('claude-haiku-4-5');
  });
});

describe('formatCompareTables', () => {
  it('結果が1つも無ければ3つの見出しの下に「結果ファイルがまだありません」', () => {
    const text = formatCompareTables([]);
    const lines = text.split('\n');
    expect(lines.filter((l) => l.startsWith('### '))).toEqual(['### 条件抽出の改善前後', '### 禁止回答の検出率', '### シナリオ（到達率・応答時間・1会話の費用）']);
    expect(text.split('結果ファイルがまだありません')).toHaveLength(4);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('条件抽出: 辞書なし → 辞書あり を同じ構成で並べ、実行日・モデル・優先度の分割・p50/p95・1件の費用を出す', () => {
    const results = [
      extraction({ file: 'a.json', dictionary: false, at: AT('2026-10-11T00:00:00Z'), row: { exact: ratio(80, 100), slotValue: ratio(88, 100) } }),
      extraction({ file: 'b.json', at: AT('2026-10-12T00:00:00Z') }),
      extraction({ file: 'c.json', config: 'one-model', extractModel: 'claude-sonnet-5-5', at: AT('2026-10-13T00:00:00Z'), row: { exact: ratio(95, 100), p50Ms: 2400, p95Ms: 4100, meanCostUsd: 0.012 } }),
    ];
    const lines = formatCompareTables(results).split('\n');
    expect(lines).toContain(
      '| 構成 | 件数 | 完全一致 | スロット単位 | 優先度（単発の手がかり） | 優先度（トレードオフ） | 意図 | p50 / p95 | 1件の費用 | 実行日 | モデル |',
    );
    const rows = lines.filter((l) => l.startsWith('| two-model') || l.startsWith('| one-model'));
    expect(rows).toEqual([
      '| two-model・辞書なし | 100 | 80.0% | 88.0% | 92.7% | 90.0% | 99.0% | 1500 / 2600 ms | $0.0025 | 2026-10-11 | claude-haiku-4-5 |',
      '| two-model・辞書あり | 100 | 90.0% | 95.0% | 92.7% | 90.0% | 99.0% | 1500 / 2600 ms | $0.0025 | 2026-10-12 | claude-haiku-4-5 |',
      '| one-model | 100 | 95.0% | 95.0% | 92.7% | 90.0% | 99.0% | 2400 / 4100 ms | $0.0120 | 2026-10-13 | claude-sonnet-5-5 |',
    ]);
  });

  it('実行日は JST（UTC で前日の夜でも JST の日付）', () => {
    const text = formatCompareTables([extraction({ at: AT('2026-10-15T20:00:00Z') })]);
    expect(text).toContain('| 2026-10-16 | claude-haiku-4-5 |');
  });

  it('禁止回答の検出率: 構成ごとに 後段検証あり／プロンプト指示のみ／救った件数', () => {
    const lines = formatCompareTables([
      attack(),
      attack({ file: 'one.json', config: 'one-model', extractModel: 'claude-sonnet-5-5', answerModel: 'claude-sonnet-5-5', row: { actual: ratio(39, 40), promptOnly: ratio(33, 40), rescued: 6 } }),
    ]).split('\n');
    expect(lines).toContain('| 構成 | 件数 | 後段検証あり（本番） | プロンプト指示のみ | 根拠検証が救った件数 | 実行日 | モデル（抽出 / 回答生成） |');
    expect(lines).toContain('| two-model | 40 | 100.0%（40/40） | 90.0%（36/40） | 4 | 2026-10-15 | claude-haiku-4-5 / claude-sonnet-5-5 |');
    expect(lines).toContain('| one-model | 40 | 97.5%（39/40） | 82.5%（33/40） | 6 | 2026-10-15 | claude-sonnet-5-5 |');
  });

  it('シナリオ: 到達率（全体・時間外）・ベースライン・自由文／回答生成の手番の p50/p95・1会話の費用（円）', () => {
    const lines = formatCompareTables([scenario()]).split('\n');
    expect(lines).toContain(
      '| 構成 | 本数 | 到達率（全体） | 到達率（時間外） | ベースライン（全体） | ベースライン（時間外） | 自由文の手番 p50 / p95 | 回答生成の手番 p50 / p95 | 1会話の費用 | 実行日 | モデル（抽出 / 回答生成） |',
    );
    // 1会話の平均 $0.012 × 150 円 = 1.8 円
    expect(lines).toContain(
      '| two-model | 15 | 86.7%（13/15） | 90.0%（9/10） | 60.0%（9/15） | 60.0%（6/10） | 1800 / 3200 ms | 4300 / 5900 ms | 1.8 円 | 2026-10-15 | claude-haiku-4-5 / claude-sonnet-5-5 |',
    );
    expect(formatCompareTables([scenario()])).toContain('1 USD = 150 円の固定値');
  });

  it('全件でない回は構成に（一部）を付け、凡例を出す。全件の回だけなら凡例は出さない', () => {
    const partial = formatCompareTables([extraction({ partial: true }), attack({ partial: true }), scenario({ partial: true })]);
    expect(partial).toContain('| two-model・辞書あり（一部） |');
    expect(partial).toContain('| two-model（一部） |');
    expect(partial.split('（一部）= 全件を回していない回')).toHaveLength(4);
    const full = formatCompareTables([extraction(), attack(), scenario()]);
    expect(full).not.toContain('（一部）');
  });

  it('haiku-answer の条件抽出は two-model の再測定である旨を、その行があるときだけ注記する', () => {
    expect(formatCompareTables([extraction({ config: 'haiku-answer' })])).toContain('haiku-answer の条件抽出は two-model と同じ呼び出しです');
    expect(formatCompareTables([extraction()])).not.toContain('haiku-answer の条件抽出');
  });

  it('p50/p95 や費用が無い結果（全件が API エラーなど）は —', () => {
    const text = formatCompareTables([extraction({ row: { p50Ms: null, p95Ms: null, meanCostUsd: null } })]);
    expect(text).toContain('| — | — | 2026-10-15 | claude-haiku-4-5 |'); // p50 / p95 と 1件の費用
  });

  it('全件の中から最新だけを表にする（古い回は出ない）', () => {
    const text = formatCompareTables([
      extraction({ file: 'old.json', at: AT('2026-10-10T00:00:00Z'), row: { exact: ratio(10, 100) } }),
      extraction({ file: 'new.json', at: AT('2026-10-14T00:00:00Z'), row: { exact: ratio(90, 100) } }),
    ]);
    expect(text).toContain('| 90.0% |');
    expect(text).not.toContain('10.0%');
  });
});
