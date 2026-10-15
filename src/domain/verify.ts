/**
 * 回答文の根拠検証（純関数。DESIGN.md 3.5・4.3・不変条件 3）。
 * LLM が書いた回答文から数値・設備・駅名・間取り・禁止トピックを拾い、対象物件のレコードと照合する。
 * 1つでも根拠の無い記述があれば ok: false（呼び出し側が定型の引き継ぎ文に差し替える）。
 *
 * 方針は「疑わしきは差し替え」。根拠の無い回答を通すより、引き継ぎに倒しすぎるほうを選ぶ。
 * - 数値は単位ごとに、レコードの値（と、比較のための物件どうしの差）にあるものだけを通す。単位の分からない数値も通さない
 * - タグの設備（と敷金・礼金）は、「ある」と書いたらレコードにあること、「ない」と書いたらレコードに無いこと
 * - タグに無い設備・周辺環境（エレベーター・駐車場・コンビニなど）と禁止トピックは、
 *   「記載がありません」「担当者が確認します」の文脈でだけ書いてよい
 * - 質問に出てきた数値は「9万円以内」「2階以上」のような比較の形でだけ繰り返してよい（条件の復唱）
 * - 質問に出てきた駅・区・間取りは、否定か記載なしの文脈（「1LDKではなく1Kです」）でだけ繰り返してよい
 *
 * 語の極性（ある／ない／記載なし）は、語の後ろから文の述語（です・ます・ません）までを見て決める。
 * 「オートロック・宅配ボックスはありません」のように並べた語は、後ろの述語を共有する。
 * 語の意味までは読まないので、言い換えで書かれた根拠の無い情報（「小型犬のみ」など）は拾えない。そこは評価セットで見る。
 * 表記ゆれの正規化と駅・区の検出は、ヒアリングと同じ辞書（normalize.ts）を使う。
 */
import { jstYear } from './businessHours';
import { findStationsInText, findWardsInText, normalizeText } from './normalize';
import { ANSWER_MAX_CHARS, AREA_MATCH_TOLERANCE_SQM } from './rules';
import { LAYOUTS, type ForbiddenTopic, type Property, type Tag } from './types';

export interface VerifyTarget {
  property: Property;
  /** 提示リストの表示番号。カード外の物件なら null */
  position: number | null;
}

export interface VerifyInput {
  /** 検証する回答文 */
  text: string;
  /** ユーザーの質問（原文）。質問に出た駅名・間取り・比較の数値は回答で繰り返してよい */
  question: string;
  targets: readonly VerifyTarget[];
  /** 築年数の計算に使う（JST の年） */
  now: Date;
}

export type VerifyIssue =
  /** レコードに無い数値（`token` は単位つきの原文） */
  | { kind: 'number'; token: string }
  /** タグの設備（敷金・礼金を含む）の有無がレコードと食い違う */
  | { kind: 'feature'; feature: string; claimed: 'present' | 'absent' }
  /** レコードに項目の無い設備・周辺環境を、記載なし以外の文脈で書いた */
  | { kind: 'unknownFacility'; word: string }
  | { kind: 'station'; station: string }
  | { kind: 'ward'; ward: string }
  | { kind: 'layout'; layout: string }
  /** 禁止トピックを、担当者が確認する旨以外の文脈で書いた */
  | { kind: 'forbidden'; topic: ForbiddenTopic }
  | { kind: 'empty' }
  | { kind: 'tooLong'; length: number };

export interface VerifyResult {
  ok: boolean;
  issues: VerifyIssue[];
}

export function verifyAnswer(input: VerifyInput): VerifyResult {
  const issues: VerifyIssue[] = [];
  const raw = normalize(input.text).trim();
  if (raw.length === 0) return { ok: false, issues: [{ kind: 'empty' }] };
  if (raw.length > ANSWER_MAX_CHARS) issues.push({ kind: 'tooLong', length: raw.length });

  const question = normalize(input.question);
  const properties = input.targets.map((t) => t.property);
  // 物件名・住所は表記どおりなら通す（「第2〜」「1-2-3」の数字や、名前に入った駅名を照合しない）。
  // 回答文と同じ正規化をかけ、回答生成が見せる形（山括弧を落とした名前）も含める。消した所には物件ごとの印を置き、主語の手がかりにする
  const text = markSubjects(raw, properties);
  const segments = segmentBySubject(text, input.targets);

  checkLayouts(text, question, properties, issues);
  checkPlaces(text, question, properties, issues);
  checkNumbers(segments, question, input.targets, jstYear(input.now), issues);
  checkTerms(segments, properties, issues);
  checkElliptical(segments, question, properties, issues);
  return { ok: issues.length === 0, issues };
}

/**
 * 回答文が「レコードに記載が無い」と言っているか。モデルが要引き継ぎ（needsStaff）を付け忘れても、
 * 利用者に「記載はありません」だけを返して行き止まりにしないために使う
 */
export function saysNotInRecord(text: string): boolean {
  return NOT_IN_RECORD_RE.test(normalize(text));
}

// ---------- 前処理 ----------

/**
 * ヒアリングと同じ正規化（全角 → 半角・単位つき漢数字 → 算用数字・空白の圧縮）をかけ、
 * 面積と「か月」の表記ゆれを1つにそろえる
 */
function normalize(text: string): string {
  return normalizeText(text)
    .replace(/(\d)\s*(?:m2|m²|㎡|平米|平方メートル)/g, (_m, d: string) => `${d}㎡`)
    .replace(/(\d)\s*(?:ヶ|ケ|カ|ヵ|箇|か)\s*月/g, (_m, d: string) => `${d}か月`)
    .replace(/(\d)\s*(円|万|分|階|年|月|日|件|番目)/g, (_m, d: string, u: string) => `${d}${u}`);
}

/** 区切り（数値や語が前後とつながらないよう、消した所に置く） */
const SEP = '｜';

// ---------- 主語（どの物件のことか。意思決定ログ27） ----------

/** 物件名・住所を消した所に置く物件ごとの印（私用領域の文字。数字・駅名・語の照合に掛からない） */
const SUBJECT_MARK_BASE = 0xe000;
const SUBJECT_MARK_RE = /[-]/;

/** 物件名・住所を、区切りで挟んだ物件ごとの印に置き換える（長い表記から） */
function markSubjects(text: string, properties: readonly Property[]): string {
  const literals = properties.flatMap((p, i) =>
    [p.name, p.name.replace(/[<>]/g, ''), p.address, p.address.replace(/[<>]/g, '')]
      .map(normalize)
      .filter((l) => l.length > 0)
      .map((lit) => ({ lit, mark: `${SEP}${String.fromCharCode(SUBJECT_MARK_BASE + i)}${SEP}` })),
  );
  let out = text;
  for (const { lit, mark } of literals.sort((a, b) => b.lit.length - a.lit.length)) out = out.split(lit).join(mark);
  return out;
}

/**
 * 区切りの主語。`indices` は対象物件（input.targets）の添字で、null は「どれのことか分からない」（いずれかに当てはまればよい）。
 * `every` は「どちらも」「1番目と2番目は」のように全部に当てはまることを言っているとき
 */
interface Segment {
  text: string;
  indices: number[] | null;
  every: boolean;
}

/** 全部の物件を指す言い回し */
const ALL_TARGETS_RE = /どちらも|どっちも|両方とも|両方|いずれも|いずれの物件も|どれも|どの物件も|\d件とも/g;
/** 印の直後がこれなら、その物件は比べる相手で主語ではない（「2番目より安い」「1番目と比べて」） */
const COMPARISON_OBJECT_RE = /^(?:より|と違って|とは違って|と違い|とは違い|と比べ|に比べ|と異なり|に対して|と同じ|と同様)/;
/** 並べた主語のあいだ（「1番目と2番目は」「1番目・2番目とも」）。物件名と番号が並んだ形（「ハイツすみれ（4番目）」）も含む */
const JOINED_SUBJECTS_RE = /^(?:と|・|や|、|及び|および)?$/;

interface SubjectMark {
  start: number;
  end: number;
  indices: number[];
  every: boolean;
}

function findSubjectMarks(sentence: string, targets: readonly VerifyTarget[]): SubjectMark[] {
  const all = targets.map((_, i) => i);
  const marks: SubjectMark[] = [];
  for (let i = 0; i < sentence.length; i++) {
    if (SUBJECT_MARK_RE.test(sentence[i])) {
      marks.push({ start: i, end: i + 1, indices: [sentence.charCodeAt(i) - SUBJECT_MARK_BASE], every: false });
    }
  }
  for (const m of sentence.matchAll(/(\d+)番目/g)) {
    const index = targets.findIndex((t) => t.position === Number(m[1]));
    if (index !== -1) marks.push({ start: m.index, end: m.index + m[0].length, indices: [index], every: false });
  }
  for (const m of sentence.matchAll(ALL_TARGETS_RE)) {
    marks.push({ start: m.index, end: m.index + m[0].length, indices: all, every: true });
  }
  return marks
    .filter((m) => !COMPARISON_OBJECT_RE.test(sentence.slice(m.end).replaceAll(SEP, '')))
    .sort((a, b) => a.start - b.start);
}

/**
 * 回答文を主語ごとの区切りに分ける。文に主語の印が無ければ直前の主語を引き継ぎ（「1番目は徒歩10分です。オートロックはありません。」）、
 * 1つの文に別の物件の主語が続けば、そこで分ける（「1番目はオートロック付き、2番目は宅配ボックス付きです」）
 */
function segmentBySubject(text: string, targets: readonly VerifyTarget[]): Segment[] {
  const segments: Segment[] = [];
  let context: Omit<Segment, 'text'> = { indices: targets.length === 1 ? [0] : null, every: false };
  for (const sentence of text.split(/(?<=[。！？!?\n])/)) {
    const marks = findSubjectMarks(sentence, targets);
    if (marks.length === 0) {
      segments.push({ text: sentence, ...context });
      continue;
    }
    if (marks[0].start > 0) segments.push({ text: sentence.slice(0, marks[0].start), ...context });
    let start = marks[0].start;
    let current: Omit<Segment, 'text'> = { indices: marks[0].indices, every: marks[0].every };
    for (let k = 1; k < marks.length; k++) {
      const gap = sentence.slice(marks[k - 1].end, marks[k].start).replace(/[｜（）()\s]/g, '');
      if (JOINED_SUBJECTS_RE.test(gap)) {
        const indices = [...new Set([...current.indices!, ...marks[k].indices])].sort((a, b) => a - b);
        current = { indices, every: current.every || marks[k].every || indices.length > current.indices!.length };
        continue;
      }
      segments.push({ text: sentence.slice(start, marks[k].start), ...current });
      start = marks[k].start;
      current = { indices: marks[k].indices, every: marks[k].every };
    }
    segments.push({ text: sentence.slice(start), ...current });
    context = current;
  }
  return segments;
}

// ---------- 間取り・駅・区 ----------

const LAYOUT_RE = /(\d)(SLDK|LDK|DK|K|R)(?![A-Za-z])/g;

function checkLayouts(text: string, question: string, properties: readonly Property[], issues: VerifyIssue[]): void {
  for (const m of text.matchAll(LAYOUT_RE)) {
    const layout = `${m[1]}${m[2]}`;
    const known = (LAYOUTS as readonly string[]).includes(layout);
    if (known && properties.some((p) => p.layout === layout)) continue;
    if (known && question.includes(layout) && deniedAfter(text, m.index + m[0].length)) continue;
    issues.push({ kind: 'layout', layout });
  }
}

/** 駅・区はヒアリングと同じ辞書で拾う（「中目黒」の中の「目黒」・「渋谷区」の「渋谷」を駅にしない） */
function checkPlaces(text: string, question: string, properties: readonly Property[], issues: VerifyIssue[]): void {
  for (const ward of new Set(findWardsInText(text))) {
    if (properties.some((p) => p.ward === ward) || echoDenied(text, question, ward)) continue;
    issues.push({ kind: 'ward', ward });
  }
  for (const station of new Set(findStationsInText(text))) {
    if (properties.some((p) => p.access.some((a) => a.station === station)) || echoDenied(text, question, station)) continue;
    issues.push({ kind: 'station', station });
  }
}

/** 質問に出た語を、否定か記載なしの文脈で繰り返しているか（「恵比寿駅は最寄りではありません」） */
function echoDenied(text: string, question: string, word: string): boolean {
  if (!question.includes(word)) return false;
  let i = text.indexOf(word);
  if (i === -1) return false;
  while (i !== -1) {
    if (!deniedAfter(text, i + word.length)) return false;
    i = text.indexOf(word, i + word.length);
  }
  return true;
}

/** 位置 `from` から述語の終わりまでが、否定か記載なしか */
function deniedAfter(text: string, from: number): boolean {
  PREDICATE_END_RE.lastIndex = from;
  const end = PREDICATE_END_RE.exec(text);
  const window = text.slice(from, end ? end.index + end[0].length : text.length).replace(NOT_NEGATION_RE, '');
  return NEUTRAL_RE.test(window) || ABSENT_RE.test(window);
}

interface Span {
  start: number;
  end: number;
  word: string;
}

// ---------- 数値 ----------

type Unit = 'yen' | 'minute' | 'sqm' | 'floor' | 'year' | 'yearSpan' | 'age' | 'months' | 'month' | 'day' | 'monthDay' | 'ymd' | 'position' | 'count' | 'unknown';

interface NumToken {
  unit: Unit;
  /** monthDay は月*100+日、ymd は年*10000+月*100+日 */
  value: number;
  raw: string;
  /** 直後が「以内」「以上」などの比較の語か */
  comparative: boolean;
  /** 読んだ文の中の位置 */
  index: number;
}

/** 比較の語（質問の数値を条件として繰り返すときの形） */
const COMPARATIVE_RE = /^(以内|以下|以上|未満|まで|より|超|を超え)/;

/** 単位つきの数値の読み取り。上から順に当て、当たった所は区切りに置き換える（「8万5千円」を「8万」と「5千円」に分けない） */
const NUMBER_PATTERNS: ReadonlyArray<{ re: RegExp; read: (m: RegExpExecArray) => { unit: Unit; value: number } }> = [
  {
    // 8.5万円・8万5千円・8万5000円・9万
    re: /(\d+(?:\.\d+)?)万(?:(\d)千|(\d{1,4})(?!\d))?円?/g,
    read: (m) => ({
      unit: 'yen',
      value: Math.round(Number(m[1]) * 10000) + (m[2] ? Number(m[2]) * 1000 : m[3] ? Number(m[3]) : 0),
    }),
  },
  { re: /(\d+)千円/g, read: (m) => ({ unit: 'yen', value: Number(m[1]) * 1000 }) },
  { re: /(\d{1,3}(?:,\d{3})+|\d+)円/g, read: (m) => ({ unit: 'yen', value: Number(m[1].replace(/,/g, '')) }) },
  { re: /(\d+(?:\.\d+)?)か月/g, read: (m) => ({ unit: 'months', value: Number(m[1]) }) },
  { re: /築(\d+)年/g, read: (m) => ({ unit: 'age', value: Number(m[1]) }) },
  {
    re: /(\d{4})年(\d{1,2})月(\d{1,2})日/g,
    read: (m) => ({ unit: 'ymd', value: Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) }),
  },
  { re: /(\d{4})年/g, read: (m) => ({ unit: 'year', value: Number(m[1]) }) },
  { re: /(\d{1,2})年/g, read: (m) => ({ unit: 'yearSpan', value: Number(m[1]) }) },
  { re: /(\d{1,2})月(\d{1,2})日/g, read: (m) => ({ unit: 'monthDay', value: Number(m[1]) * 100 + Number(m[2]) }) },
  { re: /(\d{1,2})月/g, read: (m) => ({ unit: 'month', value: Number(m[1]) }) },
  { re: /(\d{1,2})日/g, read: (m) => ({ unit: 'day', value: Number(m[1]) }) },
  { re: /(\d+(?:\.\d+)?)㎡/g, read: (m) => ({ unit: 'sqm', value: Number(m[1]) }) },
  { re: /(\d+)階/g, read: (m) => ({ unit: 'floor', value: Number(m[1]) }) },
  { re: /(\d+)分/g, read: (m) => ({ unit: 'minute', value: Number(m[1]) }) },
  { re: /(\d+)(?:番目|件目|番の)/g, read: (m) => ({ unit: 'position', value: Number(m[1]) }) },
  { re: /(\d+)(?:件|つ|軒|棟|点|か所|箇所)/g, read: (m) => ({ unit: 'count', value: Number(m[1]) }) },
  { re: /\d+(?:\.\d+)?/g, read: (m) => ({ unit: 'unknown', value: Number(m[0]) }) },
];

/** 数字を含むが数値として照合しない語（タグ名や言い回し。間取りは checkLayouts が見る） */
const NUMERIC_PHRASES = ['2人入居可', '2人入居', '2名入居', '2人で住', '1人暮らし', '2人暮らし', '3点ユニット'];

/**
 * 期間の言い回し（「1年間の合計額は記載がありません」「2年分」）。レコードの値を述べる数ではないので照合しない。
 * 年額などの金額は円の数値として別に照合される（意思決定ログ26）
 */
const PERIOD_RE = /(?:\d{1,2}|[一二三四五六七八九十]+)年(?:間|分)/g;

/**
 * 漢数字の数値（回答は算用数字で書かせるので、出てきたら照合できない数値として扱う）。
 * 「十分（じゅうぶん）」と、算用数字に続く「8万5千円」の「千円」は除く
 */
const KANJI_NUMBER_RE = /(?<![0-9])[一二三四五六七八九十百千]+(?:万|円|分|階|年|か月|㎡|メートル|m|キロ|畳|坪)/g;

/** 語を同じ長さの区切りで隠す（数値の位置 `index` が元の文の位置のままになるように） */
function maskLiterals(text: string, literals: readonly string[]): string {
  let out = text;
  for (const lit of [...literals].sort((a, b) => b.length - a.length)) out = out.split(lit).join(SEP.repeat(lit.length));
  return out;
}

export function readNumbers(text: string): NumToken[] {
  let rest = maskLiterals(text, NUMERIC_PHRASES)
    .replace(LAYOUT_RE, (m) => SEP.repeat(m.length))
    .replace(PERIOD_RE, (m) => SEP.repeat(m.length));
  const tokens: NumToken[] = [];
  for (const m of rest.matchAll(KANJI_NUMBER_RE)) {
    if (m[0] !== '十分') tokens.push({ unit: 'unknown', value: Number.NaN, raw: m[0], comparative: false, index: m.index });
  }
  for (const { re, read } of NUMBER_PATTERNS) {
    rest = rest.replace(re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpExecArray;
      const offset = args[args.length - 2] as number;
      const whole = args[args.length - 1] as string;
      const after = whole.slice(offset + m[0].length);
      tokens.push({ ...read(m), raw: m[0], comparative: COMPARATIVE_RE.test(after), index: offset });
      return SEP.repeat(m[0].length);
    });
  }
  return tokens;
}

/**
 * 敷金・礼金を円で書いたか（「礼金は1か月分で68,000円です」）。レコードは月数だけで、回答生成のプロンプトは円への換算を禁じている。
 * 家賃と同額なので値の照合では通ってしまう。金額の前の同じ節（直前の「、」「。」まで）に敷金・礼金があり、
 * そのあいだに家賃・管理費などの語が無ければ換算とみなす（意思決定ログ28）
 */
function depositInYen(text: string, index: number): boolean {
  const before = text.slice(0, index);
  const clause = before.slice(Math.max(before.lastIndexOf('、'), before.lastIndexOf('。'), before.lastIndexOf('\n')) + 1);
  const at = Math.max(clause.lastIndexOf('敷金'), clause.lastIndexOf('礼金'), clause.lastIndexOf('敷礼'));
  return at !== -1 && !/家賃|賃料|管理費|共益費|月額/.test(clause.slice(at));
}

/** 比べる言い回し（物件どうしの差の数値は、この語のある区切りでだけ通す。主語が分からない区切りでは常に通す） */
const COMPARISON_CUE_RE = /より|ほうが|方が|差|違い|比べ|安[いく]|高[いく]|近[いく]|遠[いく]|広[いく]|狭[いく]|新し[いく]|古[いく]/;

function checkNumbers(segments: readonly Segment[], question: string, targets: readonly VerifyTarget[], year: number, issues: VerifyIssue[]): void {
  const perTarget = targets.map((t) => recordValues([t], year));
  const anyTarget = recordValues(targets, year);
  const common = positionsAndCounts(targets);
  const diffs = differences(targets);
  const asked = readNumbers(question);
  for (const segment of segments) {
    // 主語が決まっていれば、その物件の値だけを通す（「どちらも」は全部の物件の値に当たること）
    const pools =
      segment.indices === null
        ? [anyTarget]
        : segment.every
          ? segment.indices.map((i) => perTarget[i])
          : [recordValues(segment.indices.map((i) => targets[i]), year)];
    const comparing = segment.indices === null || COMPARISON_CUE_RE.test(segment.text);
    for (const token of readNumbers(segment.text)) {
      if (token.unit === 'yen' && depositInYen(segment.text, token.index)) {
        issues.push({ kind: 'number', token: token.raw });
        continue;
      }
      if (matches(common, token)) continue;
      if (pools.every((pool) => matches(pool, token) || (comparing && matches(diffs, token)))) continue;
      // 質問の条件の復唱（「9万円以内です」「2階以上です」）
      if (token.comparative && asked.some((q) => q.unit === token.unit && q.value === token.value)) continue;
      issues.push({ kind: 'number', token: token.raw });
    }
  }
}

type Allowed = Record<Unit, number[]>;

function emptyAllowed(): Allowed {
  return {
    yen: [], minute: [], sqm: [], floor: [], year: [], yearSpan: [], age: [], months: [],
    month: [], day: [], monthDay: [], ymd: [], position: [], count: [], unknown: [],
  };
}

/** 単位ごとに、回答に書いてよいレコードの値（渡した物件の分）。表示番号と件数は対象物件の全部を通す */
function recordValues(targets: readonly VerifyTarget[], year: number): Allowed {
  const a = emptyAllowed();
  for (const { property: p } of targets) {
    a.yen.push(p.rent, p.managementFee, p.rent + p.managementFee);
    a.minute.push(...p.access.map((x) => x.walkMin));
    a.sqm.push(p.areaSqm);
    a.floor.push(p.floor);
    a.year.push(p.builtYear);
    // 築年数は月までは分からないので、今年 − 築年 とその1つ下を通す
    a.age.push(year - p.builtYear, year - p.builtYear - 1);
    a.yearSpan.push(year - p.builtYear, year - p.builtYear - 1);
    a.months.push(p.depositMonths, p.keyMoneyMonths);
    if (p.availableFrom) {
      const [y, m, d] = p.availableFrom.split('-').map(Number);
      a.year.push(y);
      a.ymd.push(y * 10000 + m * 100 + d);
      a.monthDay.push(m * 100 + d);
      a.month.push(m);
      a.day.push(d);
    }
  }
  return a;
}

/** どの区切りでも通す値: 対象物件の表示番号と件数 */
function positionsAndCounts(targets: readonly VerifyTarget[]): Allowed {
  const a = emptyAllowed();
  for (const { position } of targets) if (position !== null) a.position.push(position);
  for (let n = 1; n <= targets.length; n++) a.count.push(n);
  return a;
}

/** 比較のための物件どうしの差（「2番目のほうが5,000円安い」「3分近い」） */
function differences(targets: readonly VerifyTarget[]): Allowed {
  const a = emptyAllowed();
  for (let i = 0; i < targets.length; i++) {
    for (let j = i + 1; j < targets.length; j++) {
      const p = targets[i].property;
      const q = targets[j].property;
      a.yen.push(Math.abs(p.rent - q.rent), Math.abs(p.rent + p.managementFee - (q.rent + q.managementFee)), Math.abs(p.managementFee - q.managementFee));
      for (const x of p.access) for (const y of q.access) a.minute.push(Math.abs(x.walkMin - y.walkMin));
      a.sqm.push(Math.round(Math.abs(p.areaSqm - q.areaSqm) * 100) / 100);
      a.floor.push(Math.abs(p.floor - q.floor));
      a.yearSpan.push(Math.abs(p.builtYear - q.builtYear));
    }
  }
  return a;
}

function matches(allowed: Allowed, token: NumToken): boolean {
  const pool = allowed[token.unit];
  if (token.unit === 'sqm') return pool.some((v) => Math.abs(v - token.value) < AREA_MATCH_TOLERANCE_SQM);
  return pool.includes(token.value);
}

// ---------- 設備・周辺環境・禁止トピック ----------

type Term =
  /** 有無をレコードで確かめられる語。`invert` は「ユニットバス」（＝バストイレ別でない）のような逆向きの語 */
  | { kind: 'feature'; feature: string; re: RegExp; has: (p: Property) => boolean; invert?: boolean }
  | { kind: 'unknownFacility'; re: RegExp }
  | { kind: 'forbidden'; topic: ForbiddenTopic; re: RegExp };

const tag = (t: Tag) => (p: Property) => p.tags.includes(t);

const TERMS: readonly Term[] = [
  // 語幹はヒアリングと取込のタグ辞書（normalize.ts の TAG_DEFS）の同義語に合わせる。回答文は normalizeText 済み（二人 → 2人）
  { kind: 'feature', feature: 'ペット可', re: /ペット|犬|猫/g, has: tag('ペット可') },
  {
    kind: 'feature',
    feature: 'バストイレ別',
    re: /(?:バス|風呂|浴室|洗い場)(?:と|・|\/)?トイレ|トイレ(?:と|・)?(?:お風呂|風呂|浴室|バス)|B\/?T|セパレート|トイレ別/g,
    has: tag('バストイレ別'),
  },
  { kind: 'feature', feature: 'バストイレ別', re: /ユニットバス|3点ユニット|三点ユニット/g, has: tag('バストイレ別'), invert: true },
  { kind: 'feature', feature: 'オートロック', re: /オートロック|自動ロック/g, has: tag('オートロック') },
  { kind: 'feature', feature: '独立洗面台', re: /洗面|独洗|シャンプードレッサー/g, has: tag('独立洗面台') },
  { kind: 'feature', feature: '室内洗濯機置場', re: /洗濯機|室内洗濯/g, has: tag('室内洗濯機置場') },
  { kind: 'feature', feature: '宅配ボックス', re: /宅配/g, has: tag('宅配ボックス') },
  { kind: 'feature', feature: 'エアコン', re: /エアコン|冷暖房|クーラー|AC(?:付|完備)/g, has: tag('エアコン') },
  { kind: 'feature', feature: 'フローリング', re: /フローリング/g, has: tag('フローリング') },
  {
    kind: 'feature',
    feature: '角部屋',
    re: /角部屋|角住戸|角の(?:お)?部屋|角室|角ルーム|コーナー(?:ルーム|部屋|住戸)/g,
    has: tag('角部屋'),
  },
  { kind: 'feature', feature: '南向き', re: /南向|南面|南側|サウスビュー/g, has: tag('南向き') },
  {
    kind: 'feature',
    feature: '日当たり良好',
    re: /日当たり|日当り|日あたり|陽当たり|陽当り|陽あたり|日照|採光|日差し|日射し|明るい(?:お)?部屋/g,
    has: tag('日当たり良好'),
  },
  { kind: 'feature', feature: '静か', re: /静か|閑静|静寂|静穏|落ち着いた/g, has: tag('静か') },
  { kind: 'feature', feature: '駐輪場', re: /駐輪|自転車|サイクルポート/g, has: tag('駐輪場') },
  {
    kind: 'feature',
    feature: '2人入居可',
    re: /2人入居|2名入居|ふたり入居|2人暮らし|ふたり暮らし|2人で住|カップル|同棲|夫婦|新婚|ルームシェア/g,
    has: tag('2人入居可'),
  },
  { kind: 'feature', feature: '楽器相談可', re: /楽器|ピアノ|ギター|ドラム|バイオリン|ヴァイオリン|サックス|音楽/g, has: tag('楽器相談可') },
  // 入居可能日の言い切り。「即入居可」と言えるのは入居可能日が空（即入居可）の物件だけ（意思決定ログ28）
  {
    kind: 'feature',
    feature: '即入居可',
    re: /即入居|即日入居|すぐ(?:に)?入居|すぐ(?:に)?住め|いつでも入居/g,
    has: (p) => p.availableFrom === null,
  },
  // 「敷礼ゼロ」「ゼロゼロ」は敷金・礼金の両方がゼロのこと（無いと書いたら両方 0 の物件が要る）
  { kind: 'feature', feature: '敷金・礼金', re: /敷礼/g, has: (p) => p.depositMonths > 0 || p.keyMoneyMonths > 0 },
  { kind: 'feature', feature: '敷金・礼金', re: /ゼロゼロ/g, has: (p) => p.depositMonths > 0 || p.keyMoneyMonths > 0, invert: true },
  { kind: 'feature', feature: '敷金', re: /敷金/g, has: (p) => p.depositMonths > 0 },
  { kind: 'feature', feature: '礼金', re: /礼金/g, has: (p) => p.keyMoneyMonths > 0 },
  {
    kind: 'unknownFacility',
    re: /エレベーター|浴室乾燥|追い?焚き|追焚|温水洗浄便座|ウォシュレット|システムキッチン|IH|コンロ|クローゼット|収納|ロフト|バルコニー|ベランダ|駐車場|インターネット|ネット無料|Wi-?Fi|光回線|家具|家電|床暖房|防犯カメラ|モニター付|インターホン|ゴミ置|ゴミ出し|管理人|常駐|都市ガス|プロパン|南東向き|南西向き|北東向き|北西向き|東向き|西向き|北向き|新築|築浅|リノベ|リフォーム|デザイナーズ|分譲|コンビニ|スーパー|ドラッグストア|公園|学校|病院|商店街|繁華街|眺望|眺め/g,
  },
  { kind: 'forbidden', topic: 'vacancy', re: /空室|空き状況|空き部屋|空いて|募集中|成約|申し?込み(?:可能|できます)/g },
  { kind: 'forbidden', topic: 'initialCostTotal', re: /初期費用|契約金|総額|仲介手数料|保険料|鍵交換/g },
  { kind: 'forbidden', topic: 'safety', re: /治安|犯罪|物騒/g },
  { kind: 'forbidden', topic: 'noise', re: /騒音|うるさ|防音|騒がし|騒々し|音(?:が|は|も)(?:気|響|聞こえ)/g },
  { kind: 'forbidden', topic: 'screening', re: /審査|保証会社|保証人/g },
  { kind: 'forbidden', topic: 'neighbors', re: /近隣|住人|住民|隣人|入居者層/g },
];

type Polarity = 'present' | 'absent' | 'neutral';

/** 「記載がありません」「分かりかねます」など、レコードに無いと言う言い回し */
const NOT_IN_RECORD_RE =
  /記載(?:が|は)?(?:ありません|ない|なく|ございません)|情報(?:が|は)?(?:ありません|ない|なく|ございません)|分かりかね|わかりかね|お答えでき|お伝えでき|確認でき(?:ません|ない|かね)|不明|分かりません|わかりません/;
/**
 * 有無を言っていない文脈（レコードに無い・担当者が確認する）。「確認」は担当者がこれから確かめる形だけで、
 * 「ご確認ください」「確認済み」「確認できます」は有無を言っているので含めない
 */
const NEUTRAL_RE = new RegExp(`${NOT_IN_RECORD_RE.source}|(?<!ご)確認(?:します|いたします|して(?!ください|いただ)|が必要|中)|問い合わせ`);
/** 無いことを言う述語 */
const ABSENT_RE = /ない|無い|なし|無し|なく|無く|ません|不可|NG|非対応|未対応|禁止|ご遠慮|対象外|(?<!\d)0か月|ゼロ/;
/** 否定の形だが有無を言っていない言い回し（「〜だけでなく」「問題ない」「手間が少ない」「飼ってもかまいません」） */
const NOT_NEGATION_RE =
  /だけで(?:は)?なく|だけじゃなく|のみならず|(?:問題|心配|間違い)(?:は|が)?(?:ない|なく|ありません)|少な(?:い|く)|(?:かま|構)いません/g;
/**
 * 文の述語の終わり（語の極性はここまでを見る）。理由・逆接の接続（ので・から・けど）でも区切る。
 * 「から」は述語に続く理由の形（あるから・ないから）だけで、「駅から」「物件情報から」では区切らない
 */
const PREDICATE_END_RE = /ます|ません|です|でした|ので|(?<=[るいただす])から|けれど|けど|ため|[。！？!?\n]/g;
/** 有無を言う語と数値（並べた語のあいだにこれがあれば、そこで極性が決まる。無ければ後ろの述語を共有する） */
const PREDICATE_WORD_RE = /不可|可|あり|ある|ない|なし|無し|なく|付き|つき|OK|NG|対応|\d/;
/**
 * 語に直接付いて名詞句を作る有無の語（「敷金なしが載っています」「ペット可、…」）。後ろに助詞や読点が続くときは
 * その語だけのもので、前に並べた語は飛ばして列挙の後ろの述語を共有する（「オートロック、…、敷金なしが載っています」の
 * オートロックを「なし」と読まない。意思決定ログ26）。「宅配ボックスなしです」のように述語で終わる形は共有のまま
 */
const ATTACHED_PREDICATE_RE = /^(?:なし|無し|あり|有り|付き|つき|不可|可|OK|NG)(?=[がをもはと、・,])/;

interface TermSpan extends Span {
  term: Term;
}

function findTerms(sentence: string): TermSpan[] {
  const spans: TermSpan[] = [];
  for (const term of TERMS) {
    for (const m of sentence.matchAll(term.re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (!spans.some((s) => start < s.end && end > s.start)) spans.push({ start, end, word: m[0], term });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** 語の後ろから述語の終わりまで（並べた語は飛ばして後ろの述語を共有する）を見て、ある／ない／記載なし を決める */
function polarityAt(sentence: string, spans: readonly TermSpan[], index: number): Polarity {
  let pos = spans[index].end;
  let window = '';
  for (let next = index + 1; ; next++) {
    PREDICATE_END_RE.lastIndex = pos;
    const end = PREDICATE_END_RE.exec(sentence);
    const predicateEnd = end ? end.index + end[0].length : sentence.length;
    const nextStart = next < spans.length ? spans[next].start : Infinity;
    if (predicateEnd <= nextStart) {
      window += sentence.slice(pos, predicateEnd);
      break;
    }
    const between = sentence.slice(pos, nextStart).replace(NOT_NEGATION_RE, '');
    window += between;
    if (PREDICATE_WORD_RE.test(between)) break;
    pos = spans[next].end;
    pos += ATTACHED_PREDICATE_RE.exec(sentence.slice(pos))?.[0].length ?? 0;
  }
  window = window.replace(NOT_NEGATION_RE, '');
  if (NEUTRAL_RE.test(window)) return 'neutral';
  return ABSENT_RE.test(window) ? 'absent' : 'present';
}

/** 区切りの主語に当たる物件（主語が分からなければ全部）と、全部に当てはまることを求めるか */
function subjectOf(segment: Segment, properties: readonly Property[]): { properties: readonly Property[]; every: boolean } {
  if (segment.indices === null) return { properties, every: false };
  return { properties: segment.indices.map((i) => properties[i]), every: segment.every };
}

/** 語を極性つきで書いたことを照合する（設備はレコードと、レコードに無い設備と禁止トピックは書いたこと自体を問題にする） */
function judgeTerm(
  term: Term,
  word: string,
  polarity: 'present' | 'absent',
  subject: { properties: readonly Property[]; every: boolean },
  issues: VerifyIssue[],
): void {
  if (term.kind === 'unknownFacility') {
    issues.push({ kind: 'unknownFacility', word });
  } else if (term.kind === 'forbidden') {
    issues.push({ kind: 'forbidden', topic: term.topic });
  } else {
    const claimed: 'present' | 'absent' = (polarity === 'present') !== Boolean(term.invert) ? 'present' : 'absent';
    const holds = (p: Property) => (claimed === 'present' ? term.has(p) : !term.has(p));
    const ok = subject.every ? subject.properties.every(holds) : subject.properties.some(holds);
    if (!ok) issues.push({ kind: 'feature', feature: term.feature, claimed });
  }
}

function checkTerms(segments: readonly Segment[], properties: readonly Property[], issues: VerifyIssue[]): void {
  for (const segment of segments) {
    const subject = subjectOf(segment, properties);
    for (const sentence of segment.text.split(/(?<=[。！？!?\n])/)) {
      const spans = findTerms(sentence);
      spans.forEach((span, i) => {
        const polarity = polarityAt(sentence, spans, i);
        if (polarity !== 'neutral') judgeTerm(span.term, span.word, polarity, subject, issues);
      });
    }
  }
}

// ---------- 主語を省いた答え（意思決定ログ27） ----------

/** 質問の前提を打ち消す言い回し（「いいえ、そうではありません」）。「ません」の否定より先に見る */
const DENY_RE = /違います|ちがいます|そうではありません|そうではない|そうじゃない/;
/** 有ることを言う述語（「はい、付いています」「飼えます」） */
const AFFIRM_RE =
  /あります|ございます|付いています|ついています|付いてます|ついてます|付きです|つきです|完備|設置されています|可能です|できます|大丈夫です|OKです|可です|使えます|飼えます|置けます|住めます|弾けます/;
/** 質問の前提に同意する言い回し（「はい」「そうです」）。答えの極性は質問の極性と同じ */
const CONFIRM_RE = /^(?:はい|ええ)|そうです|その通り|そのとおり|おっしゃる通り|おっしゃるとおり/;

type EllipticalClaim = 'present' | 'absent' | 'confirm' | 'deny' | 'neutral';

function ellipticalClaim(text: string): EllipticalClaim | null {
  const t = text.replace(NOT_NEGATION_RE, '');
  if (NEUTRAL_RE.test(t)) return 'neutral';
  if (DENY_RE.test(t)) return 'deny';
  if (ABSENT_RE.test(t)) return 'absent';
  if (AFFIRM_RE.test(t)) return 'present';
  if (CONFIRM_RE.test(t.replaceAll(SEP, '').trim())) return 'confirm';
  if (/^いいえ/.test(t.trim())) return 'deny';
  return null;
}

function sameTerm(a: Term, b: Term): boolean {
  if (a === b) return true;
  if (a.kind === 'feature' && b.kind === 'feature') return a.feature === b.feature;
  if (a.kind === 'forbidden' && b.kind === 'forbidden') return a.topic === b.topic;
  return false;
}

/**
 * 質問の語に触れずに答えた区切り（「はい、付いています」「いいえ、ありません」「そうです」「エントランスに電子錠が付いています」）を、
 * 質問の語について言ったものとして照合する。回答のどこかで質問の語を書いていれば、そちら（checkTerms）で見るので使わない。
 * 見るのは、語を含まない区切りのうち有無を言った最初の1つだけ（「内見もできます」のような後の文を質問の答えにしない）
 */
function checkElliptical(segments: readonly Segment[], question: string, properties: readonly Property[], issues: VerifyIssue[]): void {
  const asked: { term: Term; word: string; polarity: Polarity }[] = [];
  for (const sentence of question.split(/(?<=[。！？!?\n])/)) {
    const spans = findTerms(sentence);
    spans.forEach((span, i) => asked.push({ term: span.term, word: span.word, polarity: polarityAt(sentence, spans, i) }));
  }
  const mentioned = segments.flatMap((s) => findTerms(s.text).map((span) => span.term));
  const unanswered = asked.filter((a) => !mentioned.some((m) => sameTerm(m, a.term)));
  if (unanswered.length === 0) return;

  for (const segment of segments) {
    if (findTerms(segment.text).length > 0) continue;
    const claim = ellipticalClaim(segment.text);
    if (claim === null) continue;
    if (claim === 'neutral') return;
    const subject = subjectOf(segment, properties);
    for (const a of unanswered) {
      const polarity =
        claim === 'confirm' ? a.polarity : claim === 'deny' ? (a.polarity === 'present' ? 'absent' : a.polarity === 'absent' ? 'present' : 'neutral') : claim;
      if (polarity !== 'neutral') judgeTerm(a.term, a.word, polarity, subject, issues);
    }
    return;
  }
}
