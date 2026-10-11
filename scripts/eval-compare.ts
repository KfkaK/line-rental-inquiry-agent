/**
 * 評価の比較表（`npm run eval:compare`。整形は eval/compare.ts）。eval/results/ の結果ファイルのうち fake でないものを読み、
 * (評価セット, 構成, 辞書の有無) ごとに最新の1つを選んで、README にそのまま貼れる Markdown の表を標準出力に出す。
 *
 *   npm run eval:compare                    # eval/results/ を読む
 *   npm run eval:compare -- --dir=tmp/out   # 別のディレクトリを読む
 *
 * 読めない結果ファイルは標準エラーに理由を出して飛ばす（終了コードは 0）。ディレクトリが無いなど実行自体の失敗だけ 1。
 */
import fs from 'node:fs';
import path from 'node:path';
import { formatCompareTables, parseResultFile, type CompareResult } from '../eval/compare';
import { DEFAULT_OUT_DIR } from '../eval/report';

function parseDir(argv: readonly string[]): string {
  let dir = DEFAULT_OUT_DIR;
  for (const arg of argv) {
    if (!arg.startsWith('--dir=') || arg.length === '--dir='.length) {
      throw new Error(`使い方: npm run eval:compare -- [--dir=<結果ファイルのディレクトリ。省略時 ${DEFAULT_OUT_DIR}>]\n未知の引数: ${arg}`);
    }
    dir = arg.slice('--dir='.length);
  }
  return dir;
}

function main(): void {
  const dir = parseDir(process.argv.slice(2));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`結果のディレクトリがありません: ${dir}`);

  const results: CompareResult[] = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    let json: unknown;
    try {
      json = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch (error) {
      console.error(`飛ばしました: ${name}（JSON として読めません: ${error instanceof Error ? error.message : String(error)}）`);
      continue;
    }
    const outcome = parseResultFile(json, name);
    if (outcome.ok) results.push(outcome.result);
    else if (!outcome.fake) console.error(`飛ばしました: ${name}（${outcome.reason}）`);
  }
  console.error(`読んだ結果ファイル: ${results.length} 件（${dir}）`);
  console.log(formatCompareTables(results));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
