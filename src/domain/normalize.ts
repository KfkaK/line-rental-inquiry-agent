/**
 * 表記ゆれの正規化（DESIGN.md 3.2）。LLM の前段（preNormalize）と後段（canonicalizeOps）に置く純関数。
 *
 * - 純関数: `Date.now()` / `new Date()`（引数なし）は呼ばない。現在時刻は引数 `now`。日付は JST で解釈する
 * - 抽出精度はモデルよりここで決まることが多い（DESIGN.md 3.2）。辞書は足しやすいようデータとして上に並べる
 * - 辞書の検出結果（hints）は LLM に添える「候補」。LLM は発話の文脈で採否を決める
 */
import { CLAMP, NEAR_STATION_WALK_MIN, RENT_IN_MAN_UP_TO, TIMEZONE_OFFSET_MINUTES, WALK_NO_PREFERENCE_MIN } from './rules';
import { STATIONS, WARDS } from './stations';
import {
  LAYOUTS,
  PRIORITIES,
  SCALAR_SLOT_KEYS,
  TAGS,
  type AreaValue,
  type ExtractionResult,
  type Layout,
  type Priority,
  type ScalarSlotKey,
  type SlotOp,
  type Tag,
} from './types';

// 値の範囲（CLAMP）と「万」単位の閾値は rules.ts に置く（不変条件 6）
export { CLAMP };

// ---------- 文字の正規化 ----------

const ZERO_WIDTH_RE = /[​-‍⁠﻿]/g;
/** ハイフン・ダッシュ類（長音「ー」U+30FC は含めない） */
const DASH_LIKE_RE = /[‐-―−﹣]/g;
/** 波ダッシュ類。範囲表現「6〜8万」を '~' に揃える */
const WAVE_LIKE_RE = /[〜〰∼～]/g;

const KANJI_DIGITS: Record<string, number> = {
  〇: 0,
  零: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
const KANJI_SMALL_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const KANJI_NUM_RUN_RE = /[〇零一二三四五六七八九十百千万]+/g;
const KANJI_POSITIONAL_RE = /^[〇零一二三四五六七八九]+$/;

/** 万未満の漢数字（〜9999）。「千五百」「二十」「二〇二六」 */
function kanjiBelowMan(s: string): number | undefined {
  if (s === '') return 0;
  if (KANJI_POSITIONAL_RE.test(s)) return Number([...s].map((c) => KANJI_DIGITS[c]).join(''));
  let total = 0;
  let pending: number | undefined;
  for (const ch of s) {
    if (ch in KANJI_DIGITS) {
      if (pending !== undefined) return undefined;
      pending = KANJI_DIGITS[ch];
    } else if (ch in KANJI_SMALL_UNITS) {
      total += (pending ?? 1) * KANJI_SMALL_UNITS[ch];
      pending = undefined;
    } else {
      return undefined;
    }
  }
  return total + (pending ?? 0);
}

function kanjiToInt(run: string): number | undefined {
  const manAt = run.indexOf('万');
  if (manAt === 0) return undefined;
  if (manAt < 0) return kanjiBelowMan(run);
  if (run.indexOf('万', manAt + 1) >= 0) return undefined;
  const head = kanjiBelowMan(run.slice(0, manAt));
  const tail = kanjiBelowMan(run.slice(manAt + 1));
  if (head === undefined || tail === undefined) return undefined;
  return head * 10_000 + tail;
}

/** 万を含む金額の表記。75000 → '7万5000'、70000 → '7万' */
function formatMan(n: number): string {
  if (n % 10_000 === 0) return `${n / 10_000}万`;
  if (n > 10_000) return `${Math.floor(n / 10_000)}万${n % 10_000}`;
  return String(n);
}

const KANJI_UNIT_AFTER_RE = /^(?:円|階|畳|帖|年|月|日|人|名|件|室|部屋|平米|㎡|ヶ月|か月|カ月|ケ月|ヵ月)/;
const WALK_BEFORE_RE = /(?:徒歩|歩|から|まで)\s*(?:約)?$/;
const WALK_AFTER_RE = /^分(?:以内|圏内|以下|ほど|くらい|ぐらい|程度)/;

/** 「一緒」「千代田」「十分満足」のような普通の語を数字にしないため、単位が続くときだけ変換する */
function shouldConvertKanjiRun(run: string, before: string, after: string): boolean {
  if (run.startsWith('万')) return false;
  if (run.includes('万')) return true;
  if (after.startsWith('分')) return WALK_BEFORE_RE.test(before) || WALK_AFTER_RE.test(after);
  return KANJI_UNIT_AFTER_RE.test(after);
}

function convertKanjiNumbers(s: string): string {
  return s.replace(KANJI_NUM_RUN_RE, (run: string, offset: number) => {
    const before = s.slice(0, offset);
    const after = s.slice(offset + run.length);
    if (/\d$/.test(before)) {
      // 算用数字のあとの漢数字は単位（「5千円」「7万5千円」）。「7万五千円」は万のあとの五千だけ直す
      const tail = run.startsWith('万') && run.length > 1 ? kanjiBelowMan(run.slice(1)) : undefined;
      return tail === undefined ? run : `万${tail}`;
    }
    if (!shouldConvertKanjiRun(run, before, after)) return run;
    const n = kanjiToInt(run);
    if (n === undefined) return run;
    return run.includes('万') ? formatMan(n) : String(n);
  });
}

/**
 * 発話の文字を揃える: 全角英数・記号 → 半角（NFKC）、全角スペース → 半角、波ダッシュ類 → '~'、
 * ハイフン類 → '-'、ゼロ幅文字の除去、空白の圧縮、単位つきの漢数字（七万・二階・三千円）→ 算用数字。
 * 大文字小文字は変えない。
 */
export function normalizeText(input: string): string {
  let s = input.normalize('NFKC');
  s = s.replace(ZERO_WIDTH_RE, '').replace(DASH_LIKE_RE, '-').replace(WAVE_LIKE_RE, '~');
  s = convertKanjiNumbers(s);
  return s.replace(/\s+/g, ' ').trim();
}

/** カタカナ → ひらがな（長音「ー」はそのまま。1文字対1文字なので位置が保たれる） */
function toHiragana(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

// ---------- JST の日付 ----------

export interface JstParts {
  year: number;
  /** 1〜12 */
  month: number;
  day: number;
  /** 0=日 … 6=土 */
  weekday: number;
  hour: number;
  minute: number;
}

/** `now` を JST の年月日・曜日・時刻に分解する（Vercel は UTC で動くので必ずここを通す） */
export function jstParts(now: Date): JstParts {
  const d = new Date(now.getTime() + TIMEZONE_OFFSET_MINUTES * 60_000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: d.getUTCDay(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

function formatYearMonth(year: number, month: number): string {
  return `${year}-${pad2(month)}`;
}

function addMonths(year: number, month: number, n: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + n;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

// ---------- 金額 ----------

const NUM = String.raw`\d+(?:,\d{3})*(?:\.\d+)?`;
/**
 * 金額の表現。1: 万の数 / 2: 万の後ろの「n千」/ 3: 万の後ろの4桁 / 4: 万の後ろの1桁（「7万5」= 7万5千）/
 * 5: 「n千円」/ 6: 「n円」
 */
const YEN_RE = new RegExp(
  `(?<![\\d.])(?:(${NUM})\\s*万(?:(\\d{1,4})千|(\\d{4})(?!\\d)|(\\d)(?![\\d階分人件年月日畳帖A-Za-z]))?\\s*円?|(${NUM})\\s*千\\s*円?|(${NUM})\\s*円)`,
  'g',
);
/** 5〜7桁の裸の数字（「75000以内」）。年・間取り・面積に付く数字は除く */
const BARE_YEN_RE = /(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d{5,7})(?![\d,]|\.\d|\s*[年月日分階号番人件㎡畳帖駅歩%LDKRldkr])/g;

const toNumber = (s: string): number => Number(s.replace(/,/g, ''));

interface YenHit {
  index: number;
  end: number;
  yen: number;
}

/** 金額表現を出現順に集める（t は normalizeText 済み） */
function collectYen(t: string, allowBare: boolean): YenHit[] {
  const hits: YenHit[] = [];
  for (const m of t.matchAll(YEN_RE)) {
    let yen: number;
    if (m[1] !== undefined) {
      yen = toNumber(m[1]) * 10_000;
      if (m[2] !== undefined) yen += Number(m[2]) * 1000;
      else if (m[3] !== undefined) yen += Number(m[3]);
      else if (m[4] !== undefined) yen += Number(m[4]) * 1000;
    } else if (m[5] !== undefined) {
      yen = toNumber(m[5]) * 1000;
    } else {
      yen = toNumber(m[6]);
    }
    const index = m.index ?? 0;
    hits.push({ index, end: index + m[0].length, yen: Math.round(yen) });
  }
  if (allowBare) {
    const withUnit = hits.slice();
    for (const m of t.matchAll(BARE_YEN_RE)) {
      const index = m.index ?? 0;
      if (withUnit.some((h) => index >= h.index && index < h.end)) continue;
      hits.push({ index, end: index + m[0].length, yen: toNumber(m[1]) });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

/** 発話中の金額（円）を出現順に返す（重複なし）。「6〜8万」は上限 80000 だけが残る */
export function findYenAmounts(text: string, opts: { allowBare?: boolean } = {}): number[] {
  const yens: number[] = [];
  for (const h of collectYen(normalizeText(text), opts.allowBare ?? false)) if (!yens.includes(h.yen)) yens.push(h.yen);
  return yens;
}

/**
 * 金額表現 → 円。「7万」「7.5万円」「75000円」「7万以内」「7万前後」「7万5千円」「70,000円」→ 円。
 * 範囲（「6〜8万」「6万〜8万」）は上限。見つからなければ undefined。
 */
export function parseYen(text: string): number | undefined {
  const t = normalizeText(text);
  const hits = collectYen(t, true);
  if (hits.length === 0) return undefined;
  if (hits.length >= 2 && /^(?:~|-|から)$/.test(t.slice(hits[0].end, hits[1].index).replace(/\s+/g, ''))) return hits[1].yen;
  return hits[0].yen;
}

// ---------- 間取り ----------

const LAYOUT_ALNUM_RE = /(?<![0-9A-Z])([1-9])\s*-?\s*(LDK|DK|K|R)(?![A-Z])/g;
const LAYOUT_KANA: ReadonlyArray<readonly [RegExp, Layout]> = [
  [/ワンルーム|1ルーム/g, '1R'],
  [/ワンエルディーケー/g, '1LDK'],
  [/ワンディーケー/g, '1DK'],
  [/ワンケー/g, '1K'],
  [/ツーエルディーケー/g, '2LDK'],
  [/ツーディーケー/g, '2DK'],
  [/ツーケー/g, '2K'],
];

const isLayout = (s: string): s is Layout => (LAYOUTS as readonly string[]).includes(s);

/** 発話中の間取りを出現順に返す（重複なし）。LAYOUTS に無い間取り（3LDK など）は返さない */
export function parseLayouts(text: string): Layout[] {
  const t = normalizeText(text);
  const found: Array<{ index: number; layout: Layout }> = [];
  for (const m of t.toUpperCase().matchAll(LAYOUT_ALNUM_RE)) {
    const layout = `${m[1]}${m[2]}`;
    if (isLayout(layout)) found.push({ index: m.index ?? 0, layout });
  }
  for (const [re, layout] of LAYOUT_KANA) {
    for (const m of t.matchAll(re)) found.push({ index: m.index ?? 0, layout });
  }
  found.sort((a, b) => a.index - b.index);
  const layouts: Layout[] = [];
  for (const f of found) if (!layouts.includes(f.layout)) layouts.push(f.layout);
  return layouts;
}

/** 「ワンルーム」→ 1R、「1ldk」→ 1LDK。最初に見つかった間取り */
export function parseLayout(text: string): Layout | undefined {
  return parseLayouts(text)[0];
}

// ---------- 駅徒歩・階数 ----------

const NEAR_STATION_RE = /駅近|駅チカ|駅ちか|駅から近い|駅に近い|駅の近く/;
const WALK_PREFIXED_RE = /(?:徒歩|歩いて|歩|駅から|駅|最寄り(?:駅)?から)\s*(?:約)?(\d{1,2})(?:\s*~\s*(\d{1,2}))?\s*分/;
const WALK_SUFFIXED_RE =
  /(?<!(?:バス|自転車|車|電車|チャリ|タクシー)(?:で|から)?\s*)(\d{1,2})(?:\s*~\s*(\d{1,2}))?\s*分\s*(?:以内|圏内|以下)/;

/** 「駅近」→ NEAR_STATION_WALK_MIN、「徒歩5分以内」→ 5、「徒歩5〜10分」→ 10。1〜60 分の範囲外は undefined */
export function parseWalkMax(text: string): number | undefined {
  const t = normalizeText(text);
  const m = WALK_PREFIXED_RE.exec(t) ?? WALK_SUFFIXED_RE.exec(t);
  if (m) {
    const n = Number(m[2] ?? m[1]);
    if (n >= CLAMP.walkMin.min && n <= CLAMP.walkMin.max) return n;
    return undefined;
  }
  if (NEAR_STATION_RE.test(t)) return NEAR_STATION_WALK_MIN;
  return undefined;
}

/** 「2階以上」→ 2、「1階は避けたい」→ 2 */
export function parseFloorMin(text: string): number | undefined {
  const t = normalizeText(text);
  const m = /(\d{1,2})\s*階\s*(?:以上|から|より上|以降)/.exec(t);
  if (m) {
    const n = Number(m[1]);
    return n >= CLAMP.floor.min && n <= CLAMP.floor.max ? n : undefined;
  }
  if (/(?<!\d)1\s*階(?:は|だけは)?\s*(?:嫌|いや|イヤ|避け|NG|ng|ダメ|だめ|以外)/.test(t)) return 2;
  return undefined;
}

// ---------- 駅・区 ----------

/** 駅マスタの駅名に加えて受け付ける表記（キーは正規化後の形） */
const STATION_ALIASES: Readonly<Record<string, string>> = {
  阿佐ヶ谷: '阿佐ケ谷',
  阿佐谷: '阿佐ケ谷',
  阿佐ヵ谷: '阿佐ケ谷',
  四谷: '四ツ谷',
  四ッ谷: '四ツ谷',
  御茶の水: '御茶ノ水',
  お茶の水: '御茶ノ水',
  お茶ノ水: '御茶ノ水',
  自由ヶ丘: '自由が丘',
  自由ケ丘: '自由が丘',
  学大: '学芸大学',
  西荻: '西荻窪',
  小杉: '武蔵小杉',
  たかたのばば: '高田馬場',
  高輪ゲートウェー: '高輪ゲートウェイ',
  たかなわゲートウェイ: '高輪ゲートウェイ',
};

const STATION_NAME_SET: ReadonlySet<string> = new Set(STATIONS.map((s) => s.name));
const STATION_BY_KANA: ReadonlyMap<string, string> = new Map(STATIONS.map((s) => [s.kana, s.name]));
/** 路線名・事業者名の接頭辞（「JR渋谷」「東急渋谷駅」）。駅名「東京」と衝突する「東京メトロ」は残りが空なら外さない */
const STATION_PREFIX_RE = /^(?:JR|東京メトロ|メトロ|東急東横線|東横線|東急|山手線|中央線)/;

/** 駅名・「〜駅」・ひらがな・カタカナ・別表記 → 駅マスタの駅名。マスタに無ければ undefined */
export function resolveStation(input: string): string | undefined {
  let s = normalizeText(input).replace(/\s+/g, '');
  const withoutPrefix = s.replace(STATION_PREFIX_RE, '');
  if (withoutPrefix !== '') s = withoutPrefix;
  if (s.endsWith('駅') && s.length > 1) s = s.slice(0, -1);
  if (STATION_NAME_SET.has(s)) return s;
  const alias = STATION_ALIASES[s];
  if (alias) return alias;
  let kana = toHiragana(s);
  if (kana.endsWith('えき') && kana.length > 2) kana = kana.slice(0, -2);
  return STATION_BY_KANA.get(kana);
}

/** 区・市の別表記: 「川崎市中原区」→「中原区」 */
const WARD_ALIASES: ReadonlyMap<string, string> = new Map(
  WARDS.flatMap((w): Array<[string, string]> => {
    const m = /^.+市(.+区)$/.exec(w);
    return m ? [[m[1], w]] : [];
  }),
);
const WARD_SET: ReadonlySet<string> = new Set(WARDS);

/** 「目黒区」「東京都目黒区」「中原区」→ 区・市マスタの名前。「区」「市」を付けない形は区として扱わない */
export function resolveWard(input: string): string | undefined {
  const s = normalizeText(input)
    .replace(/\s+/g, '')
    .replace(/^(?:東京都|神奈川県)/, '');
  if (WARD_SET.has(s)) return s;
  return WARD_ALIASES.get(s);
}

interface NameEntry {
  surface: string;
  value: string;
  kana: boolean;
}

/** 区・市の接尾辞が続くとき、駅名ではなく区・市の言及（「渋谷区」「三鷹市」「東京都」） */
const WARD_SUFFIX_RE = /^[区市都]/;

function buildStationEntries(): NameEntry[] {
  const entries: NameEntry[] = [];
  for (const s of STATIONS) {
    entries.push({ surface: s.name, value: s.name, kana: false });
    entries.push({ surface: s.kana, value: s.name, kana: true });
  }
  for (const [alias, name] of Object.entries(STATION_ALIASES)) {
    const hira = toHiragana(alias);
    const isKana = /^[ぁ-ゖー]+$/.test(hira);
    entries.push({ surface: isKana ? hira : alias, value: name, kana: isKana });
  }
  return entries.sort((a, b) => b.surface.length - a.surface.length);
}
const STATION_ENTRIES = buildStationEntries();

/** 長い名前から順に、重ならないように探す（「中目黒」の中の「目黒」は拾わない） */
function scanNames(text: string, entries: readonly NameEntry[], accept: (e: NameEntry, end: number) => boolean): string[] {
  const hira = toHiragana(text);
  const claimed: boolean[] = new Array<boolean>(text.length).fill(false);
  const hits: Array<{ index: number; value: string }> = [];
  for (const e of entries) {
    const haystack = e.kana ? hira : text;
    let from = 0;
    for (;;) {
      const i = haystack.indexOf(e.surface, from);
      if (i < 0) break;
      from = i + 1;
      const end = i + e.surface.length;
      let overlap = false;
      for (let k = i; k < end; k++) if (claimed[k]) overlap = true;
      if (overlap) continue;
      if (!accept(e, end)) continue;
      for (let k = i; k < end; k++) claimed[k] = true;
      hits.push({ index: i, value: e.value });
    }
  }
  hits.sort((a, b) => a.index - b.index);
  const values: string[] = [];
  for (const h of hits) if (!values.includes(h.value)) values.push(h.value);
  return values;
}

/**
 * 発話中の駅名を出現順に返す（hints 用）。「渋谷区」は駅にしない。
 * 短いひらがな（3文字以下）は普通の語と紛れるので、「駅」が続くか発話全体がその語のときだけ拾う。
 */
export function findStationsInText(input: string): string[] {
  const text = normalizeText(input);
  const wholeKana = toHiragana(text.replace(/\s+/g, '').replace(/駅$/, ''));
  return scanNames(text, STATION_ENTRIES, (e, end) => {
    if (WARD_SUFFIX_RE.test(text.slice(end))) return false;
    // 「東京メトロ」の「東京」は駅ではない
    if (text.slice(end).startsWith('メトロ')) return false;
    if (e.kana && e.surface.length <= 3) {
      return text.charAt(end) === '駅' || wholeKana === e.surface;
    }
    return true;
  });
}

const WARD_ENTRIES: NameEntry[] = [
  ...WARDS.map((w) => ({ surface: w, value: w, kana: false })),
  ...[...WARD_ALIASES].map(([alias, w]) => ({ surface: alias, value: w, kana: false })),
].sort((a, b) => b.surface.length - a.surface.length);

/** 発話中の区・市を出現順に返す（hints 用） */
export function findWardsInText(input: string): string[] {
  return scanNames(normalizeText(input), WARD_ENTRIES, () => true);
}

// ---------- タグ（同義語辞書） ----------

interface TagDef {
  /** 単独で意味が確定する語。完全一致（resolveTag）・備考・発話のどれでも使う */
  synonyms: string[];
  /** 発話のヒントと完全一致だけに使う緩い語。備考には使わない（「日当たりが悪い」を拾わないため） */
  loose?: Array<string | RegExp>;
}

/**
 * 語は「記号と空白を除き小文字にした形（toKey）」で書いても、そのままでもよい（読み込み時に toKey する）。
 * 「二人」のような単位つき漢数字は normalizeText が算用数字にするので、数字の形で書く。
 */
const TAG_DEFS: Record<Tag, TagDef> = {
  ペット可: {
    synonyms: [
      'ペット可', 'ペットOK', 'ペット可能', 'ペット相談', 'ペット相談可', 'ペット相談OK', 'ペット飼育可',
      'ペット飼育可能', 'ペット飼育OK', 'ペット飼える', 'ペットが飼える', 'ペットを飼える', 'ペットと暮らせる',
      'ペットと住める', 'ペット同居可', 'ペット歓迎', 'ペットフレンドリー', 'ペット共生', '犬可', '猫可',
      '犬猫可', '犬OK', '猫OK', '犬猫OK', '小型犬可', '小型犬OK', '小型犬相談', 'ペット可物件', 'ペットOK物件',
    ],
    loose: ['ペット飼いたい', 'ペットを飼いたい', '犬を飼いたい', '猫を飼いたい', 'ペット連れ', /(?:犬|猫|ペット)(?:が|を|と)?(?:飼|暮らし|住め|住みたい|連れ)/],
  },
  バストイレ別: {
    synonyms: [
      'バストイレ別', 'バス・トイレ別', 'バストイレ別々', 'バストイレ独立', 'バスとトイレ別', 'バスとトイレが別',
      'バストイレセパレート', 'BT別', 'BT別々', 'BT独立', '風呂トイレ別', '風呂トイレ別々', '風呂トイレ独立',
      'お風呂トイレ別', 'お風呂とトイレ別', 'お風呂とトイレが別', 'お風呂とトイレが別々', 'お風呂とトイレは別',
      'おふろトイレ別', 'トイレとお風呂が別', 'トイレとお風呂は別', 'トイレ別', 'トイレ風呂別', 'セパレート',
      'セパレートタイプ', '浴室トイレ別', '洗い場トイレ別',
    ],
    loose: [/(?:バス|風呂|お風呂|浴室)(?:と)?トイレ(?:が|は)?(?:別|独立|分か|セパレート)/],
  },
  オートロック: {
    synonyms: [
      'オートロック', 'オートロック付', 'オートロック付き', 'オートロックあり', 'オートロック有',
      'オートロック完備', 'オートロックマンション', 'オートロック物件', 'オートロックの物件', '自動ロック',
      'モニター付オートロック', 'モニター付きオートロック',
    ],
  },
  独立洗面台: {
    synonyms: [
      '独立洗面台', '独立洗面', '洗面台独立', '洗面所独立', '洗面独立', '独立洗面化粧台', '洗面化粧台独立',
      '洗面台別', '洗面所別', '独洗', 'シャンプードレッサー', '独立洗面所', '洗面台が独立', '洗面所が独立',
      '洗面台は独立',
    ],
  },
  室内洗濯機置場: {
    synonyms: [
      '室内洗濯機置場', '室内洗濯機置き場', '室内洗濯機', '室内洗濯置場', '室内洗濯置き場', '室内洗濯',
      '洗濯機置場室内', '洗濯機置き場室内', '洗濯機室内', '洗濯機は室内', '洗濯機が室内', '洗濯機を室内',
      '洗濯機置場は室内', '洗濯機置き場は室内', '洗濯機置場が室内', '洗濯機置き場が室内', '室内に洗濯機',
      '室内置き洗濯機',
    ],
    loose: [/洗濯機(?:置(?:き)?場)?(?:は|が|を|の|も)?(?:室内|部屋の中|部屋内)/, /(?:室内|部屋の中|部屋内)(?:に|で|の)?洗濯/],
  },
  宅配ボックス: {
    synonyms: [
      '宅配ボックス', '宅配BOX', '宅配ボックス付', '宅配ボックス付き', '宅配ボックスあり', '宅配ボックス有',
      '宅配ボックス完備', '宅配BOX付', '宅配BOX付き', '宅配BOX完備', '宅配ロッカー', '宅配ポスト', '宅配ボツクス',
      '宅配便ボックス', '宅配ボックス設置',
    ],
  },
  エアコン: {
    synonyms: [
      'エアコン', 'エアコン付', 'エアコン付き', 'エアコンあり', 'エアコン有', 'エアコン完備', 'エアコン設置',
      'エアコン設置済', 'エアコン1台', 'エアコン2台', 'エアコン付属', 'クーラー', 'クーラー付', '冷暖房',
      '冷暖房完備', 'AC付', 'AC完備',
    ],
  },
  フローリング: {
    synonyms: [
      'フローリング', 'フローリング張り', 'フローリング貼り', 'フローリング仕様', 'フローリングの部屋', '洋室フローリング',
      '床フローリング', '床はフローリング', '床がフローリング', 'フローリング床',
    ],
  },
  角部屋: {
    synonyms: [
      '角部屋', '角住戸', '角のお部屋', '角の部屋', '角お部屋', '角室', '角ルーム', 'コーナールーム', 'コーナー部屋',
      'コーナー住戸', '角部屋物件', '最上階角部屋',
    ],
  },
  南向き: {
    synonyms: [
      '南向き', '南向', '南向きの部屋', '南向きバルコニー', '南向きベランダ', '南向き物件', '南向き窓', '南向きルーム',
      '南側向き', '真南向き', '南面', '南面採光', 'サウスビュー',
    ],
    loose: [/南側(?:に)?(?:窓|バルコニー|ベランダ)/],
  },
  日当たり良好: {
    synonyms: [
      '日当たり良好', '日当たりが良い', '日当たり良い', '日当たりのよい', '日当たりの良い', '日当たりよい',
      '日当たりが良好', '日当たり抜群', '日当たりバツグン', '陽当たり良好', '陽当たりが良い', '陽当たりの良い',
      '陽あたり良好', '日照良好', '採光良好', '採光が良い', '明るい部屋', '明るいお部屋',
    ],
    loose: ['日当たり', '日当り', '日あたり', '陽当たり', '陽当り', '陽あたり', '日照', '採光', '日差し', '日射し'],
  },
  静か: {
    synonyms: [
      '静か', '閑静', '閑静な住宅街', '静かな環境', '静かな部屋', '静かな物件', '静かなところ', '静かな場所',
      '静かなエリア', '静かな住宅街', '静かな立地', '静かな暮らし', '静寂', '静穏', '閑静な立地', '閑静な環境',
      '閑静エリア',
    ],
    loose: ['静かに暮らしたい', '静かに過ごしたい', '落ち着いた環境', '落ち着いた住宅街', '落ち着いたエリア'],
  },
  駐輪場: {
    synonyms: [
      '駐輪場', '駐輪スペース', '駐輪', '自転車置き場', '自転車置場', '自転車置き場あり', '自転車置場あり',
      '駐輪場あり', '駐輪場有', '駐輪場付', '駐輪場付き', '駐輪場完備', '自転車駐輪場', 'サイクルポート', '駐輪所',
      '自転車スペース', '敷地内駐輪場',
    ],
  },
  '2人入居可': {
    synonyms: [
      '2人入居可', '2人入居', '2人入居可能', '2人入居相談', '2人入居OK', '2名入居可', '2名入居', '二名入居可',
      '二名入居', '2人暮らし可', 'ふたり入居', 'カップル可', 'カップルOK', '同棲可', '同棲OK', '夫婦可', '新婚可',
    ],
    loose: ['2人暮らし', 'ふたり暮らし', '2人で住める', '2人で住みたい', '同棲'],
  },
  楽器相談可: {
    synonyms: [
      '楽器相談可', '楽器相談', '楽器可', '楽器OK', '楽器演奏可', '楽器演奏相談', '楽器演奏相談可', '楽器演奏OK',
      '楽器演奏可能', '楽器使用可', '楽器利用可', 'ピアノ可', 'ピアノOK', 'ピアノ相談', 'ピアノ相談可', 'ギター可',
      'ギターOK', 'ドラム可', '音楽可', '音楽相談',
    ],
    loose: [/(?:楽器|ピアノ|ギター|ドラム|バイオリン|ヴァイオリン|サックス|フルート|ベース|電子ピアノ|キーボード)(?:を|が)?(?:弾|演奏|練習|使いたい|やりたい|吹)/],
  },
  敷金なし: {
    synonyms: [
      '敷金なし', '敷金無し', '敷金無', '敷金0', '敷金ゼロ', '敷金不要', '敷金0円', '敷金ゼロ円', '敷金0ヶ月',
      '敷金0か月', '敷金0カ月', '敷金なしの物件', '敷なし', '敷0', '敷金いらない', '敷金要らない',
    ],
  },
  礼金なし: {
    synonyms: [
      '礼金なし', '礼金無し', '礼金無', '礼金0', '礼金ゼロ', '礼金不要', '礼金0円', '礼金ゼロ円', '礼金0ヶ月',
      '礼金0か月', '礼金0カ月', '礼金なしの物件', '礼なし', '礼0', '礼金いらない', '礼金要らない',
    ],
  },
};

/** 1つの語が複数タグを指すもの（「敷礼ゼロ」= 敷金なし＋礼金なし） */
const TAG_COMBOS: ReadonlyArray<{ synonyms: string[]; tags: Tag[] }> = [
  {
    synonyms: [
      '敷礼なし', '敷礼ゼロ', '敷礼0', '敷礼不要', '敷金礼金なし', '敷金礼金無し', '敷金礼金ゼロ', '敷金礼金0',
      '敷金礼金不要', '敷金礼金0円', 'ゼロゼロ', 'ゼロゼロ物件', '敷金・礼金なし',
    ],
    tags: ['敷金なし', '礼金なし'],
  },
];

/** 辞書照合用のキー: 正規化 → 小文字 → 空白と記号（. と , 以外）を除く。「バス・トイレ別」「BT別」「B/T別」を同じ形にする */
function toKey(s: string): string {
  return normalizeText(s)
    .toLowerCase()
    .replace(/[\s!-+\-/:-@[-`{-~　-〄〈-〠・･]/g, '');
}

interface TagEntry {
  surface: string;
  tags: readonly Tag[];
  /** 数字で終わる語（「敷金0」）。直後に数字が続くとき（「敷金0.5ヶ月」）は別の意味なので拾わない */
  digitEnd: boolean;
}

const TAG_STRICT_ENTRIES: TagEntry[] = [];
const TAG_LOOSE_ENTRIES: TagEntry[] = [];
const TAG_LOOSE_PATTERNS: Array<{ re: RegExp; tags: readonly Tag[] }> = [];
const TAG_EXACT = new Map<string, readonly Tag[]>();

function registerTagSurface(list: TagEntry[], raw: string, tags: readonly Tag[]): void {
  const surface = toKey(raw);
  if (surface.length < 2) return;
  list.push({ surface, tags, digitEnd: /\d$/.test(surface) });
  if (!TAG_EXACT.has(surface)) TAG_EXACT.set(surface, tags);
}

for (const tag of TAGS) {
  const def = TAG_DEFS[tag];
  for (const s of def.synonyms) registerTagSurface(TAG_STRICT_ENTRIES, s, [tag]);
  for (const l of def.loose ?? []) {
    if (typeof l === 'string') registerTagSurface(TAG_LOOSE_ENTRIES, l, [tag]);
    else TAG_LOOSE_PATTERNS.push({ re: l, tags: [tag] });
  }
}
for (const combo of TAG_COMBOS) {
  for (const s of combo.synonyms) {
    const surface = toKey(s);
    TAG_STRICT_ENTRIES.push({ surface, tags: combo.tags, digitEnd: /\d$/.test(surface) });
    TAG_EXACT.set(surface, combo.tags);
  }
}
TAG_STRICT_ENTRIES.sort((a, b) => b.surface.length - a.surface.length);
TAG_LOOSE_ENTRIES.sort((a, b) => b.surface.length - a.surface.length);

const isTag = (s: string): s is Tag => (TAGS as readonly string[]).includes(s);

/** 語の直後が否定（「ペット不可」「エアコンなし」）か。「〜ないと嫌」「〜なしは嫌」は要望なので判定しない */
const NEGATION_AFTER_RE = /^(?:は|も)?(?:不可|ng|なし|無し|不要|禁止|いらない|要らない)/;

function scanTagEntries(key: string, entries: readonly TagEntry[], skipNegated: boolean, into: Set<Tag>): void {
  const claimed: boolean[] = new Array<boolean>(key.length).fill(false);
  for (const e of entries) {
    let from = 0;
    for (;;) {
      const i = key.indexOf(e.surface, from);
      if (i < 0) break;
      from = i + 1;
      const end = i + e.surface.length;
      let overlap = false;
      for (let k = i; k < end; k++) if (claimed[k]) overlap = true;
      if (overlap) continue;
      for (let k = i; k < end; k++) claimed[k] = true;
      const rest = key.slice(end);
      if (e.digitEnd && /^\.?\d/.test(rest)) continue;
      if (skipNegated && NEGATION_AFTER_RE.test(rest)) continue;
      for (const t of e.tags) into.add(t);
    }
  }
}

/**
 * 文中のタグを TAGS の並びで返す。
 * - 'note'（物件の備考）: 厳密な語だけ。直後が否定（「ペット不可」「エアコンなし」）なら拾わない
 * - 'utterance'（ユーザー発話の hints）: 緩い語・パターンも使い、否定の判定はしない（採否は LLM が決める）
 */
export function findTagsInText(text: string, opts: { mode?: 'note' | 'utterance' } = {}): Tag[] {
  const mode = opts.mode ?? 'utterance';
  const key = toKey(text);
  const found = new Set<Tag>();
  scanTagEntries(key, TAG_STRICT_ENTRIES, mode === 'note', found);
  if (mode === 'utterance') {
    scanTagEntries(key, TAG_LOOSE_ENTRIES, false, found);
    for (const p of TAG_LOOSE_PATTERNS) if (p.re.test(key)) for (const t of p.tags) found.add(t);
  }
  return TAGS.filter((t) => found.has(t));
}

/** 同義語 → タグ（完全一致）。「敷礼ゼロ」のように複数タグを指す語は複数返す */
export function resolveTags(input: string): Tag[] {
  const hit = TAG_EXACT.get(toKey(input));
  return hit ? [...hit] : [];
}

/** 「BT別」「バス・トイレ別」「風呂トイレ別」→ バストイレ別。辞書に無ければ undefined（複数タグを指す語は先頭） */
export function resolveTag(input: string): Tag | undefined {
  return resolveTags(input)[0];
}

// ---------- 入居時期 ----------

/** 「来月の土曜に内見したい」の月は内見の話であって入居時期ではない（直後に内見の語があり、入居の語が無い） */
function isViewingTalk(t: string, end: number): boolean {
  const following = t.slice(end, end + 16);
  return /内見|見学|見に|下見|案内/.test(following) && !/入居|住み|住む|住ん|引っ越|引越/.test(following);
}

const MOVE_IN_VERB = String.raw`(?:入居|住み|住む|引っ越|引越)`;

/**
 * 入居時期 → 'YYYY-MM'（JST）。「来月」「再来月」「4月」「来年の3月」「2027年3月」「3ヶ月後」「半年後」「すぐ入居」「年明け」。
 * 「4月」は今月以降で最も近い月。内見の話（「来月の土曜に内見」）と、入居と結び付かない「来週」「すぐ」は拾わない。
 * 決められなければ undefined。
 */
export function parseMoveIn(text: string, now: Date): string | undefined {
  const t = normalizeText(text);
  const cur = jstParts(now);
  const find = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(t);
    return m && !isViewingTalk(t, m.index + m[0].length) ? m : null;
  };

  const full = find(/(?<!\d)(20\d{2})\s*(?:年|\/|-|\.)\s*(\d{1,2})(?:\s*月)?/);
  if (full) {
    const month = Number(full[2]);
    if (month >= 1 && month <= 12) return formatYearMonth(Number(full[1]), month);
  }
  const nextYear = find(/来年(?:の)?\s*(\d{1,2})\s*月/);
  if (nextYear) {
    const month = Number(nextYear[1]);
    if (month >= 1 && month <= 12) return formatYearMonth(cur.year + 1, month);
  }
  const monthOnly = find(/(?<!\d)(\d{1,2})\s*月/);
  if (monthOnly) {
    const month = Number(monthOnly[1]);
    if (month >= 1 && month <= 12) return formatYearMonth(month >= cur.month ? cur.year : cur.year + 1, month);
  }
  const relative = (n: number): string => {
    const r = addMonths(cur.year, cur.month, n);
    return formatYearMonth(r.year, r.month);
  };
  if (find(/再来月/)) return relative(2);
  if (find(/来月/)) return relative(1);
  if (find(/今月/)) return relative(0);
  const later = find(/(\d{1,2})\s*(?:ヶ|か|カ|ケ|ヵ)月\s*(?:後|先)/);
  if (later) return relative(Number(later[1]));
  if (find(/半年\s*(?:後|先)/)) return relative(6);
  if (/年明け|来年初め|新年/.test(t)) return formatYearMonth(cur.year + 1, 1);
  const week = new RegExp(`(再来週|来週|今週)(?:から|には|に|中に|までに)?${MOVE_IN_VERB}`).exec(t);
  if (week) {
    const weeks = week[1] === '再来週' ? 2 : week[1] === '来週' ? 1 : 0;
    const d = new Date(Date.UTC(cur.year, cur.month - 1, cur.day + weeks * 7));
    return formatYearMonth(d.getUTCFullYear(), d.getUTCMonth() + 1);
  }
  if (new RegExp(`(?:すぐ|今すぐ|早急|急ぎ)(?:に|にでも|で)?${MOVE_IN_VERB}|即入居|即日入居`).test(t)) return relative(0);
  return undefined;
}

// ---------- 内見の日時 ----------

/** 日時 → 'YYYY-MM-DDTHH:mm'（時刻が無ければ 'YYYY-MM-DD'）。暦として不正なら undefined。秒・タイムゾーン表記は落とす（JST 前提） */
export function canonicalizeViewingTime(raw: string): string | undefined {
  const t = normalizeText(raw)
    .replace(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/, '$1-$2-$3')
    .replace(/^(\d{4}-\d{1,2}-\d{1,2}) (?=\d)/, '$1T');
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:T(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(t);
  if (!m) return undefined;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return undefined;
  const date = `${year}-${pad2(month)}-${pad2(day)}`;
  if (m[4] === undefined) return date;
  const [hour, minute] = [Number(m[4]), Number(m[5])];
  if (hour > 23 || minute > 59) return undefined;
  return `${date}T${pad2(hour)}:${pad2(minute)}`;
}

// ---------- 前段: preNormalize ----------

/** 辞書が発話から見つけた候補。LLM のプロンプトに添える（採否は LLM が文脈で決める） */
export interface NormalizeHints {
  stations: string[];
  wards: string[];
  /** 発話中の金額（円）。家賃以外の金額（初期費用など）も含みうる */
  rentMax: number[];
  layouts: Layout[];
  tags: Tag[];
  walkMax?: number;
  floorMin?: number;
  /** 'YYYY-MM'（JST） */
  moveIn?: string;
}

export interface PreNormalized {
  /** 正規化後の発話。LLM にはこちらを `<user_message>` で渡す */
  text: string;
  hints: NormalizeHints;
}

export function preNormalize(utterance: string, now: Date): PreNormalized {
  const text = normalizeText(utterance);
  const hints: NormalizeHints = {
    stations: findStationsInText(text),
    wards: findWardsInText(text),
    rentMax: findYenAmounts(text, { allowBare: true }),
    layouts: parseLayouts(text),
    tags: findTagsInText(text, { mode: 'utterance' }),
  };
  const walkMax = parseWalkMax(text);
  if (walkMax !== undefined) hints.walkMax = walkMax;
  const floorMin = parseFloorMin(text);
  if (floorMin !== undefined) hints.floorMin = floorMin;
  const moveIn = parseMoveIn(text, now);
  if (moveIn !== undefined) hints.moveIn = moveIn;
  return { text, hints };
}

// ---------- 後段: canonicalizeOps ----------

export interface DroppedOp {
  raw: unknown;
  reason: string;
}

const KEY_ALIASES: Readonly<Record<string, ScalarSlotKey>> = {
  rent_max: 'rentMax',
  rent: 'rentMax',
  budget: 'rentMax',
  walk_min: 'walkMax',
  walk_max: 'walkMax',
  floor_min: 'floorMin',
  move_in: 'moveIn',
  station: 'area',
  stations: 'area',
  layout: 'layouts',
};

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

function asKey(x: unknown): ScalarSlotKey | undefined {
  if (typeof x !== 'string') return undefined;
  if ((SCALAR_SLOT_KEYS as readonly string[]).includes(x)) return x as ScalarSlotKey;
  return KEY_ALIASES[x];
}

function asPriority(x: unknown): Priority | undefined {
  return typeof x === 'string' && (PRIORITIES as readonly string[]).includes(x) ? (x as Priority) : undefined;
}

function clampInt(n: number, range: { min: number; max: number }): number {
  return Math.min(range.max, Math.max(range.min, Math.round(n)));
}

function numberFrom(x: unknown, parse: (s: string) => number | undefined): number | undefined {
  if (typeof x === 'number') return Number.isFinite(x) ? x : undefined;
  if (typeof x === 'string') {
    const parsed = parse(x);
    if (parsed !== undefined) return parsed;
    const n = Number(normalizeText(x).replace(/,/g, ''));
    return Number.isFinite(n) && normalizeText(x) !== '' ? n : undefined;
  }
  return undefined;
}

function canonicalRent(x: unknown): number | undefined {
  const n = numberFrom(x, parseYen);
  if (n === undefined || n <= 0) return undefined;
  const yen = n <= RENT_IN_MAN_UP_TO ? n * 10_000 : n;
  return clampInt(yen, CLAMP.rentYen);
}

function canonicalArea(value: unknown): AreaValue | undefined {
  const fromStations: unknown[] = [];
  const fromWards: unknown[] = [];
  const push = (list: unknown[], v: unknown): void => {
    if (Array.isArray(v)) list.push(...v);
    else if (v !== undefined && v !== null) list.push(v);
  };
  if (isRecord(value)) {
    push(fromStations, value.stations);
    push(fromWards, value.wards);
  } else {
    push(fromStations, value);
  }
  const stations: string[] = [];
  const wards: string[] = [];
  const add = (list: string[], v: string): void => {
    if (!list.includes(v)) list.push(v);
  };
  const resolveInto = (raw: unknown): void => {
    if (typeof raw !== 'string') return;
    const station = resolveStation(raw);
    const ward = resolveWard(raw);
    if (station) {
      add(stations, station);
    } else if (ward) {
      add(wards, ward);
    } else {
      // 「渋谷・恵比寿あたり」のような文は中の名前を拾う
      for (const w of findWardsInText(raw)) add(wards, w);
      for (const s of findStationsInText(raw)) add(stations, s);
    }
  };
  // 駅の欄に区が、区の欄に駅が入っていても取り違えずに振り分ける
  for (const raw of [...fromStations, ...fromWards]) resolveInto(raw);
  return stations.length > 0 || wards.length > 0 ? { stations, wards } : undefined;
}

function canonicalLayouts(value: unknown): Layout[] | undefined {
  const list = Array.isArray(value) ? value : [value];
  const layouts: Layout[] = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const layout = parseLayout(raw);
    if (layout && !layouts.includes(layout)) layouts.push(layout);
  }
  return layouts.length > 0 ? layouts : undefined;
}

function canonicalMoveIn(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = normalizeText(value);
  const m = /^(\d{4})\s*(?:-|\/|\.|年)\s*(\d{1,2})\s*月?$/.exec(t);
  if (!m) return undefined;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? formatYearMonth(Number(m[1]), month) : undefined;
}

function canonicalScalarValue(key: ScalarSlotKey, value: unknown): unknown {
  switch (key) {
    case 'area':
      return canonicalArea(value);
    case 'rentMax':
      return canonicalRent(value);
    case 'layouts':
      return canonicalLayouts(value);
    case 'walkMax': {
      const n = numberFrom(value, parseWalkMax);
      return n === undefined ? undefined : clampInt(n, CLAMP.walkMin);
    }
    case 'floorMin': {
      const n = numberFrom(value, parseFloorMin);
      return n === undefined ? undefined : clampInt(n, CLAMP.floor);
    }
    case 'moveIn':
      return canonicalMoveIn(value);
  }
}

/** タグ名の解決: TAGS の値 → 同義語辞書 → 文中の語。解決できなければ空 */
function resolveTagsLoose(raw: unknown): Tag[] {
  if (typeof raw !== 'string') return [];
  if (isTag(raw)) return [raw];
  const exact = resolveTags(raw);
  if (exact.length > 0) return exact;
  return findTagsInText(raw, { mode: 'utterance' });
}

/**
 * LLM が返した ops を検証して SlotOp に直す。駅マスタ・TAGS・LAYOUTS に無い値は辞書で解決を試み、
 * 解決できなければ捨てる（捨てた理由は dropped）。数値は妥当な範囲にクランプする（CLAMP）。
 */
export function canonicalizeOpsWithReport(ops: unknown[]): { ops: SlotOp[]; dropped: DroppedOp[] } {
  const result: SlotOp[] = [];
  const dropped: DroppedOp[] = [];
  const drop = (raw: unknown, reason: string): void => {
    dropped.push({ raw, reason });
  };

  for (const raw of ops) {
    if (!isRecord(raw)) {
      drop(raw, 'オブジェクトではない');
      continue;
    }
    const priority = asPriority(raw.priority);
    switch (raw.op) {
      case 'set': {
        const key = asKey(raw.key);
        if (!key) {
          drop(raw, `未知のスロット: ${String(raw.key)}`);
          break;
        }
        const value = canonicalScalarValue(key, raw.value);
        if (value === undefined) {
          drop(raw, `値を解決できない: ${key}`);
          break;
        }
        result.push({ op: 'set', key, value, ...(priority ? { priority } : {}) } as SlotOp);
        break;
      }
      case 'unset': {
        const key = asKey(raw.key);
        if (key) result.push({ op: 'unset', key });
        else drop(raw, `未知のスロット: ${String(raw.key)}`);
        break;
      }
      case 'setPriority': {
        const key = asKey(raw.key);
        if (key && priority) result.push({ op: 'setPriority', key, priority });
        else drop(raw, key ? '優先度が不正' : `未知のスロット: ${String(raw.key)}`);
        break;
      }
      case 'addTag': {
        const tags = resolveTagsLoose(raw.tag);
        if (tags.length === 0) drop(raw, `未知のタグ: ${String(raw.tag)}`);
        for (const tag of tags) result.push({ op: 'addTag', tag, ...(priority ? { priority } : {}) });
        break;
      }
      case 'removeTag': {
        const tags = resolveTagsLoose(raw.tag);
        if (tags.length === 0) drop(raw, `未知のタグ: ${String(raw.tag)}`);
        for (const tag of tags) result.push({ op: 'removeTag', tag });
        break;
      }
      case 'setTagPriority': {
        const tags = resolveTagsLoose(raw.tag);
        if (tags.length === 0 || !priority) {
          drop(raw, tags.length === 0 ? `未知のタグ: ${String(raw.tag)}` : '優先度が不正');
          break;
        }
        for (const tag of tags) result.push({ op: 'setTagPriority', tag, priority });
        break;
      }
      default:
        drop(raw, `未知の op: ${String(raw.op)}`);
    }
  }
  return { ops: result, dropped };
}

export function canonicalizeOps(ops: unknown[]): SlotOp[] {
  return canonicalizeOpsWithReport(ops).ops;
}

// ---------- 徒歩の条件を問わない言い回し（意思決定ログ31） ----------

/**
 * 「駅から遠くてもいい」「徒歩は気にしない」「駅近じゃなくてもいい」。抽出のプロンプトに規則を足すと、
 * 徒歩の条件の優先度だけを変える発話（「ほかはどっちでもいい」「徒歩10分以内は絶対」）まで崩れたので、語で拾う
 */
const WALK_NO_PREFERENCE_RE =
  /駅から(?:は)?遠くても(?:いい|良い|大丈夫|構わない|かまわない|OK)|駅からの距離は(?:気にしない|問わない|どうでもいい|こだわらない|関係ない)|徒歩(?:は|の時間は)?(?:何分でも|気にしない|問わない|こだわらない|どうでもいい)|駅(?:近|ちか)(?:じゃ|で)?なくても(?:いい|良い|大丈夫|構わない|かまわない)/;

/**
 * 発話が徒歩の条件を問わないと言っていれば、抽出の結果の徒歩の操作を「徒歩 WALK_NO_PREFERENCE_MIN 分以内・あれば嬉しい」に置き換える。
 * 徒歩の条件が無いと検索は徒歩の目安（DEFAULT_WALK_PREFERENCE_MIN）で並べるので、明示の条件にして目安を外す
 */
export function applyWalkNoPreference(result: ExtractionResult, utterance: string): ExtractionResult {
  if (!WALK_NO_PREFERENCE_RE.test(normalizeText(utterance))) return result;
  const ops: SlotOp[] = result.ops.filter((op) => !('key' in op && op.key === 'walkMax'));
  ops.push({ op: 'set', key: 'walkMax', value: WALK_NO_PREFERENCE_MIN, priority: 'nice' });
  return { ...result, intent: result.intent === 'offTopic' ? 'conditions' : result.intent, ops };
}
