import { describe, expect, it } from 'vitest';
import { NEAR_STATION_WALK_MIN, WALK_NO_PREFERENCE_MIN } from './rules';
import {
  applyWalkNoPreference,
  canonicalizeOps,
  canonicalizeOpsWithReport,
  canonicalizeViewingTime,
  CLAMP,
  findStationsInText,
  findTagsInText,
  findWardsInText,
  findYenAmounts,
  jstParts,
  normalizeText,
  parseFloorMin,
  parseLayout,
  parseLayouts,
  parseMoveIn,
  parseWalkMax,
  parseYen,
  preNormalize,
  resolveStation,
  resolveTag,
  resolveTags,
  resolveWard,
} from './normalize';
import { STATIONS, WARDS } from './stations';
import { TAGS, type ExtractionResult, type SlotOp } from './types';

/** 2026-10-07 20:00 JST（UTC では 11:00） */
const NOW = new Date('2026-10-07T11:00:00Z');

describe('normalizeText', () => {
  it.each([
    ['１ＬＤＫ　７万円', '1LDK 7万円'],
    ['６〜８万', '6~8万'],
    ['６～８万', '6~8万'],
    ['七万', '7万'],
    ['七万円以内', '7万円以内'],
    ['七万五千円', '7万5000円'],
    ['三千円', '3000円'],
    ['二階以上', '2階以上'],
    ['徒歩十分', '徒歩10分'],
    ['徒歩五分以内', '徒歩5分以内'],
    ['二人暮らし', '2人暮らし'],
    ['ﾍﾟｯﾄ可', 'ペット可'],
    ['ペ​ット可', 'ペット可'],
    ['渋谷   で\n7万', '渋谷 で 7万'],
    ['バス－トイレ別', 'バス-トイレ別'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeText(input)).toBe(expected);
  });

  it.each([
    ['十分な広さがほしい'],
    ['千代田区で探しています'],
    ['一緒に住みたい'],
    ['五反田か目黒'],
    ['五分五分です'],
    ['万が一のとき'],
    ['長音のスーパー'],
  ])('普通の語は数字にしない: %s', (input) => {
    expect(normalizeText(input)).toBe(input);
  });

  it('二度かけても変わらない（冪等）', () => {
    const once = normalizeText('７万５千円、徒歩十分、二階以上');
    expect(normalizeText(once)).toBe(once);
  });
});

describe('parseYen', () => {
  it.each([
    ['7万', 70000],
    ['７万', 70000],
    ['7.5万円', 75000],
    ['75000円', 75000],
    ['7万以内', 70000],
    ['7万前後', 70000],
    ['7万円台', 70000],
    ['7万5千円', 75000],
    ['7万5000円', 75000],
    ['7万5', 75000],
    ['70,000円', 70000],
    ['10万', 100000],
    ['5千円', 5000],
    ['6〜8万', 80000],
    ['6万〜8万', 80000],
    ['七万五千円', 75000],
    ['七万以内で', 70000],
    ['75000以内', 75000],
    ['家賃は8万までで', 80000],
  ])('%s → %d', (input, expected) => {
    expect(parseYen(input)).toBe(expected);
  });

  it.each([['予算は特にない'], ['2025年4月'], ['徒歩5分'], ['1LDK'], ['2階以上']])(
    '金額でないものは undefined: %s',
    (input) => {
      expect(parseYen(input)).toBeUndefined();
    },
  );

  it('金額を出現順に集める（重複なし）', () => {
    expect(findYenAmounts('家賃7万、敷金は14万円、7万まで')).toEqual([70000, 140000]);
  });

  it('万のあとに間取りの数字が続いても千円と読まない', () => {
    expect(parseYen('7万 2LDK')).toBe(70000);
    expect(parseYen('7万2LDK')).toBe(70000);
  });
});

describe('parseLayout', () => {
  it.each([
    ['ワンルーム', '1R'],
    ['ワンルームマンション', '1R'],
    ['1ルーム', '1R'],
    ['1ldk', '1LDK'],
    ['１ＬＤＫ', '1LDK'],
    ['2DKがいい', '2DK'],
    ['1 K', '1K'],
    ['1-LDK', '1LDK'],
    ['2LDK', '2LDK'],
    ['ワンケー', '1K'],
    ['ツーエルディーケー', '2LDK'],
  ])('%s → %s', (input, expected) => {
    expect(parseLayout(input)).toBe(expected);
  });

  it('LAYOUTS に無い間取りは undefined', () => {
    expect(parseLayout('3LDK')).toBeUndefined();
    expect(parseLayout('1SLDK')).toBeUndefined();
    expect(parseLayout('LDK広め')).toBeUndefined();
  });

  it('複数の間取りを出現順・重複なしで返す', () => {
    expect(parseLayouts('ワンルームか1K、できれば1Rでも')).toEqual(['1R', '1K']);
    expect(parseLayouts('2LDKと2DKと1LDK')).toEqual(['2LDK', '2DK', '1LDK']);
  });
});

describe('parseWalkMax / parseFloorMin', () => {
  it.each([
    ['駅近', NEAR_STATION_WALK_MIN],
    ['駅チカがいい', NEAR_STATION_WALK_MIN],
    ['徒歩5分以内', 5],
    ['駅徒歩10分', 10],
    ['駅から7分', 7],
    ['歩いて5分くらい', 5],
    ['5分以内', 5],
    ['徒歩5〜10分', 10],
    ['徒歩五分以内', 5],
    ['駅近で徒歩5分以内', 5],
  ])('%s → %d', (input, expected) => {
    expect(parseWalkMax(input)).toBe(expected);
  });

  it.each([['バスで10分以内'], ['徒歩0分'], ['徒歩99分'], ['静かなところ']])('駅徒歩でないものは undefined: %s', (input) => {
    expect(parseWalkMax(input)).toBeUndefined();
  });

  it.each([
    ['2階以上', 2],
    ['３階以上がいい', 3],
    ['1階は避けたい', 2],
    ['二階以上', 2],
  ])('階 %s → %d', (input, expected) => {
    expect(parseFloorMin(input)).toBe(expected);
  });

  it('階の指定が無ければ undefined', () => {
    expect(parseFloorMin('渋谷で7万')).toBeUndefined();
  });
});

describe('駅・区の解決', () => {
  it.each([
    ['渋谷', '渋谷'],
    ['渋谷駅', '渋谷'],
    ['しぶや', '渋谷'],
    ['シブヤ', '渋谷'],
    ['しぶや駅', '渋谷'],
    ['JR渋谷駅', '渋谷'],
    ['東急渋谷駅', '渋谷'],
    ['ＪＲ新宿駅', '新宿'],
    ['中目黒駅', '中目黒'],
    ['めぐろ', '目黒'],
    ['東京駅', '東京'],
    ['阿佐ヶ谷', '阿佐ケ谷'],
    ['四谷', '四ツ谷'],
    ['お茶の水', '御茶ノ水'],
    ['自由ヶ丘', '自由が丘'],
    ['たかなわゲートウェイ', '高輪ゲートウェイ'],
  ])('駅 %s → %s', (input, expected) => {
    expect(resolveStation(input)).toBe(expected);
  });

  it.each([['架空駅'], ['渋谷区'], ['目黒区'], ['東京メトロ'], ['中央線'], ['']])('駅マスタに無い: "%s"', (input) => {
    expect(resolveStation(input)).toBeUndefined();
  });

  it('駅マスタの全駅が、駅名・「〜駅」・よみのどれでも自分自身に解決される', () => {
    for (const s of STATIONS) {
      expect(resolveStation(s.name)).toBe(s.name);
      expect(resolveStation(`${s.name}駅`)).toBe(s.name);
      expect(resolveStation(s.kana)).toBe(s.name);
    }
  });

  it.each([
    ['目黒区', '目黒区'],
    ['東京都目黒区', '目黒区'],
    ['三鷹市', '三鷹市'],
    ['北区', '北区'],
    ['中原区', '川崎市中原区'],
    ['港北区', '横浜市港北区'],
    ['神奈川県川崎市中原区', '川崎市中原区'],
  ])('区 %s → %s', (input, expected) => {
    expect(resolveWard(input)).toBe(expected);
  });

  it('「区」「市」を付けない形や駅名は区として扱わない', () => {
    expect(resolveWard('目黒')).toBeUndefined();
    expect(resolveWard('渋谷')).toBeUndefined();
  });

  it('区マスタの全区が自分自身に解決される', () => {
    for (const w of WARDS) expect(resolveWard(w)).toBe(w);
  });

  it('文中の駅と区を取り分ける（「渋谷区」は区、「渋谷駅」は駅）', () => {
    expect(findStationsInText('渋谷区で探しています')).toEqual([]);
    expect(findWardsInText('渋谷区で探しています')).toEqual(['渋谷区']);
    expect(findStationsInText('渋谷区の渋谷駅が近い所')).toEqual(['渋谷']);
    expect(findStationsInText('三鷹市はやめて三鷹駅周辺')).toEqual(['三鷹']);
  });

  it('文中では長い駅名を優先する（中目黒の中の「目黒」は拾わない）', () => {
    expect(findStationsInText('中目黒か目黒')).toEqual(['中目黒', '目黒']);
    expect(findStationsInText('日暮里と西日暮里')).toEqual(['日暮里', '西日暮里']);
    expect(findStationsInText('中目黒')).toEqual(['中目黒']);
  });

  it('文中の複数の駅を出現順に返す', () => {
    expect(findStationsInText('恵比寿、渋谷、代官山あたり')).toEqual(['恵比寿', '渋谷', '代官山']);
    expect(findWardsInText('港北区か中原区')).toEqual(['横浜市港北区', '川崎市中原区']);
  });

  it('「東京メトロ」の「東京」は駅にしない', () => {
    expect(findStationsInText('東京メトロ中野駅か高円寺')).toEqual(['中野', '高円寺']);
    expect(findStationsInText('東京駅の近く')).toEqual(['東京']);
    expect(findStationsInText('東京都内で')).toEqual([]);
  });

  it('短いひらがなは「駅」が付くか発話全体がそれのときだけ拾う', () => {
    expect(findStationsInText('なかのひと')).toEqual([]);
    expect(findStationsInText('しぶや駅')).toEqual(['渋谷']);
    expect(findStationsInText('しぶや')).toEqual(['渋谷']);
    expect(findStationsInText('シブヤ')).toEqual(['渋谷']);
  });
});

describe('タグの同義語', () => {
  it.each([
    ['BT別', 'バストイレ別'],
    ['B/T別', 'バストイレ別'],
    ['バス・トイレ別', 'バストイレ別'],
    ['風呂トイレ別', 'バストイレ別'],
    ['お風呂とトイレが別', 'バストイレ別'],
    ['ペット相談', 'ペット可'],
    ['ペットOK', 'ペット可'],
    ['小型犬可', 'ペット可'],
    ['陽当たり', '日当たり良好'],
    ['日当たりの良い', '日当たり良好'],
    ['閑静', '静か'],
    ['閑静な住宅街', '静か'],
    ['洗濯機室内', '室内洗濯機置場'],
    ['室内洗濯機置き場', '室内洗濯機置場'],
    ['宅配BOX', '宅配ボックス'],
    ['宅配ボックス付き', '宅配ボックス'],
    ['オートロック付き', 'オートロック'],
    ['独立洗面', '独立洗面台'],
    ['二人入居可', '2人入居可'],
    ['カップル可', '2人入居可'],
    ['楽器可', '楽器相談可'],
    ['ピアノ相談', '楽器相談可'],
    ['南向', '南向き'],
    ['角部屋', '角部屋'],
    ['自転車置き場', '駐輪場'],
    ['冷暖房完備', 'エアコン'],
    ['敷金ゼロ', '敷金なし'],
    ['礼金0', '礼金なし'],
    ['ゼロゼロ物件', '敷金なし'],
    ['プール付き', undefined],
  ])('%s → %s', (input, expected) => {
    expect(resolveTag(input)).toBe(expected);
  });

  it('全タグが自分自身に解決される', () => {
    for (const t of TAGS) expect(resolveTag(t)).toBe(t);
  });

  it('1つの語が複数のタグを指す（敷礼ゼロ）', () => {
    expect(resolveTags('敷礼ゼロ')).toEqual(['敷金なし', '礼金なし']);
    expect(resolveTags('敷金・礼金なし')).toEqual(['敷金なし', '礼金なし']);
    expect(resolveTags('存在しないタグ')).toEqual([]);
  });

  it('備考では否定を拾わない', () => {
    expect(findTagsInText('ペット不可、楽器相談可', { mode: 'note' })).toEqual(['楽器相談可']);
    expect(findTagsInText('ペット相談不可', { mode: 'note' })).toEqual([]);
    expect(findTagsInText('エアコンなし', { mode: 'note' })).toEqual([]);
    expect(findTagsInText('駐輪場なし', { mode: 'note' })).toEqual([]);
    expect(findTagsInText('オートロック無し／宅配ボックス有', { mode: 'note' })).toEqual(['宅配ボックス']);
  });

  it('備考の区切り（スラッシュ・読点・中点）を越えて辞書を引く', () => {
    expect(findTagsInText('ペット相談/オートロック/BT別/南向き/角部屋', { mode: 'note' })).toEqual([
      'ペット可',
      'バストイレ別',
      'オートロック',
      '角部屋',
      '南向き',
    ]);
    expect(findTagsInText('バス・トイレ別、独立洗面台、室内洗濯機置場', { mode: 'note' })).toEqual([
      'バストイレ別',
      '独立洗面台',
      '室内洗濯機置場',
    ]);
  });

  it('備考では「日当たりが悪い」を日当たり良好にしない（発話のヒントでは緩い語も拾う）', () => {
    expect(findTagsInText('日当たりが悪い', { mode: 'note' })).toEqual([]);
    expect(findTagsInText('日当たりのいい部屋がいい', { mode: 'utterance' })).toEqual(['日当たり良好']);
  });

  it('敷金0.5ヶ月は敷金なしにしない', () => {
    expect(findTagsInText('敷金0.5ヶ月', { mode: 'note' })).toEqual([]);
    expect(findTagsInText('敷金0ヶ月', { mode: 'note' })).toEqual(['敷金なし']);
  });

  it('発話の言い回しからタグの候補を拾う', () => {
    expect(findTagsInText('犬を飼いたいのでペット可で、洗濯機は室内がいい')).toEqual(['ペット可', '室内洗濯機置場']);
    expect(findTagsInText('ピアノを弾きたい')).toEqual(['楽器相談可']);
  });
});

describe('parseMoveIn（JST）', () => {
  it.each([
    ['来月', '2026-11'],
    ['来月から入居したい', '2026-11'],
    ['再来月', '2026-12'],
    ['今月中に', '2026-10'],
    ['4月', '2027-04'],
    ['４月から', '2027-04'],
    ['10月', '2026-10'],
    ['11月', '2026-11'],
    ['来年の3月', '2027-03'],
    ['2027年3月', '2027-03'],
    ['2027/03', '2027-03'],
    ['3ヶ月後', '2027-01'],
    ['半年後', '2027-04'],
    ['すぐ入居したい', '2026-10'],
    ['年明け', '2027-01'],
    ['来週から入居したい', '2026-10'],
    ['すぐに入居したい', '2026-10'],
    ['即入居希望', '2026-10'],
  ])('%s → %s', (input, expected) => {
    expect(parseMoveIn(input, NOW)).toBe(expected);
  });

  it('決められなければ undefined', () => {
    expect(parseMoveIn('いつでもいい', NOW)).toBeUndefined();
    expect(parseMoveIn('13月', NOW)).toBeUndefined();
  });

  it('内見の話の日時は入居時期にしない（来週・来月・4月・すぐ）', () => {
    expect(parseMoveIn('来週の土曜日の14時に内見したいです', NOW)).toBeUndefined();
    expect(parseMoveIn('来月の土曜に内見したい', NOW)).toBeUndefined();
    expect(parseMoveIn('4月に見学できますか', NOW)).toBeUndefined();
    expect(parseMoveIn('すぐに内見したい', NOW)).toBeUndefined();
    // 入居の話と一緒なら入居時期
    expect(parseMoveIn('来月入居で、内見は今週末がいい', NOW)).toBe('2026-11');
    expect(parseMoveIn('4月から住みたいので、内見したい', NOW)).toBe('2027-04');
  });

  it('月末の UTC/JST のずれを JST で解釈する', () => {
    // UTC では 9/30 16:00 だが JST では 10/1 01:00
    const jstNewMonth = new Date('2026-09-30T16:00:00Z');
    expect(parseMoveIn('今月', jstNewMonth)).toBe('2026-10');
    expect(parseMoveIn('来月', jstNewMonth)).toBe('2026-11');
    // 12/31 15:30 UTC = 2027/1/1 00:30 JST。年をまたぐ
    const jstNewYear = new Date('2026-12-31T15:30:00Z');
    expect(parseMoveIn('来月', jstNewYear)).toBe('2027-02');
    expect(parseMoveIn('1月', jstNewYear)).toBe('2027-01');
  });

  it('来週が翌月にまたがるときは翌月', () => {
    expect(parseMoveIn('来週入居したい', new Date('2026-10-28T03:00:00Z'))).toBe('2026-11');
  });

  it('jstParts は JST の暦と曜日を返す', () => {
    expect(jstParts(NOW)).toEqual({ year: 2026, month: 10, day: 7, weekday: 3, hour: 20, minute: 0 });
    expect(jstParts(new Date('2026-09-30T16:00:00Z'))).toMatchObject({ year: 2026, month: 10, day: 1, hour: 1 });
  });
});

describe('canonicalizeViewingTime', () => {
  it.each([
    ['2026-10-10T14:00', '2026-10-10T14:00'],
    ['2026-10-10 14:00', '2026-10-10T14:00'],
    ['2026-10-10T14:00:00', '2026-10-10T14:00'],
    ['2026-10-10T14:00:00+09:00', '2026-10-10T14:00'],
    ['2026/10/10', '2026-10-10'],
    ['2026-10-10', '2026-10-10'],
    ['2026-10-9T9:30', '2026-10-09T09:30'],
  ])('%s → %s', (input, expected) => {
    expect(canonicalizeViewingTime(input)).toBe(expected);
  });

  it.each([['2026-02-30'], ['2026-13-01'], ['2026-10-10T25:00'], ['2026-10-10T14:75'], ['あした'], ['']])('不正は undefined: %s', (input) => {
    expect(canonicalizeViewingTime(input)).toBeUndefined();
  });
});

describe('preNormalize', () => {
  it('表記ゆれを正規化し、辞書の検出結果を hints にまとめる', () => {
    const { text, hints } = preNormalize('渋谷で７万以内、１ｌｄｋでBT別の駅近。来月入居で２階以上', NOW);
    expect(text).toBe('渋谷で7万以内、1ldkでBT別の駅近。来月入居で2階以上');
    expect(hints).toEqual({
      stations: ['渋谷'],
      wards: [],
      rentMax: [70000],
      layouts: ['1LDK'],
      tags: ['バストイレ別'],
      walkMax: NEAR_STATION_WALK_MIN,
      floorMin: 2,
      moveIn: '2026-11',
    });
  });

  it('見つからないものは hints に入れない', () => {
    const { hints } = preNormalize('こんにちは', NOW);
    expect(hints).toEqual({ stations: [], wards: [], rentMax: [], layouts: [], tags: [] });
  });

  it('漢数字の金額も hints に入る', () => {
    expect(preNormalize('目黒区で七万五千円まで', NOW).hints).toMatchObject({ wards: ['目黒区'], rentMax: [75000] });
  });

  it('入力の発話は書き換えない（純関数）', () => {
    const input = '渋谷で７万';
    preNormalize(input, NOW);
    expect(input).toBe('渋谷で７万');
  });
});

describe('canonicalizeOps（LLM 出力の後段）', () => {
  it('駅は駅マスタに、区は区マスタに解決し、解決できないものは捨てる', () => {
    expect(
      canonicalizeOps([
        { op: 'set', key: 'area', value: { stations: ['渋谷駅', '架空駅', 'しぶや'], wards: ['目黒区', '東京都港区'] }, priority: 'must' },
      ]),
    ).toEqual([{ op: 'set', key: 'area', value: { stations: ['渋谷'], wards: ['目黒区', '港区'] }, priority: 'must' }]);
  });

  it('駅の欄に区が、区の欄に駅が入っていても振り分ける', () => {
    expect(canonicalizeOps([{ op: 'set', key: 'area', value: { stations: ['目黒区'], wards: ['恵比寿'] } }])).toEqual([
      { op: 'set', key: 'area', value: { stations: ['恵比寿'], wards: ['目黒区'] } },
    ]);
  });

  it('area が文字列・配列・自然文でも受ける', () => {
    expect(canonicalizeOps([{ op: 'set', key: 'area', value: '渋谷' }])).toEqual([
      { op: 'set', key: 'area', value: { stations: ['渋谷'], wards: [] } },
    ]);
    expect(canonicalizeOps([{ op: 'set', key: 'area', value: ['渋谷', '目黒区'] }])).toEqual([
      { op: 'set', key: 'area', value: { stations: ['渋谷'], wards: ['目黒区'] } },
    ]);
    expect(canonicalizeOps([{ op: 'set', key: 'area', value: '恵比寿・代官山あたり' }])).toEqual([
      { op: 'set', key: 'area', value: { stations: ['恵比寿', '代官山'], wards: [] } },
    ]);
  });

  it('area が全部解決できなければ op ごと捨てる（理由つき）', () => {
    const { ops, dropped } = canonicalizeOpsWithReport([{ op: 'set', key: 'area', value: { stations: ['架空駅'], wards: [] } }]);
    expect(ops).toEqual([]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].reason).toContain('area');
  });

  it.each([
    [70000, 70000],
    [7, 70000],
    [100, 1_000_000],
    [5000, CLAMP.rentYen.min],
    [5_000_000, CLAMP.rentYen.max],
    ['7万', 70000],
    ['75000', 75000],
    [65000.4, 65000],
  ])('rentMax %s → %d', (value, expected) => {
    expect(canonicalizeOps([{ op: 'set', key: 'rentMax', value }])).toEqual([{ op: 'set', key: 'rentMax', value: expected }]);
  });

  it.each([[Number.NaN], ['安い'], [null], [-5], [0]])('rentMax %s は捨てる', (value) => {
    expect(canonicalizeOps([{ op: 'set', key: 'rentMax', value }])).toEqual([]);
  });

  it.each([
    ['walkMax', 5, 5],
    ['walkMax', 100, CLAMP.walkMin.max],
    ['walkMax', 0, CLAMP.walkMin.min],
    ['walkMax', '駅近', NEAR_STATION_WALK_MIN],
    ['floorMin', 2, 2],
    ['floorMin', 99, CLAMP.floor.max],
    ['floorMin', 0, CLAMP.floor.min],
    ['floorMin', '2階以上', 2],
  ])('%s %s → %d', (key, value, expected) => {
    expect(canonicalizeOps([{ op: 'set', key, value }])).toEqual([{ op: 'set', key, value: expected }]);
  });

  it('間取りは LAYOUTS に直し、無いものは捨てる', () => {
    expect(canonicalizeOps([{ op: 'set', key: 'layouts', value: ['ワンルーム', '3LDK', '2dk', '1R'] }])).toEqual([
      { op: 'set', key: 'layouts', value: ['1R', '2DK'] },
    ]);
    expect(canonicalizeOps([{ op: 'set', key: 'layouts', value: ['3LDK'] }])).toEqual([]);
    expect(canonicalizeOps([{ op: 'set', key: 'layouts', value: '1LDK' }])).toEqual([{ op: 'set', key: 'layouts', value: ['1LDK'] }]);
  });

  it.each([
    ['2027-03', '2027-03'],
    ['2027-3', '2027-03'],
    ['2027/3', '2027-03'],
    ['2027年3月', '2027-03'],
  ])('moveIn %s → %s', (value, expected) => {
    expect(canonicalizeOps([{ op: 'set', key: 'moveIn', value }])).toEqual([{ op: 'set', key: 'moveIn', value: expected }]);
  });

  it.each([['来月'], ['2027-13'], [202703], [null]])('moveIn %s は捨てる', (value) => {
    expect(canonicalizeOps([{ op: 'set', key: 'moveIn', value }])).toEqual([]);
  });

  it('不正な優先度は省略として扱い、op は残す', () => {
    expect(canonicalizeOps([{ op: 'set', key: 'rentMax', value: 70000, priority: 'high' }])).toEqual([
      { op: 'set', key: 'rentMax', value: 70000 },
    ]);
  });

  it('スロット名の別表記（rent_max など）を受ける', () => {
    expect(canonicalizeOps([{ op: 'set', key: 'rent_max', value: 70000 }, { op: 'unset', key: 'walk_min' }])).toEqual([
      { op: 'set', key: 'rentMax', value: 70000 },
      { op: 'unset', key: 'walkMax' },
    ]);
  });

  it('unset と setPriority', () => {
    expect(canonicalizeOps([{ op: 'unset', key: 'area' }, { op: 'setPriority', key: 'floorMin', priority: 'nice' }])).toEqual([
      { op: 'unset', key: 'area' },
      { op: 'setPriority', key: 'floorMin', priority: 'nice' },
    ]);
    expect(canonicalizeOps([{ op: 'setPriority', key: 'floorMin' }])).toEqual([]);
    expect(canonicalizeOps([{ op: 'unset', key: 'tags' }])).toEqual([]);
  });

  it('タグは同義語で TAGS に寄せ、解決できないものは捨てる', () => {
    expect(
      canonicalizeOps([
        { op: 'addTag', tag: 'BT別', priority: 'must' },
        { op: 'addTag', tag: 'ペット相談' },
        { op: 'addTag', tag: 'プール付き' },
        { op: 'removeTag', tag: '陽当たり' },
        { op: 'setTagPriority', tag: 'オートロック', priority: 'nice' },
      ]),
    ).toEqual([
      { op: 'addTag', tag: 'バストイレ別', priority: 'must' },
      { op: 'addTag', tag: 'ペット可' },
      { op: 'removeTag', tag: '日当たり良好' },
      { op: 'setTagPriority', tag: 'オートロック', priority: 'nice' },
    ]);
  });

  it('1つの語が複数のタグを指すときは op を増やす', () => {
    expect(canonicalizeOps([{ op: 'addTag', tag: '敷礼ゼロ', priority: 'want' }])).toEqual([
      { op: 'addTag', tag: '敷金なし', priority: 'want' },
      { op: 'addTag', tag: '礼金なし', priority: 'want' },
    ]);
  });

  it('setTagPriority は優先度が無ければ捨てる', () => {
    expect(canonicalizeOps([{ op: 'setTagPriority', tag: 'オートロック' }])).toEqual([]);
  });

  it('形の崩れた op・未知の op は捨て、理由を残す', () => {
    const { ops, dropped } = canonicalizeOpsWithReport([
      null,
      'set',
      ['set'],
      { op: 'drop', key: 'area' },
      { op: 'set', key: 'unknown', value: 1 },
      { op: 'addTag' },
      { op: 'set', key: 'rentMax', value: 70000 },
    ]);
    expect(ops).toEqual([{ op: 'set', key: 'rentMax', value: 70000 }]);
    expect(dropped).toHaveLength(6);
  });

  it('入力の ops を書き換えない', () => {
    const raw = [{ op: 'set', key: 'rentMax', value: 7 }];
    const copy = JSON.parse(JSON.stringify(raw));
    canonicalizeOps(raw);
    expect(raw).toEqual(copy);
  });
});

describe('applyWalkNoPreference（「駅から遠くてもいい」を徒歩の条件にする。意思決定ログ31）', () => {
  const base = (ops: SlotOp[] = [], intent: ExtractionResult['intent'] = 'conditions'): ExtractionResult => ({
    intent,
    ops,
    targetPositions: [],
    viewingTimes: [],
    forbiddenTopic: null,
  });
  const NO_PREF: SlotOp = { op: 'set', key: 'walkMax', value: WALK_NO_PREFERENCE_MIN, priority: 'nice' };

  it.each(['駅から遠くても大丈夫です', '徒歩は何分でも気にしないです', '駅からの距離は気にしないです', '駅近じゃなくてもいいです', '徒歩は問わないです'])(
    '%s → 徒歩 60 分以内・あれば嬉しい',
    (utterance) => {
      expect(applyWalkNoPreference(base(), utterance).ops).toEqual([NO_PREF]);
    },
  );

  it('抽出が出した徒歩の操作（unset・setPriority）は置き換え、ほかの操作は残す', () => {
    const ops: SlotOp[] = [
      { op: 'unset', key: 'walkMax' },
      { op: 'setPriority', key: 'walkMax', priority: 'nice' },
      { op: 'set', key: 'rentMax', value: 80000 },
    ];
    expect(applyWalkNoPreference(base(ops), '駅から遠くてもいいので8万まで').ops).toEqual([
      { op: 'set', key: 'rentMax', value: 80000 },
      NO_PREF,
    ]);
  });

  it('抽出が offTopic に倒れていても条件として扱う', () => {
    expect(applyWalkNoPreference(base([], 'offTopic'), '駅から遠くても大丈夫').intent).toBe('conditions');
  });

  it('徒歩の条件の優先度だけを変える発話・ほかの「どっちでもいい」には触れない', () => {
    for (const utterance of ['2階以上は必須、ほかはどっちでもいい', 'やっぱり駅から徒歩10分以内は絶対条件でお願いします', '駅近がいいです']) {
      const result = base([{ op: 'setPriority', key: 'walkMax', priority: 'must' }]);
      expect(applyWalkNoPreference(result, utterance)).toBe(result);
    }
  });
});
