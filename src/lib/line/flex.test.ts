import { describe, expect, it } from 'vitest';
import { theme } from '@/constants/theme';
import type { ConditionResult, Property, ScoredProperty } from '@/domain/types';
import {
  ALT_TEXT_MAX_LENGTH,
  buildDisclaimerMessage,
  buildMatchSummary,
  buildPropertyCarousel,
  buildQuickReply,
  DISCLAIMER_TEXT,
  MAX_BUBBLES,
  MAX_QUICK_REPLIES,
  QUICK_REPLY_LABEL_MAX_LENGTH,
  stationLine,
  withQuickReply,
} from './flex';
import { parsePostbackData } from './postback';

function makeProperty(id: string, overrides: Partial<Property> = {}): Property {
  return {
    id,
    name: `テスト物件${id}`,
    address: '東京都渋谷区',
    ward: '渋谷区',
    access: [{ station: '渋谷', walkMin: 7 }],
    rent: 125000,
    managementFee: 5000,
    depositMonths: 1,
    keyMoneyMonths: 1,
    layout: '1LDK',
    areaSqm: 32.5,
    floor: 3,
    builtYear: 2018,
    tags: ['オートロック'],
    note: '',
    availableFrom: null,
    status: 'public',
    ...overrides,
  };
}

function cond(label: string, credit: number, tag?: 'オートロック'): ConditionResult {
  return {
    ref: tag ? { kind: 'tag', tag } : { kind: 'slot', key: 'walkMax' },
    priority: 'want',
    label,
    credit,
    shortfall: credit < 1 ? `${label}なし` : null,
  };
}

function makeItem(id: string, overrides: Partial<ScoredProperty> = {}, property: Partial<Property> = {}): ScoredProperty {
  const p = makeProperty(id, property);
  return {
    property: p,
    score: 0.8,
    conditions: [
      cond('渋谷駅周辺', 1),
      cond('家賃15万円以下', 1),
      cond('徒歩10分以内', 1),
      cond('1LDK', 1),
      cond('オートロック', 0, 'オートロック'),
    ],
    matched: ['渋谷駅周辺', '家賃15万円以下', '徒歩10分以内', '1LDK'],
    unmatched: ['オートロックなし'],
    displayAccess: p.access[0],
    ...overrides,
  };
}

function makeItems(n: number): ScoredProperty[] {
  return Array.from({ length: n }, (_, i) => makeItem(`P${String(i + 1).padStart(3, '0')}`));
}

/** JSON の中の全ノードを順にたどる */
function walk(node: unknown, visit: (n: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit));
  } else if (typeof node === 'object' && node !== null) {
    visit(node as Record<string, unknown>);
    Object.values(node).forEach((child) => walk(child, visit));
  }
}

function carouselOf(messages: ReturnType<typeof buildPropertyCarousel>) {
  const flex = messages[0];
  if (flex.type !== 'flex' || flex.contents.type !== 'carousel') throw new Error('carousel ではありません');
  return { flex, bubbles: flex.contents.contents };
}

describe('buildMatchSummary', () => {
  it('希望件数・一致件数・不足の説明をそのまま「・」で連結する', () => {
    expect(buildMatchSummary(makeItem('P001'))).toBe('希望5件中4件に一致・オートロックなし');
  });

  it('不足が複数ならすべて「・」で連結し、「なし」を足さない', () => {
    const item = makeItem('P001', {
      conditions: [cond('a', 1), cond('b', 1), cond('c', 0.6), cond('d', 0.6), cond('e', 0)],
      matched: ['a', 'b'],
      unmatched: ['徒歩12分', '月額9.3万円', 'オートロックなし'],
    });
    expect(buildMatchSummary(item)).toBe('希望5件中2件に一致・徒歩12分・月額9.3万円・オートロックなし');
  });

  it('不足が無ければ一致の部分だけ', () => {
    const item = makeItem('P001', {
      conditions: [cond('a', 1), cond('b', 1)],
      matched: ['a', 'b'],
      unmatched: [],
    });
    expect(buildMatchSummary(item)).toBe('希望2件中2件に一致');
  });

  it('条件が 0 件でも落ちない', () => {
    const item = makeItem('P001', { conditions: [], matched: [], unmatched: [] });
    expect(buildMatchSummary(item)).toBe('希望0件中0件に一致');
  });
});

describe('buildPropertyCarousel', () => {
  it('Flex カルーセル＋免責のテキストの 2 通を返す', () => {
    const messages = buildPropertyCarousel(makeItems(3), { startPosition: 1, hasMore: false });
    expect(messages).toHaveLength(2);
    expect(messages[0].type).toBe('flex');
    expect(messages[1]).toMatchObject({ type: 'text', text: DISCLAIMER_TEXT });
    expect(DISCLAIMER_TEXT).toBe('回答は参考情報です。契約条件は担当者からの案内が優先されます。');
    expect(buildDisclaimerMessage().text).toBe(DISCLAIMER_TEXT);
  });

  it('表示番号は startPosition からの通し番号', () => {
    const { bubbles } = carouselOf(buildPropertyCarousel(makeItems(3), { startPosition: 6, hasMore: false }));
    const json = JSON.stringify(bubbles);
    expect(bubbles).toHaveLength(3);
    expect(json).toContain('"6番目"');
    expect(json).toContain('"7番目"');
    expect(json).toContain('"8番目"');
    expect(json).not.toContain('"1番目"');
  });

  it('startPosition が不正（0・負・小数）なら 1 から振る', () => {
    for (const startPosition of [0, -3, 1.5, Number.NaN]) {
      const { bubbles } = carouselOf(buildPropertyCarousel(makeItems(1), { startPosition, hasMore: false }));
      expect(JSON.stringify(bubbles)).toContain('"1番目"');
    }
  });

  it('カードに物件名・家賃・管理費・間取り・面積・駅・階・築年・一致の要約が出る', () => {
    const { bubbles } = carouselOf(buildPropertyCarousel([makeItem('P001')], { startPosition: 1, hasMore: false }));
    const texts: string[] = [];
    walk(bubbles[0], (n) => {
      if (n.type === 'text' && typeof n.text === 'string') texts.push(n.text);
      if (n.type === 'span' && typeof n.text === 'string') texts.push(n.text);
    });
    const all = texts.join('|');
    expect(all).toContain('テスト物件P001');
    expect(all).toContain('125,000円');
    expect(all).toContain('管理費 5,000円');
    expect(all).toContain('1LDK ・ 32.5㎡');
    expect(all).toContain('渋谷駅 徒歩7分');
    expect(all).toContain('3階 ・ 2018年築');
    expect(all).toContain('希望5件中4件に一致');
    expect(all).toContain('・オートロックなし');
  });

  it('displayAccess（エリア条件の駅）を先に出し、ほかの駅のほうが近ければ最寄りを添える', () => {
    const item = makeItem(
      'P001',
      { displayAccess: { station: '恵比寿', walkMin: 12 } },
      { access: [{ station: '渋谷', walkMin: 7 }, { station: '恵比寿', walkMin: 12 }] },
    );
    expect(stationLine(item)).toBe('恵比寿駅 徒歩12分（最寄りは渋谷駅 徒歩7分）');
    const { bubbles } = carouselOf(buildPropertyCarousel([item], { startPosition: 1, hasMore: false }));
    expect(JSON.stringify(bubbles)).toContain('恵比寿駅 徒歩12分（最寄りは渋谷駅 徒歩7分）');
  });

  it('表示する駅が最寄り（同じ分数を含む）なら駅は1つだけ', () => {
    const nearest = makeItem(
      'P001',
      { displayAccess: { station: '渋谷', walkMin: 7 } },
      { access: [{ station: '渋谷', walkMin: 7 }, { station: '恵比寿', walkMin: 12 }] },
    );
    expect(stationLine(nearest)).toBe('渋谷駅 徒歩7分');
    const tie = makeItem(
      'P002',
      { displayAccess: { station: '恵比寿', walkMin: 7 } },
      { access: [{ station: '渋谷', walkMin: 7 }, { station: '恵比寿', walkMin: 7 }] },
    );
    expect(stationLine(tie)).toBe('恵比寿駅 徒歩7分');
  });

  it('ボタンは「詳細」「内見を希望」で、postback に物件 ID が入る', () => {
    const { bubbles } = carouselOf(buildPropertyCarousel(makeItems(2), { startPosition: 1, hasMore: false }));
    const postbacks: { label: string; data: string; displayText?: string }[] = [];
    walk(bubbles[1], (n) => {
      if (n.type === 'postback') postbacks.push(n as never);
    });
    expect(postbacks.map((p) => p.label)).toEqual(['詳細', '内見を希望']);
    expect(parsePostbackData(postbacks[0].data)).toEqual({ action: 'detail', propertyId: 'P002' });
    expect(parsePostbackData(postbacks[1].data)).toEqual({ action: 'viewing', propertyId: 'P002' });
    expect(postbacks[0].displayText).toBe('2番目の詳細');
    expect(postbacks[1].displayText).toBe('2番目の内見を希望');
  });

  it('バブルは最大 12 枚（超えた分は切り捨て）', () => {
    const { bubbles } = carouselOf(buildPropertyCarousel(makeItems(15), { startPosition: 1, hasMore: false }));
    expect(MAX_BUBBLES).toBe(12);
    expect(bubbles).toHaveLength(12);
  });

  it('物件が 0 件なら空配列', () => {
    expect(buildPropertyCarousel([], { startPosition: 1, hasMore: true })).toEqual([]);
  });

  it('altText は 400 文字以内（物件名が長くても）', () => {
    const items = Array.from({ length: 12 }, (_, i) => makeItem(`P${i}`, {}, { name: 'とても長い物件名'.repeat(20) }));
    const { flex } = carouselOf(buildPropertyCarousel(items, { startPosition: 1, hasMore: false }));
    expect(Array.from(flex.altText).length).toBeLessThanOrEqual(ALT_TEXT_MAX_LENGTH);
    expect(flex.altText.length).toBeGreaterThan(0);
  });

  it('altText に番号の範囲と物件名が入る', () => {
    const { flex } = carouselOf(buildPropertyCarousel(makeItems(2), { startPosition: 6, hasMore: false }));
    expect(flex.altText).toContain('6〜7番目');
    expect(flex.altText).toContain('テスト物件P001');
  });

  it('hasMore なら最後のメッセージに「もっと見る」のクイックリプライが付く', () => {
    const messages = buildPropertyCarousel(makeItems(5), { startPosition: 1, hasMore: true });
    const items = messages[1].quickReply?.items ?? [];
    expect(items).toHaveLength(1);
    expect(items[0].action).toMatchObject({ type: 'postback', label: 'もっと見る' });
    const action = items[0].action as { data: string };
    expect(parsePostbackData(action.data)).toEqual({ action: 'more' });
    expect(messages[0].quickReply).toBeUndefined();
  });

  it('hasMore が false ならクイックリプライは付かない', () => {
    const messages = buildPropertyCarousel(makeItems(5), { startPosition: 1, hasMore: false });
    expect(messages[1].quickReply).toBeUndefined();
  });

  it('extraQuickReplies は「もっと見る」の後ろに付く', () => {
    const messages = buildPropertyCarousel(makeItems(5), {
      startPosition: 1,
      hasMore: true,
      extraQuickReplies: [{ label: '条件を変える', text: '条件を変えたい' }],
    });
    const labels = (messages[1].quickReply?.items ?? []).map((i) => (i.action as { label: string }).label);
    expect(labels).toEqual(['もっと見る', '条件を変える']);
  });

  it('色は theme.light のトークンだけ（直書きの色が無い）', () => {
    const messages = buildPropertyCarousel(makeItems(3), { startPosition: 1, hasMore: true });
    const allowed = new Set<string>(Object.values(theme.light).map((v) => v.toLowerCase()));
    const hexes = (JSON.stringify(messages).match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).map((h) => h.toLowerCase());
    expect(hexes.length).toBeGreaterThan(0);
    for (const hex of hexes) expect(allowed.has(hex)).toBe(true);

    // 色名・rgb() などの直書きも無いこと
    walk(messages, (n) => {
      for (const key of ['color', 'backgroundColor', 'borderColor', 'separatorColor']) {
        if (typeof n[key] === 'string') expect(allowed.has((n[key] as string).toLowerCase())).toBe(true);
      }
    });
  });

  it('text コンポーネントに空文字が無い（LINE が拒否する）', () => {
    const odd = makeItem('P001', {}, { name: '   ' });
    const messages = buildPropertyCarousel([odd], { startPosition: 1, hasMore: false });
    walk(messages, (n) => {
      if (n.type === 'text' && 'text' in n) expect((n.text as string).trim().length).toBeGreaterThan(0);
      if (n.type === 'span') expect((n.text as string).trim().length).toBeGreaterThan(0);
    });
  });

  it('太字は bold だけ（600 以上の細かい指定は LINE に無い）で、使う箇所は限られる', () => {
    const { bubbles } = carouselOf(buildPropertyCarousel([makeItem('P001')], { startPosition: 1, hasMore: false }));
    let bold = 0;
    walk(bubbles[0], (n) => {
      if (n.weight === 'bold') bold += 1;
    });
    expect(bold).toBeLessThanOrEqual(5);
  });
});

describe('buildQuickReply', () => {
  it('0 個なら undefined', () => {
    expect(buildQuickReply([])).toBeUndefined();
  });

  it('postback とテキストの両方を作れる', () => {
    const qr = buildQuickReply([
      { label: '渋谷区', text: '渋谷区で探したい' },
      { label: 'もっと見る', postback: 'a=more' },
    ]);
    expect(qr?.items).toEqual([
      { type: 'action', action: { type: 'message', label: '渋谷区', text: '渋谷区で探したい' } },
      { type: 'action', action: { type: 'postback', label: 'もっと見る', data: 'a=more', displayText: 'もっと見る' } },
    ]);
  });

  it('最大 13 個（超えた分は切り捨て）', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ label: `項目${i}`, text: `項目${i}` }));
    expect(MAX_QUICK_REPLIES).toBe(13);
    expect(buildQuickReply(many)?.items).toHaveLength(13);
  });

  it('ラベルは 20 文字以内に収める（超えたら … で切る）', () => {
    const qr = buildQuickReply([{ label: 'あ'.repeat(30), text: 'x' }]);
    const label = (qr?.items?.[0].action as { label: string }).label;
    expect(Array.from(label)).toHaveLength(QUICK_REPLY_LABEL_MAX_LENGTH);
    expect(label.endsWith('…')).toBe(true);
  });

  it('20 文字ちょうどは切らない・空ラベルは代わりの文字を使う', () => {
    const exact = 'あ'.repeat(20);
    const qr = buildQuickReply([
      { label: exact, text: 'x' },
      { label: '  ', text: 'y' },
    ]);
    expect((qr?.items?.[0].action as { label: string }).label).toBe(exact);
    expect((qr?.items?.[1].action as { label: string }).label.length).toBeGreaterThan(0);
  });

  it('絵文字などサロゲートペアの途中で切らない', () => {
    const qr = buildQuickReply([{ label: '😀'.repeat(25), text: 'x' }]);
    const label = (qr?.items?.[0].action as { label: string }).label;
    expect(Array.from(label)).toHaveLength(20);
    expect(label).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('postback の data が 300 文字を超えると例外', () => {
    expect(() => buildQuickReply([{ label: 'x', postback: 'a'.repeat(301) }])).toThrow();
  });
});

describe('withQuickReply', () => {
  it('最後のメッセージにだけ付け直し、元の配列は変えない', () => {
    const original = buildPropertyCarousel(makeItems(2), { startPosition: 1, hasMore: true });
    const replaced = withQuickReply(original, buildQuickReply([{ label: '条件を変える', text: '条件を変える' }]));
    expect(replaced[0].quickReply).toBeUndefined();
    expect((replaced[1].quickReply?.items?.[0].action as { label: string }).label).toBe('条件を変える');
    expect(original[1].quickReply?.items).toHaveLength(1);
    expect((original[1].quickReply?.items?.[0].action as { label: string }).label).toBe('もっと見る');
  });

  it('undefined を渡すと外す・空配列はそのまま', () => {
    const original = buildPropertyCarousel(makeItems(2), { startPosition: 1, hasMore: true });
    expect(withQuickReply(original, undefined)[1].quickReply).toBeUndefined();
    expect(withQuickReply([], buildQuickReply([{ label: 'x', text: 'x' }]))).toEqual([]);
  });
});
