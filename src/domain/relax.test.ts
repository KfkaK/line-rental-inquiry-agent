import { describe, expect, it } from 'vitest';
import { baseSlots, makeProperty } from './fixtures';
import { suggestRelaxation } from './relax';
import { applySlotOps } from './slots';
import { countMatches } from './search';

describe('suggestRelaxation', () => {
  it('must を1つ want に下げて最も増えるものを提案する', () => {
    const slots = baseSlots({
      tags: [
        { value: 'オートロック', priority: 'must' },
        { value: 'バストイレ別', priority: 'must' },
      ],
    });
    const props = [
      makeProperty({ tags: ['バストイレ別'] }),
      makeProperty({ tags: ['バストイレ別'] }),
      makeProperty({ tags: ['オートロック'] }),
      makeProperty({ tags: ['オートロック', 'バストイレ別'] }),
    ];
    const s = suggestRelaxation(props, slots)!;
    expect(s.kind).toBe('downgrade');
    expect(s.ref).toEqual({ kind: 'tag', tag: 'オートロック' });
    expect(s.label).toBe('オートロックを「できれば」にする');
    expect(s.gained).toBe(2);
    expect(s.totalAfter).toBe(3);
    // 提案の ops を当てると件数がそのとおり増える
    expect(countMatches(props, applySlotOps(slots, s.ops))).toBe(3);
  });

  it('同数なら条件の並び順で先のもの（決定的）', () => {
    const slots = baseSlots({
      floorMin: { value: 2, priority: 'must' },
      tags: [{ value: 'オートロック', priority: 'must' }],
    });
    const props = [makeProperty({ floor: 1, tags: ['オートロック'] }), makeProperty({ floor: 3, tags: [] })];
    expect(suggestRelaxation(props, slots)!.ref).toEqual({ kind: 'slot', key: 'floorMin' });
  });

  it('エリアと予算は下げる候補にせず、従来型（予算＋5,000円）に回す', () => {
    const props = [makeProperty({ rent: 88000, managementFee: 5000 })];
    const s = suggestRelaxation(props, baseSlots())!;
    expect(s.kind).toBe('widen');
    expect(s.label).toBe('予算を9.5万円まで広げる');
    expect(s.ops).toEqual([{ op: 'set', key: 'rentMax', value: 95000 }]);
    expect(s.gained).toBe(1);
  });

  it('予算で増えなければ徒歩＋5分、それでも駄目なら隣の駅', () => {
    const walkSlots = baseSlots({ walkMax: { value: 5, priority: 'must' } });
    const far = makeProperty({ access: [{ station: '渋谷', walkMin: 9 }] });
    expect(suggestRelaxation([far], walkSlots)!.label).toBe('徒歩10分まで広げる');

    const neighbor = makeProperty({ ward: '渋谷区', access: [{ station: '代官山', walkMin: 4 }] });
    const s = suggestRelaxation([neighbor], baseSlots())!;
    expect(s.ref).toEqual({ kind: 'slot', key: 'area' });
    expect(s.label).toBe('隣の駅（恵比寿・原宿・代官山）も含める');
    expect(s.gained).toBe(1);
  });

  it('何をしても増えなければ null', () => {
    const props = [makeProperty({ ward: '杉並区', access: [{ station: '荻窪', walkMin: 3 }] })];
    expect(suggestRelaxation(props, baseSlots())).toBeNull();
  });
});
