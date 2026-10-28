import { describe, expect, it } from 'vitest';
import { defaultCalendar, fromJst } from './businessHours';
import { makeProperty } from './fixtures';
import * as msg from './messages';
import { emptySlots } from './slots';
import { decideTurn, type ConversationSnapshot, type TurnContext, type TurnDecision } from './turn';
import type { ExtractionResult, Property, SlotOp } from './types';

const calendar = defaultCalendar();
/** 火曜 23:30（時間外。水曜定休なので連絡は木曜 10/8） */
const NIGHT = fromJst('2026-10-06', '23:30');
/** 木曜 12:00（営業時間内） */
const NOON = fromJst('2026-10-08', '12:00');

function ex(partial: Partial<ExtractionResult> = {}): ExtractionResult {
  return { intent: 'conditions', ops: [], targetPositions: [], viewingTimes: [], forbiddenTopic: null, ...partial };
}

function fresh(): ConversationSnapshot {
  return { state: 'hearing', slots: emptySlots(), shownPropertyIds: [], priorityAskedCount: 0, booking: null };
}

function ctx(properties: Property[], now = NOON): TurnContext {
  return { now, calendar, properties };
}

const AREA_AND_BUDGET: SlotOp[] = [
  { op: 'set', key: 'area', value: { stations: ['渋谷'], wards: [] } },
  { op: 'set', key: 'rentMax', value: 90000 },
];

/** 渋谷・月額 8.1〜(8+n/1000) 万の物件を n 件 */
function shibuya(n: number, overrides: Partial<Property> = {}): Property[] {
  return Array.from({ length: n }, (_, i) =>
    makeProperty({ id: `S${String(i + 1).padStart(3, '0')}`, rent: 75000 + i * 100, ...overrides }),
  );
}

function texts(d: TurnDecision): string[] {
  return d.replies.filter((r) => r.type === 'text').map((r) => (r as { text: string }).text);
}

function search(props: Property[], ops: SlotOp[] = AREA_AND_BUDGET, conv = fresh(), now = NOON) {
  return decideTurn(conv, { kind: 'text', text: '渋谷で9万まで', extraction: ex({ ops }) }, ctx(props, now));
}

describe('ヒアリングと検索', () => {
  it('友だち追加: AI の一次対応を明示し、時間外ならその旨も', () => {
    const d = decideTurn(fresh(), { kind: 'follow' }, ctx([], NIGHT));
    expect(texts(d)[0]).toContain('AI が一次対応');
    expect(texts(d)[0]).toContain('営業時間外');
    expect(d.quickReplies.map((q) => q.label)).toContain('渋谷');
  });

  it('友だち追加し直し（ブロック解除）: 前回の条件・提示・内見の下書きを捨てて聞き直す', () => {
    const props = shibuya(8);
    const viewing = decideTurn(search(props).next, { kind: 'viewing', propertyId: 'S001' }, ctx(props));
    expect(viewing.next.booking).not.toBeNull();
    const d = decideTurn(viewing.next, { kind: 'follow' }, ctx(props, NIGHT));
    expect(d.next).toEqual(fresh());
    expect(texts(d)[0]).toContain('エリア');
  });

  it('エリアだけなら予算を1つだけ聞き返す', () => {
    const d = search(shibuya(3), [AREA_AND_BUDGET[0]]);
    expect(texts(d)).toEqual([expect.stringContaining('ご予算')]);
    expect(d.quickReplies.map((q) => q.label)).toContain('9万円まで');
    expect(d.next.state).toBe('hearing');
  });

  it('エリアと予算が揃ったら優先順位を聞かずに即検索し、5件ずつ見せる', () => {
    const d = search(shibuya(8));
    expect(texts(d)[0]).toContain('8件あります');
    expect(texts(d)[0]).toContain('外せない: 渋谷エリア・予算9万円以内');
    const carousel = d.replies.find((r) => r.type === 'carousel')!;
    expect(carousel).toMatchObject({ startPosition: 1, hasMore: true });
    expect(d.next.shownPropertyIds).toEqual(['S001', 'S002', 'S003', 'S004', 'S005']);
    expect(d.next.state).toBe('presenting');
    expect(d.quickReplies.map((q) => q.label)).toEqual(['もっと見る']);
  });

  it('「もっと見る」で次の5件（表示番号は続き）', () => {
    const props = shibuya(8);
    const first = search(props);
    const d = decideTurn(first.next, { kind: 'more' }, ctx(props));
    expect(d.replies[0]).toMatchObject({ type: 'carousel', startPosition: 6, hasMore: false });
    expect(d.next.shownPropertyIds).toHaveLength(8);
    const end = decideTurn(d.next, { kind: 'more' }, ctx(props));
    expect(texts(end)[0]).toContain('以上');
  });

  it('最初のターンが営業時間外なら冒頭で案内する', () => {
    const d = search(shibuya(3), AREA_AND_BUDGET, fresh(), NIGHT);
    expect(texts(d)[0]).toContain('営業時間外');
  });

  it('徒歩の条件が無いときは、徒歩の目安で並べたことを添える（あれば添えない）', () => {
    expect(texts(search(shibuya(3)))[0]).toContain('駅からの徒歩は15分以内を目安に並べています');
    const withWalk = search(shibuya(3), [...AREA_AND_BUDGET, { op: 'set', key: 'walkMax', value: 10 }]);
    expect(texts(withWalk)[0]).not.toContain('目安');
  });

  it('条件を変えても1ページ目が前回と同じなら、そう添える（初回と、並びが変わったときは添えない）', () => {
    const props = shibuya(8);
    const first = search(props);
    expect(texts(first)[0]).not.toContain('前回と同じ');
    // 「もっと見る」の後でも、比べるのは前回の1ページ目
    const more = decideTurn(first.next, { kind: 'more' }, ctx(props));
    const same = search(props, [{ op: 'addTag', tag: 'オートロック' }], more.next);
    expect(texts(same)[0]).toContain('上位5件は前回と同じです。続きは「もっと見る」からご覧ください。');
    // 1ページで収まるときは「もっと見る」に触れない
    const few = shibuya(3);
    const again = search(few, [{ op: 'addTag', tag: 'オートロック' }], search(few).next);
    expect(texts(again)[0]).toContain('前回と同じ物件です。');
    expect(texts(again)[0]).not.toContain('もっと見る');
    // 並びが変わったら添えない（オートロック付きの S008 が先頭に来る）
    const locked = shibuya(8).map((p) => (p.id === 'S008' ? { ...p, tags: [...p.tags, 'オートロック' as const] } : p));
    const changed = search(locked, [{ op: 'addTag', tag: 'オートロック' }], search(locked).next);
    expect(texts(changed)[0]).not.toContain('前回と同じ');
  });
});

describe('対応エリアの外の地名（実機で見つかった不具合: 「やっぱり船橋で」が無視され、前のエリアで探していた）', () => {
  const outside = (partial: Partial<ExtractionResult> = {}) => ex({ outOfArea: true, ...partial });

  it('エリアを聞いている途中で言われたら、予算を聞き進めずに対応エリアを案内し、エリアのボタンを出す', () => {
    const asked = search(shibuya(3), [AREA_AND_BUDGET[0]]);
    const d = decideTurn(asked.next, { kind: 'text', text: 'やっぱり船橋で', extraction: outside() }, ctx(shibuya(3)));
    expect(texts(d)).toEqual([msg.outOfArea(false)]);
    expect(texts(d)[0]).toContain('山手線・中央線（東京〜三鷹）・東急東横線（渋谷〜日吉）の駅の近く');
    expect(d.quickReplies.map((q) => q.label)).toContain('渋谷');
    expect(d.replies.some((r) => r.type === 'carousel')).toBe(false);
    // エリアは前の値のまま（言い直してもらう）
    expect(d.next).toEqual(asked.next);
  });

  it('提示の後に言われたら、前のエリアで探し直さない。条件が変わらなければ提示はそのまま', () => {
    const props = shibuya(8);
    const first = search(props);
    const d = decideTurn(first.next, { kind: 'text', text: '船橋市の近くだよ', extraction: outside({ intent: 'offTopic' }) }, ctx(props));
    expect(texts(d)).toEqual([msg.outOfArea(false)]);
    expect(d.next).toEqual(first.next);
  });

  it('同じ発話のほかの条件は当て、提示を捨てて聞き取りに戻す（探さない）', () => {
    const props = shibuya(8);
    const first = search(props);
    const extraction = outside({ ops: [{ op: 'set', key: 'rentMax', value: 100000 }] });
    const d = decideTurn(first.next, { kind: 'text', text: '船橋で10万まで', extraction }, ctx(props));
    expect(texts(d)).toEqual([msg.outOfArea(false)]);
    expect(d.next.slots.rentMax?.value).toBe(100000);
    expect(d.next.slots.area?.value.stations).toEqual(['渋谷']);
    expect(d.next).toMatchObject({ state: 'hearing', shownPropertyIds: [] });
  });

  it('対応エリアの駅も一緒なら、そちらで探して前置きを添える', () => {
    const d = decideTurn(fresh(), { kind: 'text', text: '渋谷か船橋で9万まで', extraction: outside({ ops: AREA_AND_BUDGET }) }, ctx(shibuya(3)));
    expect(texts(d)[0]).toBe(msg.outOfArea(true));
    expect(texts(d)[1]).toContain('3件あります');
    expect(d.replies.some((r) => r.type === 'carousel')).toBe(true);
  });

  it('提示物件への質問の中の地名や、禁止トピックは、これまでどおりに扱う', () => {
    const props = shibuya(3);
    const first = search(props);
    const question = outside({ intent: 'propertyQuestion', targetPositions: [1] });
    const q = decideTurn(first.next, { kind: 'text', text: '1番目から船橋は遠い？', extraction: question }, ctx(props));
    expect(q.replies[0].type).toBe('answer');
    const handoff = outside({ intent: 'handoff', forbiddenTopic: 'safety' });
    const h = decideTurn(first.next, { kind: 'text', text: '船橋って治安いい？', extraction: handoff }, ctx(props));
    expect(texts(h)[0]).toContain('周辺の治安');
  });
});

describe('優先順位と緩和', () => {
  it('0件なら、must を下げて増える条件を具体的に提案する', () => {
    const props = [...shibuya(7, { tags: ['バストイレ別'] }), ...shibuya(1, { id: 'X001', tags: ['オートロック'] })];
    const ops: SlotOp[] = [
      ...AREA_AND_BUDGET,
      { op: 'addTag', tag: 'バストイレ別', priority: 'must' },
      { op: 'addTag', tag: 'オートロック', priority: 'must' },
    ];
    const d = search(props, ops);
    expect(texts(d)).toEqual([
      expect.stringContaining('見つかりませんでした'),
      'オートロックを「できれば」にすると7件増えます。条件を変えますか？',
    ]);
    expect(d.quickReplies.map((q) => q.label)).toEqual(['条件を変える', 'このままにする']);

    const accept = d.quickReplies[0].action;
    if (accept.kind !== 'event') throw new Error('postback のはず');
    const after = decideTurn(d.next, accept.event, ctx(props));
    expect(texts(after)[0]).toContain('7件あります');
    expect(after.next.slots.tags.find((t) => t.value === 'オートロック')?.priority).toBe('want');
  });

  it('0件で1つ緩めても増えないなら、緩められる条件を聞いて「できれば」に下げて探し直す（行き止まりにしない）', () => {
    // 予算5万（must）に対して相場が12万。予算＋5,000円でも、オートロックを下げても0件のまま
    const props = shibuya(3, { rent: 120000, tags: ['オートロック'] });
    const ops: SlotOp[] = [
      { op: 'set', key: 'area', value: { stations: ['渋谷'], wards: [] } },
      { op: 'set', key: 'rentMax', value: 50000, priority: 'must' },
      { op: 'addTag', tag: 'オートロック', priority: 'must' },
    ];
    const d = search(props, ops);
    expect(texts(d)).toEqual([expect.stringContaining('見つかりませんでした'), expect.stringContaining('どの条件なら緩められそうですか')]);
    // エリアはボタンに出さない
    expect(d.quickReplies.map((q) => q.label)).toEqual(['予算5万円以内', 'オートロック']);
    expect(d.next.priorityAskedCount).toBe(1);

    const loosen = d.quickReplies[0].action;
    if (loosen.kind !== 'event') throw new Error('postback のはず');
    expect(loosen.event).toEqual({ kind: 'loosen', ref: { kind: 'slot', key: 'rentMax' } });
    const after = decideTurn(d.next, loosen.event, ctx(props));
    expect(after.next.slots.rentMax?.priority).toBe('want');
    expect(texts(after)[0]).toContain('3件あります');
  });

  it('0件で緩める条件を聞くのは1会話1回まで。2回目以降と、聞ける条件が無いときは条件の変え方の例を返す', () => {
    const props = shibuya(3, { rent: 120000 });
    const ops: SlotOp[] = [
      { op: 'set', key: 'area', value: { stations: ['渋谷'], wards: [] } },
      { op: 'set', key: 'rentMax', value: 50000, priority: 'must' },
    ];
    const asked = search(props, ops, { ...fresh(), priorityAskedCount: 1 });
    expect(texts(asked)).toEqual([expect.stringContaining('見つかりませんでした'), expect.stringContaining('条件を変えて送ってください')]);
    expect(asked.quickReplies).toEqual([]);

    // エリアだけが外せない条件（エリアに物件が無い）
    const areaOnly = search([], [{ op: 'set', key: 'area', value: { stations: ['渋谷'], wards: [] } }, { op: 'set', key: 'rentMax', value: 90000, priority: 'want' }]);
    expect(texts(areaOnly).at(-1)).toContain('条件を変えて送ってください');
    expect(areaOnly.next.priorityAskedCount).toBe(0);
  });

  it('「このままにする」は条件を変えない', () => {
    const d = decideTurn(fresh(), { kind: 'relax', ref: { kind: 'tag', tag: 'オートロック' }, accept: false }, ctx([]));
    expect(d.next).toEqual(fresh());
  });

  it('20件超なら結果を見せたうえで外せない条件を1回だけ聞く', () => {
    const props = shibuya(25);
    const ops: SlotOp[] = [...AREA_AND_BUDGET, { op: 'addTag', tag: 'オートロック' }, { op: 'set', key: 'floorMin', value: 2 }];
    const d = search(props, ops);
    expect(d.replies.map((r) => r.type)).toEqual(['text', 'carousel', 'text']);
    expect(texts(d)[1]).toContain('外せない条件はどれですか');
    expect(d.quickReplies.map((q) => q.label)).toEqual(['2階以上', 'オートロック', 'もっと見る']);
    expect(d.next.priorityAskedCount).toBe(1);

    const again = search(props, ops, d.next);
    expect(texts(again)).toHaveLength(1);
  });

  it('選ばれた条件を must に上げて検索し直す', () => {
    const props = [...shibuya(3, { floor: 1 }), ...shibuya(2, { id: 'H001', floor: 5 })];
    const conv = search(props, [...AREA_AND_BUDGET, { op: 'set', key: 'floorMin', value: 2 }]).next;
    const d = decideTurn(conv, { kind: 'priority', ref: { kind: 'slot', key: 'floorMin' } }, ctx(props));
    expect(d.next.slots.floorMin?.priority).toBe('must');
    expect(texts(d)[0]).toContain('2件あります');
  });
});

describe('質問と引き継ぎ', () => {
  it('「2番目の物件は？」は提示リストから解決して回答生成に回す', () => {
    const props = shibuya(5);
    const conv = search(props).next;
    const d = decideTurn(
      conv,
      { kind: 'text', text: '2番目は駐輪場ある？', extraction: ex({ intent: 'propertyQuestion', targetPositions: [2] }) },
      ctx(props),
    );
    expect(d.replies[0]).toMatchObject({ type: 'answer', question: '2番目は駐輪場ある？' });
    const answer = d.replies[0] as Extract<TurnDecision['replies'][number], { type: 'answer' }>;
    expect(answer.targets.map((t) => [t.property.id, t.position])).toEqual([['S002', 2]]);
    expect(d.next.state).toBe('qa');
  });

  it('対象が分からなければ番号で聞き返す', () => {
    const d = decideTurn(
      search(shibuya(5)).next,
      { kind: 'text', text: 'ここ駐輪場ある？', extraction: ex({ intent: 'propertyQuestion' }) },
      ctx(shibuya(5)),
    );
    expect(texts(d)[0]).toContain('番号');
  });

  it('禁止トピックは答えずに引き継ぎ、時間外なら連絡日を具体的に示す', () => {
    const d = decideTurn(
      fresh(),
      { kind: 'text', text: 'この辺の治安どう？', extraction: ex({ intent: 'propertyQuestion', forbiddenTopic: 'safety' }) },
      ctx([], NIGHT),
    );
    expect(texts(d)).toEqual([expect.stringContaining('10月8日(木)に担当者からご連絡します')]);
    expect(d.handoffNote).toEqual({ text: 'この辺の治安どう？', topic: 'safety', propertyIds: [] });
    expect(d.replies.some((r) => r.type === 'answer')).toBe(false);
  });

  it('対象物件を引き継ぎメモに残す（「1番目の物件、空いてますか？」）', () => {
    const props = shibuya(3);
    const d = decideTurn(
      search(props).next,
      {
        kind: 'text',
        text: '1番目の物件、空いてますか？',
        extraction: ex({ intent: 'handoff', forbiddenTopic: 'vacancy', targetPositions: [1] }),
      },
      ctx(props),
    );
    expect(d.handoffNote).toEqual({ text: '1番目の物件、空いてますか？', topic: 'vacancy', propertyIds: ['S001'] });
  });

  it('同じ発話の条件変更は捨てずに当て、引き継ぎ文に続けて検索結果を出す', () => {
    const d = decideTurn(
      fresh(),
      {
        kind: 'text',
        text: '渋谷で9万以内、あと空いてますか？',
        extraction: ex({ intent: 'conditions', ops: AREA_AND_BUDGET, forbiddenTopic: 'vacancy' }),
      },
      ctx(shibuya(3)),
    );
    expect(d.replies.map((r) => r.type)).toEqual(['text', 'text', 'carousel']);
    expect(texts(d)[0]).toContain('空室状況については担当者が確認します');
    expect(d.next.slots.rentMax?.value).toBe(90000);
    expect(d.next.state).toBe('presenting');
    expect(d.handoffNote?.topic).toBe('vacancy');
  });
});

describe('内見の仮受付', () => {
  const props = shibuya(3);
  const presented = () => search(props, AREA_AND_BUDGET, fresh(), NIGHT).next;

  it('「内見を希望」→ 翌営業日以降の候補日（定休日を除く）を出す', () => {
    const d = decideTurn(presented(), { kind: 'viewing', propertyId: 'S001' }, ctx(props, NIGHT));
    expect(d.next.state).toBe('booking');
    expect(d.next.booking).toEqual({ propertyId: 'S001', candidateTimes: [] });
    expect(d.quickReplies.map((q) => q.label)).toEqual(['10月8日(木)', '10月9日(金)', '10月10日(土)', '10月11日(日)', '10月12日(月)']);
    // 例の日時は最初の候補日から作る（固定の日付だと過去になる）
    expect(texts(d)[0]).toContain('（例: 10月8日(木) 14時）');
  });

  it('候補日を2つ選ぶと受け付け、確定はしない（担当者が確定する）', () => {
    const c = ctx(props, NIGHT);
    const d1 = decideTurn(presented(), { kind: 'viewing', propertyId: 'S001' }, c);
    const d2 = decideTurn(d1.next, { kind: 'viewingDay', date: '2026-10-08' }, c);
    expect(d2.viewingRequest).toBeNull();
    expect(d2.quickReplies.map((q) => q.label)).toContain('この日時で送る');
    expect(d2.quickReplies.map((q) => q.label)).not.toContain('10月8日(木)');
    const d3 = decideTurn(d2.next, { kind: 'viewingDay', date: '2026-10-10' }, c);
    expect(d3.viewingRequest).toEqual({ propertyId: 'S001', candidateTimes: ['2026-10-08', '2026-10-10'] });
    expect(d3.next).toMatchObject({ state: 'handed_off', booking: null });
    expect(texts(d3)[0]).toContain('まだ予約は確定していません');
    expect(texts(d3)[0]).toContain('10月8日(木)に担当者から確定のご連絡');
  });

  it('自由文の日時: 当日・定休日は落として理由を伝える', () => {
    const d = decideTurn(
      presented(),
      {
        kind: 'text',
        text: '1番目を明日の14時か8日の15時に見たい',
        extraction: ex({ intent: 'viewingRequest', targetPositions: [1], viewingTimes: ['2026-10-07T14:00', '2026-10-08T15:00'] }),
      },
      ctx(props, NIGHT),
    );
    expect(d.viewingRequest).toBeNull();
    expect(d.next.booking).toEqual({ propertyId: 'S001', candidateTimes: ['2026-10-08T15:00'] });
    expect(texts(d)[0]).toContain('10月8日(木)以降');
  });

  it('番号の指定が無ければ、提示1件目より聞き取り中の物件を優先する（古いカードの「内見を希望」）', () => {
    const one = [makeProperty({ id: 'A001' }), makeProperty({ id: 'B001' })];
    const conv: ConversationSnapshot = {
      ...fresh(),
      state: 'booking',
      slots: search(one).next.slots,
      shownPropertyIds: ['A001'],
      booking: { propertyId: 'B001', candidateTimes: [] },
    };
    const d = decideTurn(
      conv,
      {
        kind: 'text',
        text: '8日の14時と9日の10時で',
        extraction: ex({ intent: 'viewingRequest', viewingTimes: ['2026-10-08T14:00', '2026-10-09T10:00'] }),
      },
      ctx(one, NIGHT),
    );
    expect(d.viewingRequest?.propertyId).toBe('B001');
  });

  it('1件だけでも「この日時で送る」で受け付ける', () => {
    const conv: ConversationSnapshot = {
      ...presented(),
      state: 'booking',
      booking: { propertyId: 'S002', candidateTimes: ['2026-10-09T11:00'] },
    };
    const d = decideTurn(conv, { kind: 'bookingSubmit' }, ctx(props, NIGHT));
    expect(d.viewingRequest).toEqual({ propertyId: 'S002', candidateTimes: ['2026-10-09T11:00'] });
  });

  it('非公開になった物件は受け付けない', () => {
    const d = decideTurn(presented(), { kind: 'viewing', propertyId: 'GONE' }, ctx(props, NIGHT));
    expect(d.viewingRequest).toBeNull();
    expect(texts(d)[0]).toContain('ご案内できません');
  });

  describe('量の上限（セキュリティ点検 A4・A12。意思決定ログ36）', () => {
    const withOpen = (openViewings: string[]): TurnContext => ({ ...ctx(props, NIGHT), openViewings });

    it('同じ物件の未対応の仮受付があれば、候補日を聞かずに受け付け済みと伝える', () => {
      const d = decideTurn(presented(), { kind: 'viewing', propertyId: 'S001' }, withOpen(['S001']));
      expect(texts(d)).toEqual([expect.stringContaining('受け付け済み')]);
      expect(d.next.booking).toBeNull();
      expect(d.viewingRequest).toBeNull();
    });

    it('未対応の仮受付が会話ごとの上限（3件）に達したら、ほかの物件も受け付けない', () => {
      const d = decideTurn(presented(), { kind: 'viewing', propertyId: 'S001' }, withOpen(['X1', 'X2', 'X3']));
      expect(texts(d)).toEqual([expect.stringContaining('すでにいくつか受け付けています')]);
      // 2件までなら受け付ける
      expect(decideTurn(presented(), { kind: 'viewing', propertyId: 'S001' }, withOpen(['X1', 'X2'])).next.state).toBe('booking');
    });

    it('聞き取りの途中で上限に当たったら、送るときに下書きを捨てて伝える', () => {
      const d1 = decideTurn(presented(), { kind: 'viewing', propertyId: 'S001' }, withOpen([]));
      const d2 = decideTurn(d1.next, { kind: 'viewingDay', date: '2026-10-08' }, withOpen([]));
      const d3 = decideTurn(d2.next, { kind: 'bookingSubmit' }, withOpen(['S001']));
      expect(d3.viewingRequest).toBeNull();
      expect(d3.next).toMatchObject({ state: 'qa', booking: null });
      expect(texts(d3)[0]).toContain('受け付け済み');
    });

    it('候補日は今日から60日先までの営業日だけ（先の日付は落として上限の日を伝える）', () => {
      // NIGHT は 2026-10-06(火)。60日先は 12月5日(土)
      const d = decideTurn(
        presented(),
        {
          kind: 'text',
          text: '1番目を12月4日の14時か、2099年1月5日に見たい',
          extraction: ex({ intent: 'viewingRequest', targetPositions: [1], viewingTimes: ['2026-12-04T14:00', '2099-01-05'] }),
        },
        ctx(props, NIGHT),
      );
      expect(d.next.booking).toEqual({ propertyId: 'S001', candidateTimes: ['2026-12-04T14:00'] });
      expect(texts(d)[0]).toContain('（12月5日(土)まで）');
    });
  });
});

describe('内見の下書きは聞き取り中（state = booking）の間だけ持つ', () => {
  /** 番号を言わずに日時だけ送る */
  const DATES_ONLY = {
    kind: 'text',
    text: '8日の14時と9日の10時で',
    extraction: ex({ intent: 'viewingRequest', viewingTimes: ['2026-10-08T14:00', '2026-10-09T10:00'] }),
  } as const;
  const say = (text: string, partial: Partial<ExtractionResult>) => ({ kind: 'text', text, extraction: ex(partial) }) as const;

  /** 検索して1番目（S001）の「内見を希望」を押し、候補日を1つ選んだところ */
  function midBooking(props: Property[]): ConversationSnapshot {
    const c = ctx(props, NIGHT);
    const viewing = decideTurn(search(props, AREA_AND_BUDGET, fresh(), NIGHT).next, { kind: 'viewing', propertyId: 'S001' }, c);
    const picked = decideTurn(viewing.next, { kind: 'viewingDay', date: '2026-10-08' }, c);
    expect(picked.next).toMatchObject({ state: 'booking', booking: { propertyId: 'S001', candidateTimes: ['2026-10-08'] } });
    return picked.next;
  }

  it('条件を変えたら下書きを捨て、日時だけの発話を前の物件に当てない（番号で聞き返す）', () => {
    const shinjuku = { access: [{ station: '新宿', walkMin: 5 }] };
    const props = [...shibuya(3), makeProperty({ id: 'N001', ...shinjuku }), makeProperty({ id: 'N002', ...shinjuku })];
    const c = ctx(props, NIGHT);
    const changed = decideTurn(
      midBooking(props),
      say('やっぱり新宿で', { ops: [{ op: 'set', key: 'area', value: { stations: ['新宿'], wards: [] } }] }),
      c,
    );
    expect(changed.next).toMatchObject({ state: 'presenting', shownPropertyIds: ['N001', 'N002'], booking: null });
    const d = decideTurn(changed.next, DATES_ONLY, c);
    expect(d.viewingRequest).toBeNull();
    expect(texts(d)).toEqual([expect.stringContaining('カードの番号')]);
  });

  it('「もっと見る」・別の物件の詳細・質問・引き継ぎに移っても下書きを捨てる', () => {
    const props = shibuya(8);
    const c = ctx(props, NIGHT);
    const moves = [
      { kind: 'more' },
      { kind: 'detail', propertyId: 'S002' },
      say('2番目は駐輪場ある？', { intent: 'propertyQuestion', targetPositions: [2] }),
      say('2番目は空いてますか？', { intent: 'handoff', forbiddenTopic: 'vacancy', targetPositions: [2] }),
    ] as const;
    for (const move of moves) {
      const moved = decideTurn(midBooking(props), move, c);
      expect(moved.next.state, move.kind).not.toBe('booking');
      expect(moved.next.booking, move.kind).toBeNull();
      expect(decideTurn(moved.next, DATES_ONLY, c).viewingRequest, move.kind).toBeNull();
    }
  });

  it('聞き取り中の物件の詳細・質問・引き継ぎ、物件を指さない発話なら聞き取りを続け、選んだ候補日を持ち越す', () => {
    const props = shibuya(3);
    const c = ctx(props, NIGHT);
    const stays = [
      { kind: 'detail', propertyId: 'S001' },
      say('1番目は駐輪場ある？', { intent: 'propertyQuestion', targetPositions: [1] }),
      say('1番目は空いてますか？', { intent: 'handoff', forbiddenTopic: 'vacancy', targetPositions: [1] }),
      say('ありがとう', { intent: 'offTopic' }),
    ] as const;
    for (const move of stays) {
      const stayed = decideTurn(midBooking(props), move, c);
      expect(stayed.next.state, move.kind).toBe('booking');
      const d = decideTurn(stayed.next, say('9日の10時も', { intent: 'viewingRequest', viewingTimes: ['2026-10-09T10:00'] }), c);
      expect(d.viewingRequest, move.kind).toEqual({ propertyId: 'S001', candidateTimes: ['2026-10-08', '2026-10-09T10:00'] });
    }
  });

  it('聞き取り中でない会話に残った下書き（修正前に保存されたもの）は使わない', () => {
    const props = shibuya(3);
    const c = ctx(props, NIGHT);
    const stale: ConversationSnapshot = {
      ...search(props, AREA_AND_BUDGET, fresh(), NIGHT).next,
      booking: { propertyId: 'S002', candidateTimes: ['2026-10-09T11:00'] },
    };
    expect(decideTurn(stale, { kind: 'bookingSubmit' }, c).viewingRequest).toBeNull();
    expect(decideTurn(stale, { kind: 'viewingDay', date: '2026-10-08' }, c).viewingRequest).toBeNull();
    const d = decideTurn(stale, DATES_ONLY, c);
    expect(d.viewingRequest).toBeNull();
    expect(d.next.booking).toBeNull();
  });
});

describe('営業時間外の案内は友だち追加のあいさつと重ねない', () => {
  const OUTSIDE = '営業時間外';

  it('友だち追加を経ずに話しかけられた最初の発話には、営業時間外の案内を足す', () => {
    const d = search(shibuya(3), AREA_AND_BUDGET, fresh(), NIGHT);
    expect(texts(d)[0]).toContain(OUTSIDE);
  });

  it('友だち追加のあいさつを出した会話の最初の発話には足さない（ブロック解除のあいさつの直後も同じ）', () => {
    const props = shibuya(3);
    const greeted = decideTurn(fresh(), { kind: 'follow' }, ctx(props, NIGHT));
    expect(texts(greeted)[0]).toContain(OUTSIDE);
    const d = decideTurn(
      greeted.next,
      { kind: 'text', text: '渋谷で9万まで', extraction: ex({ ops: AREA_AND_BUDGET }) },
      { ...ctx(props, NIGHT), greeted: true },
    );
    expect(texts(d).filter((t) => t.includes(OUTSIDE))).toEqual([]);
    expect(texts(d)[0]).toContain('3件あります');
  });

  it('営業時間内なら、あいさつの有無にかかわらず何も足さず、検索の結果も変わらない', () => {
    const props = shibuya(3);
    const event = { kind: 'text', text: '渋谷で9万まで', extraction: ex({ ops: AREA_AND_BUDGET }) } as const;
    const a = decideTurn(fresh(), event, ctx(props));
    const b = decideTurn(fresh(), event, { ...ctx(props), greeted: true });
    expect(b).toEqual(a);
    expect(texts(a).filter((t) => t.includes(OUTSIDE))).toEqual([]);
  });

  it('始まった後の会話（条件がある）には、あいさつの有無にかかわらず足さない', () => {
    const props = shibuya(3);
    const started = search(props, AREA_AND_BUDGET, fresh(), NIGHT).next;
    const d = decideTurn(started, { kind: 'more' }, ctx(props, NIGHT));
    expect(texts(d).filter((t) => t.includes(OUTSIDE))).toEqual([]);
  });
});

describe('公開デモ（demo: true）', () => {
  const DEMO = 'これはデモです。物件は架空のデータで、担当者からの連絡はありません。';
  const NO_CONTACT = '（デモのため、実際の連絡はありません）';
  const demoCtx = (properties: Property[], now = NOON): TurnContext => ({ ...ctx(properties, now), demo: true });

  it('友だち追加のあいさつにデモである旨を足す。AI の一次対応の明示は残る', () => {
    const d = decideTurn(fresh(), { kind: 'follow' }, demoCtx([], NIGHT));
    expect(texts(d)[0]).toContain(DEMO);
    expect(texts(d)[0]).toContain('AI が一次対応');
    expect(texts(d)[0]).toContain('営業時間外');
    // 通常は出さない
    expect(texts(decideTurn(fresh(), { kind: 'follow' }, ctx([], NIGHT)))[0]).not.toContain('デモ');
  });

  it('引き継ぎ文に「実際の連絡はありません」を足す（時間外・時間内とも）。担当者が確認する旨は残る', () => {
    const forbidden = ex({ intent: 'propertyQuestion', forbiddenTopic: 'safety' });
    const night = decideTurn(fresh(), { kind: 'text', text: 'この辺の治安どう？', extraction: forbidden }, demoCtx([], NIGHT));
    expect(texts(night)[0]).toContain(`10月8日(木)に担当者からご連絡します。${NO_CONTACT}`);
    expect(texts(night)[0]).toContain('周辺の治安については担当者が確認します');
    const noon = decideTurn(fresh(), { kind: 'text', text: 'この辺の治安どう？', extraction: forbidden }, demoCtx([], NOON));
    expect(texts(noon)[0]).toContain(`営業時間内に担当者からご連絡します。${NO_CONTACT}`);
    // 通常は足さない
    const normal = decideTurn(fresh(), { kind: 'text', text: 'この辺の治安どう？', extraction: forbidden }, ctx([], NIGHT));
    expect(texts(normal)[0]).not.toContain('デモ');
  });

  it('内見の仮受付の文に「実際の連絡はありません」を足すが、「まだ予約は確定していません」は保つ（AI は確定しない）', () => {
    const props = shibuya(3);
    const c = demoCtx(props, NIGHT);
    const presented = search(props, AREA_AND_BUDGET, fresh(), NIGHT).next;
    const d1 = decideTurn(presented, { kind: 'viewing', propertyId: 'S001' }, c);
    const d2 = decideTurn(d1.next, { kind: 'viewingDay', date: '2026-10-08' }, c);
    const d3 = decideTurn(d2.next, { kind: 'viewingDay', date: '2026-10-10' }, c);
    expect(d3.viewingRequest).not.toBeNull();
    expect(texts(d3)[0]).toContain('まだ予約は確定していません');
    expect(texts(d3)[0]).toContain(`10月8日(木)に担当者から確定のご連絡をします。${NO_CONTACT}`);
    expect(texts(d3)[0]).not.toContain('確定しました');
  });

  it('検索・並び順などの判断は通常と同じ（文面だけが違う）', () => {
    const props = shibuya(8);
    const event = { kind: 'text', text: '渋谷で9万まで', extraction: ex({ ops: AREA_AND_BUDGET }) } as const;
    expect(decideTurn(fresh(), event, demoCtx(props))).toEqual(decideTurn(fresh(), event, ctx(props)));
  });
});
