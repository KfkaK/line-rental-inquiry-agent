import { describe, expect, it } from 'vitest';
import { SCALAR_SLOT_KEYS, TAGS } from '@/domain/types';
import {
  buildPostbackData,
  parsePostbackData,
  POSTBACK_DATA_MAX_LENGTH,
  type PostbackData,
} from './postback';

describe('buildPostbackData / parsePostbackData', () => {
  const samples: PostbackData[] = [
    { action: 'detail', propertyId: 'P001' },
    { action: 'viewing', propertyId: 'P001' },
    { action: 'more' },
    { action: 'viewingDay', date: '2026-10-08' },
    { action: 'bookingSubmit' },
    { action: 'relax', ref: { kind: 'tag', tag: 'オートロック' }, accept: true },
    { action: 'relax', ref: { kind: 'slot', key: 'walkMax' }, accept: false },
    { action: 'priority', ref: { kind: 'tag', tag: 'ペット可' } },
    { action: 'priority', ref: { kind: 'slot', key: 'rentMax' } },
    { action: 'loosen', ref: { kind: 'slot', key: 'rentMax' } },
    { action: 'loosen', ref: { kind: 'tag', tag: 'オートロック' } },
  ];

  it.each(samples)('組み立てて解析すると元に戻る: %j', (data) => {
    expect(parsePostbackData(buildPostbackData(data))).toEqual(data);
  });

  it('すべてのスロットキー・タグで往復できる', () => {
    for (const key of SCALAR_SLOT_KEYS) {
      const data: PostbackData = { action: 'priority', ref: { kind: 'slot', key } };
      expect(parsePostbackData(buildPostbackData(data))).toEqual(data);
    }
    for (const tag of TAGS) {
      const data: PostbackData = { action: 'relax', ref: { kind: 'tag', tag }, accept: true };
      const text = buildPostbackData(data);
      expect(text.length).toBeLessThanOrEqual(POSTBACK_DATA_MAX_LENGTH);
      expect(parsePostbackData(text)).toEqual(data);
    }
  });

  it('物件 ID に記号・日本語・空白があっても往復できる', () => {
    for (const propertyId of ['a&b=c', '渋谷-001', 'id with space', '100%', 'x+y', "o'neil"]) {
      const data: PostbackData = { action: 'detail', propertyId };
      expect(parsePostbackData(buildPostbackData(data))).toEqual(data);
    }
  });

  it('形式は URLSearchParams', () => {
    expect(buildPostbackData({ action: 'detail', propertyId: 'P001' })).toBe('a=detail&id=P001');
    expect(buildPostbackData({ action: 'more' })).toBe('a=more');
  });

  it('組み立て: 空・長すぎ・制御文字の物件 ID は例外', () => {
    expect(() => buildPostbackData({ action: 'detail', propertyId: '' })).toThrow();
    expect(() => buildPostbackData({ action: 'viewing', propertyId: 'x'.repeat(101) })).toThrow();
    expect(() => buildPostbackData({ action: 'detail', propertyId: 'a\nb' })).toThrow();
  });
});

describe('parsePostbackData: 不正な入力は null（例外にしない）', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['数値', 42],
    ['オブジェクト', { a: 'more' }],
    ['空文字', ''],
    ['ただの文字列', 'こんにちは'],
    ['action なし', 'id=P001'],
    ['未知の action', 'a=delete&id=P001'],
    ['物件 ID なし', 'a=detail'],
    ['物件 ID が空', 'a=viewing&id='],
    ['物件 ID が長すぎ', `a=detail&id=${'x'.repeat(101)}`],
    ['物件 ID に制御文字', 'a=detail&id=a%0Ab'],
    ['relax に ref なし', 'a=relax&accept=1'],
    ['relax の accept が不正', 'a=relax&k=tag&tag=ペット可&accept=maybe'],
    ['relax の accept なし', 'a=relax&k=tag&tag=ペット可'],
    ['未知のタグ', 'a=priority&k=tag&tag=存在しないタグ'],
    ['未知のスロットキー', 'a=priority&k=slot&key=__proto__'],
    ['未知の kind', 'a=priority&k=other&key=area'],
    ['kind とキーの食い違い', 'a=priority&k=slot&tag=ペット可'],
    ['loosen の参照なし', 'a=loosen'],
    ['300 文字超', `a=detail&id=P001&junk=${'x'.repeat(300)}`],
  ])('%s', (_name, input) => {
    expect(parsePostbackData(input)).toBeNull();
  });

  it('壊れたパーセントエンコードでも例外にしない', () => {
    expect(() => parsePostbackData('a=detail&id=%E3%81')).not.toThrow();
    expect(() => parsePostbackData('%%%&&&===')).not.toThrow();
  });

  it('余計なパラメータは無視する', () => {
    expect(parsePostbackData('a=more&x=1')).toEqual({ action: 'more' });
  });
});

describe('viewingDay の日付', () => {
  it('YYYY-MM-DD 以外は組み立てで例外・解析で null', () => {
    expect(() => buildPostbackData({ action: 'viewingDay', date: '10/8' })).toThrow();
    expect(parsePostbackData('a=viewingDay&d=2026-1-8')).toBeNull();
    expect(parsePostbackData('a=viewingDay')).toBeNull();
  });
});
