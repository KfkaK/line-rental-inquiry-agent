import { describe, expect, it } from 'vitest';
import type { HandoffNote, Slots } from '@/domain/types';
import { groupConditions } from './conditions';
import { describeHandoffNote } from './notes';

const note = (over: Partial<HandoffNote> = {}): HandoffNote => ({
  text: '1番目は今空いてますか？',
  topic: 'vacancy',
  propertyIds: ['P0001'],
  at: '2026-10-10T14:00:00.000Z',
  ...over,
});

describe('describeHandoffNote', () => {
  it('話題が分かれば「空室状況: 『…』」の形にする', () => {
    expect(describeHandoffNote(note())).toBe('空室状況: 『1番目は今空いてますか？』');
    expect(describeHandoffNote(note({ topic: 'safety', text: '夜は治安どうですか' }))).toBe('周辺の治安: 『夜は治安どうですか』');
  });

  it('話題が null なら質問だけ', () => {
    expect(describeHandoffNote(note({ topic: null }))).toBe('『1番目は今空いてますか？』');
  });

  it('改行を空白にし、長ければ切って「…」を付ける', () => {
    expect(describeHandoffNote(note({ text: '空いてますか？\n\n至急です', topic: null }))).toBe('『空いてますか？ 至急です』');
    expect(describeHandoffNote(note({ text: 'あいうえおかきくけこ', topic: null }), 5)).toBe('『あいうえお…』');
    expect(describeHandoffNote(note({ text: 'あいうえお', topic: null }), 5)).toBe('『あいうえお』');
  });

  it('保存期間を過ぎて原文を消したメモ（text が空）は、空の『』でなく削除済みと出す', () => {
    expect(describeHandoffNote(note({ text: '' }))).toBe('空室状況: （保存期間を過ぎたため削除）');
    expect(describeHandoffNote(note({ text: '', topic: null }), 5)).toBe('（保存期間を過ぎたため削除）');
  });
});

describe('groupConditions', () => {
  it('優先度ごと（外せない → できれば → あれば）にタグも含めてまとめ、空の優先度は出さない', () => {
    const slots: Slots = {
      area: { value: { stations: ['渋谷', '中目黒'], wards: [] }, priority: 'must' },
      rentMax: { value: 90000, priority: 'must' },
      walkMax: { value: 10, priority: 'want' },
      tags: [
        { value: 'オートロック', priority: 'want' },
        { value: '静か', priority: 'must' },
      ],
    };
    expect(groupConditions(slots)).toEqual([
      { priority: 'must', label: '外せない', items: ['渋谷・中目黒エリア', '予算9万円以内', '静か'] },
      { priority: 'want', label: 'できれば', items: ['徒歩10分以内', 'オートロック'] },
    ]);
  });

  it('条件が無ければ空', () => {
    expect(groupConditions({ tags: [] })).toEqual([]);
  });
});
