/**
 * 駅マスタ（架空データと条件の正規化が使う）。対象は山手線・中央線（快速）・東急東横線。
 * 駅名は「駅」を付けない正式表記。`ward` は駅の所在地の区・市。
 * `lines` の駅の並びは路線上の順（隣接駅の緩和で使う）。
 */

export interface StationInfo {
  name: string;
  /** よみ（ひらがな）。表記ゆれの正規化で使う */
  kana: string;
  ward: string;
}

export const STATIONS: readonly StationInfo[] = [
  // 山手線（東京から外回り）
  { name: '東京', kana: 'とうきょう', ward: '千代田区' },
  { name: '有楽町', kana: 'ゆうらくちょう', ward: '千代田区' },
  { name: '新橋', kana: 'しんばし', ward: '港区' },
  { name: '浜松町', kana: 'はままつちょう', ward: '港区' },
  { name: '田町', kana: 'たまち', ward: '港区' },
  { name: '高輪ゲートウェイ', kana: 'たかなわげーとうぇい', ward: '港区' },
  { name: '品川', kana: 'しながわ', ward: '港区' },
  { name: '大崎', kana: 'おおさき', ward: '品川区' },
  { name: '五反田', kana: 'ごたんだ', ward: '品川区' },
  { name: '目黒', kana: 'めぐろ', ward: '品川区' },
  { name: '恵比寿', kana: 'えびす', ward: '渋谷区' },
  { name: '渋谷', kana: 'しぶや', ward: '渋谷区' },
  { name: '原宿', kana: 'はらじゅく', ward: '渋谷区' },
  { name: '代々木', kana: 'よよぎ', ward: '渋谷区' },
  { name: '新宿', kana: 'しんじゅく', ward: '新宿区' },
  { name: '新大久保', kana: 'しんおおくぼ', ward: '新宿区' },
  { name: '高田馬場', kana: 'たかだのばば', ward: '新宿区' },
  { name: '目白', kana: 'めじろ', ward: '豊島区' },
  { name: '池袋', kana: 'いけぶくろ', ward: '豊島区' },
  { name: '大塚', kana: 'おおつか', ward: '豊島区' },
  { name: '巣鴨', kana: 'すがも', ward: '豊島区' },
  { name: '駒込', kana: 'こまごめ', ward: '豊島区' },
  { name: '田端', kana: 'たばた', ward: '北区' },
  { name: '西日暮里', kana: 'にしにっぽり', ward: '荒川区' },
  { name: '日暮里', kana: 'にっぽり', ward: '荒川区' },
  { name: '鶯谷', kana: 'うぐいすだに', ward: '台東区' },
  { name: '上野', kana: 'うえの', ward: '台東区' },
  { name: '御徒町', kana: 'おかちまち', ward: '台東区' },
  { name: '秋葉原', kana: 'あきはばら', ward: '千代田区' },
  { name: '神田', kana: 'かんだ', ward: '千代田区' },
  // 中央線（快速）。東京・神田・新宿は山手線と共通
  { name: '御茶ノ水', kana: 'おちゃのみず', ward: '千代田区' },
  { name: '四ツ谷', kana: 'よつや', ward: '新宿区' },
  { name: '中野', kana: 'なかの', ward: '中野区' },
  { name: '高円寺', kana: 'こうえんじ', ward: '杉並区' },
  { name: '阿佐ケ谷', kana: 'あさがや', ward: '杉並区' },
  { name: '荻窪', kana: 'おぎくぼ', ward: '杉並区' },
  { name: '西荻窪', kana: 'にしおぎくぼ', ward: '杉並区' },
  { name: '吉祥寺', kana: 'きちじょうじ', ward: '武蔵野市' },
  { name: '三鷹', kana: 'みたか', ward: '三鷹市' },
  // 東急東横線（渋谷から日吉）。渋谷は山手線と共通
  { name: '代官山', kana: 'だいかんやま', ward: '渋谷区' },
  { name: '中目黒', kana: 'なかめぐろ', ward: '目黒区' },
  { name: '祐天寺', kana: 'ゆうてんじ', ward: '目黒区' },
  { name: '学芸大学', kana: 'がくげいだいがく', ward: '目黒区' },
  { name: '都立大学', kana: 'とりつだいがく', ward: '目黒区' },
  { name: '自由が丘', kana: 'じゆうがおか', ward: '目黒区' },
  { name: '田園調布', kana: 'でんえんちょうふ', ward: '大田区' },
  { name: '多摩川', kana: 'たまがわ', ward: '大田区' },
  { name: '新丸子', kana: 'しんまるこ', ward: '川崎市中原区' },
  { name: '武蔵小杉', kana: 'むさしこすぎ', ward: '川崎市中原区' },
  { name: '元住吉', kana: 'もとすみよし', ward: '川崎市中原区' },
  { name: '日吉', kana: 'ひよし', ward: '横浜市港北区' },
];

export interface LineInfo {
  name: string;
  /** 路線上の順。環状線は先頭と末尾が隣接する */
  stations: readonly string[];
  loop: boolean;
}

export const LINES: readonly LineInfo[] = [
  {
    name: '山手線',
    loop: true,
    stations: [
      '東京', '有楽町', '新橋', '浜松町', '田町', '高輪ゲートウェイ', '品川', '大崎', '五反田', '目黒',
      '恵比寿', '渋谷', '原宿', '代々木', '新宿', '新大久保', '高田馬場', '目白', '池袋', '大塚',
      '巣鴨', '駒込', '田端', '西日暮里', '日暮里', '鶯谷', '上野', '御徒町', '秋葉原', '神田',
    ],
  },
  {
    name: '中央線',
    loop: false,
    stations: ['東京', '神田', '御茶ノ水', '四ツ谷', '新宿', '中野', '高円寺', '阿佐ケ谷', '荻窪', '西荻窪', '吉祥寺', '三鷹'],
  },
  {
    name: '東急東横線',
    loop: false,
    stations: ['渋谷', '代官山', '中目黒', '祐天寺', '学芸大学', '都立大学', '自由が丘', '田園調布', '多摩川', '新丸子', '武蔵小杉', '元住吉', '日吉'],
  },
];

const STATION_BY_NAME = new Map(STATIONS.map((s) => [s.name, s]));

export function findStation(name: string): StationInfo | undefined {
  return STATION_BY_NAME.get(name);
}

/** その駅を通る路線名 */
export function linesOf(station: string): string[] {
  return LINES.filter((l) => l.stations.includes(station)).map((l) => l.name);
}

/** 路線上で隣り合う駅（重複なし・路線の定義順） */
export function adjacentStations(station: string): string[] {
  const result: string[] = [];
  for (const line of LINES) {
    const i = line.stations.indexOf(station);
    if (i < 0) continue;
    const n = line.stations.length;
    const neighbors = [i - 1, i + 1]
      .map((j) => (line.loop ? (j + n) % n : j))
      .filter((j) => j >= 0 && j < n)
      .map((j) => line.stations[j]);
    for (const s of neighbors) if (!result.includes(s)) result.push(s);
  }
  return result;
}

/** 区・市の一覧（重複なし・駅マスタの定義順） */
export const WARDS: readonly string[] = [...new Set(STATIONS.map((s) => s.ward))];
