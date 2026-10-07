/**
 * 架空データ（data/properties.csv ＋ 正解タグ）でデモ動画の流れ（DESIGN.md 10.1）が再現できることを固定する。
 * データを作り直したらここが落ちないことを確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePropertiesCsv } from '@/lib/csv/properties';
import { suggestRelaxation } from './relax';
import { searchProperties } from './search';
import { applySlotOps, asAllMust } from './slots';
import type { Property, Slots, Tag } from './types';

function loadDemoProperties(): Property[] {
  const root = path.resolve(__dirname, '..', '..', 'data');
  const { rows, errors } = parsePropertiesCsv(fs.readFileSync(path.join(root, 'properties.csv'), 'utf8'));
  expect(errors).toEqual([]);
  const truth = JSON.parse(fs.readFileSync(path.join(root, 'properties.truth.json'), 'utf8')) as { id: string; tags: Tag[] }[];
  const tagsById = new Map(truth.map((t) => [t.id, t.tags]));
  return rows.map((r) => ({ ...r, tags: tagsById.get(r.id) ?? [] }));
}

const properties = loadDemoProperties();

/** 「渋谷か中目黒か代官山で9万まで。バストイレ別とオートロックは絶対、静かなところがいい」 */
const demo: Slots = {
  area: { value: { stations: ['渋谷', '中目黒', '代官山'], wards: [] }, priority: 'must' },
  rentMax: { value: 90000, priority: 'must' },
  tags: [
    { value: 'バストイレ別', priority: 'must' },
    { value: 'オートロック', priority: 'must' },
    { value: '静か', priority: 'must' },
  ],
};

describe('デモの流れ（架空データ）', () => {
  it('全条件 must では 0 件で、「オートロックを『できれば』にすると7件増えます」と提案する', () => {
    expect(searchProperties(properties, demo).total).toBe(0);
    const s = suggestRelaxation(properties, demo)!;
    expect(s.label).toBe('オートロックを「できれば」にする');
    expect(s.gained).toBe(7);
  });

  it('受け入れると7件出て、オートロック付きが無いことを「オートロックなし」と示す', () => {
    const relaxed = applySlotOps(demo, suggestRelaxation(properties, demo)!.ops);
    const result = searchProperties(properties, relaxed);
    expect(result.total).toBe(7);
    expect(result.items.every((i) => i.unmatched.includes('オートロックなし'))).toBe(true);
  });

  it('Web サイト式（全条件 AND）では 0 件でも、優先順位つきなら候補が出る', () => {
    const prioritized = applySlotOps(demo, [
      { op: 'setTagPriority', tag: 'オートロック', priority: 'nice' },
      { op: 'setTagPriority', tag: '静か', priority: 'want' },
    ]);
    expect(searchProperties(properties, asAllMust(prioritized)).total).toBe(0);
    expect(searchProperties(properties, prioritized).total).toBeGreaterThan(0);
  });

  it('成約済み（非公開）は検索に出ない', () => {
    const all = searchProperties(properties, { tags: [] });
    expect(all.total).toBe(properties.filter((p) => p.status === 'public').length);
    expect(all.items.some((i) => i.property.status === 'private')).toBe(false);
  });
});
