import { describe, expect, it } from 'vitest';
import type { SlotOp } from '@/domain/types';
import { describeSlotDiff, describeSlotOp } from './slotDiff';

describe('describeSlotOp', () => {
  it('条件を置く: 「予算: 9万円まで（外せない）」。優先度を省略したら付けない', () => {
    expect(describeSlotOp({ op: 'set', key: 'rentMax', value: 90000, priority: 'must' })).toBe('予算: 9万円まで（外せない）');
    expect(describeSlotOp({ op: 'set', key: 'walkMax', value: 10 })).toBe('駅徒歩: 10分以内');
    expect(describeSlotOp({ op: 'set', key: 'area', value: { stations: ['渋谷', '中目黒'], wards: ['目黒区'] }, priority: 'must' })).toBe(
      'エリア: 渋谷・中目黒・目黒区（外せない）',
    );
    expect(describeSlotOp({ op: 'set', key: 'layouts', value: ['1K', '1LDK'], priority: 'want' })).toBe('間取り: 1K・1LDK（できれば）');
    expect(describeSlotOp({ op: 'set', key: 'floorMin', value: 2, priority: 'want' })).toBe('階数: 2階以上（できれば）');
    expect(describeSlotOp({ op: 'set', key: 'moveIn', value: '2026-11' })).toBe('入居時期: 2026年11月までに入居');
  });

  it('条件を外す・優先度を変える', () => {
    expect(describeSlotOp({ op: 'unset', key: 'walkMax' })).toBe('駅徒歩の指定を外す');
    expect(describeSlotOp({ op: 'setPriority', key: 'rentMax', priority: 'nice' })).toBe('予算を「あれば」にする');
  });

  it('タグ: 追加・外す・優先度の変更', () => {
    expect(describeSlotOp({ op: 'addTag', tag: 'ペット可', priority: 'must' })).toBe('ペット可を追加（外せない）');
    expect(describeSlotOp({ op: 'addTag', tag: 'ペット可' })).toBe('ペット可を追加');
    expect(describeSlotOp({ op: 'removeTag', tag: 'オートロック' })).toBe('オートロックを外す');
    expect(describeSlotOp({ op: 'setTagPriority', tag: '静か', priority: 'want' })).toBe('静かを「できれば」にする');
  });
});

describe('describeSlotDiff', () => {
  it('差分を順に日本語にする', () => {
    const ops: SlotOp[] = [
      { op: 'set', key: 'rentMax', value: 90000, priority: 'must' },
      { op: 'removeTag', tag: 'オートロック' },
    ];
    expect(describeSlotDiff(ops)).toEqual(['予算: 9万円まで（外せない）', 'オートロックを外す']);
    expect(describeSlotDiff([])).toEqual([]);
  });
});
