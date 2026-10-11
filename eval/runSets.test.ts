/**
 * 評価セットを回す本体（eval/runSets.ts）のテスト。実 API は使わず、--fake 用の偽物（ランナーが --fake で使うものと同じ）か、
 * 手で書いた factories で回す。費用の上限での打ち切り・構成の差し替え・API エラーの扱いを確かめる。
 */
import { describe, expect, it } from 'vitest';
import { MODEL_FAST, MODEL_SMART } from '@/lib/llm/models';
import { loadDemoProperties } from './data';
import { ATTACK_CASES } from './datasets/attack';
import { EXTRACTION_CASES } from './datasets/extraction';
import { SCENARIO_CASES } from './datasets/scenarios';
import type { HarnessTurn } from './harness';
import { parseEvalArgs, type EvalArgs } from './report';
import {
  budgetReached,
  createBudget,
  fakeAttackPipeline,
  fakeFactories,
  runAttackSet,
  runExtractionSet,
  runScenarioSet,
  turnCostUsd,
  type PipelineFactories,
  type SetContext,
} from './runSets';
import type { AttackCase, ExtractionCase } from './types';

const properties = loadDemoProperties();

function makeCtx(argv: string[], overrides: Partial<SetContext> = {}): SetContext & { lines: string[] } {
  const lines: string[] = [];
  const args: EvalArgs = parseEvalArgs(['--fake', ...argv]);
  const ctx: SetContext & { lines: string[] } = {
    args,
    properties,
    budget: createBudget(args.maxCostUsd),
    progress: (line) => lines.push(line),
    factories: fakeFactories(args),
    lines,
    ...overrides,
  };
  return ctx;
}

// ---------- 費用の上限 ----------

describe('費用の上限', () => {
  it('累計が上限に達したら budgetReached（ちょうどでも達したとみなす）', () => {
    const budget = createBudget(0.01);
    expect(budgetReached(budget)).toBe(false);
    budget.spentUsd = 0.009;
    expect(budgetReached(budget)).toBe(false);
    budget.spentUsd = 0.01;
    expect(budgetReached(budget)).toBe(true);
  });

  it('turnCostUsd: 保存された AI の発言の費用があればそれ、無ければ抽出と回答の費用の合計', () => {
    const turn = (partial: Partial<HarnessTurn>) => ({ costUsd: null, extraction: null, answers: [], ...partial }) as HarnessTurn;
    expect(turnCostUsd(turn({ costUsd: 0.03 }))).toBe(0.03);
    expect(turnCostUsd(turn({}))).toBe(0);
    const extraction = { result: {}, latencyMs: 1, costUsd: 0.01, model: 'm' } as HarnessTurn['extraction'];
    const answers = [{ costUsd: 0.02 }, { costUsd: 0.005 }] as HarnessTurn['answers'];
    expect(turnCostUsd(turn({ extraction, answers }))).toBeCloseTo(0.035, 10);
  });
});

// ---------- 条件抽出 ----------

describe('runExtractionSet', () => {
  it('--fake: 全件を順に回し、採点・集計・設定（構成・モデル・全件数）を返す', async () => {
    const ctx = makeCtx(['--limit=5']);
    const result = await runExtractionSet(ctx);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.runs.map((r) => r.case.id)).toEqual(EXTRACTION_CASES.slice(0, 5).map((c) => c.id));
    expect(result.summary.cases).toBe(5);
    expect(result).toMatchObject({
      set: 'extraction',
      config: 'two-model',
      dictionary: true,
      models: { extract: MODEL_FAST, answer: null },
      modelOverride: false,
      fake: true,
      limit: 5,
      ids: null,
      totalCases: EXTRACTION_CASES.length,
      maxCostUsd: 2,
      cutoff: null,
    });
    expect(ctx.lines).toHaveLength(5);
    expect(ctx.lines[0]).toMatch(/^\[1\/5\] ex-001 (ok|ng) \d+ms$/);
    expect(ctx.budget.spentUsd).toBeGreaterThan(0);
  });

  it('構成と引数が設定に出る: one-model は抽出と回答を兼ねる Sonnet、haiku-answer の抽出は Haiku、--model は上書き', async () => {
    const one = await runExtractionSet(makeCtx(['--config=one-model', '--limit=2']));
    expect(one).toMatchObject({ config: 'one-model', models: { extract: MODEL_SMART, answer: null } });
    expect(one?.runs).toHaveLength(2);
    expect(one?.runs.every((r) => r.error === null)).toBe(true); // 1モデル構成の偽の応答（answer: null つき）も検証を通る

    const haiku = await runExtractionSet(makeCtx(['--config=haiku-answer', '--no-dictionary', '--limit=2']));
    expect(haiku).toMatchObject({ config: 'haiku-answer', dictionary: false, models: { extract: MODEL_FAST, answer: null } });

    const override = await runExtractionSet(makeCtx(['--model=claude-sonnet-5-5', '--limit=1']));
    expect(override).toMatchObject({ modelOverride: true, models: { extract: 'claude-sonnet-5-5', answer: null } });
  });

  it('--ids はその順、--limit は先頭から。全件数は絞る前の件数', async () => {
    const result = await runExtractionSet(makeCtx(['--ids=ex-003,ex-001']));
    expect(result?.runs.map((r) => r.case.id)).toEqual(['ex-003', 'ex-001']);
    expect(result?.totalCases).toBe(EXTRACTION_CASES.length);
  });

  it('費用の上限に達したら、次のケースを始めずに打ち切る（打ち切りを記録）', async () => {
    // 偽の応答 1 件あたり約 $0.00035。$0.0005 なら 2 件目の後で上限に達する
    const ctx = makeCtx(['--max-cost=0.0005']);
    const result = await runExtractionSet(ctx);
    expect(result?.runs).toHaveLength(2);
    expect(result?.cutoff).toMatchObject({ reason: 'maxCost', maxCostUsd: 0.0005, completed: 2, planned: EXTRACTION_CASES.length });
    expect(result?.cutoff?.spentUsd).toBeGreaterThanOrEqual(0.0005);
    expect(ctx.lines.at(-1)).toContain('打ち切り: 費用が上限 $0.0005');
    expect(ctx.lines).toHaveLength(3); // 2 件の進捗 ＋ 打ち切りの1行
  });

  it('上限にすでに達していて1ケースも回していなければ null（評価セットごと見送る）', async () => {
    const ctx = makeCtx([]);
    ctx.budget.spentUsd = ctx.budget.maxUsd;
    expect(await runExtractionSet(ctx)).toBeNull();
  });

  it('API エラーのケースは fallbackExtraction() として採点して続ける（完全一致には数えない）', async () => {
    const cases: ExtractionCase[] = [
      { id: 'ex-901', category: 'other', priorityCue: false, utterance: 'こんにちは', expected: { intent: 'offTopic', ops: [] } },
      { id: 'ex-902', category: 'other', priorityCue: false, utterance: 'もっと見る', expected: { intent: 'showMore', ops: [] } },
    ];
    let calls = 0;
    const factories: PipelineFactories = {
      ...fakeFactories(parseEvalArgs(['--fake'])),
      extractor: () => async () => {
        calls += 1;
        if (calls === 1) throw new Error('APIConnectionError: timeout');
        return { result: { intent: 'showMore', ops: [], targetPositions: [], viewingTimes: [], forbiddenTopic: null }, latencyMs: 100, costUsd: 0.001, model: 'm' };
      },
    };
    const ctx = makeCtx([], { factories });
    const result = await runExtractionSet(ctx, cases);
    expect(result?.runs[0].error).toContain('APIConnectionError');
    expect(result?.runs[0].score.exact).toBe(false);
    expect(result?.runs[1].score.exact).toBe(true);
    expect(result?.measures.n).toBe(1);
    expect(ctx.lines[0]).toContain('error');
    expect(result?.totalCases).toBe(2);
    expect(ctx.budget.spentUsd).toBeCloseTo(0.001, 10); // エラーのケースは費用が分からないので 0 として数える
  });

  it('ケースごとに抽出を作り直し、logger のログはケースごとに集める', async () => {
    const cases: ExtractionCase[] = [
      { id: 'ex-901', category: 'other', priorityCue: false, utterance: 'a', expected: { intent: 'offTopic', ops: [] } },
      { id: 'ex-902', category: 'other', priorityCue: false, utterance: 'b', expected: { intent: 'offTopic', ops: [] } },
    ];
    let created = 0;
    const factories: PipelineFactories = {
      ...fakeFactories(parseEvalArgs(['--fake'])),
      extractor: (logger) => {
        const n = ++created;
        return async () => {
          logger.error(`[extract] ${n} 回目`);
          return { result: { intent: 'offTopic', ops: [], targetPositions: [], viewingTimes: [], forbiddenTopic: null }, latencyMs: 1, costUsd: 0, model: 'm' };
        };
      },
    };
    const result = await runExtractionSet(makeCtx([], { factories }), cases);
    expect(created).toBe(2);
    expect(result?.runs.map((r) => r.logs)).toEqual([['[extract] 1 回目'], ['[extract] 2 回目']]);
  });
});

// ---------- 攻撃的質問 ----------

describe('runAttackSet', () => {
  it('--fake: 1ケース1会話で回し、本番とプロンプト指示のみの2通りで採点する', async () => {
    const ctx = makeCtx(['--limit=4']);
    const result = await runAttackSet(ctx);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.runs.map((r) => r.case.id)).toEqual(ATTACK_CASES.slice(0, 4).map((c) => c.id));
    expect(result).toMatchObject({
      set: 'attack',
      config: 'two-model',
      models: { extract: MODEL_FAST, answer: MODEL_SMART },
      fake: true,
      totalCases: ATTACK_CASES.length,
      cutoff: null,
    });
    // 偽の Pipeline は常に引き継ぐので、引き継ぎを期待したケースは引き継ぎが起きる
    for (const run of result.runs) {
      expect(run.turn.error).toBeNull();
      expect(run.turn.handoffAdded.length).toBeGreaterThan(0);
      expect(run.score.actual.handoff).toBe(true);
    }
    expect(result.summary.cases).toBe(4);
    expect(result.measures.n).toBe(4);
    expect(ctx.lines[0]).toMatch(/^\[1\/4\] at-001 (ok|ng) \d+ms$/);
  });

  it('構成の名前が Pipeline に入る（偽物は <構成>-fake）', () => {
    expect(fakeAttackPipeline('one-model').name).toBe('one-model-fake');
  });

  it('全 40 件を回せる（毎回 Pipeline を作り直しても、会話は共有されない）', async () => {
    const result = await runAttackSet(makeCtx([]));
    expect(result?.runs).toHaveLength(40);
    expect(result?.runs.every((r) => r.turn.error === null)).toBe(true);
  });

  it('費用の上限に達したら打ち切る。1件の偽の費用は $0.001', async () => {
    const ctx = makeCtx(['--max-cost=0.0025']);
    const result = await runAttackSet(ctx);
    expect(result?.runs).toHaveLength(3);
    expect(result?.cutoff).toMatchObject({ completed: 3, planned: 40, maxCostUsd: 0.0025 });
  });

  it('種まきの shownIds が公開物件に無ければ、会話を始める前に例外（Pipeline を作らない）', async () => {
    const bad: AttackCase = { id: 'at-901', category: 'injection', utterance: 'x', shownIds: ['P-NONE'], expected: { handoff: false } };
    let created = 0;
    const factories: PipelineFactories = {
      ...fakeFactories(parseEvalArgs(['--fake'])),
      attack: () => {
        created += 1;
        return fakeAttackPipeline('two-model');
      },
    };
    await expect(runAttackSet(makeCtx([], { factories }), [ATTACK_CASES[0], bad])).rejects.toThrow('P-NONE');
    expect(created).toBe(0);
  });

  it('上限にすでに達していて1ケースも回していなければ null', async () => {
    const ctx = makeCtx([]);
    ctx.budget.spentUsd = 5;
    expect(await runAttackSet(ctx)).toBeNull();
  });
});

// ---------- シナリオ ----------

describe('runScenarioSet', () => {
  it('--fake: 台本の正解（oraclePipeline）で全 15 本が合格し、到達が期待どおり', async () => {
    const ctx = makeCtx([]);
    const result = await runScenarioSet(ctx);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.runs).toHaveLength(SCENARIO_CASES.length);
    expect(result.summary.passed).toMatchObject({ correct: 15, total: 15 });
    expect(result.summary.reachMatch).toMatchObject({ correct: 15, total: 15 });
    expect(result).toMatchObject({ set: 'scenario', fake: true, totalCases: 15, cutoff: null, models: { extract: MODEL_FAST, answer: MODEL_SMART } });
    expect(ctx.lines).toHaveLength(15);
    expect(ctx.lines[0]).toBe('[1/15] sc-01 ok 8/8手番 $0.0030');
  });

  it('費用の上限（--max-cost=0.005）に達したら、次のシナリオを始めずに打ち切る', async () => {
    // 偽の費用: sc-01 が $0.0030、sc-02 が $0.0060。sc-01 の後は 0.003 < 0.005 で続き、sc-02 の後は 0.009 ≥ 0.005 で止まる
    const ctx = makeCtx(['--max-cost=0.005']);
    const result = await runScenarioSet(ctx);
    expect(result?.runs.map((r) => r.score.id)).toEqual(['sc-01', 'sc-02']);
    expect(result?.cutoff).toMatchObject({ reason: 'maxCost', maxCostUsd: 0.005, completed: 2, planned: 15 });
    expect(result?.cutoff?.spentUsd).toBeCloseTo(0.009, 10);
    expect(ctx.lines.at(-1)).toContain('15 本のうち 2 本で止めました');
  });

  it('--ids と --limit で絞れる', async () => {
    const result = await runScenarioSet(makeCtx(['--ids=sc-05,sc-02']));
    expect(result?.runs.map((r) => r.score.id)).toEqual(['sc-05', 'sc-02']);
    const limited = await runScenarioSet(makeCtx(['--limit=3']));
    expect(limited?.runs).toHaveLength(3);
  });

  it('上限を3つの評価セットで通算する（先のセットで使い切ると、後のセットは null）', async () => {
    const ctx = makeCtx(['--max-cost=0.01']);
    const extraction = await runExtractionSet(ctx);
    expect(extraction?.cutoff).not.toBeNull();
    expect(await runAttackSet(ctx)).toBeNull();
    expect(await runScenarioSet(ctx)).toBeNull();
  });
});
