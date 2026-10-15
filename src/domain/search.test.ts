import { describe, expect, it } from 'vitest';
import { baseSlots, makeProperty } from './fixtures';
import { conditionLabel } from './labels';
import { CLAMP, WALK_NO_PREFERENCE_MIN } from './rules';
import { relevantAccess, scoreProperty, searchProperties } from './search';
import { asAllMust, listConditions } from './slots';

describe('must の絞り込み', () => {
  it('エリアは駅か区のどちらかが合えば一致', () => {
    const slots = baseSlots({ area: { value: { stations: ['中目黒'], wards: ['渋谷区'] }, priority: 'must' } });
    const byStation = makeProperty({ ward: '目黒区', access: [{ station: '中目黒', walkMin: 5 }] });
    const byWard = makeProperty({ ward: '渋谷区', access: [{ station: '代々木', walkMin: 5 }] });
    const neither = makeProperty({ ward: '新宿区', access: [{ station: '新宿', walkMin: 5 }] });
    expect(searchProperties([byStation, byWard, neither], slots).items.map((i) => i.property.id)).toEqual(
      [byStation.id, byWard.id].sort(),
    );
  });

  it('予算は家賃＋管理費で比べる', () => {
    const ok = makeProperty({ rent: 85000, managementFee: 5000 });
    const over = makeProperty({ rent: 86000, managementFee: 5000 });
    expect(searchProperties([ok, over], baseSlots()).items.map((i) => i.property.id)).toEqual([ok.id]);
  });

  it('非公開（成約済み）は出さない', () => {
    const hidden = makeProperty({ status: 'private' });
    expect(searchProperties([hidden], baseSlots()).total).toBe(0);
  });

  it('must のタグ・階・間取り・入居時期は全か無か', () => {
    const slots = baseSlots({
      layouts: { value: ['1K', '1DK'], priority: 'must' },
      floorMin: { value: 2, priority: 'must' },
      moveIn: { value: '2026-11', priority: 'must' },
      tags: [{ value: 'バストイレ別', priority: 'must' }],
    });
    const ok = makeProperty({ availableFrom: '2026-11-30' });
    const noTag = makeProperty({ tags: [] });
    const ground = makeProperty({ floor: 1 });
    const wrongLayout = makeProperty({ layout: '1R' });
    const late = makeProperty({ availableFrom: '2026-12-01' });
    expect(searchProperties([ok, noTag, ground, wrongLayout, late], slots).items.map((i) => i.property.id)).toEqual([
      ok.id,
    ]);
  });
});

/** 徒歩の条件を must で置き、徒歩の目安（採点に足す nice）を外して重みだけを見る */
const NO_WALK_GUIDE = { walkMax: { value: 30, priority: 'must' as const } };

describe('want / nice のスコア', () => {
  it('want は重み2、nice は重み1', () => {
    const slots = baseSlots({
      ...NO_WALK_GUIDE,
      tags: [
        { value: 'オートロック', priority: 'want' },
        { value: '宅配ボックス', priority: 'nice' },
      ],
    });
    const wantOnly = scoreProperty(makeProperty({ tags: ['オートロック'] }), slots)!;
    const niceOnly = scoreProperty(makeProperty({ tags: ['宅配ボックス'] }), slots)!;
    expect(wantOnly.score).toBeCloseTo(2 / 3);
    expect(niceOnly.score).toBeCloseTo(1 / 3);
  });

  it('徒歩10分 want に 12分は部分点 0.6、14分は 0', () => {
    const slots = baseSlots({ walkMax: { value: 10, priority: 'want' } });
    expect(scoreProperty(makeProperty({ access: [{ station: '渋谷', walkMin: 12 }] }), slots)!.score).toBeCloseTo(0.6);
    expect(scoreProperty(makeProperty({ access: [{ station: '渋谷', walkMin: 14 }] }), slots)!.score).toBe(0);
  });

  it('予算 want は 5,000円超までは部分点', () => {
    const slots = baseSlots({ ...NO_WALK_GUIDE, rentMax: { value: 90000, priority: 'want' } });
    expect(scoreProperty(makeProperty({ rent: 90000, managementFee: 5000 }), slots)!.score).toBeCloseTo(0.6);
    expect(scoreProperty(makeProperty({ rent: 90000, managementFee: 6000 }), slots)!.score).toBe(0);
  });

  it('want/nice が無く、徒歩の目安（15分）以内ならスコア 1', () => {
    expect(scoreProperty(makeProperty(), baseSlots())!.score).toBe(1);
    expect(scoreProperty(makeProperty(), baseSlots(NO_WALK_GUIDE))!.score).toBe(1);
  });

  it('一致の内訳: matched は条件の文言、unmatched はそのまま表示できる不足の説明', () => {
    const slots = baseSlots({
      walkMax: { value: 10, priority: 'want' },
      floorMin: { value: 2, priority: 'want' },
      tags: [{ value: 'オートロック', priority: 'nice' }],
    });
    const r = scoreProperty(makeProperty({ access: [{ station: '渋谷', walkMin: 12 }], floor: 3, tags: [] }), slots)!;
    expect(r.matched).toEqual(['渋谷エリア', '予算9万円以内', '2階以上']);
    expect(r.unmatched).toEqual(['徒歩12分', 'オートロックなし']);
    expect(r.conditions).toHaveLength(5);
  });
});

describe('徒歩の目安（徒歩の条件が無いとき。意思決定ログ24）', () => {
  const nakameguro = baseSlots({ area: { value: { stations: ['中目黒'], wards: [] }, priority: 'must' } });
  const at = (walkMin: number, over: Parameters<typeof makeProperty>[0] = {}) =>
    makeProperty({ access: [{ station: '中目黒', walkMin }], ...over });

  it('聞かれた駅まで15分以内は満点、18分までは部分点、それより遠いと 0（nice として採点に足す）', () => {
    expect(scoreProperty(at(15), nakameguro)!.score).toBe(1);
    expect(scoreProperty(at(18), nakameguro)!.score).toBeCloseTo(0.6);
    expect(scoreProperty(at(19), nakameguro)!.score).toBe(0);
  });

  it('安くても聞かれた駅から遠い物件は、近い物件より後ろ（祐天寺 15分・中目黒 22分 の物件を中目黒で探した場合）', () => {
    const far = makeProperty({
      id: 'P0161',
      rent: 63000,
      access: [
        { station: '祐天寺', walkMin: 15 },
        { station: '中目黒', walkMin: 22 },
      ],
    });
    const near = at(10, { id: 'P0096', rent: 70000 });
    const result = searchProperties([far, near], nakameguro);
    expect(result.items.map((i) => i.property.id)).toEqual(['P0096', 'P0161']);
    expect(result.total).toBe(2); // 絞り込み（must の件数）は変えない
  });

  it('徒歩の条件があれば（優先度を問わず）目安は使わない', () => {
    const far = at(22, { id: 'P0001', rent: 63000 });
    const near = at(10, { id: 'P0002', rent: 70000 });
    const slots = { ...nakameguro, walkMax: { value: 30, priority: 'nice' as const } };
    expect(searchProperties([far, near], slots).items.map((i) => i.property.id)).toEqual(['P0001', 'P0002']);
  });

  it('「できれば」の条件のほうが重い: 遠くても want に合う物件は、近くて want に合わない物件より上', () => {
    const slots = { ...nakameguro, tags: [{ value: 'オートロック' as const, priority: 'want' as const }] };
    const farWithLock = at(25, { id: 'P0001', tags: ['オートロック'] });
    const nearNoLock = at(5, { id: 'P0002', tags: [] });
    expect(searchProperties([nearNoLock, farWithLock], slots).items.map((i) => i.property.id)).toEqual(['P0001', 'P0002']);
  });

  it('目安は利用者の条件ではないので、conditions・matched・unmatched（カードの「希望N件中M件」）には入らない', () => {
    const r = scoreProperty(at(22), nakameguro)!;
    expect(r.conditions.map((c) => c.label)).toEqual(['中目黒エリア', '予算9万円以内']);
    expect(r.unmatched).toEqual([]);
  });

  it('区だけの指定では最寄り駅までの徒歩で見る', () => {
    const slots = baseSlots({ area: { value: { stations: [], wards: ['渋谷区'] }, priority: 'must' } });
    const near = makeProperty({ id: 'P0002', rent: 80000, access: [{ station: '代々木', walkMin: 6 }] });
    const far = makeProperty({ id: 'P0001', rent: 60000, access: [{ station: '代々木', walkMin: 20 }] });
    expect(searchProperties([far, near], slots).items.map((i) => i.property.id)).toEqual(['P0002', 'P0001']);
  });
});

describe('「駅から遠くてもいい」（walkMax = WALK_NO_PREFERENCE_MIN を nice。意思決定ログ26）', () => {
  it('値は徒歩の値域の上限と同じで、条件の文言は「駅からの距離は問わない」', () => {
    expect(WALK_NO_PREFERENCE_MIN).toBe(CLAMP.walkMin.max);
    const slots = baseSlots({ walkMax: { value: WALK_NO_PREFERENCE_MIN, priority: 'nice' } });
    expect(listConditions(slots).map((c) => c.label)).toContain('駅からの距離は問わない');
    expect(conditionLabel({ kind: 'slot', key: 'walkMax' }, slots)).toBe('駅からの距離は問わない');
  });

  it('目安は使わず、遠くても安い物件が先に来る', () => {
    const slots = baseSlots({
      area: { value: { stations: ['中目黒'], wards: [] }, priority: 'must' },
      walkMax: { value: WALK_NO_PREFERENCE_MIN, priority: 'nice' },
    });
    const far = makeProperty({ id: 'P0161', rent: 63000, access: [{ station: '中目黒', walkMin: 22 }] });
    const near = makeProperty({ id: 'P0096', rent: 70000, access: [{ station: '中目黒', walkMin: 10 }] });
    expect(searchProperties([near, far], slots).items.map((i) => i.property.id)).toEqual(['P0161', 'P0096']);
  });
});

describe('並び順', () => {
  it('スコアと月額が同じなら、表示する駅まで徒歩の近い順', () => {
    const slots = baseSlots();
    const a = makeProperty({ id: 'P0001', rent: 70000, access: [{ station: '渋谷', walkMin: 12 }] });
    const b = makeProperty({ id: 'P0002', rent: 70000, access: [{ station: '渋谷', walkMin: 5 }] });
    expect(searchProperties([a, b], slots).items.map((i) => i.property.id)).toEqual(['P0002', 'P0001']);
  });

  it('スコア降順 → 月額の安い順 → 徒歩の近い順 → ID 昇順（決定的）', () => {
    const slots = baseSlots({ tags: [{ value: 'オートロック', priority: 'want' }] });
    const a = makeProperty({ id: 'P0003', rent: 80000, tags: [] });
    const b = makeProperty({ id: 'P0002', rent: 80000, tags: [] });
    const c = makeProperty({ id: 'P0009', rent: 70000, tags: [] });
    const d = makeProperty({ id: 'P0010', rent: 85000, tags: ['オートロック'] });
    const order = searchProperties([a, b, c, d], slots).items.map((i) => i.property.id);
    expect(order).toEqual(['P0010', 'P0009', 'P0002', 'P0003']);
    expect(searchProperties([d, c, b, a], slots).items.map((i) => i.property.id)).toEqual(order);
  });

  it('優先順位つき検索は、全条件 AND（Web サイト式）で 0 件のときも候補を出す', () => {
    const slots = baseSlots({
      walkMax: { value: 10, priority: 'want' },
      tags: [
        { value: 'バストイレ別', priority: 'must' },
        { value: 'オートロック', priority: 'nice' },
      ],
    });
    const props = [
      makeProperty({ tags: ['バストイレ別'], access: [{ station: '渋谷', walkMin: 9 }] }),
      makeProperty({ tags: ['バストイレ別'], access: [{ station: '渋谷', walkMin: 12 }] }),
    ];
    expect(searchProperties(props, asAllMust(slots)).total).toBe(0);
    expect(searchProperties(props, slots).total).toBe(2);
  });
});

describe('relevantAccess', () => {
  const p = makeProperty({
    access: [
      { station: '渋谷', walkMin: 6 },
      { station: '代官山', walkMin: 9 },
    ],
  });

  it('エリアの駅があればその駅の徒歩で評価・表示する', () => {
    expect(relevantAccess(p, { stations: ['代官山'], wards: [] })).toEqual({ station: '代官山', walkMin: 9 });
    const slots = baseSlots({
      area: { value: { stations: ['代官山'], wards: [] }, priority: 'must' },
      walkMax: { value: 7, priority: 'want' },
    });
    const r = scoreProperty(p, slots)!;
    expect(r.displayAccess.station).toBe('代官山');
    expect(r.unmatched).toEqual(['徒歩9分']);
  });

  it('エリアの駅が無ければ最寄り', () => {
    expect(relevantAccess(p, { stations: [], wards: ['渋谷区'] })).toEqual({ station: '渋谷', walkMin: 6 });
    expect(relevantAccess(p)).toEqual({ station: '渋谷', walkMin: 6 });
  });
});
