/**
 * 優先順位つき検索（純関数。DESIGN.md 3.2.1・4.2）。
 * 1. must の条件で絞り込む（全か無か）
 * 2. 残った物件を want（重み2）/ nice（重み1）の一致度でスコア化する。数値条件は段階評価で部分点。
 *    徒歩の条件が無いときは、徒歩の目安（rules.DEFAULT_WALK_PREFERENCE_MIN）を nice として採点に足す（意思決定ログ24）
 * 3. スコア降順 → 月額の安い順 → 徒歩の近い順 → 物件 ID 昇順で並べる（決定的）
 *
 * must の絞り込みは SQL の WHERE ではなく、公開物件を全件取得してこの関数で行う（意思決定ログ2）。
 */
import { formatDate, formatManYen } from './labels';
import { listConditions } from './slots';
import {
  BUDGET_INCLUDES_MANAGEMENT_FEE,
  DEFAULT_WALK_PREFERENCE_MIN,
  FLOOR_PARTIAL_TOLERANCE,
  PARTIAL_CREDIT,
  PRIORITY_WEIGHT,
  RENT_PARTIAL_TOLERANCE_YEN,
  WALK_PARTIAL_TOLERANCE_MIN,
} from './rules';
import type {
  Access,
  AreaValue,
  ConditionRef,
  ConditionResult,
  Property,
  ScoredProperty,
  SearchResult,
  Slots,
} from './types';

/** 予算と比べる月額 */
export function monthlyCost(property: Property): number {
  return property.rent + (BUDGET_INCLUDES_MANAGEMENT_FEE ? property.managementFee : 0);
}

/**
 * 徒歩の評価と表示に使う駅。エリア条件の駅に入っている駅があればその中で最短、
 * 無ければ全駅の中で最短（同じ分数なら access の並び順で先のもの）
 */
export function relevantAccess(property: Property, area?: AreaValue): Access {
  const inArea = area ? property.access.filter((a) => area.stations.includes(a.station)) : [];
  const pool = inArea.length > 0 ? inArea : property.access;
  return pool.reduce((best, a) => (a.walkMin < best.walkMin ? a : best));
}

/** 'YYYY-MM' の月末 'YYYY-MM-DD' */
function endOfMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ym}-${String(last).padStart(2, '0')}`;
}

interface Evaluation {
  credit: number;
  shortfall: string | null;
}

const FULL: Evaluation = { credit: 1, shortfall: null };

/** 上限つきの数値条件の段階評価（上限以内 1、許容幅以内 PARTIAL_CREDIT、それ以上 0） */
function gradeUpperBound(actual: number, max: number, tolerance: number): number {
  if (actual <= max) return 1;
  if (actual <= max + tolerance) return PARTIAL_CREDIT;
  return 0;
}

function evaluate(ref: ConditionRef, property: Property, slots: Slots): Evaluation {
  if (ref.kind === 'tag') {
    return property.tags.includes(ref.tag) ? FULL : { credit: 0, shortfall: `${ref.tag}なし` };
  }
  switch (ref.key) {
    case 'area': {
      const area = slots.area!.value;
      const hit =
        property.access.some((a) => area.stations.includes(a.station)) || area.wards.includes(property.ward);
      return hit ? FULL : { credit: 0, shortfall: '希望エリア外' };
    }
    case 'rentMax': {
      const cost = monthlyCost(property);
      const credit = gradeUpperBound(cost, slots.rentMax!.value, RENT_PARTIAL_TOLERANCE_YEN);
      return credit === 1 ? FULL : { credit, shortfall: `月額${formatManYen(cost)}円` };
    }
    case 'layouts':
      return slots.layouts!.value.includes(property.layout)
        ? FULL
        : { credit: 0, shortfall: property.layout };
    case 'walkMax': {
      const walk = relevantAccess(property, slots.area?.value).walkMin;
      const credit = gradeUpperBound(walk, slots.walkMax!.value, WALK_PARTIAL_TOLERANCE_MIN);
      return credit === 1 ? FULL : { credit, shortfall: `徒歩${walk}分` };
    }
    case 'floorMin': {
      const min = slots.floorMin!.value;
      if (property.floor >= min) return FULL;
      const credit = property.floor >= min - FLOOR_PARTIAL_TOLERANCE ? PARTIAL_CREDIT : 0;
      return { credit, shortfall: `${property.floor}階` };
    }
    case 'moveIn': {
      const from = property.availableFrom;
      if (from === null || from <= endOfMonth(slots.moveIn!.value)) return FULL;
      return { credit: 0, shortfall: `${formatDate(from)}から入居可` };
    }
  }
}

/**
 * 徒歩の条件が無いので、徒歩の目安（DEFAULT_WALK_PREFERENCE_MIN 分以内を nice）で並べるか。
 * 「中目黒で」と言われて中目黒まで徒歩22分の物件が安さだけで1番目に来ないようにする（意思決定ログ24）
 */
export function usesDefaultWalkPreference(slots: Slots): boolean {
  return slots.walkMax === undefined;
}

/** 1件を評価する。must を1つでも満たさなければ null */
export function scoreProperty(property: Property, slots: Slots): ScoredProperty | null {
  const conditions: ConditionResult[] = [];
  let weighted = 0;
  let totalWeight = 0;
  // 徒歩の目安は採点だけに効かせ、conditions（カードの「希望N件中M件」と不足の説明）には入れない。利用者が言っていない条件のため
  if (usesDefaultWalkPreference(slots)) {
    const walk = relevantAccess(property, slots.area?.value).walkMin;
    const w = PRIORITY_WEIGHT.nice;
    weighted += w * gradeUpperBound(walk, DEFAULT_WALK_PREFERENCE_MIN, WALK_PARTIAL_TOLERANCE_MIN);
    totalWeight += w;
  }
  for (const c of listConditions(slots)) {
    const { credit, shortfall } = evaluate(c.ref, property, slots);
    if (c.priority === 'must') {
      if (credit < 1) return null;
    } else {
      const w = PRIORITY_WEIGHT[c.priority];
      weighted += w * credit;
      totalWeight += w;
    }
    conditions.push({ ref: c.ref, priority: c.priority, label: c.label, credit, shortfall });
  }
  return {
    property,
    score: totalWeight === 0 ? 1 : weighted / totalWeight,
    conditions,
    matched: conditions.filter((c) => c.credit === 1).map((c) => c.label),
    unmatched: conditions.filter((c) => c.credit < 1).map((c) => c.shortfall!),
    displayAccess: relevantAccess(property, slots.area?.value),
  };
}

/** スコア降順 → 月額の安い順 → 徒歩（表示に使う駅まで）の近い順 → 物件 ID 昇順 */
function compareScored(a: ScoredProperty, b: ScoredProperty): number {
  if (a.score !== b.score) return b.score - a.score;
  const cost = monthlyCost(a.property) - monthlyCost(b.property);
  if (cost !== 0) return cost;
  const walk = a.displayAccess.walkMin - b.displayAccess.walkMin;
  if (walk !== 0) return walk;
  return a.property.id < b.property.id ? -1 : a.property.id > b.property.id ? 1 : 0;
}

/** 公開物件だけを対象に、must で絞ってスコア順に並べる */
export function searchProperties(properties: readonly Property[], slots: Slots): SearchResult {
  const items: ScoredProperty[] = [];
  for (const p of properties) {
    if (p.status !== 'public') continue;
    const scored = scoreProperty(p, slots);
    if (scored) items.push(scored);
  }
  items.sort(compareScored);
  return { total: items.length, items };
}

/** must を満たす件数だけを数える（緩和の試算用） */
export function countMatches(properties: readonly Property[], slots: Slots): number {
  return searchProperties(properties, slots).total;
}
