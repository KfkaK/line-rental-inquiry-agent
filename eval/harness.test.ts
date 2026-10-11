import { describe, expect, it } from 'vitest';
import type { ExtractionResult } from '@/domain/types';
import { loadDemoProperties } from './data';
import { createConversationHarness, parseCardIds, type Pipeline } from './harness';

const properties = loadDemoProperties();
/** 2026-10-15（木）21:30 JST（営業時間外） */
const NIGHT = new Date('2026-10-15T21:30:00+09:00');

function ex(partial: Partial<ExtractionResult>): ExtractionResult {
  return { intent: 'conditions', ops: [], targetPositions: [], viewingTimes: [], forbiddenTopic: null, ...partial };
}

/** 渡した順に抽出を返し、回答生成は常に担当者へ回す偽物 */
function oracle(extractions: ExtractionResult[]): Pipeline {
  const queue = [...extractions];
  return {
    name: 'oracle',
    extract: async () => ({ result: queue.shift() ?? ex({ intent: 'offTopic' }), latencyMs: 1, costUsd: 0.001, model: 'oracle' }),
    answer: async () => ({ text: null, handoff: { topic: null }, verification: 'ok', latencyMs: 1, costUsd: 0.002 }),
  };
}

const SEARCH = ex({
  ops: [
    { op: 'set', key: 'area', value: { stations: ['渋谷'], wards: [] } },
    { op: 'set', key: 'rentMax', value: 90000 },
  ],
});

describe('createConversationHarness', () => {
  it('友だち追加 → 条件 → カード → 内見の候補日 → 送信 で仮受付まで通る', async () => {
    const h = createConversationHarness({ properties, pipeline: oracle([SEARCH]), start: NIGHT });
    const follow = await h.send({ kind: 'follow' });
    expect(follow.texts.join('\n')).toContain('友だち追加ありがとうございます');
    expect(follow.quickReplies.map((q) => q.label)).toContain('渋谷');

    const search = await h.send({ kind: 'text', text: '渋谷で9万まで' });
    expect(search.cardIds.length).toBeGreaterThan(0);
    expect(search.state).toBe('presenting');
    expect(search.mustTotal).toBeGreaterThan(0);
    expect(search.andTotal).toBe(search.mustTotal); // エリアと予算だけなら全条件 must と同じ
    expect(search.extraction?.result).toEqual(SEARCH);
    expect(search.costUsd).toBeCloseTo(0.001);

    await h.card('viewing', 1);
    const day = await h.tapIndex(0);
    expect(day.quickReplies.map((q) => q.label)).toContain('この日時で送る');
    const submitted = await h.tap('この日時で送る');
    expect(submitted.viewingCreated).toHaveLength(1);
    expect(submitted.viewingCreated[0].propertyId).toBe(search.cardIds[0]);
    expect(submitted.viewingCreated[0].receivedOutsideHours).toBe(true);
  });

  it('種まきした会話で提示物件への質問を回し、回答生成の出力と引き継ぎメモを拾う', async () => {
    const h = createConversationHarness({
      properties,
      pipeline: oracle([ex({ intent: 'propertyQuestion', targetPositions: [1] })]),
      start: NIGHT,
      initial: { slots: { tags: [] }, shownPropertyIds: ['P0072'] },
    });
    const turn = await h.send({ kind: 'text', text: '1番目に駐輪場はありますか？' });
    expect(turn.answers).toHaveLength(1);
    expect(turn.handoffAdded).toHaveLength(1);
    expect(turn.handoffAdded[0].propertyIds).toEqual(['P0072']);
    expect(turn.texts.join('\n')).toContain('担当者が確認します');
    expect(turn.error).toBeNull();
  });

  it('条件抽出が投げたら「混み合っています」で返し、例外を記録して続ける', async () => {
    const h = createConversationHarness({
      properties,
      pipeline: {
        name: 'broken',
        extract: async () => {
          throw new Error('429');
        },
        answer: async () => {
          throw new Error('unused');
        },
      },
      start: NIGHT,
    });
    const turn = await h.send({ kind: 'text', text: '渋谷で9万まで' });
    expect(turn.texts.join('\n')).toContain('混み合っています');
    expect(turn.error).toContain('条件抽出');
  });

  it('クイックリプライが無いラベルは例外', async () => {
    const h = createConversationHarness({ properties, pipeline: oracle([]), start: NIGHT });
    await h.send({ kind: 'follow' });
    expect(() => h.tap('存在しないボタン')).toThrow('見つかりません');
  });
});

describe('parseCardIds', () => {
  it('会話ログのカードの記述から物件 ID を取り出す', () => {
    expect(parseCardIds('5件見つかりました\n\n[物件カード 1〜2番目: P0001, P0002]')).toEqual(['P0001', 'P0002']);
    expect(parseCardIds('カードなし')).toEqual([]);
  });
});
