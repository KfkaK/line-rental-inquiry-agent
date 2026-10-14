/**
 * 評価ランナー（DESIGN.md 7章。使い方と指標の定義は eval/README.md）。純関数は eval/report*.ts と eval/score*.ts、
 * 3つの評価セットを回す本体は eval/runSets.ts にあり、ここは I/O（環境変数・ファイル・標準出力）と main だけ。
 *
 *   npm run eval -- --set=extraction                          # 条件抽出 100 件（実 API・有料。.env.local の ANTHROPIC_API_KEY を使う）
 *   npm run eval -- --set=attack --config=one-model            # 攻撃的質問 52 件を 1モデル構成で
 *   npm run eval -- --set=scenario --max-cost=1                # シナリオ 15 本。累計 $1 に達したら次のシナリオを始めずに打ち切る
 *   npm run eval -- --set=all                                  # 3つを順に（費用の上限は3つで通算）
 *   npm run eval -- --set=extraction --no-dictionary           # 抽出の前段の辞書を通さない
 *   npm run eval -- --set=extraction --model=claude-sonnet-5-5 --limit=5
 *   npm run eval -- --set=all --fake                           # 実 API を使わず、流れだけ確かめる（結果は一時ディレクトリへ）
 *
 * 1件ずつ順に呼ぶ（応答時間をそろえるため）。API エラーのケースは fallbackExtraction() として採点して続ける。
 * 終了コードは、評価の結果にかかわらず 0（引数の誤りなど実行自体の失敗だけ 1）。進捗は標準エラー、レポートと結果ファイルのパスは標準出力。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDemoProperties } from '../eval/data';
import { CONFIG_MODELS } from '../eval/pipelines';
import { EVAL_USAGE, buildResultFile, formatExtractionReport, parseEvalArgs, setsOf, type EvalArgs } from '../eval/report';
import { buildAttackResultFile, formatAttackReport } from '../eval/reportAttack';
import { resultFileName, type EvalSet } from '../eval/reportCommon';
import { buildScenarioResultFile, formatScenarioReport } from '../eval/reportScenario';
import {
  createBudget,
  fakeFactories,
  realFactories,
  runAttackSet,
  runExtractionSet,
  runScenarioSet,
  type SetContext,
} from '../eval/runSets';
import { requireEnv } from '@/lib/env';
import { priceOf } from '@/lib/llm/pricing';

/** 結果ファイルを書く。同じ名前（同じ分に同じ設定で2回）があれば、-2・-3 を付けて上書きしない */
function writeResultFile(dir: string, fileName: string, data: unknown): string {
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  let filePath = path.join(dir, fileName);
  for (let n = 2; fs.existsSync(filePath); n++) filePath = path.join(dir, `${stem}-${n}${ext}`);
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return filePath;
}

/** 料金表に無いモデルは、API を呼んだあとの費用計算で例外になり、全件が課金されたうえでエラーになる。先に確かめる */
function assertPriced(args: EvalArgs): void {
  const models = CONFIG_MODELS[args.config];
  const used = new Set([args.model ?? models.extract, ...(setsOf(args.set).some((s) => s !== 'extraction') ? [models.answer] : [])]);
  for (const model of used) {
    if (!priceOf(model)) throw new Error(`料金表にないモデルです: ${model}（src/lib/llm/pricing.ts に追加してください）`);
  }
}

/**
 * .env.local を読む。worktree（.claude/worktrees/*）には .env.local が無いので、元のチェックアウトのものを読む。
 * コマンドで .env.local を名指しすると Claude Code のフックが止めるので、パスはここで解決する（意思決定ログ20）
 */
function loadEnvLocal(): void {
  const candidates = ['.env.local'];
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    candidates.push(path.join(path.dirname(commonDir), '.env.local'));
  } catch {
    // git が使えなければ作業ディレクトリだけを見る
  }
  const found = candidates.find((file) => fs.existsSync(file));
  // どこにも無ければ、環境変数がすでに設定されている前提で続ける
  if (found) process.loadEnvFile(found);
}

async function main(): Promise<void> {
  loadEnvLocal();
  let args: EvalArgs;
  try {
    args = parseEvalArgs(process.argv.slice(2));
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n\n${EVAL_USAGE}`);
  }
  assertPriced(args);
  // キーが無いまま全件が「API エラー」で終わらないよう、実 API の実行では先に確かめる
  if (!args.fake) requireEnv('ANTHROPIC_API_KEY');

  const budget = createBudget(args.maxCostUsd);
  const ctx: SetContext = {
    args,
    properties: loadDemoProperties(),
    budget,
    progress: (line) => console.error(line),
    factories: args.fake ? fakeFactories(args) : realFactories(args),
  };
  // --fake の結果は基準にならないので、eval/results ではなく一時ディレクトリへ書く
  const outDir = args.fake ? path.join(os.tmpdir(), 'line-rental-agent-eval') : args.out;
  const label = `${args.config}${args.dictionary ? '' : '・辞書なし'}${args.fake ? '・fake' : ''}`;

  const sets = setsOf(args.set);
  for (const [i, set] of sets.entries()) {
    console.error(`== ${set}（${label}）==`);
    const finished = await runOne(set, ctx, outDir);
    if (i > 0) console.log('\n---\n');
    if (finished === null) {
      console.log(`# ${set}: 実行していません\n\n費用が上限 $${args.maxCostUsd}（--max-cost）に達したため、この評価セットは始めませんでした。`);
      continue;
    }
    console.log(finished.report);
    console.log(`結果ファイル: ${finished.filePath}`);
  }
  console.error(`累計の費用: $${budget.spentUsd.toFixed(4)}（上限 $${args.maxCostUsd}）`);
}

/** 評価セットを1つ回して、レポートを組み立て、結果ファイルを書く。上限に達していて始められなければ null */
async function runOne(set: EvalSet, ctx: SetContext, outDir: string): Promise<{ report: string; filePath: string } | null> {
  const { args } = ctx;
  switch (set) {
    case 'extraction': {
      const result = await runExtractionSet(ctx);
      if (result === null) return null;
      const name = resultFileName(set, args.config, result.at, { fake: args.fake, dictionary: args.dictionary });
      return { report: formatExtractionReport(result), filePath: writeResultFile(outDir, name, buildResultFile(result)) };
    }
    case 'attack': {
      const result = await runAttackSet(ctx);
      if (result === null) return null;
      const name = resultFileName(set, args.config, result.at, { fake: args.fake, dictionary: args.dictionary });
      return { report: formatAttackReport(result), filePath: writeResultFile(outDir, name, buildAttackResultFile(result)) };
    }
    case 'scenario': {
      const result = await runScenarioSet(ctx);
      if (result === null) return null;
      const name = resultFileName(set, args.config, result.at, { fake: args.fake, dictionary: args.dictionary });
      return { report: formatScenarioReport(result), filePath: writeResultFile(outDir, name, buildScenarioResultFile(result)) };
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
