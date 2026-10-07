import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LAYOUTS, TAGS, type Layout, type Property, type Tag } from '../src/domain/types';
import { STATIONS, adjacentStations, findStation } from '../src/domain/stations';
import { parsePropertiesCsv, serializePropertiesCsv } from '../src/lib/csv/properties';
import {
  DECOYS,
  DEFAULT_SEED,
  PRIVATE_COUNT,
  PROPERTY_COUNT,
  RENT_MAX,
  RENT_MIN,
  STATION_PROFILES,
  TAG_PHRASES,
  demoScenarioCounts,
  generateProperties,
  main,
  mulberry32,
  serializeTruth,
  summarize,
} from './generate-properties';

const AREA_RANGE: Record<Layout, [number, number]> = {
  '1R': [15, 22],
  '1K': [18, 26],
  '1DK': [25, 32],
  '1LDK': [30, 45],
  '2K': [30, 38],
  '2DK': [35, 45],
  '2LDK': [45, 65],
};
const MONEY_TAGS: readonly Tag[] = ['敷金なし', '礼金なし'];

// 生成は決定的なので、一度だけ作って使い回す
const { properties, truth } = generateProperties();

const ratio = (list: readonly Property[], pred: (p: Property) => boolean) =>
  list.filter(pred).length / Math.max(1, list.length);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mulberry32', () => {
  it('同じシードなら同じ列、0 以上 1 未満', () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(xs).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(new Set(xs).size).toBeGreaterThan(990);
    expect(mulberry32(124)()).not.toBe(mulberry32(123)());
  });
});

describe('generateProperties の決定性', () => {
  it('同じシードで 2 回生成すると完全に一致する', () => {
    const again = generateProperties(DEFAULT_SEED);
    expect(again).toEqual({ properties, truth });
    expect(JSON.stringify(again)).toBe(JSON.stringify({ properties, truth }));
    expect(serializePropertiesCsv(again.properties)).toBe(serializePropertiesCsv(properties));
  });

  it('シードを変えると内容が変わる', () => {
    expect(generateProperties(DEFAULT_SEED + 1).properties).not.toEqual(properties);
  });

  it('Math.random() を使わない', () => {
    const spy = vi.spyOn(Math, 'random');
    generateProperties(42);
    expect(spy).not.toHaveBeenCalled();
  });

  it('駅マスタの全駅に出現頻度・駅係数がある', () => {
    for (const s of STATIONS) {
      expect(STATION_PROFILES[s.name], s.name).toBeDefined();
      expect(STATION_PROFILES[s.name].weight).toBeGreaterThan(0);
    }
    expect(Object.keys(STATION_PROFILES).sort()).toEqual(STATIONS.map((s) => s.name).sort());
  });
});

describe('物件の属性', () => {
  it('200 件・ID は P0001〜P0200 で一意', () => {
    expect(properties).toHaveLength(PROPERTY_COUNT);
    expect(PROPERTY_COUNT).toBe(200);
    expect(properties.map((p) => p.id)).toEqual(Array.from({ length: 200 }, (_, i) => `P${String(i + 1).padStart(4, '0')}`));
  });

  it('家賃 6〜18 万円（1000 円単位）・管理費 0〜15,000（1000 円単位）', () => {
    for (const p of properties) {
      expect(p.rent, p.id).toBeGreaterThanOrEqual(RENT_MIN);
      expect(p.rent, p.id).toBeLessThanOrEqual(RENT_MAX);
      expect(p.rent % 1000, p.id).toBe(0);
      expect(p.managementFee, p.id).toBeGreaterThanOrEqual(0);
      expect(p.managementFee, p.id).toBeLessThanOrEqual(15000);
      expect(p.managementFee % 1000, p.id).toBe(0);
    }
    expect(RENT_MIN).toBe(60000);
    expect(RENT_MAX).toBe(180000);
  });

  it('家賃帯がまんべんなく分散する（どの 2 万円帯も 5 件以上・下限や上限に張り付かない）', () => {
    for (let lo = 60000; lo < 180000; lo += 20000) {
      const n = properties.filter((p) => p.rent >= lo && p.rent < lo + 20000).length;
      expect(n, `${lo}`).toBeGreaterThanOrEqual(5);
    }
    expect(properties.filter((p) => p.rent === RENT_MIN).length).toBeLessThan(10);
    expect(properties.filter((p) => p.rent === RENT_MAX).length).toBeLessThan(10);
  });

  it('1R〜2LDK の全間取りが出て、面積は間取りごとの範囲に収まる', () => {
    for (const layout of LAYOUTS) {
      const list = properties.filter((p) => p.layout === layout);
      expect(list.length, layout).toBeGreaterThanOrEqual(8);
      for (const p of list) {
        expect(p.areaSqm, p.id).toBeGreaterThanOrEqual(AREA_RANGE[layout][0]);
        expect(p.areaSqm, p.id).toBeLessThanOrEqual(AREA_RANGE[layout][1]);
      }
    }
  });

  it('敷金・礼金 0〜2 か月（0 と 1 が多い）、階 1〜12、築年 1985〜2025', () => {
    for (const p of properties) {
      expect(p.depositMonths).toBeGreaterThanOrEqual(0);
      expect(p.depositMonths).toBeLessThanOrEqual(2);
      expect(p.keyMoneyMonths).toBeGreaterThanOrEqual(0);
      expect(p.keyMoneyMonths).toBeLessThanOrEqual(2);
      expect(Number.isInteger(p.floor)).toBe(true);
      expect(p.floor).toBeGreaterThanOrEqual(1);
      expect(p.floor).toBeLessThanOrEqual(12);
      expect(Number.isInteger(p.builtYear)).toBe(true);
      expect(p.builtYear).toBeGreaterThanOrEqual(1985);
      expect(p.builtYear).toBeLessThanOrEqual(2025);
    }
    expect(ratio(properties, (p) => p.depositMonths === 0 || p.depositMonths === 1)).toBeGreaterThan(0.7);
    expect(ratio(properties, (p) => p.keyMoneyMonths === 0 || p.keyMoneyMonths === 1)).toBeGreaterThan(0.7);
  });

  it('入居可能日は null か 2026-10〜2027-01 の日付', () => {
    for (const p of properties) {
      if (p.availableFrom === null) continue;
      expect(p.availableFrom).toMatch(/^(2026-1[0-2]|2027-01)-\d{2}$/);
    }
    const dated = properties.filter((p) => p.availableFrom !== null).length;
    expect(dated).toBeGreaterThan(40);
    expect(dated).toBeLessThan(140);
  });

  it('約 5% が成約済み（非公開）', () => {
    const closed = properties.filter((p) => p.status === 'private').length;
    expect(closed).toBe(PRIVATE_COUNT);
    expect(closed).toBeGreaterThanOrEqual(8);
    expect(closed).toBeLessThanOrEqual(12);
    expect(properties.filter((p) => p.status === 'public')).toHaveLength(200 - closed);
  });
});

describe('駅・エリア', () => {
  it('access は 1〜2 件、全駅が駅マスタにあり、先頭が最寄り', () => {
    for (const p of properties) {
      expect(p.access.length, p.id).toBeGreaterThanOrEqual(1);
      expect(p.access.length, p.id).toBeLessThanOrEqual(2);
      for (const a of p.access) {
        expect(findStation(a.station), `${p.id} ${a.station}`).toBeDefined();
        expect(Number.isInteger(a.walkMin)).toBe(true);
        expect(a.walkMin).toBeGreaterThanOrEqual(1);
      }
      expect(p.access[0].walkMin, p.id).toBeLessThanOrEqual(Math.min(...p.access.map((a) => a.walkMin)));
    }
    expect(properties.some((p) => p.access.length === 2)).toBe(true);
    expect(properties.some((p) => p.access.length === 1)).toBe(true);
  });

  it('2 件目は先頭の駅の隣駅で、徒歩は長い', () => {
    for (const p of properties.filter((x) => x.access.length === 2)) {
      expect(adjacentStations(p.access[0].station), p.id).toContain(p.access[1].station);
      expect(p.access[1].walkMin, p.id).toBeGreaterThan(p.access[0].walkMin);
    }
  });

  it('ward は先頭の駅の所在地と一致する', () => {
    for (const p of properties) expect(p.ward, p.id).toBe(findStation(p.access[0].station)!.ward);
  });

  it('山手線・中央線・東急東横線の駅にまたがって分布する', () => {
    const nearest = new Set(properties.map((p) => p.access[0].station));
    expect(nearest.size).toBeGreaterThanOrEqual(35);
    for (const s of ['渋谷', '中目黒', '代官山', '新宿', '吉祥寺', '三鷹', '日吉', '元住吉']) {
      expect(properties.some((p) => p.access.some((a) => a.station === s)), s).toBe(true);
    }
  });

  it('人気駅は家賃が高く、郊外の駅は低い', () => {
    const mean = (stations: string[]) => {
      const list = properties.filter((p) => stations.includes(p.access[0].station));
      return list.reduce((s, p) => s + p.rent / p.areaSqm, 0) / list.length;
    };
    expect(mean(['渋谷', '恵比寿', '中目黒', '代官山'])).toBeGreaterThan(mean(['三鷹', '日吉', '元住吉']) * 1.25);
  });
});

describe('名前・住所（実在しないもの）', () => {
  it('住所は {ward}{架空のひらがな町名}{n}-{m}', () => {
    for (const p of properties) {
      expect(p.address.startsWith(p.ward), p.id).toBe(true);
      expect(p.address.slice(p.ward.length), p.id).toMatch(/^[ぁ-ん]+(町|台|坂|丘)\d+-\d+$/);
    }
    const towns = new Set(properties.map((p) => p.address.slice(p.ward.length).replace(/\d+-\d+$/, '')));
    expect(towns.size).toBe(15);
    expect(new Set(properties.map((p) => p.address)).size).toBe(200);
  });

  it('物件名は一意で空でない', () => {
    expect(new Set(properties.map((p) => p.name)).size).toBe(200);
    for (const p of properties) expect(p.name.length).toBeGreaterThan(2);
  });
});

describe('正解タグ', () => {
  it('タグは TAGS の値のみ・重複なし・TAGS の順', () => {
    for (const p of properties) {
      expect(new Set(p.tags).size, p.id).toBe(p.tags.length);
      for (const t of p.tags) expect(TAGS, `${p.id} ${t}`).toContain(t);
      expect(p.tags, p.id).toEqual(TAGS.filter((t) => p.tags.includes(t)));
    }
  });

  it('truth.json の内容（{ id, tags }[]）は物件のタグと一致する', () => {
    expect(truth).toHaveLength(200);
    expect(truth).toEqual(properties.map((p) => ({ id: p.id, tags: p.tags })));
    for (const t of truth) {
      expect(Object.keys(t).sort()).toEqual(['id', 'tags']);
      for (const tag of t.tags) expect(TAGS).toContain(tag);
    }
    expect(JSON.parse(serializeTruth(truth))).toEqual(truth);
  });

  it('敷金なし・礼金なしは数値列が 0 のとき（だけ）', () => {
    for (const p of properties) {
      expect(p.tags.includes('敷金なし'), p.id).toBe(p.depositMonths === 0);
      expect(p.tags.includes('礼金なし'), p.id).toBe(p.keyMoneyMonths === 0);
    }
  });

  it('全タグが一定数出る（どのタグも評価に使える）', () => {
    for (const t of TAGS) {
      expect(properties.filter((p) => p.tags.includes(t)).length, t).toBeGreaterThanOrEqual(10);
    }
  });

  it('ペット可は 15% 程度', () => {
    expect(ratio(properties, (p) => p.tags.includes('ペット可'))).toBeGreaterThan(0.08);
    expect(ratio(properties, (p) => p.tags.includes('ペット可'))).toBeLessThan(0.22);
  });

  it('1R はバストイレ別でないことが多い', () => {
    const oneR = properties.filter((p) => p.layout === '1R');
    expect(ratio(oneR, (p) => p.tags.includes('バストイレ別'))).toBeLessThan(0.4);
    const others = properties.filter((p) => p.layout !== '1R');
    expect(ratio(others, (p) => p.tags.includes('バストイレ別'))).toBeGreaterThan(0.7);
  });

  it('オートロックは新しめ・大きめに多い', () => {
    const fresh = properties.filter((p) => p.builtYear >= 2012);
    const old = properties.filter((p) => p.builtYear < 2000);
    const has = (p: Property) => p.tags.includes('オートロック');
    expect(ratio(fresh, has)).toBeGreaterThan(ratio(old, has) + 0.3);
    const big = properties.filter((p) => p.areaSqm >= 40);
    const small = properties.filter((p) => p.areaSqm < 25);
    expect(ratio(big, has)).toBeGreaterThan(ratio(small, has));
  });

  it('日当たり良好は南向き・高層に多い', () => {
    const sunny = (p: Property) => p.tags.includes('日当たり良好');
    const southHigh = properties.filter((p) => p.tags.includes('南向き') && p.floor >= 3);
    const notSouth = properties.filter((p) => !p.tags.includes('南向き'));
    const southLow = properties.filter((p) => p.tags.includes('南向き') && p.floor === 1);
    expect(ratio(southHigh, sunny)).toBeGreaterThan(ratio(notSouth, sunny) + 0.3);
    expect(ratio(southHigh, sunny)).toBeGreaterThan(ratio(southLow, sunny));
  });

  it('静かは徒歩 7 分以上かつ繁華な駅以外に多い', () => {
    const quiet = (p: Property) => p.tags.includes('静か');
    const busy = new Set(['渋谷', '新宿', '池袋', '東京', '新橋', '品川', '五反田', '上野', '秋葉原', '恵比寿']);
    const far = properties.filter((p) => p.access[0].walkMin >= 7 && !busy.has(p.access[0].station));
    const near = properties.filter((p) => p.access[0].walkMin < 5);
    const busyStation = properties.filter((p) => busy.has(p.access[0].station));
    expect(ratio(far, quiet)).toBeGreaterThan(0.35);
    expect(ratio(near, quiet)).toBeLessThan(0.25);
    expect(ratio(busyStation, quiet)).toBeLessThan(ratio(far, quiet));
  });
});

describe('備考（note）', () => {
  const noteTags = (p: Property) => p.tags.filter((t): t is Exclude<Tag, '敷金なし' | '礼金なし'> => !MONEY_TAGS.includes(t));
  /** 紛らわしい記述（正解に含めない）を取り除いた備考 */
  const withoutDecoys = (note: string) =>
    [...DECOYS]
      .sort((a, b) => b.phrase.length - a.phrase.length)
      .reduce((text, d) => text.split(d.phrase).join(''), note);

  it('正解タグ（敷金なし・礼金なしを除く）はすべて備考に書かれている', () => {
    for (const p of properties) {
      for (const tag of noteTags(p)) {
        expect(
          TAG_PHRASES[tag].some((phrase) => p.note.includes(phrase)),
          `${p.id} ${tag}: ${p.note}`,
        ).toBe(true);
      }
    }
  });

  it('正解にないタグの表現は、紛らわしい記述を除くと備考に現れない', () => {
    for (const p of properties) {
      const note = withoutDecoys(p.note);
      for (const [tag, phrases] of Object.entries(TAG_PHRASES) as [Tag, readonly string[]][]) {
        if (p.tags.includes(tag)) continue;
        for (const phrase of phrases) expect(note.includes(phrase), `${p.id} ${tag}「${phrase}」: ${p.note}`).toBe(false);
      }
    }
  });

  it('備考に敷金・礼金の記述はない（数値列で決まるため）', () => {
    for (const p of properties) expect(p.note, p.id).not.toMatch(/敷金|礼金|敷礼/);
  });

  it('表記ゆれが混ざる（バストイレ別は 4 種類以上の書き方）', () => {
    const used = new Set(
      TAG_PHRASES['バストイレ別'].filter((phrase) => properties.some((p) => p.note.includes(phrase))),
    );
    expect(used.size).toBeGreaterThanOrEqual(4);
    expect(used.has('BT別')).toBe(true);
    expect(used.has('風呂トイレ別')).toBe(true);
    expect(properties.some((p) => p.note.includes('ペット相談可（小型犬1匹まで）'))).toBe(true);
    expect(properties.some((p) => p.note.includes('陽当たり良好'))).toBe(true);
    expect(properties.some((p) => p.note.includes('日当り良好'))).toBe(true);
    expect(properties.some((p) => p.note.includes('閑静な住宅街'))).toBe(true);
    expect(properties.some((p) => p.note.includes('オートロック付きで女性にも安心'))).toBe(true);
  });

  it('タグに無い紛らわしい記述も混ざる', () => {
    expect(properties.some((p) => p.note.includes('ペット不可'))).toBe(true);
    expect(properties.some((p) => p.note.includes('1階につき日当たりは控えめ'))).toBe(true);
    // ペット不可と書いた物件はペット可ではない
    for (const p of properties.filter((x) => x.note.includes('ペット不可'))) expect(p.tags).not.toContain('ペット可');
    // 1階につき日当たりは控えめ と書いた物件は 1 階で日当たり良好ではない
    for (const p of properties.filter((x) => x.note.includes('1階につき日当たりは控えめ'))) {
      expect(p.floor).toBe(1);
      expect(p.tags).not.toContain('日当たり良好');
    }
  });

  it('備考は 1 行（改行なし）で、CSV の列区切りと紛れる文字を含まない', () => {
    for (const p of properties) expect(p.note, p.id).not.toMatch(/[\r\n,"]/);
  });
});

describe('デモ（DESIGN.md 10.1）の流れが再現できる', () => {
  const c = demoScenarioCounts(properties);

  it('渋谷・中目黒・代官山 / 予算 9 万 / バストイレ別・オートロック・静か の全条件 AND は 0〜1 件', () => {
    expect(c.allAnd).toBeLessThanOrEqual(1);
  });

  it('オートロックを must から外すと 5〜8 件増える', () => {
    const gain = c.withoutAutolock - c.allAnd;
    expect(gain).toBeGreaterThanOrEqual(5);
    expect(gain).toBeLessThanOrEqual(8);
  });

  it('静かを want にした場合（must はバストイレ別・オートロック）も、オートロックを外すと 5〜8 件増える', () => {
    const gain = c.mustOnlyWithoutAutolock - c.mustOnlyAllAnd;
    expect(c.mustOnlyAllAnd).toBeLessThanOrEqual(1);
    expect(gain).toBeGreaterThanOrEqual(5);
    expect(gain).toBeLessThanOrEqual(8);
  });

  it('他の条件を外すより、オートロックを外すほうが件数が増える（予算は +5,000 円の緩和で見るため除く）', () => {
    expect(c.withoutAutolock).toBeGreaterThan(c.withoutQuiet);
    expect(c.withoutAutolock).toBeGreaterThan(c.withoutBathSeparate);
    expect(c.withoutAutolock).toBeGreaterThan(c.withoutBudget);
  });

  it('予算内の候補は十分にある（家賃＋管理費が 9 万円以下）', () => {
    expect(c.base).toBeGreaterThanOrEqual(10);
  });

  it('成約済み（非公開）で同じ条件に合う物件があり、検索対象外であることを示せる', () => {
    expect(c.closedMatches).toBeGreaterThanOrEqual(1);
  });
});

describe('CSV と truth の書き出し', () => {
  it('生成した物件を CSV にして読み戻すと、tags 以外が一致しエラーが出ない', () => {
    const csv = serializePropertiesCsv(properties);
    const parsed = parsePropertiesCsv(csv);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual(
      properties.map((p) => {
        const rest: Partial<Property> = { ...p };
        delete rest.tags;
        return rest;
      }),
    );
    expect(csv.split('\n')[0]).toBe(
      'id,name,address,ward,access,rent,management_fee,deposit_months,key_money_months,layout,area_sqm,floor,built_year,note,available_from,status',
    );
  });

  it('main は data/properties.csv と data/properties.truth.json を書き出す', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-props-'));
    try {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      main(root);
      const csv = fs.readFileSync(path.join(root, 'data', 'properties.csv'), 'utf8');
      const json = fs.readFileSync(path.join(root, 'data', 'properties.truth.json'), 'utf8');
      expect(csv).toBe(serializePropertiesCsv(properties));
      expect(JSON.parse(json)).toEqual(truth);
      expect(log.mock.calls.flat().join('\n')).toContain('200 件');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('リポジトリの data/ は現在の生成結果と一致している（生成ロジックを変えたら npm run data:generate）', () => {
    const dataDir = fileURLToPath(new URL('../data/', import.meta.url));
    const normalize = (s: string) => s.replace(/\r\n/g, '\n');
    expect(normalize(fs.readFileSync(path.join(dataDir, 'properties.csv'), 'utf8'))).toBe(serializePropertiesCsv(properties));
    expect(normalize(fs.readFileSync(path.join(dataDir, 'properties.truth.json'), 'utf8'))).toBe(serializeTruth(truth));
  });
});

describe('summarize', () => {
  it('間取り別・家賃帯別・駅別・デモの件数を含む', () => {
    const text = summarize(properties);
    expect(text).toContain('間取り別');
    expect(text).toContain('家賃帯別');
    expect(text).toContain('駅別件数');
    expect(text).toContain('全条件AND 0 件');
    for (const layout of LAYOUTS) expect(text).toContain(`${layout}:`);
  });
});
