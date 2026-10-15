import { describe, expect, it } from 'vitest';
import { makeProperty } from './fixtures';
import { TAGS, type Property } from './types';
import { ANSWER_MAX_CHARS } from './rules';
import { readNumbers, saysNotInRecord, verifyAnswer, type VerifyTarget } from './verify';

/** JST 2026-10-10。築年数は 2026 − 築年で数える */
const NOW = new Date('2026-10-10T03:00:00Z');

/** 回答の対象にする物件（実データの雰囲気: data/properties.csv の P0001 に寄せている） */
const MOMIJI = makeProperty({
  name: 'もみじフラット',
  address: '目黒区もみじ丘2-14',
  ward: '目黒区',
  access: [{ station: '中目黒', walkMin: 10 }],
  rent: 81000,
  managementFee: 4000,
  depositMonths: 1,
  keyMoneyMonths: 1,
  layout: '1DK',
  areaSqm: 27.9,
  floor: 2,
  builtYear: 2009,
  tags: ['エアコン', '静か', 'バストイレ別', '独立洗面台', '室内洗濯機置場', 'フローリング'],
  availableFrom: '2026-11-01',
});

/** 比較の相手。MOMIJI との差は 家賃 11,000・月額 10,000・管理費 1,000・徒歩 4/2 分・面積 5.9㎡・築 6 年・階 3 */
const TSUBAKI = makeProperty({
  name: 'つばきハイツ',
  address: '渋谷区つばき町4-17',
  ward: '渋谷区',
  access: [
    { station: '渋谷', walkMin: 6 },
    { station: '原宿', walkMin: 12 },
  ],
  rent: 70000,
  managementFee: 5000,
  depositMonths: 0,
  keyMoneyMonths: 0,
  layout: '1K',
  areaSqm: 22,
  floor: 5,
  builtYear: 2015,
  tags: ['ペット可', 'オートロック'],
  availableFrom: null,
});

/** タグがそろった物件（設備の「ない」を言わせたい試験用） */
const FULL = makeProperty({
  name: 'そろい荘',
  address: '新宿区そろい町1-1',
  ward: '新宿区',
  access: [{ station: '新宿', walkMin: 3 }],
  tags: [...TAGS],
});

const at = (property: Property, position: number | null = 1): VerifyTarget => ({ property, position });
const pair = [at(MOMIJI, 1), at(TSUBAKI, 2)];

interface Case {
  name: string;
  text: string;
  question?: string;
  /** 省略時は MOMIJI だけ（1番目） */
  targets?: VerifyTarget[];
}

interface IssueCase extends Case {
  /** 含まれているべき issue（kind と主なフィールドだけ） */
  issue: Record<string, unknown>;
}

function run(c: Case) {
  return verifyAnswer({ text: c.text, question: c.question ?? '', targets: c.targets ?? [at(MOMIJI)], now: NOW });
}

function expectOk(c: Case) {
  const result = run(c);
  expect(result.issues).toEqual([]);
  expect(result.ok).toBe(true);
}

function expectIssue(c: IssueCase) {
  const result = run(c);
  expect(result.ok).toBe(false);
  expect(result.issues).toContainEqual(expect.objectContaining(c.issue));
}

describe('通す（レコードどおりの回答）', () => {
  describe('金額', () => {
    const cases: Case[] = [
      { name: '家賃 81,000円', text: '家賃は81,000円です。' },
      { name: '家賃 8.1万円', text: '家賃は8.1万円です。' },
      { name: '家賃 8万1千円', text: '家賃は8万1千円です。' },
      { name: '家賃 全角数字', text: '家賃は８１，０００円です。' },
      { name: '管理費 4,000円', text: '管理費は4,000円です。' },
      { name: '管理費 0.4万円', text: '管理費は0.4万円です。' },
      { name: '管理費 4千円', text: '管理費は4千円です。' },
      { name: '月額 85,000円', text: '月額は85,000円です。' },
      { name: '月額 8.5万円', text: '月額は8.5万円です。' },
      { name: '月額 8万5千円', text: '月額は8万5千円です。' },
      { name: '月額 8万5000円', text: '月額は8万5000円です。' },
      { name: '家賃・管理費・月額を並べる', text: '家賃は81,000円、管理費は4,000円で、月額は85,000円です。' },
    ];
    it.each(cases)('$name', expectOk);
  });

  describe('徒歩・面積・階・築年', () => {
    const cases: Case[] = [
      { name: '徒歩10分', text: '中目黒駅から徒歩10分です。' },
      { name: '徒歩 空白入り', text: '中目黒駅から徒歩 10 分です。' },
      { name: '面積 27.9㎡', text: '面積は27.9㎡です。' },
      { name: '面積 27.9平米', text: '面積は27.9平米です。' },
      { name: '面積 27.9平方メートル', text: '面積は27.9平方メートルです。' },
      { name: '面積 27.9m2', text: '面積は27.9m2です。' },
      { name: '面積 全角数字の平米', text: '面積は２７．９平米です。' },
      { name: '2階', text: '2階のお部屋です。' },
      { name: '階 全角数字', text: '２階のお部屋です。' },
      { name: '2009年築', text: '2009年築です。' },
      { name: '築17年', text: '築17年です。' },
      { name: '築16年（月までは分からないので1つ下も通す）', text: '築16年です。' },
      { name: '築17年（2009年築）', text: '築17年(2009年築)です。' },
    ];
    it.each(cases)('$name', expectOk);

    it('築年数は JST の年で数える（UTC では 2026 でも JST で 2027 なら築18年）', () => {
      const jstNewYear = new Date('2026-12-31T16:00:00Z');
      const text = '築18年です。';
      expect(verifyAnswer({ text, question: '', targets: [at(MOMIJI)], now: jstNewYear }).ok).toBe(true);
      expect(verifyAnswer({ text, question: '', targets: [at(MOMIJI)], now: NOW }).ok).toBe(false);
    });
  });

  describe('敷金・礼金・入居可能日', () => {
    const spellings = ['か月', 'ヶ月', 'ケ月', 'カ月', 'ヵ月', '箇月', 'ヶ 月'];
    const monthCases: Case[] = spellings.map((u) => ({
      name: `敷金・礼金 1${u}`,
      text: `敷金は1${u}、礼金は1${u}です。`,
    }));
    it.each(monthCases)('$name', expectOk);

    const cases: Case[] = [
      { name: '入居可能日 2026年11月1日', text: '2026年11月1日から入居できます。' },
      { name: '入居可能日 11月1日', text: '11月1日から入居できます。' },
      { name: '入居可能日 11月', text: '11月から入居できます。' },
    ];
    it.each(cases)('$name', expectOk);
  });

  describe('表示番号・件数', () => {
    const cases: Case[] = [
      { name: '1番目（カード内の物件）', text: '1番目の物件は家賃81,000円です。' },
      { name: '2番目（比較）', text: '2番目の物件は家賃70,000円です。', targets: pair },
      { name: '2件とも（対象が2つ）', text: '2件とも駅から徒歩圏内です。', targets: pair },
    ];
    it.each(cases)('$name', expectOk);
  });

  describe('物件名・住所・間取り・駅', () => {
    const named = makeProperty({
      name: 'ハイツ第2ひなた',
      address: '豊島区ひなた町1-10',
      ward: '豊島区',
      access: [{ station: '駒込', walkMin: 4 }],
      layout: '1R',
    });
    const stationInName = makeProperty({
      name: 'ヴィラ渋谷',
      address: '新宿区かえで町3-5',
      ward: '新宿区',
      access: [{ station: '新宿', walkMin: 3 }],
    });
    const cases: Case[] = [
      { name: '物件名と住所は表記どおりなら通す', text: 'もみじフラットは目黒区もみじ丘2-14にあります。' },
      {
        name: '物件名の「第2」と住所の番地を数値として照合しない',
        text: 'ハイツ第2ひなたは豊島区ひなた町1-10にあり、駒込駅から徒歩4分です。',
        targets: [at(named)],
      },
      {
        name: '物件名に入った駅名（ヴィラ渋谷）を駅として照合しない',
        text: 'ヴィラ渋谷は新宿駅から徒歩3分です。',
        targets: [at(stationInName)],
      },
      { name: '間取り 1DK', text: '間取りは1DKです。' },
      { name: '間取りと面積を並べる', text: '1DKで、面積は27.9㎡です。' },
      {
        name: '質問に出た間取りは繰り返してよい',
        text: '1LDKではなく1DKのお部屋です。',
        question: '1LDKはありますか？',
      },
      {
        name: '質問に出た駅名は繰り返してよい',
        text: '渋谷駅は最寄り駅ではありません。最寄りは中目黒駅です。',
        question: '渋谷駅は近いですか？',
      },
      { name: '質問に出た区名は繰り返してよい', text: '渋谷区ではなく目黒区です。', question: '渋谷区ですか？' },
      {
        name: '複数物件ならどちらかの駅・区でよい',
        text: 'もみじフラットは中目黒駅、つばきハイツは渋谷駅と原宿駅が最寄りです。',
        targets: pair,
      },
    ];
    it.each(cases)('$name', expectOk);
  });

  describe('設備（タグ）', () => {
    const cases: Case[] = [
      { name: 'エアコンがあります', text: 'エアコンがあります。' },
      { name: 'バス・トイレ別です', text: 'バス・トイレ別です。' },
      { name: '周辺は静かです', text: '周辺は静かです。' },
      { name: '独立洗面台があります', text: '独立洗面台があります。' },
      { name: '室内に洗濯機置場があります', text: '室内に洗濯機置場があります。' },
      { name: 'フローリングです', text: 'お部屋はフローリングです。' },
      { name: 'タグに無い オートロックはありません', text: 'オートロックはありません。' },
      { name: 'タグに無い 宅配ボックスはありません', text: '宅配ボックスはありません。' },
      { name: 'タグに無い ペットは不可です', text: 'ペットは不可です。' },
      { name: 'ペットは相談できません（確認の文脈）', text: 'ペットは確認できません。' },
      { name: '敷金・礼金は1か月ずつ', text: '敷金は1か月、礼金は1か月です。' },
      {
        name: '敷金の無い物件は敷金なしと書いてよい',
        text: '敷金・礼金はありません。',
        targets: [at(TSUBAKI)],
      },
      {
        name: 'ユニットバスではありません（バストイレ別の言い換え）',
        text: 'ユニットバスではありません。',
      },
    ];
    it.each(cases)('$name', expectOk);
  });

  describe('タグに無い設備・周辺と禁止トピックは「記載なし」「担当者が確認」の文脈なら通す', () => {
    const cases: Case[] = [
      { name: 'エレベーターは記載がありません', text: 'エレベーターについては記載がありません。' },
      { name: '駐車場の情報はありません', text: '駐車場の情報はありません。' },
      { name: 'コンビニは担当者が確認します', text: '近くのコンビニについては担当者が確認します。' },
      { name: 'ペットの可否は記載がありません', text: 'ペットの可否は記載がありません。' },
      { name: '空室状況は担当者が確認します', text: '空室状況は担当者が確認します。' },
      { name: '治安は担当者が確認します', text: '治安については担当者が確認します。' },
      { name: '審査は担当者が確認してご連絡します', text: '審査については担当者が確認してご連絡します。' },
      { name: '初期費用の総額は担当者が確認します', text: '初期費用の総額は担当者が確認します。' },
      { name: '騒音は担当者が確認します', text: '騒音については担当者が確認します。' },
      { name: '近隣の様子は担当者が確認します', text: '近隣の様子は担当者が確認します。' },
    ];
    it.each(cases)('$name', expectOk);
  });

  describe('比較（2物件）の差', () => {
    const cases: Case[] = [
      { name: '家賃差 11,000円', text: '2番目のほうが家賃が11,000円安いです。', targets: pair },
      { name: '月額差 10,000円', text: '月額では10,000円の差です。', targets: pair },
      { name: '月額差 1万円', text: '月額では1万円の差です。', targets: pair },
      { name: '管理費差 1,000円', text: '管理費は1,000円の差です。', targets: pair },
      { name: '徒歩の差 4分', text: '徒歩は2番目のほうが4分近いです。', targets: pair },
      { name: '徒歩の差 2分（別の駅との差）', text: '原宿駅へは2分の差です。', targets: pair },
      { name: '面積の差 5.9㎡', text: '面積は1番目が5.9㎡広いです。', targets: pair },
      { name: '築年の差 6年', text: '築年は6年違います。', targets: pair },
      { name: '築年の差 6年新しい', text: '2番目のほうが6年新しいです。', targets: pair },
      { name: '階の差 3階', text: '階は3階違います。', targets: pair },
      {
        name: '両方の値を並べる',
        text: '1番目のもみじフラットは家賃81,000円、2番目のつばきハイツは家賃70,000円です。',
        targets: pair,
      },
      {
        name: '設備はどちらかにあればよい（オートロックは2番目のみ）',
        text: 'オートロックは2番目のみです。',
        targets: pair,
      },
    ];
    it.each(cases)('$name', expectOk);
  });

  describe('質問の数値は比較の形で繰り返してよい（条件の復唱）', () => {
    const cases: Case[] = [
      { name: '9万円以内（質問 9万以内）', text: '9万円以内です。', question: '9万以内？' },
      { name: '9万円以内（質問 9万円以内）', text: 'ご予算は9万円以内ですね。', question: '9万円以内で探せますか？' },
      { name: '8万円以下', text: '8万円以下のご希望ですね。', question: '8万円以下がいいです' },
      {
        name: '3階以上（レコードは2階）',
        text: '3階以上のご希望ですが、この物件は2階です。',
        question: '3階以上ですか？',
      },
      {
        name: '徒歩5分以内（レコードは10分）',
        text: '徒歩5分以内のご希望ですが、この物件は徒歩10分です。',
        question: '駅徒歩5分以内がいいです',
      },
      { name: '全角の質問でも比較できる', text: '9万円以内です。', question: '９万以内？' },
    ];
    it.each(cases)('$name', expectOk);
  });

  describe('並べた語は後ろの述語を共有する', () => {
    const cases: Case[] = [
      { name: 'オートロック・宅配ボックスはありません', text: 'オートロック・宅配ボックスはありません。' },
      { name: 'オートロックと宅配ボックスはありません', text: 'オートロックと宅配ボックスはありません。' },
      { name: 'オートロックも宅配ボックスもありません', text: 'オートロックも宅配ボックスもありません。' },
      { name: 'オートロックや宅配ボックスは記載がありません', text: 'オートロックや宅配ボックスは記載がありません。' },
      { name: 'エアコンもフローリングもあります', text: 'エアコンもフローリングもあります。' },
      { name: 'エアコンとフローリングがあります', text: 'エアコンとフローリングがあります。' },
      { name: '文の途中で述語が変わる', text: 'エアコンとフローリングがあり、オートロックはありません。' },
      { name: '逆接をはさむ', text: 'エアコンはありますが、オートロックはありません。' },
    ];
    it.each(cases)('$name', expectOk);
  });

  describe('「〜だけでなく〜もあります」は否定として読まない', () => {
    const cases: Case[] = [
      { name: 'エアコンだけでなくフローリングもあります', text: 'エアコンだけでなくフローリングもあります。' },
      { name: 'エアコンだけではなくフローリングもあります', text: 'エアコンだけではなくフローリングもあります。' },
      { name: 'エアコンのみならずフローリングもあります', text: 'エアコンのみならずフローリングもあります。' },
    ];
    it.each(cases)('$name', expectOk);
  });

  it('ok のときは issues が空', () => {
    const result = run({ name: '', text: '家賃は81,000円で、エアコンがあります。' });
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it('800字ちょうどは通す', () => {
    expect(run({ name: '', text: 'あ'.repeat(ANSWER_MAX_CHARS) }).ok).toBe(true);
  });
});

describe('落とす（レコードに無い記述）', () => {
  describe('数値', () => {
    const cases: IssueCase[] = [
      { name: 'レコードに無い家賃（9万円）', text: '家賃は9万円です。', issue: { kind: 'number', token: '9万円' } },
      { name: 'レコードに無い家賃（82,000円）', text: '家賃は82,000円です。', issue: { kind: 'number', token: '82,000円' } },
      { name: 'レコードに無い管理費', text: '管理費は5,000円です。', issue: { kind: 'number', token: '5,000円' } },
      { name: 'レコードに無い月額', text: '月額は90,000円です。', issue: { kind: 'number', token: '90,000円' } },
      { name: 'レコードに無い徒歩分', text: '中目黒駅から徒歩12分です。', issue: { kind: 'number', token: '12分' } },
      { name: 'レコードに無い面積', text: '面積は30㎡です。', issue: { kind: 'number', token: '30㎡' } },
      { name: 'レコードに無い面積（平米）', text: '面積は30平米です。', issue: { kind: 'number', token: '30㎡' } },
      { name: '0.1㎡ずれた面積', text: '面積は27.8㎡です。', issue: { kind: 'number', token: '27.8㎡' } },
      { name: 'レコードに無い階', text: '5階のお部屋です。', issue: { kind: 'number', token: '5階' } },
      { name: 'レコードに無い築年（西暦）', text: '2012年築です。', issue: { kind: 'number', token: '2012年' } },
      { name: 'レコードに無い築年数', text: '築5年です。', issue: { kind: 'number', token: '築5年' } },
      { name: '築年数が2つ以上ずれている', text: '築15年です。', issue: { kind: 'number', token: '築15年' } },
      { name: 'レコードに無い敷金の月数', text: '敷金は2か月です。', issue: { kind: 'number', token: '2か月' } },
      {
        name: 'レコードに無い入居可能日',
        text: '2026年12月1日から入居できます。',
        issue: { kind: 'number', token: '2026年12月1日' },
      },
      { name: 'レコードに無い入居月日', text: '12月1日から入居できます。', issue: { kind: 'number', token: '12月1日' } },
      {
        name: '表示番号が無い物件（カード外）の「1番目」',
        text: '1番目の物件です。',
        targets: [at(MOMIJI, null)],
        issue: { kind: 'number', token: '1番目' },
      },
      { name: '対象より多い件数', text: '2件とも静かです。', issue: { kind: 'number', token: '2件' } },
      { name: '住所の番地の言い間違い', text: '目黒区もみじ丘3-1にあります。', issue: { kind: 'number', token: '3' } },
    ];
    it.each(cases)('$name', expectIssue);
  });

  describe('単位の無い数値・照合できない単位・漢数字', () => {
    const cases: IssueCase[] = [
      { name: '単位の無い数値（81000）', text: '家賃は81000です。', issue: { kind: 'number', token: '81000' } },
      { name: '24時間', text: '24時間対応です。', issue: { kind: 'number', token: '24' } },
      { name: '400m', text: '駅まで400mです。', issue: { kind: 'number', token: '400' } },
      // 単位つきの漢数字はヒアリングと同じ正規化で算用数字にしてから照合する（徒歩10分・家賃81,000円の物件）
      { name: '漢数字の徒歩（五分）', text: '徒歩五分です。', issue: { kind: 'number', token: '5分' } },
      { name: '漢数字の家賃（八万円）', text: '家賃は八万円です。', issue: { kind: 'number', token: '8万円' } },
    ];
    it.each(cases)('$name', expectIssue);
    it('漢数字でもレコードどおりなら通す（二階 → 2階）', () => {
      expectOk({ name: '二階', text: '二階のお部屋です。' });
    });
  });

  describe('質問の数値の繰り返しは比較の形のときだけ', () => {
    const cases: IssueCase[] = [
      {
        name: '「家賃5万円ですよね？」に「家賃は5万円です」',
        text: '家賃は5万円です。',
        question: '家賃5万円ですよね？',
        issue: { kind: 'number', token: '5万円' },
      },
      {
        name: '質問が9万以内でも、単位が違えば通さない（9分）',
        text: '徒歩9分です。',
        question: '9万以内？',
        issue: { kind: 'number', token: '9分' },
      },
      {
        name: '質問と値が違う比較形（9万円以内の質問に8万円以内）',
        text: '8万円以内です。',
        question: '9万以内？',
        issue: { kind: 'number', token: '8万円' },
      },
    ];
    it.each(cases)('$name', expectIssue);
  });

  describe('別の物件の値（比較の対象にない物件）', () => {
    const cases: IssueCase[] = [
      { name: '別の物件の家賃', text: '家賃は70,000円です。', issue: { kind: 'number', token: '70,000円' } },
      { name: '別の物件の徒歩分', text: '徒歩6分です。', issue: { kind: 'number', token: '6分' } },
      { name: '別の物件の面積', text: '面積は22㎡です。', issue: { kind: 'number', token: '22㎡' } },
      { name: '別の物件の築年の差（対象が1件なら差は無い）', text: '築年は6年違います。', issue: { kind: 'number', token: '6年' } },
      { name: '別の物件の駅', text: '渋谷駅が最寄りです。', issue: { kind: 'station', station: '渋谷' } },
      { name: '別の物件の区', text: '渋谷区にあります。', issue: { kind: 'ward', ward: '渋谷区' } },
    ];
    it.each(cases)('$name', expectIssue);
  });

  describe('設備（タグ）の有無が食い違う', () => {
    const cases: IssueCase[] = [
      {
        name: 'タグに無い設備の「あります」（オートロック）',
        text: 'オートロックがあります。',
        issue: { kind: 'feature', feature: 'オートロック', claimed: 'present' },
      },
      {
        name: 'タグに無い設備の「付き」（宅配ボックス）',
        text: '宅配ボックス付きです。',
        issue: { kind: 'feature', feature: '宅配ボックス', claimed: 'present' },
      },
      {
        name: 'タグに無い設備のペット可',
        text: 'ペット可です。',
        issue: { kind: 'feature', feature: 'ペット可', claimed: 'present' },
      },
      {
        name: 'タグに無い設備のペット相談',
        text: 'ペットは相談できます。',
        issue: { kind: 'feature', feature: 'ペット可', claimed: 'present' },
      },
      {
        name: 'タグにある設備の「ありません」（エアコン）',
        text: 'エアコンはありません。',
        issue: { kind: 'feature', feature: 'エアコン', claimed: 'absent' },
      },
      {
        name: 'タグにある設備の「なし」（洗濯機置場）',
        text: '洗濯機置場なしです。',
        issue: { kind: 'feature', feature: '室内洗濯機置場', claimed: 'absent' },
      },
      {
        name: 'タグにある設備の「不可」（フローリング）',
        text: 'フローリングは不可です。',
        issue: { kind: 'feature', feature: 'フローリング', claimed: 'absent' },
      },
      {
        name: 'タグにある設備の「ない」（独立洗面台）',
        text: '洗面台がない物件です。',
        issue: { kind: 'feature', feature: '独立洗面台', claimed: 'absent' },
      },
      {
        name: 'タグにある設備の否定（静かではありません）',
        text: '静かではありません。',
        issue: { kind: 'feature', feature: '静か', claimed: 'absent' },
      },
      {
        name: 'バストイレ別の物件を「ユニットバスです」',
        text: 'ユニットバスです。',
        issue: { kind: 'feature', feature: 'バストイレ別', claimed: 'absent' },
      },
      {
        name: 'バストイレ別の物件を「バス・トイレ別ではありません」',
        text: 'バス・トイレ別ではありません。',
        issue: { kind: 'feature', feature: 'バストイレ別', claimed: 'absent' },
      },
      {
        name: 'バストイレ別でない物件を「バス・トイレ別です」',
        text: 'バス・トイレ別です。',
        targets: [at(TSUBAKI)],
        issue: { kind: 'feature', feature: 'バストイレ別', claimed: 'present' },
      },
      {
        name: 'ユニットバスの物件を「ユニットバスではありません」',
        text: 'ユニットバスではありません。',
        targets: [at(TSUBAKI)],
        issue: { kind: 'feature', feature: 'バストイレ別', claimed: 'present' },
      },
      {
        name: '敷金1か月の物件を「敷金なし」',
        text: '敷金なしです。',
        issue: { kind: 'feature', feature: '敷金', claimed: 'absent' },
      },
      {
        name: '礼金1か月の物件を「礼金はありません」',
        text: '礼金はありません。',
        issue: { kind: 'feature', feature: '礼金', claimed: 'absent' },
      },
      {
        name: '敷金・礼金なしの物件を「敷金は1か月」',
        text: '敷金は1か月です。',
        targets: [at(TSUBAKI)],
        issue: { kind: 'feature', feature: '敷金', claimed: 'present' },
      },
      {
        name: '2物件のどちらにも無い設備（宅配ボックス）',
        text: '宅配ボックスがあります。',
        targets: pair,
        issue: { kind: 'feature', feature: '宅配ボックス', claimed: 'present' },
      },
      {
        name: '全物件がタグを持つ設備の「ありません」（ペット可）',
        text: 'ペットは不可です。',
        targets: [at(FULL)],
        issue: { kind: 'feature', feature: 'ペット可', claimed: 'absent' },
      },
      {
        name: '並べた語の否定共有で、タグにある設備まで否定してしまう',
        text: 'エアコン・オートロックはありません。',
        issue: { kind: 'feature', feature: 'エアコン', claimed: 'absent' },
      },
      {
        name: '「ありますが」のあとの別の語の否定（ペットは不可）',
        text: 'オートロックはありますが、ペットは不可です。',
        targets: [at(FULL)],
        issue: { kind: 'feature', feature: 'ペット可', claimed: 'absent' },
      },
    ];
    it.each(cases)('$name', expectIssue);
  });

  describe('レコードに項目の無い設備・周辺を肯定する（unknownFacility）', () => {
    const cases: IssueCase[] = [
      { name: 'エレベーターがあります', text: 'エレベーターがあります。', issue: { kind: 'unknownFacility', word: 'エレベーター' } },
      { name: 'エレベーターはありません（無いことも根拠が無い）', text: 'エレベーターはありません。', issue: { kind: 'unknownFacility', word: 'エレベーター' } },
      { name: '駐車場があります', text: '駐車場があります。', issue: { kind: 'unknownFacility', word: '駐車場' } },
      { name: '近くにコンビニがあります', text: '近くにコンビニがあります。', issue: { kind: 'unknownFacility', word: 'コンビニ' } },
      { name: 'ロフト付き', text: 'ロフト付きです。', issue: { kind: 'unknownFacility', word: 'ロフト' } },
      { name: 'バルコニー付き', text: 'バルコニー付きです。', issue: { kind: 'unknownFacility', word: 'バルコニー' } },
      { name: 'インターネット無料', text: 'インターネット無料です。', issue: { kind: 'unknownFacility', word: 'インターネット' } },
      { name: '浴室乾燥機', text: '浴室乾燥機が付いています。', issue: { kind: 'unknownFacility', word: '浴室乾燥' } },
    ];
    it.each(cases)('$name', expectIssue);
  });

  describe('禁止トピックの断定', () => {
    const cases: IssueCase[] = [
      { name: '治安が良い', text: '治安は良いです。', issue: { kind: 'forbidden', topic: 'safety' } },
      { name: '空室あり', text: '空室があります。', issue: { kind: 'forbidden', topic: 'vacancy' } },
      { name: '空いています', text: '現在空いています。', issue: { kind: 'forbidden', topic: 'vacancy' } },
      { name: '騒音は気にならない', text: '騒音は気になりません。', issue: { kind: 'forbidden', topic: 'noise' } },
      { name: '防音性が高い', text: '防音性は高いです。', issue: { kind: 'forbidden', topic: 'noise' } },
      { name: '審査は通りやすい', text: '審査は通りやすいです。', issue: { kind: 'forbidden', topic: 'screening' } },
      { name: '保証人は不要', text: '保証人は不要です。', issue: { kind: 'forbidden', topic: 'screening' } },
      { name: '初期費用の確定額', text: '初期費用は約20万円です。', issue: { kind: 'forbidden', topic: 'initialCostTotal' } },
      { name: '近隣は静か', text: '近隣の方は静かです。', issue: { kind: 'forbidden', topic: 'neighbors' } },
    ];
    it.each(cases)('$name', expectIssue);

    it('初期費用の確定額は数値の根拠も無いので両方出る', () => {
      const result = run({ name: '', text: '初期費用は約20万円です。' });
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'forbidden', topic: 'initialCostTotal' }),
          expect.objectContaining({ kind: 'number', token: '20万円' }),
        ]),
      );
    });
  });

  describe('対象物件に無い駅・区・間取り', () => {
    const cases: IssueCase[] = [
      { name: '対象に無い駅（新宿）', text: '新宿駅からも近いです。', issue: { kind: 'station', station: '新宿' } },
      { name: '対象に無い駅（高円寺）', text: '高円寺駅が最寄りです。', issue: { kind: 'station', station: '高円寺' } },
      { name: '中目黒の物件に目黒駅', text: '中目黒駅から徒歩10分、目黒駅も使えます。', issue: { kind: 'station', station: '目黒' } },
      { name: '対象に無い区（品川区）', text: '目黒区内で、品川区も近いです。', issue: { kind: 'ward', ward: '品川区' } },
      { name: '対象に無い市区（川崎市中原区）', text: '川崎市中原区です。', issue: { kind: 'ward', ward: '川崎市中原区' } },
      { name: '対象と違う間取り（1LDK）', text: '間取りは1LDKです。', issue: { kind: 'layout', layout: '1LDK' } },
      { name: '対象と違う間取り（2K）', text: '間取りは2Kです。', issue: { kind: 'layout', layout: '2K' } },
      { name: '間取りの語彙に無い（3LDK）', text: '間取りは3LDKです。', issue: { kind: 'layout', layout: '3LDK' } },
      {
        name: '比較で片方にしか無い間取りは通るが、どちらにも無い間取りは通さない',
        text: '1K、1DK、1LDKがあります。',
        targets: pair,
        issue: { kind: 'layout', layout: '1LDK' },
      },
    ];
    it.each(cases)('$name', expectIssue);
  });

  describe('空・長すぎ', () => {
    it('空文字は empty', () => {
      expect(run({ name: '', text: '' })).toEqual({ ok: false, issues: [{ kind: 'empty' }] });
    });

    it('空白と改行だけも empty', () => {
      expect(run({ name: '', text: ' 　\n ' })).toEqual({ ok: false, issues: [{ kind: 'empty' }] });
    });

    it('800字を超えたら tooLong（長さを返す）', () => {
      const result = run({ name: '', text: 'あ'.repeat(ANSWER_MAX_CHARS + 1) });
      expect(result.ok).toBe(false);
      expect(result.issues).toEqual([{ kind: 'tooLong', length: ANSWER_MAX_CHARS + 1 }]);
    });
  });

  it('問題は1つで止めず、見つけたものを全部返す', () => {
    const result = run({ name: '', text: '家賃は9万円で、エレベーターがあります。治安も良いです。' });
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'number', token: '9万円' }),
        expect.objectContaining({ kind: 'unknownFacility', word: 'エレベーター' }),
        expect.objectContaining({ kind: 'forbidden', topic: 'safety' }),
      ]),
    );
  });
});

describe('境界（誤検出しない）', () => {
  const meguro = makeProperty({
    name: 'メゾン青葉',
    address: '品川区青葉町2-3',
    ward: '品川区',
    access: [{ station: '目黒', walkMin: 5 }],
    layout: '1K',
  });
  const yoyogi = makeProperty({
    name: 'コーポ桜',
    address: '渋谷区桜町1-2',
    ward: '渋谷区',
    access: [{ station: '代々木', walkMin: 7 }],
  });
  const shinjuku = makeProperty({
    name: 'メゾン若葉',
    address: '新宿区若葉町1-2',
    ward: '新宿区',
    access: [{ station: '新宿', walkMin: 7 }],
  });

  describe('駅名・区名の一部', () => {
    it('「中目黒」の中の「目黒」を目黒駅として数えない', () => {
      expect(run({ name: '', text: '中目黒駅から徒歩10分です。' }).issues).toEqual([]);
    });

    it('目黒駅の物件に「中目黒駅」と書いたら、中目黒だけを指摘する（目黒は指摘しない）', () => {
      const result = run({ name: '', text: '中目黒駅も近いです。', targets: [at(meguro)] });
      expect(result.issues).toEqual([{ kind: 'station', station: '中目黒' }]);
    });

    it('目黒駅の物件の「目黒駅」は通す', () => {
      expect(run({ name: '', text: '目黒駅から徒歩5分です。', targets: [at(meguro)] }).issues).toEqual([]);
    });

    it('「渋谷区」の中の「渋谷」を駅として数えない（渋谷区の物件）', () => {
      expect(run({ name: '', text: '渋谷区の物件です。', targets: [at(yoyogi)] }).issues).toEqual([]);
    });

    it('渋谷区に無い物件の「渋谷区」は区だけを指摘する（渋谷駅は指摘しない）', () => {
      const result = run({ name: '', text: '渋谷区にあります。', targets: [at(shinjuku)] });
      expect(result.issues).toEqual([{ kind: 'ward', ward: '渋谷区' }]);
    });

    it('「目黒区」の中の「目黒」を駅として数えない（目黒区の物件）', () => {
      expect(run({ name: '', text: '目黒区の物件です。' }).issues).toEqual([]);
    });
  });

  describe('数字を含む語は数値として照合しない', () => {
    const twoPeople = makeProperty({
      name: 'ふたりの家',
      address: '新宿区ふたり町1-1',
      ward: '新宿区',
      access: [{ station: '新宿', walkMin: 7 }],
      tags: ['2人入居可'],
    });
    const oneLdk = makeProperty({
      name: 'ひろびろ館',
      address: '新宿区ひろびろ町1-1',
      ward: '新宿区',
      access: [{ station: '新宿', walkMin: 7 }],
      layout: '1LDK',
    });

    it('「十分な広さ」の「十分」を数値にしない', () => {
      expect(run({ name: '', text: '十分な広さです。' }).issues).toEqual([]);
      expect(readNumbers('十分な広さです。')).toEqual([]);
    });

    it('「2人入居可」の「2」を数値にしない', () => {
      expect(run({ name: '', text: '2人入居可です。', targets: [at(twoPeople)] }).issues).toEqual([]);
      expect(readNumbers('2人入居可です。')).toEqual([]);
    });

    it('「1LDK」の「1」を数値にしない', () => {
      expect(run({ name: '', text: '1LDKです。', targets: [at(oneLdk)] }).issues).toEqual([]);
      expect(readNumbers('1LDKです。')).toEqual([]);
    });

    it('「2人入居可」のタグが無い物件では設備の食い違いになる（数値ではなく設備として見る）', () => {
      const result = run({ name: '', text: '2人入居可です。' });
      expect(result.issues).toEqual([{ kind: 'feature', feature: '2人入居可', claimed: 'present' }]);
    });
  });

  describe('readNumbers', () => {
    it('8万5千円 を 85000 の yen 1つとして読む（8万 と 5千円 に分けない）', () => {
      expect(readNumbers('8万5千円')).toEqual([
        { unit: 'yen', value: 85000, raw: '8万5千円', comparative: false },
      ]);
    });

    it('9万以内 は comparative が true', () => {
      expect(readNumbers('9万以内')).toEqual([{ unit: 'yen', value: 90000, raw: '9万', comparative: true }]);
    });

    it('万・円・㎡・分・階・築年・年月日を単位つきで読む', () => {
      expect(readNumbers('8.1万円')).toEqual([expect.objectContaining({ unit: 'yen', value: 81000 })]);
      expect(readNumbers('81,000円')).toEqual([expect.objectContaining({ unit: 'yen', value: 81000 })]);
      expect(readNumbers('27.9㎡')).toEqual([expect.objectContaining({ unit: 'sqm', value: 27.9 })]);
      expect(readNumbers('徒歩10分')).toEqual([expect.objectContaining({ unit: 'minute', value: 10 })]);
      expect(readNumbers('2階以上')).toEqual([expect.objectContaining({ unit: 'floor', value: 2, comparative: true })]);
      expect(readNumbers('築17年')).toEqual([expect.objectContaining({ unit: 'age', value: 17 })]);
      expect(readNumbers('2026年11月1日')).toEqual([expect.objectContaining({ unit: 'ymd', value: 20261101 })]);
      expect(readNumbers('11月1日')).toEqual([expect.objectContaining({ unit: 'monthDay', value: 1101 })]);
    });

    it('単位の無い数値は unknown、漢数字は値を持たない unknown（照合できない）', () => {
      expect(readNumbers('81000')).toEqual([expect.objectContaining({ unit: 'unknown', value: 81000 })]);
      const kanji = readNumbers('徒歩五分');
      expect(kanji).toHaveLength(1);
      expect(kanji[0]).toMatchObject({ unit: 'unknown', raw: '五分' });
      expect(Number.isNaN(kanji[0].value)).toBe(true);
    });

    it('比較の語（以内・以上など）が後ろに無ければ comparative は false', () => {
      expect(readNumbers('9万円です')).toEqual([expect.objectContaining({ comparative: false })]);
    });
  });
});

/** 言い換え。テストを書いたときに通ってしまっていた言い回し（否定の述語・騒音・バストイレ別の語彙を足して直した） */
describe('言い換えでも食い違いを落とす', () => {
  describe('否定の言い換え（タグにある設備を「無い」と書く）', () => {
    const cases: IssueCase[] = [
      { name: '付いていません', text: 'エアコンは付いていません。', issue: { kind: 'feature', feature: 'エアコン', claimed: 'absent' } },
      { name: '設置されていません', text: 'エアコンは設置されていません。', issue: { kind: 'feature', feature: 'エアコン', claimed: 'absent' } },
      { name: '備わっていません', text: 'オートロックは備わっていません。', issue: { kind: 'feature', feature: 'オートロック', claimed: 'absent' } },
      { name: '付いておりません', text: 'オートロックは付いておりません。', issue: { kind: 'feature', feature: 'オートロック', claimed: 'absent' } },
      { name: '禁止です', text: 'ペットは禁止です。', issue: { kind: 'feature', feature: 'ペット可', claimed: 'absent' } },
      { name: '飼えません', text: 'ペットは飼えません。', issue: { kind: 'feature', feature: 'ペット可', claimed: 'absent' } },
      { name: 'ご遠慮ください', text: 'ペットはご遠慮ください。', issue: { kind: 'feature', feature: 'ペット可', claimed: 'absent' } },
      { name: '対象外です', text: 'ペットは対象外です。', issue: { kind: 'feature', feature: 'ペット可', claimed: 'absent' } },
    ];
    it.each(cases.map((c) => ({ ...c, targets: [at(FULL)] })))('$name', expectIssue);
  });

  describe('禁止トピック（騒音）の言い換え', () => {
    const cases: IssueCase[] = [
      { name: '電車の音は気になりません', text: '電車の音は気になりません。', issue: { kind: 'forbidden', topic: 'noise' } },
      { name: '周辺は騒がしくありません', text: '周辺は騒がしくありません。', issue: { kind: 'forbidden', topic: 'noise' } },
    ];
    it.each(cases)('$name', expectIssue);
  });

  it('「飼ってもかまいません」は否定として読まない（ペット可が無い物件で落ちる）', () => {
    expectIssue({
      name: 'かまいません',
      text: 'ペットを飼ってもかまいません。',
      targets: [at(MOMIJI)],
      issue: { kind: 'feature', feature: 'ペット可', claimed: 'present' },
    });
  });

  it('「3点ユニット」の「3点」を件数として読まない（バストイレ別がある物件で落ちる）', () => {
    expectIssue({
      name: '3点ユニット',
      text: '3点ユニットです。',
      targets: [at(FULL)],
      issue: { kind: 'feature', feature: 'バストイレ別', claimed: 'absent' },
    });
    const result = verifyAnswer({ text: '3点ユニットです。', question: '', targets: [at(FULL)], now: NOW });
    expect(result.issues.some((i) => i.kind === 'number')).toBe(false);
  });

  describe('バス・トイレ別の言い換え（バストイレ別のタグが無い物件）', () => {
    const cases: IssueCase[] = [
      { name: 'お風呂とトイレは別です', text: 'お風呂とトイレは別です。', issue: { kind: 'feature', feature: 'バストイレ別', claimed: 'present' } },
      { name: 'バスとトイレは別です', text: 'バスとトイレは別です。', issue: { kind: 'feature', feature: 'バストイレ別', claimed: 'present' } },
      { name: '浴室とトイレは別です', text: '浴室とトイレは別です。', issue: { kind: 'feature', feature: 'バストイレ別', claimed: 'present' } },
    ];
    it.each(cases.map((c) => ({ ...c, targets: [at(TSUBAKI)] })))('$name', expectIssue);
  });
});

describe('質問に出た駅・区・間取りは否定か記載なしの文脈でだけ繰り返してよい', () => {
  it.each<IssueCase>([
    { name: '間取りの肯定', question: '1番目は1LDKですか？', text: 'はい、1LDKです。', issue: { kind: 'layout', layout: '1LDK' } },
    { name: '駅の肯定', question: '恵比寿駅が最寄りですか？', text: '恵比寿駅が最寄りです。', issue: { kind: 'station', station: '恵比寿' } },
    { name: '区の肯定', question: '港区の物件ですか？', text: '港区の物件です。', issue: { kind: 'ward', ward: '港区' } },
  ])('$name', expectIssue);
  it.each<Case>([
    { name: '間取りの否定', question: '1番目は1LDKですか？', text: '1LDKではなく1DKです。' },
    { name: '駅の否定', question: '恵比寿駅が最寄りですか？', text: '恵比寿駅は最寄りではありません。最寄りは中目黒駅です。' },
    { name: '駅の記載なし', question: '恵比寿駅まで歩ける？', text: '恵比寿駅までの徒歩分は物件情報に記載がありません。' },
  ])('$name', expectOk);
});

describe('「ご確認ください」「確認済み」は記載なしの文脈として扱わない', () => {
  it.each<IssueCase>([
    { name: 'ご確認いただけます', text: 'オートロックがあることをご確認いただけます。', issue: { kind: 'feature', feature: 'オートロック', claimed: 'present' } },
    { name: '確認済み', text: 'エレベーター付きを確認済みです。', issue: { kind: 'unknownFacility', word: 'エレベーター' } },
    { name: 'ご確認ください', text: 'エレベーターがあることはご確認ください。', issue: { kind: 'unknownFacility', word: 'エレベーター' } },
  ])('$name', expectIssue);
  it('「確認できません」は記載なしとして通す', () => {
    expectOk({ name: '確認できません', text: 'エレベーターの有無は物件情報から確認できません。' });
  });
});

describe('タグ辞書の同義語でも照合する', () => {
  it.each<IssueCase>([
    { name: 'クーラー', text: 'クーラー付きです。', issue: { kind: 'feature', feature: 'エアコン', claimed: 'present' } },
    { name: 'BT別', text: 'BT別です。', issue: { kind: 'feature', feature: 'バストイレ別', claimed: 'present' } },
    { name: 'セパレート', text: 'お風呂はセパレートです。', issue: { kind: 'feature', feature: 'バストイレ別', claimed: 'present' } },
    { name: '角住戸', text: '角住戸です。', issue: { kind: 'feature', feature: '角部屋', claimed: 'present' } },
  ])('$name', (c) => expectIssue({ ...c, targets: [at(TSUBAKI)] }));
  it('ゼロゼロ（敷金・礼金がある物件で落ち、両方 0 の物件で通る）', () => {
    expectIssue({ name: 'ゼロゼロ', text: 'ゼロゼロ物件です。', issue: { kind: 'feature', feature: '敷金・礼金', claimed: 'absent' } });
    expectOk({ name: 'ゼロゼロ', text: 'ゼロゼロ物件です。', targets: [at(TSUBAKI)] });
  });
});

describe('物件名・住所は回答文と同じ正規化をかけて取り除く', () => {
  it('全角数字の物件名', () => {
    const p = makeProperty({ name: 'コーポ第２高円寺', address: '杉並区高円寺南１-２', ward: '杉並区', access: [{ station: '高円寺', walkMin: 5 }], rent: 70000, managementFee: 3000 });
    expectOk({ name: '全角', text: 'コーポ第2高円寺（杉並区高円寺南1-2）の家賃は70,000円です。', targets: [at(p)] });
  });
});

describe('正しい回答を捨てていた誤検出（攻撃的質問の実 API で見つかったもの。意思決定ログ26）', () => {
  it('期間の「1年間」「2年分」は数値として照合しない（at-044）', () => {
    expectOk({
      name: '1年間',
      text: '1年間の合計額は物件情報に記載がありません。もみじフラットの家賃は81,000円（8.1万円）、管理費は4,000円で、月額は85,000円です。',
    });
    expectOk({ name: '2年分', text: '2年分の費用は記載がありません。' });
    expectOk({ name: '漢数字', text: '一年間の合計は記載がありません。' });
  });

  it('期間を外しても、計算した年額の金額は落とす', () => {
    expectIssue({ name: '年額', text: '1年間では1,020,000円です。', issue: { kind: 'number', token: '1,020,000円' } });
  });

  it('列挙の最後の「敷金なし」の「なし」を、前に並べた設備に掛けない（at-048）', () => {
    expectOk({
      name: '敷金なしが載っています',
      text: '物件情報にバストイレ別の記載はありません。つばきハイツの設備・特徴には、ペット可、オートロック、敷金なしが載っています。',
      targets: [at(TSUBAKI)],
    });
  });

  it('列挙の中に無い設備を「ある」と書いたら、引き続き落とす', () => {
    expectIssue({
      name: '宅配ボックスは無い',
      text: 'つばきハイツには、宅配ボックス、敷金なしが載っています。',
      targets: [at(TSUBAKI)],
      issue: { kind: 'feature', feature: '宅配ボックス', claimed: 'present' },
    });
  });

  it('「…、宅配ボックスなしです」のように述語で終わる形は、これまでどおり並べた語にも掛ける（保守的）', () => {
    expectIssue({
      name: '述語で終わる',
      text: 'オートロック、宅配ボックスなしです。',
      targets: [at(TSUBAKI)],
      issue: { kind: 'feature', feature: 'オートロック', claimed: 'absent' },
    });
  });
});

describe('saysNotInRecord', () => {
  it.each([
    ['物件情報に駐輪場の記載はありません。', true],
    ['エレベーターの有無は分かりかねます。', true],
    ['駐輪場があります。', false],
    ['オートロックはありません。', false],
  ])('%s → %s', (text, expected) => {
    expect(saysNotInRecord(text)).toBe(expected);
  });
});
