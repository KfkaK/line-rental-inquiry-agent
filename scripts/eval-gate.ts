/**
 * 評価の関門（`npm run eval:gate`。比較と基準値の作り直しは eval/gate.ts の純関数）。実 API の評価結果を基準値
 * （eval/baseline.json）と比べ、落ちていたら終了コード 1 で知らせる。GitHub Actions の eval.yml から呼ぶ。
 *
 *   npm run --silent eval:gate -- --results=<dir>                 # <dir> の結果ファイルを基準値と比べる。レポート（Markdown）は標準出力
 *   npm run --silent eval:gate -- --results=<dir> --baseline=<path>
 *   npm run --silent eval:gate -- --update --results=eval/results # 比べずに、選んだ3つの結果から eval/baseline.json を作り直す
 *
 * セットごとに「基準値と同じ構成・辞書あり・fake でない・config.at が最新」の1つを選ぶ。<dir> は、CI では評価の --out に渡した
 * そのジョブだけのディレクトリにする（コミット済みの古い結果が混ざる eval/results をそのまま渡すと、古い結果を選んで合格してしまう）。
 * 終了コード: 合格 0・不合格 1。引数の誤り・ファイルの読み込みの失敗も 1（標準エラーに理由）。
 * 標準出力は `npm run --silent`（npm の行を出さない）で受けると、そのまま $GITHUB_STEP_SUMMARY に追記できる。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  GATE_USAGE,
  buildBaseline,
  evaluateGate,
  formatGateReport,
  parseBaseline,
  parseGateArgs,
  selectGateResults,
  type GateArgs,
  type GateBaseline,
} from '../eval/gate';

function readJson(file: string, what: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`${what}を読めません: ${file}（${error instanceof Error ? error.message : String(error)}）`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${what}が JSON として読めません: ${file}（${error instanceof Error ? error.message : String(error)}）`);
  }
}

function readBaseline(file: string): GateBaseline {
  const json = readJson(file, '基準値');
  try {
    return parseBaseline(json);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}（${file}）`);
  }
}

/** ディレクトリの *.json を読む。JSON として読めないファイルがあれば、古い結果で合格するのを避けるため止める */
function readResultFiles(dir: string): { name: string; json: unknown }[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`結果のディレクトリがありません: ${dir}`);
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({ name, json: readJson(path.join(dir, name), '結果ファイル') }));
}

/** 戻り値は終了コード */
function main(args: GateArgs): number {
  const baseline = readBaseline(args.baseline);
  const files = readResultFiles(args.results);
  const selection = selectGateResults(files, args.config ?? baseline.config);
  for (const { file, reason } of selection.skipped) console.error(`飛ばしました: ${file}（${reason}）`);
  console.error(`読んだ結果ファイル: ${files.length} 件（${args.results}）`);

  if (args.update) {
    const next = buildBaseline(baseline, selection.results);
    fs.writeFileSync(args.baseline, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    console.log(`基準値を書きました: ${args.baseline}`);
    console.log(`- 更新日 ${next.updated}・構成 ${next.config}・プロンプト 抽出 ${next.prompts.extract} / 回答 ${next.prompts.answer}`);
    console.log(`- 条件抽出の完全一致 ${next.extraction.exact.correct}/${next.extraction.exact.total}（外れた id: ${next.extraction.misses.join(', ') || 'なし'}）`);
    console.log(`- 攻撃的質問の合格 ${next.attack.passed}/${next.attack.total}`);
    console.log(`- シナリオの到達 ${next.scenario.reached.length} 本（到達しないのが正解 ${next.scenario.expectedNone.length} 本）`);
    console.log(`- 元の結果ファイル（これもコミットする）: ${Object.values(next.sources).join(', ')}`);
    return 0;
  }

  const outcome = evaluateGate(baseline, selection.results, { hints: selection.hints });
  console.log(formatGateReport(baseline, selection.results, outcome));
  if (outcome.ok) {
    console.error('基準値との比較: 合格');
    return 0;
  }
  // ジョブの要約に標準出力を貼っても、ログの先頭で原因が分かるように標準エラーにも出す
  console.error(`基準値との比較: 不合格（失敗 ${outcome.failures.length} 件）`);
  for (const failure of outcome.failures) console.error(`- ${failure}`);
  return 1;
}

try {
  let args: GateArgs;
  try {
    args = parseGateArgs(process.argv.slice(2));
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n\n${GATE_USAGE}`);
  }
  process.exitCode = main(args);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
