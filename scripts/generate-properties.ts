/**
 * 架空物件 200 件の生成（DESIGN.md 5章・8章）。
 *
 * - 決定的: シード固定の PRNG（mulberry32）だけを使う。`Math.random()` は使わない
 * - 物件名・住所は実在しないもの（架空のひらがな町名・汎用語の組み合わせ）
 * - 正解タグは属性から決め、備考（note）はその正解タグを表記ゆれつきの日本語で書く。
 *   タグ抽出の評価用の正解は `data/properties.truth.json`（`{ id, tags }[]`）に出す
 * - デモ（DESIGN.md 10.1）の流れが再現できるよう、渋谷・中目黒・代官山 / 予算9万 / バストイレ別 / 静か の周辺に偏りを入れる
 *
 * `npm run data:generate` で `data/properties.csv` と `data/properties.truth.json` を書き出す。
 */
import fs from 'node:fs';
import path from 'node:path';
import { LAYOUTS, TAGS, type Access, type Layout, type Property, type Tag } from '../src/domain/types';
import { STATIONS, adjacentStations, findStation } from '../src/domain/stations';
import { serializePropertiesCsv } from '../src/lib/csv/properties';

export const DEFAULT_SEED = 20261007;
export const PROPERTY_COUNT = 200;
/** 成約済み（非公開）にする件数 = 5% */
export const PRIVATE_COUNT = Math.round(PROPERTY_COUNT * 0.05);
/** 築年数の基準年（築年は 1985〜2025） */
const BASE_YEAR = 2026;

export const RENT_MIN = 60000;
export const RENT_MAX = 180000;

// ---------- 決定的な乱数 ----------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mix32(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

export class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  /** min 以上 max 以下の整数 */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }
  weighted<T>(items: readonly (readonly [T, number])[]): T {
    const total = items.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [value, w] of items) {
      r -= w;
      if (r < 0) return value;
    }
    return items[items.length - 1][0];
  }
  shuffle<T>(items: readonly T[]): T[] {
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}

/** 物件ごとに独立した乱数列を使う（ある物件の処理を変えても他の物件が変わらないように） */
function rngFor(seed: number, index: number, salt: number): Rng {
  return new Rng(mix32(seed ^ mix32(Math.imul(index + 1, 7919) + Math.imul(salt, 104729))));
}
const SALT = { attrs: 1, tags: 2, rent: 3, text: 4, note: 5, fix: 6, fixRent: 7 } as const;

// ---------- 駅の人気度・出現頻度 ----------

interface StationProfile {
  /** 出現頻度（相対） */
  weight: number;
  /** 家賃の駅係数（1.0 が標準） */
  price: number;
  /** 繁華な駅（「静か」になりにくい） */
  busy?: true;
}

export const STATION_PROFILES: Record<string, StationProfile> = {
  // 山手線
  東京: { weight: 1, price: 1.25, busy: true },
  有楽町: { weight: 1, price: 1.25, busy: true },
  新橋: { weight: 2, price: 1.12, busy: true },
  浜松町: { weight: 2, price: 1.1 },
  田町: { weight: 3, price: 1.1 },
  高輪ゲートウェイ: { weight: 1, price: 1.15 },
  品川: { weight: 3, price: 1.15, busy: true },
  大崎: { weight: 3, price: 1.0 },
  五反田: { weight: 4, price: 1.05, busy: true },
  目黒: { weight: 5, price: 1.18 },
  恵比寿: { weight: 6, price: 1.3, busy: true },
  渋谷: { weight: 12, price: 1.15, busy: true },
  原宿: { weight: 3, price: 1.2, busy: true },
  代々木: { weight: 4, price: 1.1 },
  新宿: { weight: 6, price: 1.2, busy: true },
  新大久保: { weight: 4, price: 0.9, busy: true },
  高田馬場: { weight: 5, price: 0.97, busy: true },
  目白: { weight: 3, price: 1.0 },
  池袋: { weight: 5, price: 1.0, busy: true },
  大塚: { weight: 4, price: 0.85 },
  巣鴨: { weight: 4, price: 0.82 },
  駒込: { weight: 3, price: 0.85 },
  田端: { weight: 3, price: 0.8 },
  西日暮里: { weight: 3, price: 0.85 },
  日暮里: { weight: 3, price: 0.85 },
  鶯谷: { weight: 2, price: 0.8 },
  上野: { weight: 3, price: 0.9, busy: true },
  御徒町: { weight: 2, price: 0.9, busy: true },
  秋葉原: { weight: 2, price: 1.05, busy: true },
  神田: { weight: 3, price: 1.08 },
  // 中央線
  御茶ノ水: { weight: 2, price: 1.1 },
  四ツ谷: { weight: 3, price: 1.15 },
  中野: { weight: 6, price: 0.95, busy: true },
  高円寺: { weight: 6, price: 0.9 },
  阿佐ケ谷: { weight: 4, price: 0.9 },
  荻窪: { weight: 5, price: 0.88 },
  西荻窪: { weight: 4, price: 0.9 },
  吉祥寺: { weight: 6, price: 1.1, busy: true },
  三鷹: { weight: 5, price: 0.8 },
  // 東急東横線
  代官山: { weight: 7, price: 1.18 },
  中目黒: { weight: 10, price: 1.15 },
  祐天寺: { weight: 4, price: 1.1 },
  学芸大学: { weight: 5, price: 1.1 },
  都立大学: { weight: 4, price: 1.0 },
  自由が丘: { weight: 5, price: 1.15 },
  田園調布: { weight: 3, price: 1.0 },
  多摩川: { weight: 3, price: 0.85 },
  新丸子: { weight: 3, price: 0.85 },
  武蔵小杉: { weight: 6, price: 0.95, busy: true },
  元住吉: { weight: 4, price: 0.8 },
  日吉: { weight: 5, price: 0.8 },
};

// ---------- 間取りと面積 ----------

interface LayoutSpec {
  weight: number;
  areaMin: number;
  areaMax: number;
  /** 家賃の㎡単価（駅係数 1.0・築 15 年・徒歩 7 分でのおおよその値） */
  unit: number;
}

const LAYOUT_SPECS: Record<Layout, LayoutSpec> = {
  '1R': { weight: 20, areaMin: 15, areaMax: 22, unit: 3950 },
  '1K': { weight: 22, areaMin: 18, areaMax: 26, unit: 3600 },
  '1DK': { weight: 11, areaMin: 25, areaMax: 32, unit: 3400 },
  '1LDK': { weight: 17, areaMin: 30, areaMax: 45, unit: 3450 },
  '2K': { weight: 7, areaMin: 30, areaMax: 38, unit: 3000 },
  '2DK': { weight: 9, areaMin: 35, areaMax: 45, unit: 2950 },
  '2LDK': { weight: 14, areaMin: 45, areaMax: 65, unit: 2850 },
};

// ---------- 架空の町名・物件名 ----------

const TOWNS: readonly { full: string; short: string }[] = [
  { full: 'かえで町', short: 'かえで' },
  { full: 'みどり台', short: 'みどり' },
  { full: 'さくら坂', short: 'さくら' },
  { full: 'すみれ町', short: 'すみれ' },
  { full: 'ひなた町', short: 'ひなた' },
  { full: 'あおば台', short: 'あおば' },
  { full: 'つばき町', short: 'つばき' },
  { full: 'もみじ丘', short: 'もみじ' },
  { full: 'ふじみ町', short: 'ふじみ' },
  { full: 'あかね町', short: 'あかね' },
  { full: 'わかば台', short: 'わかば' },
  { full: 'せせらぎ町', short: 'せせらぎ' },
  { full: 'はなみずき町', short: 'はなみずき' },
  { full: 'こもれび台', short: 'こもれび' },
  { full: 'ひので町', short: 'ひので' },
];

const NAME_PATTERNS: readonly ((station: string, town: string) => string)[] = [
  (_s, t) => `コーポ${t}`,
  (_s, t) => `ハイツ${t}`,
  (_s, t) => `メゾン${t}`,
  (_s, t) => `ヴィラ${t}`,
  (_s, t) => `プラザ${t}`,
  (_s, t) => `${t}レジデンス`,
  (_s, t) => `${t}コート`,
  (_s, t) => `${t}テラス`,
  (_s, t) => `${t}ガーデン`,
  (_s, t) => `${t}フラット`,
  (s, t) => `${s}${t}レジデンス`,
  (s, t) => `${s}${t}コート`,
  (s) => `コーポ${s}`,
  (s) => `ハイツ${s}`,
  (s) => `${s}ハウス`,
  (s) => `${s}アパートメント`,
];
const NAME_SERIES = ['Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ', 'Ⅶ', 'Ⅷ'] as const;

// ---------- 備考の表現（表記ゆれ） ----------

type NoteTag = Exclude<Tag, '敷金なし' | '礼金なし'>;

/** 正解タグごとの表現。備考にはこの中から1つが入る（敷金なし・礼金なしは数値列で決まるので備考に書かない） */
export const TAG_PHRASES: Record<NoteTag, readonly string[]> = {
  ペット可: ['ペット可', 'ペット相談可（小型犬1匹まで）', 'ペット相談可', '小型犬・猫の飼育相談可', 'ペットと暮らせる物件', '犬猫相談可'],
  バストイレ別: ['バス・トイレ別', 'BT別', '風呂トイレ別', 'バストイレ別', 'バス・トイレ別々', 'セパレートタイプ（バス・トイレ別）'],
  オートロック: ['オートロック', 'オートロック付き', 'オートロック付きで女性にも安心', 'オートロックマンション', 'エントランスオートロック', 'オートロック完備'],
  独立洗面台: ['独立洗面台', '洗面台独立', '独立洗面化粧台', '洗面所独立', '独立洗面台付き'],
  室内洗濯機置場: ['室内洗濯機置場', '洗濯機置場室内', '室内洗濯機置き場', '洗濯機は室内に置けます', '室内に洗濯機置場あり'],
  宅配ボックス: ['宅配ボックス', '宅配BOX', '宅配ボックス付き', '宅配ボックスあり', '宅配便ボックス完備'],
  エアコン: ['エアコン', 'エアコン付き', 'エアコン完備', '冷暖房エアコン設置済み', 'エアコン1台付'],
  フローリング: ['フローリング', 'フローリング張り', '床はフローリング', 'フローリング仕様', '洋室はフローリング'],
  角部屋: ['角部屋', '角部屋で開放感あり', '角住戸', '角部屋・2面採光'],
  南向き: ['南向き', '南向きバルコニー', '南面バルコニー', '主要採光面は南向き', '南向きの明るいお部屋'],
  日当たり良好: ['日当たり良好', '陽当たり良好', '日当り良好', '日当たり抜群', '陽当り良好', '日差したっぷりの明るい室内'],
  静か: ['周辺は静か', '閑静な住宅街', '静かな環境', '落ち着いた住環境', '閑静な立地', '静かな住宅地にあります'],
  駐輪場: ['駐輪場', '駐輪場あり', '敷地内駐輪場', '駐輪場完備', '自転車置場あり'],
  '2人入居可': ['2人入居可', '二人入居可', 'ふたり入居可', '2名入居可', '二人暮らしOK', 'カップル・ご夫婦の2人入居も可'],
  楽器相談可: ['楽器相談可', '楽器相談OK', '楽器演奏は相談可（時間帯制限あり）', '楽器可（要相談）'],
};

/** タグに無い・タグと紛らわしい記述（正解には含めない） */
export const DECOYS: readonly { phrase: string; p: number; applies: (d: DecoyContext) => boolean }[] = [
  { phrase: 'ペット不可', p: 0.3, applies: (d) => !d.has('ペット可') },
  { phrase: '1階につき日当たりは控えめ', p: 0.7, applies: (d) => d.floor === 1 && !d.has('日当たり良好') },
  { phrase: '北向きのため日当たりは控えめ', p: 0.4, applies: (d) => d.facing === '北' && !d.has('日当たり良好') },
  { phrase: '東向き', p: 0.3, applies: (d) => d.facing === '東' && !d.has('南向き') },
  { phrase: '西向き', p: 0.3, applies: (d) => d.facing === '西' && !d.has('南向き') },
  { phrase: 'バス・トイレ一体型（ユニットバス）', p: 0.5, applies: (d) => !d.has('バストイレ別') },
  { phrase: '洗濯機置場はベランダ', p: 0.4, applies: (d) => !d.has('室内洗濯機置場') },
  { phrase: 'エアコンなし（設置可）', p: 0.4, applies: (d) => !d.has('エアコン') },
  { phrase: 'オートロックなし', p: 0.1, applies: (d) => !d.has('オートロック') },
  { phrase: '宅配ボックスなし', p: 0.1, applies: (d) => !d.has('宅配ボックス') },
  { phrase: '楽器不可', p: 0.18, applies: (d) => !d.has('楽器相談可') },
  { phrase: '駐輪場なし', p: 0.1, applies: (d) => !d.has('駐輪場') },
  { phrase: '単身者向け', p: 0.3, applies: (d) => !d.has('2人入居可') && (d.layout === '1R' || d.layout === '1K') },
  { phrase: '駅前の賑やかなエリア', p: 0.4, applies: (d) => !d.has('静か') && d.busyStation },
  { phrase: '大通り沿いのため交通量あり', p: 0.2, applies: (d) => !d.has('静か') },
];

interface DecoyContext {
  has: (tag: Tag) => boolean;
  floor: number;
  facing: Facing;
  layout: Layout;
  busyStation: boolean;
}

/** タグと無関係な、ありふれた備考 */
const NEUTRAL_PHRASES: readonly string[] = [
  'スーパー・ドラッグストアが徒歩圏内',
  'コンビニまで徒歩3分',
  'ゴミ出し24時間可',
  'インターネット無料',
  '都市ガス',
  'システムキッチン',
  'リフォーム済み',
  '駅までの道は平坦',
  '管理人日勤',
  '内見随時可',
  'ガスコンロ設置可',
  '周辺に飲食店多数',
  'IHコンロ',
  '収納スペースあり',
  'クローゼット付き',
];

// ---------- 下書き ----------

type Facing = '南' | '東' | '西' | '北';

interface Draft {
  index: number;
  access: Access[];
  layout: Layout;
  areaSqm: number;
  floor: number;
  builtYear: number;
  facing: Facing;
  corner: boolean;
  depositMonths: number;
  keyMoneyMonths: number;
  availableFrom: string | null;
  status: 'public' | 'private';
  tags: Set<Tag>;
  rent: number;
  managementFee: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round1 = (x: number) => Math.round(x * 10) / 10;

function nearest(d: Pick<Draft, 'access'>): string {
  return d.access[0].station;
}

function isBusy(station: string): boolean {
  return STATION_PROFILES[station]?.busy === true;
}

/** 属性（駅・間取り・面積・築年・階・向き・徒歩・敷礼・入居可能日）を決める */
function draftAttributes(seed: number, index: number): Draft {
  const rng = rngFor(seed, index, SALT.attrs);

  const station = rng.weighted(STATIONS.map((s) => [s.name, STATION_PROFILES[s.name].weight] as const));
  const walk1 = rng.weighted([
    [1, 2], [2, 4], [3, 7], [4, 9], [5, 11], [6, 11], [7, 11], [8, 10],
    [9, 8], [10, 8], [11, 4], [12, 5], [13, 2], [14, 2], [15, 3],
  ] as const);
  const access: Access[] = [{ station, walkMin: walk1 }];
  if (rng.chance(0.4)) {
    const second = rng.pick(adjacentStations(station));
    access.push({ station: second, walkMin: Math.min(walk1 + rng.int(3, 9), 22) });
  }

  const layout = rng.weighted(LAYOUTS.map((l) => [l, LAYOUT_SPECS[l].weight] as const));
  const spec = LAYOUT_SPECS[layout];
  const areaSqm = round1(spec.areaMin + ((rng.float() + rng.float()) / 2) * (spec.areaMax - spec.areaMin));

  const builtYear = rng.chance(0.25) ? rng.int(2015, 2025) : 1985 + Math.round(((rng.float() + rng.float()) / 2) * 40);
  const age = BASE_YEAR - builtYear;
  const maxFloor = age >= 35 ? 5 : age >= 25 ? 7 : age >= 15 ? 10 : 12;
  const floor = Math.min(maxFloor, 1 + Math.floor(Math.pow(rng.float(), 1.3) * maxFloor));

  const facing = rng.weighted([['南', 32], ['東', 24], ['西', 24], ['北', 20]] as const);
  const corner = rng.chance(0.2);

  const depositMonths = rng.weighted([[0, 34], [0.5, 4], [1, 44], [2, 18]] as const);
  const keyMoneyMonths = rng.weighted([[0, 40], [0.5, 3], [1, 44], [2, 13]] as const);

  let availableFrom: string | null = null;
  if (rng.chance(0.4)) {
    const month = rng.weighted([['2026-10', 3], ['2026-11', 3], ['2026-12', 2], ['2027-01', 2]] as const);
    const day = month === '2026-10' ? rng.pick([10, 15, 20, 25]) : rng.pick([1, 10, 15, 20, 25]);
    availableFrom = `${month}-${String(day).padStart(2, '0')}`;
  }

  return {
    index,
    access,
    layout,
    areaSqm,
    floor,
    builtYear,
    facing,
    corner,
    depositMonths,
    keyMoneyMonths,
    availableFrom,
    status: 'public',
    tags: new Set(),
    rent: 0,
    managementFee: 0,
  };
}

/** 属性から正解タグを決める（確率つき。相関は「新しめ・大きめはオートロック」など） */
function assignTags(seed: number, d: Draft): void {
  const rng = rngFor(seed, d.index, SALT.tags);
  const L = d.layout;
  const walk = d.access[0].walkMin;
  const busy = isBusy(nearest(d));
  const built = d.builtYear;
  const add = (tag: Tag, p: number) => {
    if (rng.chance(clamp(p, 0, 1))) d.tags.add(tag);
  };

  add('ペット可', { '1R': 0.08, '1K': 0.1, '1DK': 0.16, '1LDK': 0.23, '2K': 0.2, '2DK': 0.23, '2LDK': 0.28 }[L]);

  add('バストイレ別', L === '1R' ? 0.12 : L === '1K' ? (built >= 2005 ? 0.75 : 0.4) : built >= 2000 ? 0.95 : 0.85);

  let autolock = built >= 2015 ? 0.78 : built >= 2008 ? 0.6 : built >= 2000 ? 0.35 : built >= 1992 ? 0.15 : 0.05;
  if (d.areaSqm >= 40) autolock += 0.1;
  if (d.floor === 1) autolock *= 0.85;
  add('オートロック', autolock);

  add('独立洗面台', L === '1R' ? 0.04 : L === '1K' ? 0.22 : built >= 2005 ? 0.65 : 0.3);
  add('室内洗濯機置場', L === '1R' ? 0.8 : built >= 2000 ? 0.93 : 0.78);
  add('宅配ボックス', (built >= 2012 ? 0.6 : built >= 2000 ? 0.25 : 0.06) + (d.tags.has('オートロック') ? 0.1 : 0));
  add('エアコン', built >= 2005 ? 0.9 : built >= 1995 ? 0.7 : 0.45);
  add('フローリング', built >= 2005 ? 0.9 : built >= 1995 ? 0.65 : 0.4);
  if (d.corner) d.tags.add('角部屋');
  if (d.facing === '南') d.tags.add('南向き');

  // 日当たり良好: 南向き・高層に多い
  if (d.facing === '南') add('日当たり良好', d.floor >= 3 ? 0.85 : d.floor === 2 ? 0.6 : 0.3);
  else if (d.facing === '北') add('日当たり良好', d.floor >= 8 ? 0.1 : 0.03);
  else add('日当たり良好', d.floor >= 6 ? 0.45 : d.floor >= 3 ? 0.2 : 0.05);

  // 静か: 駅から 7 分以上で、繁華な駅以外に多い
  add('静か', busy ? 0.04 : walk >= 7 ? 0.5 : walk >= 5 ? 0.2 : 0.08);

  add('駐輪場', busy ? 0.3 : d.areaSqm >= 25 || built >= 2005 ? 0.6 : 0.45);
  add('2人入居可', { '1R': 0.04, '1K': 0.1, '1DK': 0.4, '1LDK': 0.75, '2K': 0.65, '2DK': 0.8, '2LDK': 0.9 }[L]);

  let instrument = 0.05;
  if (d.floor <= 2) instrument *= 2;
  if (built < 2000) instrument *= 1.2;
  if (L === '1LDK' || L === '2K' || L === '2DK' || L === '2LDK') instrument *= 1.5;
  add('楽器相談可', instrument);

  // 敷金なし・礼金なしは数値列から決まる
  if (d.depositMonths === 0) d.tags.add('敷金なし');
  if (d.keyMoneyMonths === 0) d.tags.add('礼金なし');
}

function walkFactor(walk: number): number {
  if (walk <= 3) return 1.05;
  if (walk <= 5) return 1.02;
  if (walk <= 8) return 1.0;
  if (walk <= 11) return 0.96;
  if (walk <= 15) return 0.92;
  return 0.88;
}

/** 下限・上限に張り付かないよう、端を滑らかに丸める */
function softClamp(x: number): number {
  const lowKnee = RENT_MIN + 10000;
  const highKnee = RENT_MAX - 40000;
  if (x < lowKnee) return RENT_MIN + 10000 * Math.exp((x - lowKnee) / 10000);
  if (x > highKnee) return RENT_MAX - 40000 * Math.exp(-(x - highKnee) / 40000);
  return x;
}

/** 家賃・管理費を決める。駅の人気度 × 面積 × 徒歩 × 築年（＋設備の小さな上乗せ） */
function assignPrices(seed: number, d: Draft): void {
  const rng = rngFor(seed, d.index, SALT.rent);
  const age = BASE_YEAR - d.builtYear;
  const ageFactor = Math.max(0.78, 1.1 - 0.0115 * age);
  const price = STATION_PROFILES[nearest(d)].price;

  let premium = 0;
  if (d.tags.has('バストイレ別')) premium += 0.03;
  if (d.tags.has('オートロック')) premium += 0.03;
  if (d.tags.has('独立洗面台')) premium += 0.02;
  if (d.tags.has('宅配ボックス')) premium += 0.01;
  if (d.corner) premium += 0.02;
  if (d.floor >= 10) premium += 0.04;
  else if (d.floor >= 6) premium += 0.03;
  else if (d.floor >= 3) premium += 0.015;
  else if (d.floor === 1) premium -= 0.02;

  const noise = 0.94 + rng.float() * 0.12;
  const raw =
    d.areaSqm * LAYOUT_SPECS[d.layout].unit * price * walkFactor(d.access[0].walkMin) * ageFactor * (1 + premium) * noise;
  d.rent = clamp(Math.round(softClamp(raw) / 1000) * 1000, RENT_MIN, RENT_MAX);

  const fee =
    d.areaSqm * 110 +
    (d.tags.has('オートロック') ? 2500 : 0) +
    (age < 15 ? 1500 : 0) +
    (rng.float() - 0.5) * 3000;
  d.managementFee = rng.chance(0.08) ? 0 : clamp(Math.round(fee / 1000) * 1000, 0, 15000);
}

// ---------- デモ用の偏り（DESIGN.md 10.1） ----------

export const DEMO_STATIONS = ['渋谷', '中目黒', '代官山'] as const;
/** 予算 9 万円（家賃＋管理費） */
export const DEMO_BUDGET = 90000;
/** 全条件 AND（バストイレ別・オートロック・静か）では 0 件になり、オートロックを外すと増える件数 */
export const DEMO_GAIN = 7;
/** 渋谷・中目黒・代官山 × 予算 9 万に収まる公開物件の最低件数（足りなければ家賃が近い物件を少し下げる） */
const DEMO_MIN_CANDIDATES = 12;

type DemoView = Pick<Draft, 'access' | 'rent' | 'managementFee' | 'status'>;

function inDemoArea(p: Pick<Draft, 'access'>): boolean {
  return p.access.some((a) => (DEMO_STATIONS as readonly string[]).includes(a.station));
}

function inDemoBudget(p: DemoView): boolean {
  return p.rent + p.managementFee <= DEMO_BUDGET;
}

function setNearestWalk(seed: number, d: Draft, minWalk: number): void {
  if (d.access[0].walkMin >= minWalk) return;
  const rng = rngFor(seed, d.index, SALT.fix);
  d.access[0].walkMin = rng.int(minWalk, minWalk + 4);
  if (d.access[1] && d.access[1].walkMin <= d.access[0].walkMin) {
    d.access[1].walkMin = Math.min(d.access[0].walkMin + rng.int(3, 6), 25);
  }
}

/**
 * 渋谷・中目黒・代官山 × 予算 9 万 × 公開 の物件の中で、
 * 「バストイレ別・静か」が DEMO_GAIN 件・そのうちオートロックは 0 件になるよう、タグ（と静かの徒歩分）を調整する。
 * バストイレ別でオートロックの物件は無いので、静かを must から外しても件数は変わらない。
 */
function shapeDemoScenario(seed: number, drafts: Draft[]): void {
  const inScope = drafts.filter((d) => d.status === 'public' && inDemoArea(d));

  // 0. 予算内の候補が少なければ、予算を少し超えている小さめの物件の家賃を予算内に下げる（上げ幅の小さい順）
  const overBudget = inScope
    .filter((d) => !inDemoBudget(d) && (d.layout === '1R' || d.layout === '1K' || d.layout === '1DK'))
    .sort((a, b) => a.rent + a.managementFee - (b.rent + b.managementFee) || a.index - b.index);
  let within = inScope.filter(inDemoBudget).length;
  for (const d of overBudget) {
    if (within >= DEMO_MIN_CANDIDATES) break;
    const rng = rngFor(seed, d.index, SALT.fixRent);
    const rent = Math.round((DEMO_BUDGET - rng.int(0, 5) * 1000 - d.managementFee) / 1000) * 1000;
    if (rent < RENT_MIN) continue;
    d.rent = rent;
    within++;
  }

  const cands = inScope.filter(inDemoBudget);

  // 1. バストイレ別とオートロックの同居をなくす（新しい建物はバストイレ別を残す）
  for (const d of cands) {
    if (d.tags.has('バストイレ別') && d.tags.has('オートロック')) {
      d.tags.delete(d.builtYear >= 2008 ? 'バストイレ別' : 'オートロック');
    }
  }

  // 2. バストイレ別の候補が足りなければ、バストイレ別でない候補から（1R 以外を優先して）昇格する
  const sortBt = () =>
    cands
      .filter((d) => d.tags.has('バストイレ別'))
      .sort((a, b) => Number(b.tags.has('静か')) - Number(a.tags.has('静か')) || a.index - b.index);
  let bt = sortBt();
  if (bt.length < DEMO_GAIN) {
    const pool = cands
      .filter((d) => !d.tags.has('バストイレ別'))
      .sort(
        (a, b) =>
          Number(a.tags.has('オートロック')) - Number(b.tags.has('オートロック')) ||
          Number(a.layout === '1R') - Number(b.layout === '1R') ||
          a.index - b.index,
      );
    for (const d of pool) {
      if (bt.length >= DEMO_GAIN) break;
      d.tags.add('バストイレ別');
      d.tags.delete('オートロック');
      bt = sortBt();
    }
  }
  if (bt.length < DEMO_GAIN) {
    throw new Error(`デモ用の候補が足りません（${bt.length} 件 < ${DEMO_GAIN} 件）。駅の出現頻度か家賃モデルを見直してください`);
  }

  // 3. 先頭の DEMO_GAIN 件を「バストイレ別・静か・オートロックなし」にそろえる
  const chosen = bt.slice(0, DEMO_GAIN);
  const rest = bt.slice(DEMO_GAIN);
  for (const d of chosen) {
    d.tags.add('静か');
    d.tags.delete('オートロック');
    setNearestWalk(seed, d, 7);
  }
  // 4. 余りのバストイレ別は1件だけ「静かでない」物件として残し、それ以外はバストイレ別を外す
  rest.forEach((d, i) => {
    if (i === 0) d.tags.delete('静か');
    else d.tags.delete('バストイレ別');
  });

  // 5. 成約済み（非公開）の物件を1件、同じ条件に合う形にしておく（公開物件だけが検索対象であることをデモで示せる）
  const closed = drafts
    .filter((d) => d.status === 'private' && inDemoArea(d) && (d.layout === '1R' || d.layout === '1K' || d.layout === '1DK'))
    .sort((a, b) => a.rent + a.managementFee - (b.rent + b.managementFee) || a.index - b.index)[0];
  if (closed) {
    const rng = rngFor(seed, closed.index, SALT.fixRent);
    const rent = Math.round((DEMO_BUDGET - rng.int(2, 8) * 1000 - closed.managementFee) / 1000) * 1000;
    closed.rent = Math.max(RENT_MIN, rent);
    closed.tags.add('バストイレ別');
    closed.tags.add('静か');
    closed.tags.delete('オートロック');
    setNearestWalk(seed, closed, 7);
  }
}

export interface DemoCounts {
  /** エリア・予算を満たす公開物件 */
  base: number;
  /** バストイレ別・オートロック・静か（全条件 AND） */
  allAnd: number;
  /** オートロックを外す（バストイレ別・静か） */
  withoutAutolock: number;
  /** 静かを外す（バストイレ別・オートロック） */
  withoutQuiet: number;
  /** バストイレ別を外す（オートロック・静か） */
  withoutBathSeparate: number;
  /** 予算を外す（エリア内の公開物件で バストイレ別・オートロック・静か） */
  withoutBudget: number;
  /** 静かを want にした場合の must（バストイレ別・オートロック） と、オートロックを外した件数（バストイレ別） */
  mustOnlyAllAnd: number;
  mustOnlyWithoutAutolock: number;
  /** 成約済み（非公開）でオートロック以外の条件に合う物件（検索に出てはいけない） */
  closedMatches: number;
}

export function demoScenarioCounts(properties: readonly Property[]): DemoCounts {
  const inArea = properties.filter((p) => p.status === 'public' && inDemoArea(p));
  const base = inArea.filter(inDemoBudget);
  const all = (list: readonly Property[], tags: readonly Tag[]) =>
    list.filter((p) => tags.every((t) => p.tags.includes(t))).length;
  return {
    base: base.length,
    allAnd: all(base, ['バストイレ別', 'オートロック', '静か']),
    withoutAutolock: all(base, ['バストイレ別', '静か']),
    withoutQuiet: all(base, ['バストイレ別', 'オートロック']),
    withoutBathSeparate: all(base, ['オートロック', '静か']),
    withoutBudget: all(inArea, ['バストイレ別', 'オートロック', '静か']),
    mustOnlyAllAnd: all(base, ['バストイレ別', 'オートロック']),
    mustOnlyWithoutAutolock: all(base, ['バストイレ別']),
    closedMatches: all(
      properties.filter((p) => p.status === 'private' && inDemoArea(p) && inDemoBudget(p)),
      ['バストイレ別', '静か'],
    ),
  };
}

// ---------- 備考・名前・住所 ----------

function sortTags(tags: ReadonlySet<Tag>): Tag[] {
  return TAGS.filter((t) => tags.has(t));
}

function buildNote(seed: number, d: Draft): string {
  const rng = rngFor(seed, d.index, SALT.note);
  const ctx: DecoyContext = {
    has: (tag) => d.tags.has(tag),
    floor: d.floor,
    facing: d.facing,
    layout: d.layout,
    busyStation: isBusy(nearest(d)),
  };

  const items: string[] = [];
  for (const tag of sortTags(d.tags)) {
    if (tag === '敷金なし' || tag === '礼金なし') continue;
    items.push(rng.pick(TAG_PHRASES[tag]));
  }
  let decoys = 0;
  for (const decoy of DECOYS) {
    if (decoys < 2 && decoy.applies(ctx) && rng.chance(decoy.p)) {
      items.push(decoy.phrase);
      decoys++;
    }
  }
  const neutralCount = rng.weighted([[0, 25], [1, 45], [2, 30]] as const);
  items.push(...rng.shuffle(NEUTRAL_PHRASES).slice(0, neutralCount));
  if (items.length === 0) return '';

  const shuffled = rng.shuffle(items);
  switch (rng.int(0, 4)) {
    case 0:
      return `${shuffled.join('、')}。`;
    case 1:
      return shuffled.join('／');
    case 2:
      return shuffled.map((x) => `${x}。`).join('');
    case 3:
      return `【${rng.pick(['特徴', '設備・条件', 'おすすめポイント'])}】${shuffled.join('、')}`;
    default: {
      const [head, ...tail] = shuffled;
      return tail.length === 0 ? `${head}。` : `${head}。${tail.join('、')}。`;
    }
  }
}

function buildNameAndAddress(
  seed: number,
  d: Draft,
  usedNames: Set<string>,
  usedAddresses: Set<string>,
): { name: string; address: string; ward: string } {
  const rng = rngFor(seed, d.index, SALT.text);
  const station = nearest(d);
  const ward = findStation(station)!.ward;
  const town = rng.pick(TOWNS);

  let name = rng.pick(NAME_PATTERNS)(station, town.short);
  if (usedNames.has(name)) {
    const series = NAME_SERIES.map((s) => `${name}${s}`).find((n) => !usedNames.has(n));
    name = series ?? `${name}${d.index + 1}号館`;
  }
  usedNames.add(name);

  let address = '';
  do {
    address = `${ward}${town.full}${rng.int(1, 6)}-${rng.int(1, 30)}`;
  } while (usedAddresses.has(address));
  usedAddresses.add(address);

  return { name, address, ward };
}

// ---------- 生成 ----------

export interface GeneratedData {
  properties: Property[];
  /** タグ抽出の評価用の正解（`properties` の `tags` と同じ内容） */
  truth: { id: string; tags: Tag[] }[];
}

export function generateProperties(seed: number = DEFAULT_SEED, count: number = PROPERTY_COUNT): GeneratedData {
  const drafts: Draft[] = [];
  for (let i = 0; i < count; i++) {
    const d = draftAttributes(seed, i);
    assignTags(seed, d);
    assignPrices(seed, d);
    drafts.push(d);
  }

  // 成約済み（非公開）は件数を固定して無作為に選ぶ（count に対して 5%）
  const privateCount = Math.round(count * 0.05);
  const shuffled = new Rng(mix32(seed ^ 0x5eed)).shuffle(drafts.map((d) => d.index));
  for (const index of shuffled.slice(0, privateCount)) drafts[index].status = 'private';

  shapeDemoScenario(seed, drafts);

  const usedNames = new Set<string>();
  const usedAddresses = new Set<string>();
  const properties: Property[] = drafts.map((d) => {
    const { name, address, ward } = buildNameAndAddress(seed, d, usedNames, usedAddresses);
    return {
      id: `P${String(d.index + 1).padStart(4, '0')}`,
      name,
      address,
      ward,
      access: d.access,
      rent: d.rent,
      managementFee: d.managementFee,
      depositMonths: d.depositMonths,
      keyMoneyMonths: d.keyMoneyMonths,
      layout: d.layout,
      areaSqm: d.areaSqm,
      floor: d.floor,
      builtYear: d.builtYear,
      tags: sortTags(d.tags),
      note: buildNote(seed, d),
      availableFrom: d.availableFrom,
      status: d.status,
    };
  });

  return { properties, truth: properties.map((p) => ({ id: p.id, tags: [...p.tags] })) };
}

// ---------- 分布の要約 ----------

export function summarize(properties: readonly Property[]): string {
  const lines: string[] = [];
  const total = properties.length;

  const byLayout = LAYOUTS.map((l) => `${l}:${properties.filter((p) => p.layout === l).length}`);
  lines.push(`物件数: ${total}（公開 ${properties.filter((p) => p.status === 'public').length} / 非公開 ${properties.filter((p) => p.status === 'private').length}）`);
  lines.push(`間取り別: ${byLayout.join('  ')}`);

  const bands: [string, number, number][] = [
    ['6〜8万', 60000, 80000],
    ['8〜10万', 80000, 100000],
    ['10〜12万', 100000, 120000],
    ['12〜14万', 120000, 140000],
    ['14〜16万', 140000, 160000],
    ['16〜18万', 160000, 180001],
  ];
  lines.push(
    `家賃帯別: ${bands.map(([label, lo, hi]) => `${label}:${properties.filter((p) => p.rent >= lo && p.rent < hi).length}`).join('  ')}`,
  );
  const rents = properties.map((p) => p.rent);
  lines.push(`家賃: 最小 ${Math.min(...rents)} / 最大 ${Math.max(...rents)} / 平均 ${Math.round(rents.reduce((s, x) => s + x, 0) / total)}`);

  const byStation = new Map<string, number>();
  for (const p of properties) byStation.set(p.access[0].station, (byStation.get(p.access[0].station) ?? 0) + 1);
  const stationList = [...byStation.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'));
  lines.push(`駅別件数（最寄り・${byStation.size}/${STATIONS.length} 駅）: ${stationList.map(([s, n]) => `${s}:${n}`).join('  ')}`);

  const tagCounts = TAGS.map((t) => `${t}:${properties.filter((p) => p.tags.includes(t)).length}`);
  lines.push(`正解タグ件数: ${tagCounts.join('  ')}`);

  const c = demoScenarioCounts(properties);
  lines.push(
    `デモ（渋谷・中目黒・代官山 / 予算${DEMO_BUDGET / 10000}万=家賃+管理費 / バストイレ別 / オートロック / 静か）:`,
    `  エリア+予算の公開物件 ${c.base} 件`,
    `  全条件AND ${c.allAnd} 件 → オートロックを外す ${c.withoutAutolock} 件（+${c.withoutAutolock - c.allAnd}）`,
    `  他の条件を外した場合: 静かを外す ${c.withoutQuiet} 件（+${c.withoutQuiet - c.allAnd}）/ バストイレ別を外す ${c.withoutBathSeparate} 件（+${c.withoutBathSeparate - c.allAnd}）/ 予算を外す ${c.withoutBudget} 件（+${c.withoutBudget - c.allAnd}）`,
    `  静かを want にした場合の must（バストイレ別・オートロック）: ${c.mustOnlyAllAnd} 件 → オートロックを外す ${c.mustOnlyWithoutAutolock} 件（+${c.mustOnlyWithoutAutolock - c.mustOnlyAllAnd}）`,
    `  成約済み（非公開）でオートロック以外の条件に合う物件 ${c.closedMatches} 件（検索に出てはいけない）`,
  );
  return lines.join('\n');
}

// ---------- 実行 ----------

/** 1 物件 1 行の JSON 配列（差分が読みやすい） */
export function serializeTruth(truth: readonly { id: string; tags: readonly Tag[] }[]): string {
  return `[\n${truth.map((t) => `  ${JSON.stringify(t)}`).join(',\n')}\n]\n`;
}

export function main(rootDir: string): void {
  const { properties, truth } = generateProperties();

  const counts = demoScenarioCounts(properties);
  if (counts.allAnd > 1 || counts.withoutAutolock - counts.allAnd < 5 || counts.withoutAutolock - counts.allAnd > 8) {
    throw new Error(`デモ用の偏りが狙いから外れています: ${JSON.stringify(counts)}`);
  }

  const dataDir = path.join(rootDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'properties.csv'), serializePropertiesCsv(properties), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'properties.truth.json'), serializeTruth(truth), 'utf8');

  console.log(`data/properties.csv と data/properties.truth.json を書き出しました（${properties.length} 件）`);
  console.log(summarize(properties));
}

/** `tsx scripts/generate-properties.ts` で直接動かしたときだけ書き出す（テストから import したときは動かさない） */
const entry = process.argv[1] ?? '';
if (/(^|[\\/])generate-properties\.(ts|js|mjs|cjs)$/.test(entry)) {
  main(path.resolve(path.dirname(entry), '..'));
}
