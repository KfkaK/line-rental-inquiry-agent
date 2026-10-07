import { describe, expect, it } from 'vitest';
import { applySlotOps, asAllMust, emptySlots, listConditions, missingForSearch, priorityOp } from './slots';
import { formatManYen } from './labels';

describe('applySlotOps', () => {
  it('新規の条件は既定の優先度（エリア・予算は must、それ以外は want）', () => {
    const s = applySlotOps(emptySlots(), [
      { op: 'set', key: 'area', value: { stations: ['渋谷'], wards: [] } },
      { op: 'set', key: 'rentMax', value: 90000 },
      { op: 'set', key: 'walkMax', value: 10 },
      { op: 'addTag', tag: 'オートロック' },
    ]);
    expect(s.area?.priority).toBe('must');
    expect(s.rentMax?.priority).toBe('must');
    expect(s.walkMax?.priority).toBe('want');
    expect(s.tags).toEqual([{ value: 'オートロック', priority: 'want' }]);
  });

  it('値だけの変更は元の優先度を保つ（「もう少し安いのは？」）', () => {
    const s0 = applySlotOps(emptySlots(), [{ op: 'set', key: 'walkMax', value: 10, priority: 'nice' }]);
    const s1 = applySlotOps(s0, [{ op: 'set', key: 'walkMax', value: 7 }]);
    expect(s1.walkMax).toEqual({ value: 7, priority: 'nice' });
  });

  it('優先度だけの変更（「やっぱり2階以上は必須」「オートロックはなくてもいい」）', () => {
    const s0 = applySlotOps(emptySlots(), [
      { op: 'set', key: 'floorMin', value: 2 },
      { op: 'addTag', tag: 'オートロック' },
    ]);
    const s1 = applySlotOps(s0, [
      { op: 'setPriority', key: 'floorMin', priority: 'must' },
      { op: 'setTagPriority', tag: 'オートロック', priority: 'nice' },
    ]);
    expect(s1.floorMin?.priority).toBe('must');
    expect(s1.tags[0].priority).toBe('nice');
  });

  it('スロットに無い条件への優先度変更は無視する', () => {
    const s = applySlotOps(emptySlots(), [
      { op: 'setPriority', key: 'floorMin', priority: 'must' },
      { op: 'setTagPriority', tag: 'ペット可', priority: 'must' },
    ]);
    expect(s).toEqual(emptySlots());
  });

  it('addTag は重複させず、priority 指定時だけ更新する', () => {
    const s0 = applySlotOps(emptySlots(), [{ op: 'addTag', tag: 'ペット可', priority: 'must' }]);
    const s1 = applySlotOps(s0, [{ op: 'addTag', tag: 'ペット可' }]);
    expect(s1.tags).toEqual([{ value: 'ペット可', priority: 'must' }]);
    const s2 = applySlotOps(s1, [{ op: 'addTag', tag: 'ペット可', priority: 'nice' }]);
    expect(s2.tags).toEqual([{ value: 'ペット可', priority: 'nice' }]);
  });

  it('unset と removeTag', () => {
    const s0 = applySlotOps(emptySlots(), [
      { op: 'set', key: 'walkMax', value: 10 },
      { op: 'addTag', tag: '静か' },
    ]);
    const s1 = applySlotOps(s0, [
      { op: 'unset', key: 'walkMax' },
      { op: 'removeTag', tag: '静か' },
    ]);
    expect(s1).toEqual(emptySlots());
  });

  it('元のスロットを変えない', () => {
    const s0 = applySlotOps(emptySlots(), [{ op: 'addTag', tag: '静か' }]);
    const snapshot = JSON.stringify(s0);
    applySlotOps(s0, [{ op: 'setTagPriority', tag: '静か', priority: 'must' }, { op: 'removeTag', tag: '静か' }]);
    expect(JSON.stringify(s0)).toBe(snapshot);
  });
});

describe('listConditions / missingForSearch / asAllMust', () => {
  const slots = applySlotOps(emptySlots(), [
    { op: 'addTag', tag: 'オートロック', priority: 'nice' },
    { op: 'set', key: 'walkMax', value: 10 },
    { op: 'set', key: 'area', value: { stations: ['渋谷', '中目黒'], wards: [] } },
  ]);

  it('エリア → 予算 → … → タグの順で文言つき', () => {
    expect(listConditions(slots).map((c) => [c.label, c.priority])).toEqual([
      ['渋谷・中目黒エリア', 'must'],
      ['徒歩10分以内', 'want'],
      ['オートロック', 'nice'],
    ]);
  });

  it('検索に要るのはエリアと予算', () => {
    expect(missingForSearch(slots)).toEqual(['rentMax']);
    expect(missingForSearch(applySlotOps(slots, [{ op: 'set', key: 'rentMax', value: 80000 }]))).toEqual([]);
  });

  it('asAllMust は全条件を must にする', () => {
    expect(listConditions(asAllMust(slots)).every((c) => c.priority === 'must')).toBe(true);
  });

  it('priorityOp', () => {
    expect(priorityOp({ kind: 'tag', tag: '静か' }, 'want')).toEqual({ op: 'setTagPriority', tag: '静か', priority: 'want' });
    expect(priorityOp({ kind: 'slot', key: 'floorMin' }, 'must')).toEqual({ op: 'setPriority', key: 'floorMin', priority: 'must' });
  });
});

describe('formatManYen', () => {
  it.each([
    [90000, '9万'],
    [93000, '9.3万'],
    [93500, '9.35万'],
    [100000, '10万'],
    [180000, '18万'],
  ])('%i → %s', (yen, text) => {
    expect(formatManYen(yen)).toBe(text);
  });
});
