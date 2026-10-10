/**
 * 評価に使う物件データ。架空データ（data/properties.csv）に正解タグ（data/properties.truth.json）を付けたもの。
 * 本番の Supabase も正解タグで取り込んである（意思決定ログ4）ので、評価と実機の物件は同じ。
 * パスはリポジトリのルートから（ランナーもテストもルートで動かす）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Property, Tag } from '@/domain/types';
import { parsePropertiesCsv } from '@/lib/csv/properties';

export function loadDemoProperties(dataDir = path.join(process.cwd(), 'data')): Property[] {
  const { rows, errors } = parsePropertiesCsv(fs.readFileSync(path.join(dataDir, 'properties.csv'), 'utf8'));
  if (errors.length > 0) throw new Error(`data/properties.csv に不正な行があります: ${JSON.stringify(errors.slice(0, 3))}`);
  const truth = JSON.parse(fs.readFileSync(path.join(dataDir, 'properties.truth.json'), 'utf8')) as { id: string; tags: Tag[] }[];
  const tagsById = new Map(truth.map((t) => [t.id, t.tags]));
  return rows.map((r) => ({ ...r, tags: tagsById.get(r.id) ?? [] }));
}
