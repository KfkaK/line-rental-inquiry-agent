import { describe, expect, it } from 'vitest';
import { detectForbiddenTopicByKeyword } from './forbidden';

describe('detectForbiddenTopicByKeyword', () => {
  it.each([
    ['この部屋まだ空いてますか？', 'vacancy'],
    ['空室状況を教えて', 'vacancy'],
    ['初期費用は全部でいくら？', 'initialCostTotal'],
    ['このへん治安どう？', 'safety'],
    ['夜うるさくないですか', 'noise'],
    ['フリーターでも審査通りますか', 'screening'],
    ['隣の人はどんな人？', 'neighbors'],
    // 入居審査にかかわる属性と、安全の言い切りを求める質問（セキュリティ点検 A2）
    ['外国籍でも借りられますか', 'screening'],
    ['収入が少なくても大丈夫ですか', 'screening'],
    ['生活保護でも入居できますか', 'screening'],
    ['夜道は安全ですか', 'safety'],
  ])('%s → %s', (text, topic) => {
    expect(detectForbiddenTopicByKeyword(text)).toBe(topic);
  });

  it.each(['静かなところがいい', '初期費用を抑えたい', '渋谷で9万まで', 'ペット可の部屋', 'オートロックで安心したい'])('希望は拾わない: %s', (text) => {
    expect(detectForbiddenTopicByKeyword(text)).toBeNull();
  });
});
