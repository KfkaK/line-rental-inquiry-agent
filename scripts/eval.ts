/**
 * 評価ランナー（DESIGN.md 7章。使い方と指標の定義は eval/README.md）。純関数は eval/report.ts と eval/score.ts にあり、
 * ここは I/O（環境変数・API・ファイル・標準出力）と main だけ。
 *
 *   npm run eval -- --set=extraction                          # 全件（実 API・有料。.env.local の ANTHROPIC_API_KEY を使う）
 *   npm run eval -- --set=extraction --model=claude-sonnet-5-5 --limit=5
 *   npm run eval -- --ids=ex-001,ex-002
 *   npm run eval -- --fake --limit=3                          # 実 API を使わず、流れだけ確かめる（結果は一時ディレクトリへ）
 *
 * 抽出は本番と同じ経路（src/server/deps.ts の createExtractor）で、1件ずつ順に呼ぶ。
 * API エラーのケースは fallbackExtraction() として採点して続ける。終了コードは、評価の結果にかかわらず 0
 * （引数の誤りなど実行自体の失敗だけ 1）。進捗は標準エラー、レポートと結果ファイルのパスは標準出力。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXTRACTION_CASES } from '../eval/datasets/extraction';
import { loadDemoProperties } from '../eval/data';
import {
  EVAL_USAGE,
  buildResultFile,
  describeError,
  formatExtractionReport,
  formatLogEntry,
  formatProgress,
  parseEvalArgs,
  resolveShown,
  resultFileName,
  scoreRun,
  selectCases,
  summarizeRuns,
  type CaseRun,
  type EvalArgs,
  type RawCaseRun,
} from '../eval/report';
import { EVAL_NOW } from '../eval/types';
import { requireEnv } from '@/lib/env';
import { createAnthropicClient, createFakeLlmClient, type LlmClient, type Logger } from '@/lib/llm/client';
import { fallbackExtraction } from '@/lib/llm/extract';
import { priceOf } from '@/lib/llm/pricing';
import { createExtractor } from '@/server/deps';

/** --fake が毎回返すツール入力（検証を通る最小の妥当な出力） */
const FAKE_TOOL_INPUT = { intent: 'offTopic', ops: [], targetPositions: [], viewingTimes: [], forbiddenTopic: null };
/** 1件あたりの最大呼び出し回数（抽出は検証失敗で1回だけ再試行する）。偽物の応答が尽きないよう、この分だけ用意する */
const FAKE_CALLS_PER_CASE = 2;

function createClient(args: EvalArgs, caseCount: number): LlmClient {
  if (!args.fake) return createAnthropicClient();
  const respond = () => ({ input: FAKE_TOOL_INPUT });
  return createFakeLlmClient(Array.from({ length: Math.max(1, caseCount) * FAKE_CALLS_PER_CASE }, () => respond));
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    // .env.local が無ければ、環境変数がすでに設定されている前提で続ける
  }
  let args: EvalArgs;
  try {
    args = parseEvalArgs(process.argv.slice(2));
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n\n${EVAL_USAGE}`);
  }
  // 料金表に無いモデルは、API を呼んだあとの費用計算で例外になり、全件が課金されたうえでエラーになる
  if (!priceOf(args.model)) throw new Error(`料金表にないモデルです: ${args.model}（src/lib/llm/pricing.ts に追加してください）`);
  // キーが無いまま全件が「API エラー」で終わらないよう、実 API の実行では先に確かめる
  if (!args.fake) requireEnv('ANTHROPIC_API_KEY');

  const properties = loadDemoProperties();
  const cases = selectCases(EXTRACTION_CASES, { limit: args.limit, ids: args.ids });
  // 入力は先にすべて組み立てる（shownIds の誤りは、API を呼ぶ前に例外で止める）
  const inputs = cases.map((c) => ({
    utterance: c.utterance,
    slots: c.slots ?? { tags: [] },
    shown: resolveShown(c.shownIds, properties),
    now: new Date(c.now ?? EVAL_NOW),
  }));
  const client = createClient(args, cases.length);
  const startedAt = new Date();

  const runs: CaseRun[] = [];
  for (const [i, c] of cases.entries()) {
    const logs: string[] = [];
    const logger: Logger = {
      error: (message, ...rest) => {
        logs.push(formatLogEntry(message, rest));
      },
    };
    const extract = createExtractor(client, { model: args.model, logger });
    let raw: RawCaseRun;
    try {
      const out = await extract(inputs[i]);
      raw = { case: c, actual: out.result, latencyMs: out.latencyMs, costUsd: out.costUsd, logs, error: null };
    } catch (error) {
      raw = { case: c, actual: fallbackExtraction(), latencyMs: null, costUsd: null, logs, error: describeError(error) };
    }
    const run = scoreRun(raw);
    runs.push(run);
    console.error(formatProgress(i + 1, cases.length, run));
  }

  const { summary, measures } = summarizeRuns(runs);
  const report = { set: args.set, model: args.model, fake: args.fake, limit: args.limit, ids: args.ids, at: startedAt, runs, summary, measures };

  // --fake の結果は基準にならないので、eval/results ではなく一時ディレクトリへ書く
  const outDir = args.fake ? path.join(os.tmpdir(), 'line-rental-agent-eval') : args.out;
  fs.mkdirSync(outDir, { recursive: true });
  const filePath = path.join(outDir, resultFileName(args.set, args.model, startedAt, { fake: args.fake }));
  fs.writeFileSync(filePath, `${JSON.stringify(buildResultFile(report), null, 2)}\n`, 'utf8');

  console.log(formatExtractionReport(report));
  console.log(`結果ファイル: ${filePath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
