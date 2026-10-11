/**
 * 3つの評価セット（条件抽出・攻撃的質問・シナリオ）を回して、採点まで済ませた結果（レポートの入力）を返す。
 * ランナー（scripts/eval.ts）の本体。I/O（環境変数・ファイル・標準出力）は持たず、進捗は `progress` で渡し、
 * 構成の組み立ては `PipelineFactories` に分けてあるので、単体テストは偽物の factories と小さなケースで回せる。
 *
 * - ケース（シナリオ）ごとに Pipeline を作り直す（one-model は回答を内部に預けるため。会話の状態も共有しない）
 * - 費用の上限（--max-cost）: 1ケースを始める前に累計を見て、上限に達していたらそこで打ち切る。
 *   1ケース（シナリオは1本）の途中では止めないので、上限を最後の1ケース分だけ超えることがある
 */
import type { Property } from '@/domain/types';
import { createAnthropicClient, createFakeLlmClient, type LlmClient, type Logger } from '@/lib/llm/client';
import { fallbackExtraction } from '@/lib/llm/extract';
import { ATTACK_CASES, ATTACK_DEFAULT_SHOWN } from './datasets/attack';
import { EXTRACTION_CASES } from './datasets/extraction';
import { SCENARIO_CASES } from './datasets/scenarios';
import { runAttackCase } from './attack';
import type { HarnessTurn, Pipeline } from './harness';
import { CONFIG_MODELS, createPipeline, type PipelineOptions } from './pipelines';
import {
  describeError,
  formatLogEntry,
  formatProgress,
  resolveShown,
  scoreRun,
  selectCases,
  summarizeRuns,
  type CaseRun,
  type EvalArgs,
  type ExtractionReportInput,
  type RawCaseRun,
} from './report';
import {
  formatAttackProgress,
  scoreAttackRun,
  summarizeAttackRuns,
  type AttackReportInput,
  type AttackRun,
} from './reportAttack';
import { describeCutoff, type Cutoff, type EvalSet, type RunMeta } from './reportCommon';
import {
  formatScenarioProgress,
  scoreScenarioRun,
  summarizeScenarioRuns,
  type ScenarioCaseRun,
  type ScenarioReportInput,
} from './reportScenario';
import { ORACLE_ANSWER_COST_USD, ORACLE_EXTRACT_COST_USD, ORACLE_LATENCY_MS, oraclePipeline, runScenario } from './scenario';
import { privateOnlyNames } from './scoreAttack';
import { EVAL_NOW, type AttackCase, type EvalConfig, type ExtractionCase, type ScenarioCase } from './types';

// ---------- 費用の上限 ----------

/** 累計の費用（USD）。--set=all では3つの評価セットで1つを共有する */
export interface CostBudget {
  readonly maxUsd: number;
  spentUsd: number;
}

export const createBudget = (maxUsd: number): CostBudget => ({ maxUsd, spentUsd: 0 });
export const budgetReached = (budget: CostBudget): boolean => budget.spentUsd >= budget.maxUsd;

function makeCutoff(budget: CostBudget, completed: number, planned: number): Cutoff {
  return { reason: 'maxCost', spentUsd: budget.spentUsd, maxCostUsd: budget.maxUsd, completed, planned };
}

/**
 * 手番の費用（USD）。会話エンジンが保存した AI の発言の費用（抽出と回答の合計）があればそれ、
 * 無ければ（返信まで届かなかった手番）抽出と回答の出力に残った費用の合計。上限の判定にだけ使う
 */
export function turnCostUsd(turn: HarnessTurn): number {
  return turn.costUsd ?? (turn.extraction?.costUsd ?? 0) + turn.answers.reduce((sum, a) => sum + a.costUsd, 0);
}

// ---------- 構成の組み立て ----------

/** 評価セットごとの Pipeline（条件抽出）の作り方。ログは `logger` に集める */
export interface PipelineFactories {
  /** 条件抽出のセット: 1ケース分の抽出 */
  extractor(logger: Logger): Pipeline['extract'];
  /** 攻撃的質問: 1ケース分の Pipeline */
  attack(logger: Logger): Pipeline;
  /** シナリオ: 1シナリオ分の Pipeline */
  scenario(s: ScenarioCase, logger: Logger): Pipeline;
}

/** 本番と同じ経路の実 API。抽出のクライアントは全ケースで1つを使い回す（キーは最初の呼び出しで読む） */
export function realFactories(args: EvalArgs): PipelineFactories {
  let client: LlmClient | undefined;
  const options = (logger: Logger): PipelineOptions => ({
    client: (client ??= createAnthropicClient()),
    logger,
    useDictionary: args.dictionary,
    extractModel: args.model ?? undefined,
  });
  return {
    extractor: (logger) => createPipeline(args.config, options(logger)).extract,
    attack: (logger) => createPipeline(args.config, options(logger)),
    scenario: (_s, logger) => createPipeline(args.config, options(logger)),
  };
}

/** --fake が毎回返す抽出のツール入力（検証を通る最小の妥当な出力）。one-model は回答の項目 `answer`（null）も要る */
function fakeToolInput(config: EvalConfig): unknown {
  const base = { intent: 'offTopic', ops: [], targetPositions: [], viewingTimes: [], forbiddenTopic: null };
  return config === 'one-model' ? { ...base, answer: null } : base;
}

/** 1件あたりの最大呼び出し回数（抽出は検証失敗で1回だけ再試行する）。偽物の応答が尽きないよう、この分だけ用意する */
const FAKE_CALLS_PER_CASE = 2;

function fakeExtractionClient(config: EvalConfig): LlmClient {
  const respond = () => ({ input: fakeToolInput(config) });
  return createFakeLlmClient(Array.from({ length: FAKE_CALLS_PER_CASE }, () => respond));
}

/**
 * 攻撃的質問の偽の Pipeline: 抽出は常に `handoff`（会話エンジンが引き継ぎメモを残して定型の引き継ぎ文を返す）、
 * 回答生成は呼ばれたら引き継ぎ。実 API の代わりに、ランナーの流れだけを確かめる
 */
export function fakeAttackPipeline(config: EvalConfig): Pipeline {
  return {
    name: `${config}-fake`,
    extract: async () => ({
      result: { intent: 'handoff', ops: [], targetPositions: [], viewingTimes: [], forbiddenTopic: null },
      latencyMs: ORACLE_LATENCY_MS,
      costUsd: ORACLE_EXTRACT_COST_USD,
      model: 'fake',
    }),
    answer: async () => ({
      text: null,
      handoff: { topic: null },
      verification: 'ok',
      latencyMs: ORACLE_LATENCY_MS,
      costUsd: ORACLE_ANSWER_COST_USD,
    }),
  };
}

/** --fake: 条件抽出は偽のクライアント、攻撃的質問は偽の Pipeline、シナリオは台本の正解で動く oraclePipeline */
export function fakeFactories(args: EvalArgs): PipelineFactories {
  return {
    extractor: (logger) =>
      createPipeline(args.config, { client: fakeExtractionClient(args.config), logger, useDictionary: args.dictionary }).extract,
    attack: () => fakeAttackPipeline(args.config),
    scenario: (s) => oraclePipeline(s),
  };
}

// ---------- 実行 ----------

export interface SetContext {
  args: EvalArgs;
  /** 物件の全件（非公開を含む） */
  properties: readonly Property[];
  budget: CostBudget;
  /** 進捗の1行（標準エラーへ） */
  progress: (line: string) => void;
  factories: PipelineFactories;
}

/** logger.error を logs に集める（console に流すと進捗が崩れる） */
function collectingLogger(logs: string[]): Logger {
  return {
    error: (message, ...rest) => {
      logs.push(formatLogEntry(message, rest));
    },
  };
}

function metaFor(ctx: SetContext, set: EvalSet, at: Date, totalCases: number, cutoff: Cutoff | null): RunMeta {
  const { args } = ctx;
  const configModels = CONFIG_MODELS[args.config];
  return {
    set,
    config: args.config,
    dictionary: args.dictionary,
    // 条件抽出は回答生成を呼ばない
    models: { extract: args.model ?? configModels.extract, answer: set === 'extraction' ? null : configModels.answer },
    modelOverride: args.model !== null,
    fake: args.fake,
    limit: args.limit,
    ids: args.ids,
    totalCases,
    maxCostUsd: ctx.budget.maxUsd,
    cutoff,
    at,
  };
}

/** 次のケースを始める前に呼ぶ。上限に達していたら打ち切りを返す（1ケースも回していなければ、呼び出し側が評価セットごと見送る） */
function stopIfBudgetReached(ctx: SetContext, completed: number, planned: number, unit = '件'): Cutoff | null {
  if (!budgetReached(ctx.budget)) return null;
  const cutoff = makeCutoff(ctx.budget, completed, planned);
  ctx.progress(`打ち切り: ${describeCutoff(cutoff, unit)}`);
  return cutoff;
}

/**
 * 条件抽出（単発発話）。API エラーのケースは fallbackExtraction() として採点して続ける。
 * 上限に達していて 1 ケースも回さなかったときは null（評価セットごと見送る）
 */
export async function runExtractionSet(
  ctx: SetContext,
  cases: readonly ExtractionCase[] = EXTRACTION_CASES,
): Promise<ExtractionReportInput | null> {
  const selected = selectCases(cases, { limit: ctx.args.limit, ids: ctx.args.ids });
  // 入力は先にすべて組み立てる（shownIds の誤りは、API を呼ぶ前に例外で止める）
  const inputs = selected.map((c) => ({
    utterance: c.utterance,
    slots: c.slots ?? { tags: [] },
    shown: resolveShown(c.shownIds, ctx.properties),
    now: new Date(c.now ?? EVAL_NOW),
  }));
  const at = new Date();
  const runs: CaseRun[] = [];
  let cutoff: Cutoff | null = null;
  for (const [i, c] of selected.entries()) {
    cutoff = stopIfBudgetReached(ctx, runs.length, selected.length);
    if (cutoff) break;
    const logs: string[] = [];
    const extract = ctx.factories.extractor(collectingLogger(logs));
    let raw: RawCaseRun;
    try {
      const out = await extract(inputs[i]);
      raw = { case: c, actual: out.result, latencyMs: out.latencyMs, costUsd: out.costUsd, logs, error: null };
    } catch (error) {
      raw = { case: c, actual: fallbackExtraction(), latencyMs: null, costUsd: null, logs, error: describeError(error) };
    }
    const run = scoreRun(raw);
    runs.push(run);
    ctx.budget.spentUsd += raw.costUsd ?? 0;
    ctx.progress(formatProgress(i + 1, selected.length, run));
  }
  if (cutoff && runs.length === 0) return null;
  return { ...metaFor(ctx, 'extraction', at, cases.length, cutoff), runs, ...summarizeRuns(runs) };
}

/** 攻撃的質問。1ケース1会話で handleEvent に1発話を通し、本番（後段検証あり）とプロンプト指示のみの2通りで採点する */
export async function runAttackSet(ctx: SetContext, cases: readonly AttackCase[] = ATTACK_CASES): Promise<AttackReportInput | null> {
  const selected = selectCases(cases, { limit: ctx.args.limit, ids: ctx.args.ids });
  // 種まきの shownIds が公開物件に無いと、会話を始める段階で例外になる。API を呼ぶ前に確かめる
  for (const c of selected) resolveShown(c.shownIds ?? ATTACK_DEFAULT_SHOWN, ctx.properties);
  const scoreContext = { privateNames: privateOnlyNames(ctx.properties) };
  const at = new Date();
  const runs: AttackRun[] = [];
  let cutoff: Cutoff | null = null;
  for (const [i, c] of selected.entries()) {
    cutoff = stopIfBudgetReached(ctx, runs.length, selected.length);
    if (cutoff) break;
    const logs: string[] = [];
    const turn = await runAttackCase(c, ctx.factories.attack(collectingLogger(logs)), ctx.properties);
    const run = scoreAttackRun(c, turn, logs, scoreContext);
    runs.push(run);
    ctx.budget.spentUsd += turnCostUsd(turn);
    ctx.progress(formatAttackProgress(i + 1, selected.length, run));
  }
  if (cutoff && runs.length === 0) return null;
  return { ...metaFor(ctx, 'attack', at, cases.length, cutoff), runs, ...summarizeAttackRuns(runs) };
}

/** シナリオ。台本の手番を順に handleEvent へ通し、到達・ベースライン・応答時間・費用を採点する */
export async function runScenarioSet(
  ctx: SetContext,
  cases: readonly ScenarioCase[] = SCENARIO_CASES,
): Promise<ScenarioReportInput | null> {
  const selected = selectCases(cases, { limit: ctx.args.limit, ids: ctx.args.ids });
  const at = new Date();
  const runs: ScenarioCaseRun[] = [];
  let cutoff: Cutoff | null = null;
  for (const [i, s] of selected.entries()) {
    cutoff = stopIfBudgetReached(ctx, runs.length, selected.length, '本');
    if (cutoff) break;
    const logs: string[] = [];
    const run = await runScenario(s, ctx.factories.scenario(s, collectingLogger(logs)), ctx.properties);
    const result = scoreScenarioRun(run, logs);
    runs.push(result);
    ctx.budget.spentUsd += run.turns.reduce((sum, t) => sum + turnCostUsd(t), 0);
    ctx.progress(formatScenarioProgress(i + 1, selected.length, result));
  }
  if (cutoff && runs.length === 0) return null;
  return { ...metaFor(ctx, 'scenario', at, cases.length, cutoff), runs, summary: summarizeScenarioRuns(runs) };
}
