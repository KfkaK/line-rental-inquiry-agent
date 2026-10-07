/**
 * 物件 CSV を Supabase に取り込む: CSV → 行ごとの検証 → 備考からタグ抽出 → upsert（DESIGN.md 2.2「物件CSVインポート」）。
 *
 * 使い方（環境変数は .env.local から読む）:
 *   npm run data:import                                  # data/properties.csv を辞書＋Haiku のタグ抽出で取り込む
 *   npm run data:import -- --tags=truth                  # 架空データの正解タグで取り込む（デモの流れを確実に再現する）
 *   npm run data:import -- --tags=dictionary --dry-run   # API を使わず、取り込まずに件数とタグだけ確かめる
 *   npm run data:import -- path/to/other.csv
 *
 * CSV に無い既存の物件はそのまま残る（非公開にするかは未定。引き継ぎ書 6章④）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Tag } from '@/domain/types';
import { attachTags } from '@/lib/csv/importProperties';
import { parsePropertiesCsv } from '@/lib/csv/properties';
import { createSupabaseRepositories } from '@/lib/db';
import { createAnthropicClient } from '@/lib/llm/client';
import { extractTagsByDictionary, extractTagsForNotes } from '@/lib/llm/tags';

type TagSource = 'llm' | 'dictionary' | 'truth';

function parseArgs(argv: string[]): { csvPath: string; tags: TagSource; dryRun: boolean } {
  let csvPath = path.join('data', 'properties.csv');
  let tags: TagSource = 'llm';
  let dryRun = false;
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--tags=')) {
      const value = arg.slice('--tags='.length);
      if (value !== 'llm' && value !== 'dictionary' && value !== 'truth') throw new Error(`--tags は llm / dictionary / truth のどれか: ${value}`);
      tags = value;
    } else if (!arg.startsWith('--')) csvPath = arg;
    else throw new Error(`未知のオプション: ${arg}`);
  }
  return { csvPath, tags, dryRun };
}

async function noteTagsFor(source: TagSource, notes: { id: string; note: string }[]): Promise<Map<string, Tag[]>> {
  if (source === 'dictionary') return new Map(notes.map((n) => [n.id, extractTagsByDictionary(n.note)]));
  if (source === 'truth') {
    const truth = JSON.parse(fs.readFileSync(path.join('data', 'properties.truth.json'), 'utf8')) as { id: string; tags: Tag[] }[];
    return new Map(truth.map((t) => [t.id, t.tags]));
  }
  const result = await extractTagsForNotes(notes, createAnthropicClient());
  console.log(`タグ抽出（辞書＋Haiku）: LLM 呼び出し ${result.calls} 回・費用 $${result.costUsd.toFixed(4)}`);
  if (result.failedIds.length > 0) {
    console.warn(`LLM が答えられなかった ${result.failedIds.length} 件は辞書の結果だけで取り込みます: ${result.failedIds.join(', ')}`);
  }
  return result.tags;
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    // .env.local が無ければ、環境変数がすでに設定されている前提で続ける
  }
  const { csvPath, tags, dryRun } = parseArgs(process.argv.slice(2));

  const { rows, errors } = parsePropertiesCsv(fs.readFileSync(csvPath, 'utf8'));
  if (errors.length > 0) {
    for (const e of errors) console.error(`${csvPath}:${e.line} ${e.message}`);
    console.error(`CSV に ${errors.length} 件の誤りがあるため取り込みません`);
    process.exitCode = 1;
    return;
  }

  const noteTags = await noteTagsFor(tags, rows.map((r) => ({ id: r.id, note: r.note })));
  const properties = attachTags(rows, noteTags);
  const publicCount = properties.filter((p) => p.status === 'public').length;
  console.log(`${csvPath}: ${properties.length} 件（公開 ${publicCount}・非公開 ${properties.length - publicCount}）タグ: ${tags}`);

  if (dryRun) {
    for (const p of properties.slice(0, 5)) console.log(`  ${p.id} ${p.name}: ${p.tags.join('、') || '（なし）'}`);
    console.log('--dry-run のため取り込みません');
    return;
  }

  const { inserted, updated } = await createSupabaseRepositories().properties.upsertMany(properties);
  console.log(`取り込みました: 追加 ${inserted} 件・更新 ${updated} 件`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
