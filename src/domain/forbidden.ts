/**
 * 禁止トピック（DESIGN.md 3.5）の語による検出（純関数）。
 * 主の判定は LLM の条件抽出が行う。これは抽出が2回失敗して offTopic に倒れたときの安全網で、
 * 空室・治安などを聞かれたのに「物件探しのお手伝いをします」と流してしまうのを防ぐ。
 * 「静かなところがいい」のような希望（タグ）は拾わないよう、質問の形の語だけを並べる。
 */
import type { ForbiddenTopic } from './types';

const PATTERNS: readonly [ForbiddenTopic, RegExp][] = [
  ['vacancy', /空室|空き状況|空いて(い)?(ます|る)|まだ(借りられ|住め|あり|空い)/],
  ['initialCostTotal', /初期費用.*(いくら|総額|合計|全部で)|契約金|総額(は|って)?いくら/],
  ['safety', /治安|犯罪|物騒|危な(い|く)|安全(です|ですか|な(の|ところ|エリア|地域))|夜道/],
  ['noise', /騒音|うるさ(い|く)/],
  // 入居審査にかかわる属性（国籍・収入・職業など。セキュリティ点検 A2）
  ['screening', /審査|保証会社|保証人|国籍|外国人|外国籍|留学生|年収|収入|職業|無職|生活保護|高齢/],
  ['neighbors', /近隣|隣(の|に)(人|住)|住人|住民/],
];

export function detectForbiddenTopicByKeyword(text: string): ForbiddenTopic | null {
  for (const [topic, re] of PATTERNS) if (re.test(text)) return topic;
  return null;
}
