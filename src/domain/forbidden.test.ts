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
  ])('%s → %s', (text, topic) => {
    expect(detectForbiddenTopicByKeyword(text)).toBe(topic);
  });

  it.each(['静かなところがいい', '初期費用を抑えたい', '渋谷で9万まで', 'ペット可の部屋'])('希望は拾わない: %s', (text) => {
    expect(detectForbiddenTopicByKeyword(text)).toBeNull();
  });
});
