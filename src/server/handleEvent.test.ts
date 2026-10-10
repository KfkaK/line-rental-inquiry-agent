import type { webhook } from '@line/bot-sdk';
import { describe, expect, it, vi } from 'vitest';
import { fromJst } from '@/domain/businessHours';
import { makeProperty } from '@/domain/fixtures';
import type { ExtractionResult, Property } from '@/domain/types';
import { createMemoryRepositories } from '@/lib/db';
import { createFakeMessenger } from '@/lib/line/messenger';
import { buildPostbackData } from '@/lib/line/postback';
import { handleEvent, type AnswerOutput, type Deps, type ExtractInput, type StaffNotifier } from './handleEvent';

const USER = 'U-test-user';
/** 火曜 23:30 JST（営業時間外） */
const NIGHT = fromJst('2026-10-06', '23:30');
/** 木曜 12:00 JST（営業時間内） */
const NOON = fromJst('2026-10-08', '12:00');

let eventSeq = 0;
function baseEvent() {
  eventSeq += 1;
  return {
    mode: 'active',
    timestamp: 0,
    source: { type: 'user', userId: USER },
    webhookEventId: `EV${eventSeq}`,
    deliveryContext: { isRedelivery: false },
    replyToken: `RT${eventSeq}`,
  };
}
const textEvent = (text: string) =>
  ({ ...baseEvent(), type: 'message', message: { type: 'text', id: `M${eventSeq}`, text, quoteToken: 'q' } }) as webhook.Event;
const postbackEvent = (data: string) => ({ ...baseEvent(), type: 'postback', postback: { data } }) as webhook.Event;
const followEvent = () => ({ ...baseEvent(), type: 'follow', follow: { isUnblocked: false } }) as webhook.Event;

function ex(partial: Partial<ExtractionResult> = {}): ExtractionResult {
  return { intent: 'conditions', ops: [], targetPositions: [], viewingTimes: [], forbiddenTopic: null, ...partial };
}

const SEARCH: ExtractionResult = ex({
  ops: [
    { op: 'set', key: 'area', value: { stations: ['渋谷'], wards: [] } },
    { op: 'set', key: 'rentMax', value: 90000 },
  ],
});

function setup(options: { now?: Date; properties?: Property[]; extractions?: ExtractionResult[]; dailyCostLimitUsd?: number } = {}) {
  let now = (options.now ?? NOON).getTime();
  const clock = () => new Date(now);
  const properties = options.properties ?? Array.from({ length: 7 }, (_, i) => makeProperty({ id: `P${i + 1}`, rent: 70000 + i * 1000 }));
  const repos = createMemoryRepositories({ properties }, { clock });
  const messenger = createFakeMessenger({ profiles: { [USER]: { displayName: 'テスト太郎' } } });
  const queue = [...(options.extractions ?? [])];
  const extractCalls: ExtractInput[] = [];
  const notifier: StaffNotifier = {
    viewingRequested: vi.fn(async () => {}),
    handoffRequested: vi.fn(async () => {}),
    userRepliedWhilePaused: vi.fn(async () => {}),
  };
  const answer = vi.fn(
    async (): Promise<AnswerOutput> => ({ text: '駐輪場はあります。', handoff: null, verification: 'ok', latencyMs: 5, costUsd: 0.002 }),
  );
  const deps: Deps = {
    repos,
    messenger,
    extract: async (input) => {
      extractCalls.push(input);
      return { result: queue.shift() ?? ex({ intent: 'offTopic' }), latencyMs: 10, costUsd: 0.001, model: 'fake' };
    },
    answer,
    notifier,
    clock,
    dailyCostLimitUsd: options.dailyCostLimitUsd ?? 5,
  };
  return {
    deps,
    repos,
    messenger,
    extractCalls,
    notifier,
    answer,
    advance: (ms: number) => {
      now += ms;
    },
    conversation: () => repos.conversations.getOrCreate(USER),
    lastReply: () => messenger.replies.at(-1)?.messages ?? [],
  };
}

function textsOf(messages: readonly { type: string }[]): string[] {
  return messages.filter((m) => m.type === 'text').map((m) => (m as unknown as { text: string }).text);
}

describe('handleEvent', () => {
  it('友だち追加: 表示名を保存し、AI の一次対応を明示してあいさつする', async () => {
    const t = setup({ now: NIGHT });
    await handleEvent(followEvent(), t.deps);
    expect(textsOf(t.lastReply())[0]).toContain('AI が一次対応');
    expect(textsOf(t.lastReply())[0]).toContain('営業時間外');
    const list = await t.repos.conversations.listRecent();
    expect(list[0].displayName).toBe('テスト太郎');
  });

  it('同じ webhookEventId の再送は1回しか処理しない', async () => {
    const t = setup({ extractions: [SEARCH, SEARCH] });
    const event = textEvent('渋谷で9万まで');
    await handleEvent(event, t.deps);
    await handleEvent(event, t.deps);
    expect(t.messenger.replies).toHaveLength(1);
    expect(t.extractCalls).toHaveLength(1);
  });

  it('自由文: 抽出 → 検索 → カード。状態・会話ログ（意図・差分・費用）を保存する', async () => {
    const t = setup({ extractions: [SEARCH] });
    await handleEvent(textEvent('渋谷で9万まで'), t.deps);
    const types = t.lastReply().map((m) => m.type);
    expect(types).toEqual(['text', 'flex', 'text']);
    expect(t.messenger.loadings).toHaveLength(1);

    const conv = await t.conversation();
    expect(conv.state).toBe('presenting');
    expect(conv.shownPropertyIds).toEqual(['P1', 'P2', 'P3', 'P4', 'P5']);
    const log = await t.repos.messages.listByConversation(conv.id);
    expect(log.map((m) => m.role)).toEqual(['user', 'ai']);
    expect(log[1]).toMatchObject({ intent: 'conditions', costUsd: 0.001 });
    expect(log[1].slotDiff).toEqual(SEARCH.ops);
  });

  it('提示済みリストを抽出器に渡し、質問は回答生成に回す', async () => {
    const t = setup({ extractions: [SEARCH, ex({ intent: 'propertyQuestion', targetPositions: [2] })] });
    await handleEvent(textEvent('渋谷で9万まで'), t.deps);
    await handleEvent(textEvent('2番目は駐輪場ある？'), t.deps);
    expect(t.extractCalls[1].shown.map((s) => [s.position, s.property.id])).toEqual([
      [1, 'P1'],
      [2, 'P2'],
      [3, 'P3'],
      [4, 'P4'],
      [5, 'P5'],
    ]);
    expect(t.answer).toHaveBeenCalledWith(expect.objectContaining({ question: '2番目は駐輪場ある？' }));
    expect(textsOf(t.lastReply())).toEqual(['駐輪場はあります。']);
    const log = await t.repos.messages.listByConversation((await t.conversation()).id);
    expect(log.at(-1)).toMatchObject({ verification: 'ok', costUsd: 0.001 + 0.002 });
  });

  it('担当者が対応中（ai_paused）なら返信しない。最終の担当者返信から24時間で自動再開', async () => {
    const t = setup({ extractions: [SEARCH] });
    const conv = await (async () => {
      await t.repos.lineUsers.upsert({ lineUserId: USER });
      return t.conversation();
    })();
    await t.repos.conversations.update(conv.id, { aiPaused: true, lastStaffReplyAt: NOON.toISOString() });

    await handleEvent(textEvent('まだですか？'), t.deps);
    expect(t.messenger.replies).toHaveLength(0);
    expect(t.extractCalls).toHaveLength(0);
    expect((await t.repos.messages.listByConversation(conv.id)).map((m) => m.text)).toEqual(['まだですか？']);

    t.advance(24 * 60 * 60 * 1000);
    await handleEvent(textEvent('渋谷で9万まで'), t.deps);
    expect(t.messenger.replies).toHaveLength(1);
    expect((await t.conversation()).aiPaused).toBe(false);
  });

  it('1分に5発話を超えたら LLM を呼ばずに「混み合っています」', async () => {
    const t = setup();
    for (let i = 0; i < 5; i++) await handleEvent(textEvent(`こんにちは${i}`), t.deps);
    await handleEvent(textEvent('6回目'), t.deps);
    expect(t.extractCalls).toHaveLength(5);
    expect(textsOf(t.lastReply())[0]).toContain('混み合っています');
  });

  it('レート制限はボタン・友だち追加・断った発話を数えず、1分たてば戻る（実機で見つかった不具合）', async () => {
    const t = setup({ extractions: [SEARCH] });
    await handleEvent(followEvent(), t.deps);
    await handleEvent(textEvent('渋谷で9万まで'), t.deps);
    for (let i = 0; i < 4; i++) await handleEvent(postbackEvent(buildPostbackData({ action: 'more' })), t.deps);
    for (let i = 0; i < 4; i++) await handleEvent(textEvent(`質問${i}`), t.deps);
    // 友だち追加1・ボタン4・自由文5 のうち、LLM を通したのは自由文の5回だけ
    expect(t.extractCalls).toHaveLength(5);
    expect(textsOf(t.lastReply()).join('')).not.toContain('混み合っています');

    await handleEvent(textEvent('6回目'), t.deps);
    await handleEvent(textEvent('7回目'), t.deps);
    expect(t.extractCalls).toHaveLength(5);
    expect(textsOf(t.lastReply())[0]).toContain('混み合っています');

    // 断った2回は数えないので、最初の5回から1分たてば通る
    t.advance(60_001);
    await handleEvent(textEvent('8回目'), t.deps);
    expect(t.extractCalls).toHaveLength(6);
  });

  it('1日の費用上限を超えたら LLM を呼ばない', async () => {
    const t = setup({ dailyCostLimitUsd: 0.0015 });
    await handleEvent(textEvent('1回目'), t.deps);
    await handleEvent(textEvent('2回目'), t.deps);
    await handleEvent(textEvent('3回目'), t.deps);
    expect(t.extractCalls).toHaveLength(2);
    expect(textsOf(t.lastReply())[0]).toContain('混み合っています');
  });

  it('reply が失敗したら push に切り替える', async () => {
    const t = setup({ extractions: [SEARCH] });
    t.messenger.failReplyWith = new Error('Invalid reply token');
    await handleEvent(textEvent('渋谷で9万まで'), t.deps);
    expect(t.messenger.pushes.map((p) => p.to)).toEqual([USER]);
  });

  it('LINE への送信が失敗しても、保存した仮受付は担当者へ通知する', async () => {
    const t = setup({ now: NIGHT, extractions: [SEARCH] });
    await handleEvent(textEvent('渋谷で9万まで'), t.deps);
    await handleEvent(postbackEvent(buildPostbackData({ action: 'viewing', propertyId: 'P2' })), t.deps);
    await handleEvent(postbackEvent(buildPostbackData({ action: 'viewingDay', date: '2026-10-08' })), t.deps);
    t.messenger.failReplyWith = new Error('Invalid reply token');
    t.messenger.failPushWith = new Error('monthly limit');
    await expect(
      handleEvent(postbackEvent(buildPostbackData({ action: 'viewingDay', date: '2026-10-09' })), t.deps),
    ).rejects.toThrow('monthly limit');
    expect(await t.repos.viewingRequests.listByStatus('pending')).toHaveLength(1);
    expect(t.notifier.viewingRequested).toHaveBeenCalledTimes(1);
  });

  it('偽造された postback は無視する', async () => {
    const t = setup();
    await handleEvent(postbackEvent('a=detail&id='), t.deps);
    await handleEvent(postbackEvent('{"action":"confirm"}'), t.deps);
    expect(t.messenger.replies).toHaveLength(0);
  });

  it('内見: ボタン → 候補日2つで仮受付を保存し、時間外受付を記録して担当者へ通知する', async () => {
    const t = setup({ now: NIGHT, extractions: [SEARCH] });
    await handleEvent(textEvent('渋谷で9万まで'), t.deps);
    await handleEvent(postbackEvent(buildPostbackData({ action: 'viewing', propertyId: 'P2' })), t.deps);
    expect((await t.conversation()).booking).toEqual({ propertyId: 'P2', candidateTimes: [] });
    await handleEvent(postbackEvent(buildPostbackData({ action: 'viewingDay', date: '2026-10-08' })), t.deps);
    await handleEvent(postbackEvent(buildPostbackData({ action: 'viewingDay', date: '2026-10-09' })), t.deps);

    const requests = await t.repos.viewingRequests.listByStatus('pending');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      propertyId: 'P2',
      candidateTimes: ['2026-10-08', '2026-10-09'],
      receivedOutsideHours: true,
      displayName: null,
    });
    expect(t.notifier.viewingRequested).toHaveBeenCalledWith({
      viewingRequestId: requests[0].id,
      conversationId: (await t.conversation()).id,
      propertyName: expect.stringContaining('テスト荘'),
      candidateTimes: ['2026-10-08', '2026-10-09'],
      receivedOutsideHours: true,
    });
    expect(t.notifier.handoffRequested).not.toHaveBeenCalled();
    expect(textsOf(t.lastReply())[0]).toContain('まだ予約は確定していません');
    expect((await t.conversation()).booking).toBeNull();
  });

  it('禁止トピックは引き継ぎメモに残す', async () => {
    const t = setup({ now: NIGHT, extractions: [ex({ intent: 'propertyQuestion', forbiddenTopic: 'safety' })] });
    await handleEvent(textEvent('このへん治安どう？'), t.deps);
    const conv = await t.conversation();
    expect(conv.handoffNotes).toEqual([{ text: 'このへん治安どう？', topic: 'safety', propertyIds: [], at: NIGHT.toISOString() }]);
    expect(t.answer).not.toHaveBeenCalled();
  });

  it('条件抽出の API が失敗したら状態を進めず「混み合っています」', async () => {
    const t = setup();
    t.deps.extract = async () => {
      throw new Error('429 rate_limit_error');
    };
    await handleEvent(textEvent('渋谷で9万まで'), t.deps);
    expect(textsOf(t.lastReply())[0]).toContain('混み合っています');
    expect((await t.conversation()).state).toBe('hearing');
  });

  it('回答の一部がレコードに無い: 答えられた部分に続けて引き継ぎ文を返し、メモを残す', async () => {
    const t = setup({ now: NIGHT, extractions: [SEARCH, ex({ intent: 'propertyQuestion', targetPositions: [2] })] });
    t.answer.mockResolvedValueOnce({
      text: '物件情報に駐車場の記載はありません。',
      handoff: { topic: null },
      verification: 'ok',
      latencyMs: 5,
      costUsd: 0.002,
      toolCalls: { status: 'needsStaff' },
    });
    await handleEvent(textEvent('渋谷で9万まで'), t.deps);
    await handleEvent(textEvent('2番目は駐車場ある？'), t.deps);
    const [reply] = textsOf(t.lastReply());
    expect(reply.startsWith('物件情報に駐車場の記載はありません。\n\n')).toBe(true);
    expect(reply).toContain('担当者が確認します');
    expect(reply).toContain('営業時間外');
    const conv = await t.conversation();
    expect(conv.handoffNotes).toEqual([{ text: '2番目は駐車場ある？', topic: null, propertyIds: ['P2'], at: NIGHT.toISOString() }]);
    const log = await t.repos.messages.listByConversation(conv.id);
    expect(log.at(-1)).toMatchObject({ verification: 'ok', toolCalls: { status: 'needsStaff' } });
  });

  it('回答生成が禁止トピックと判断したら、回答文なしで話題つきの引き継ぎ文を返す', async () => {
    const t = setup({ extractions: [SEARCH, ex({ intent: 'propertyQuestion', targetPositions: [1] })] });
    t.answer.mockResolvedValueOnce({ text: null, handoff: { topic: 'vacancy' }, verification: 'ok', latencyMs: 5, costUsd: 0.002 });
    await handleEvent(textEvent('渋谷で9万まで'), t.deps);
    await handleEvent(textEvent('1番目はまだ借りられる？'), t.deps);
    expect(textsOf(t.lastReply())).toEqual([expect.stringMatching(/^空室状況については担当者が確認します。/)]);
    const conv = await t.conversation();
    expect(conv.handoffNotes.map((n) => [n.topic, n.propertyIds])).toEqual([['vacancy', ['P1']]]);
  });

  it('根拠検証で差し替えた回答は送らず、引き継ぎ文とメモにして replaced を記録する', async () => {
    const t = setup({ extractions: [SEARCH, ex({ intent: 'propertyQuestion', targetPositions: [1] })] });
    t.answer.mockResolvedValueOnce({ text: null, handoff: { topic: null }, verification: 'replaced', latencyMs: 5, costUsd: 0.002 });
    await handleEvent(textEvent('渋谷で9万まで'), t.deps);
    await handleEvent(textEvent('1番目の家賃は？'), t.deps);
    expect(textsOf(t.lastReply())).toEqual([expect.stringMatching(/^このご質問は担当者が確認します。/)]);
    const conv = await t.conversation();
    expect(conv.handoffNotes.map((n) => n.text)).toEqual(['1番目の家賃は？']);
    const log = await t.repos.messages.listByConversation(conv.id);
    expect(log.at(-1)).toMatchObject({ verification: 'replaced', costUsd: 0.001 + 0.002 });
  });

  it('回答生成が失敗したら推測で埋めず担当者へ回す', async () => {
    const t = setup({ extractions: [SEARCH, ex({ intent: 'propertyQuestion', targetPositions: [1] })] });
    t.answer.mockRejectedValueOnce(new Error('overloaded'));
    await handleEvent(textEvent('渋谷で9万まで'), t.deps);
    await handleEvent(textEvent('1番目は駐輪場ある？'), t.deps);
    expect(textsOf(t.lastReply())[0]).toContain('担当者が確認します');
    const conv = await t.conversation();
    expect(conv.handoffNotes.map((n) => [n.text, n.propertyIds])).toEqual([['1番目は駐輪場ある？', ['P1']]]);
    const log = await t.repos.messages.listByConversation(conv.id);
    expect(log.at(-1)?.verification).toBe('replaced');
  });

  describe('担当者への通知（引き継ぎメモ）', () => {
    const SAFETY = ex({ intent: 'propertyQuestion', forbiddenTopic: 'safety' });

    it('未対応のメモが無い会話で最初のメモを足したときだけ通知し、続けて届いたメモでは重ねない', async () => {
      const t = setup({ now: NIGHT, extractions: [SAFETY, SAFETY] });
      await handleEvent(textEvent('このへん治安どう？'), t.deps);
      const conv = await t.conversation();
      expect(t.notifier.handoffRequested).toHaveBeenCalledTimes(1);
      expect(t.notifier.handoffRequested).toHaveBeenCalledWith({
        conversationId: conv.id,
        question: 'このへん治安どう？',
        topic: 'safety',
        propertyNames: [],
        receivedOutsideHours: true,
      });
      expect(t.notifier.viewingRequested).not.toHaveBeenCalled();

      await handleEvent(textEvent('夜は危なくない？'), t.deps);
      expect((await t.conversation()).handoffNotes).toHaveLength(2);
      expect(t.notifier.handoffRequested).toHaveBeenCalledTimes(1);
    });

    it('担当者が対応済みにした（handoffResolvedCount を進めた）あとの次のメモは、改めて通知する', async () => {
      const t = setup({ extractions: [SAFETY, SAFETY, SAFETY, SAFETY] });
      await handleEvent(textEvent('このへん治安どう？'), t.deps);
      await handleEvent(textEvent('夜は危なくない？'), t.deps);
      expect(t.notifier.handoffRequested).toHaveBeenCalledTimes(1);

      const conv = await t.conversation();
      await t.repos.conversations.update(conv.id, { handoffResolvedCount: conv.handoffNotes.length });
      await handleEvent(textEvent('駅前は？'), t.deps);
      expect(t.notifier.handoffRequested).toHaveBeenCalledTimes(2);
      expect(t.notifier.handoffRequested).toHaveBeenLastCalledWith(
        expect.objectContaining({ question: '駅前は？', receivedOutsideHours: false }),
      );

      // 見た後に届いたメモは未対応のまま残るので、その次はまた重ねない
      await handleEvent(textEvent('やっぱり夜が心配'), t.deps);
      expect(t.notifier.handoffRequested).toHaveBeenCalledTimes(2);
    });

    it('回答生成が回した質問は、対象物件の名前と話題つきで通知する', async () => {
      const t = setup({ extractions: [SEARCH, ex({ intent: 'propertyQuestion', targetPositions: [2] })] });
      t.answer.mockResolvedValueOnce({ text: null, handoff: { topic: 'vacancy' }, verification: 'ok', latencyMs: 5, costUsd: 0.002 });
      await handleEvent(textEvent('渋谷で9万まで'), t.deps);
      expect(t.notifier.handoffRequested).not.toHaveBeenCalled();

      await handleEvent(textEvent('2番目はまだ借りられる？'), t.deps);
      const p2 = (await t.repos.properties.listPublic()).find((p) => p.id === 'P2');
      expect(t.notifier.handoffRequested).toHaveBeenCalledTimes(1);
      expect(t.notifier.handoffRequested).toHaveBeenCalledWith(
        expect.objectContaining({ question: '2番目はまだ借りられる？', topic: 'vacancy', propertyNames: [p2?.name] }),
      );
    });

    it('通知に LINE ユーザー ID・表示名は渡さない', async () => {
      const t = setup({ extractions: [SAFETY] });
      await handleEvent(followEvent(), t.deps);
      await handleEvent(textEvent('このへん治安どう？'), t.deps);
      const calls = JSON.stringify(vi.mocked(t.notifier.handoffRequested).mock.calls);
      expect(calls).toContain('このへん治安どう？');
      expect(calls).not.toContain(USER);
      expect(calls).not.toContain('テスト太郎');
    });

    it('LINE への送信が失敗しても、保存したメモは担当者へ通知する', async () => {
      const t = setup({ extractions: [SAFETY] });
      t.messenger.failReplyWith = new Error('Invalid reply token');
      t.messenger.failPushWith = new Error('monthly limit');
      await expect(handleEvent(textEvent('このへん治安どう？'), t.deps)).rejects.toThrow('monthly limit');
      expect((await t.conversation()).handoffNotes).toHaveLength(1);
      expect(t.notifier.handoffRequested).toHaveBeenCalledTimes(1);
    });

    it('担当者が対応中（ai_paused）の会話では通知しない', async () => {
      const t = setup({ extractions: [SAFETY] });
      await t.repos.lineUsers.upsert({ lineUserId: USER });
      const conv = await t.conversation();
      await t.repos.conversations.update(conv.id, { aiPaused: true, lastStaffReplyAt: NOON.toISOString() });
      await handleEvent(textEvent('このへん治安どう？'), t.deps);
      expect(t.notifier.handoffRequested).not.toHaveBeenCalled();
      expect(t.notifier.viewingRequested).not.toHaveBeenCalled();
    });

    it('通知が失敗（reject・同期例外）しても handleEvent は投げず、返信と保存は済んでいる', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const t = setup({ extractions: [SAFETY] });
        vi.mocked(t.notifier.handoffRequested).mockRejectedValueOnce(new Error('resend down'));
        await expect(handleEvent(textEvent('このへん治安どう？'), t.deps)).resolves.toBeUndefined();
        expect(textsOf(t.lastReply())[0]).toContain('担当者が確認します');
        expect((await t.conversation()).handoffNotes).toHaveLength(1);

        const v = setup({ now: NIGHT, extractions: [SEARCH] });
        vi.mocked(v.notifier.viewingRequested).mockImplementationOnce(() => {
          throw new Error('sync failure');
        });
        await handleEvent(textEvent('渋谷で9万まで'), v.deps);
        await handleEvent(postbackEvent(buildPostbackData({ action: 'viewing', propertyId: 'P2' })), v.deps);
        await handleEvent(postbackEvent(buildPostbackData({ action: 'viewingDay', date: '2026-10-08' })), v.deps);
        await expect(
          handleEvent(postbackEvent(buildPostbackData({ action: 'viewingDay', date: '2026-10-09' })), v.deps),
        ).resolves.toBeUndefined();
        expect(await v.repos.viewingRequests.listByStatus('pending')).toHaveLength(1);
        expect(textsOf(v.lastReply())[0]).toContain('まだ予約は確定していません');
        expect(error).toHaveBeenCalledTimes(2);
      } finally {
        error.mockRestore();
      }
    });

    it('送信が失敗したうえで通知も失敗したら、投げるのは送信の失敗（通知の失敗で元の例外を覆わない）', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const t = setup({ extractions: [SAFETY] });
        vi.mocked(t.notifier.handoffRequested).mockRejectedValueOnce(new Error('resend down'));
        t.messenger.failReplyWith = new Error('Invalid reply token');
        t.messenger.failPushWith = new Error('monthly limit');
        await expect(handleEvent(textEvent('このへん治安どう？'), t.deps)).rejects.toThrow('monthly limit');
      } finally {
        error.mockRestore();
      }
    });
  });

  describe('担当者への通知（担当者対応中の返信）', () => {
    const HOUR = 60 * 60 * 1000;

    /** 担当者が手動返信して会話を止めた状態にする（管理画面の手動返信と同じ更新） */
    async function staffReplies(t: ReturnType<typeof setup>, text = '担当者です。お名前を教えてください') {
      await t.repos.lineUsers.upsert({ lineUserId: USER });
      const conv = await t.conversation();
      const at = t.deps.clock().toISOString();
      await t.repos.messages.insert({ conversationId: conv.id, role: 'staff', text });
      await t.repos.conversations.update(conv.id, { aiPaused: true, pausedAt: at, lastStaffReplyAt: at });
      return conv;
    }

    it('担当者の返信の後の最初の発言で通知する。続けて送られても重ねず、本文も渡さない', async () => {
      const t = setup({ now: NIGHT });
      const conv = await staffReplies(t);

      t.advance(5 * 60 * 1000);
      await handleEvent(textEvent('山田太郎、090-1234-5678です'), t.deps);
      expect(t.notifier.userRepliedWhilePaused).toHaveBeenCalledTimes(1);
      // 営業時間外（火曜 23:30 JST）。渡すのは会話 ID と時間外かだけ（キーを完全一致で固定する）
      expect(t.notifier.userRepliedWhilePaused).toHaveBeenCalledWith({ conversationId: conv.id, receivedOutsideHours: true });
      const calls = JSON.stringify(vi.mocked(t.notifier.userRepliedWhilePaused).mock.calls);
      expect(calls).not.toContain('山田太郎');
      expect(calls).not.toContain('090-1234-5678');
      expect(calls).not.toContain(USER);

      // 2通目・3通目（ボタンも利用者の発言）では重ねない。AI は返信せず、発言は保存される
      t.advance(60 * 1000);
      await handleEvent(textEvent('あと、ペットは飼えますか'), t.deps);
      await handleEvent(postbackEvent(buildPostbackData({ action: 'more' })), t.deps);
      expect(t.notifier.userRepliedWhilePaused).toHaveBeenCalledTimes(1);
      expect(t.messenger.replies).toHaveLength(0);
      expect(t.extractCalls).toHaveLength(0);
      expect((await t.repos.messages.listByConversation(conv.id)).filter((m) => m.role === 'user')).toHaveLength(3);
    });

    it('営業時間内の受付は receivedOutsideHours=false', async () => {
      const t = setup({ now: NOON });
      const conv = await staffReplies(t);
      t.advance(60 * 1000);
      await handleEvent(textEvent('はい'), t.deps);
      expect(t.notifier.userRepliedWhilePaused).toHaveBeenCalledWith({ conversationId: conv.id, receivedOutsideHours: false });
    });

    it('担当者がもう一度返信した後の最初の発言で、また通知する', async () => {
      const t = setup({ now: NOON });
      await staffReplies(t);
      t.advance(HOUR);
      await handleEvent(textEvent('1回目の返事'), t.deps);
      await handleEvent(textEvent('続き'), t.deps);
      expect(t.notifier.userRepliedWhilePaused).toHaveBeenCalledTimes(1);

      t.advance(HOUR);
      const conv = await staffReplies(t, '追加でお聞きします'); // lastStaffReplyAt が進む
      t.advance(HOUR);
      await handleEvent(textEvent('2回目の返事'), t.deps);
      expect(t.notifier.userRepliedWhilePaused).toHaveBeenCalledTimes(2);
      expect(t.notifier.userRepliedWhilePaused).toHaveBeenLastCalledWith(expect.objectContaining({ conversationId: conv.id }));
      await handleEvent(textEvent('2回目の続き'), t.deps);
      expect(t.notifier.userRepliedWhilePaused).toHaveBeenCalledTimes(2);
    });

    it('担当者の返信が無いまま止まっている（lastStaffReplyAt が null）なら、停止以降の最初の発言で通知する。停止より前の発言は数えない', async () => {
      const t = setup({ now: NOON });
      await t.repos.lineUsers.upsert({ lineUserId: USER });
      const conv = await t.conversation();
      await t.repos.messages.insert({ conversationId: conv.id, role: 'user', text: '停止の前の発言' });
      t.advance(HOUR);
      await t.repos.conversations.update(conv.id, { aiPaused: true, pausedAt: t.deps.clock().toISOString() });

      t.advance(HOUR);
      await handleEvent(textEvent('停止の後の最初'), t.deps);
      await handleEvent(textEvent('停止の後の2つ目'), t.deps);
      expect(t.notifier.userRepliedWhilePaused).toHaveBeenCalledTimes(1);
    });

    it('lastStaffReplyAt も pausedAt も null の停止は、発言のたびに通知する（起点が無いので最初とみなす）', async () => {
      const t = setup({ now: NOON });
      await t.repos.lineUsers.upsert({ lineUserId: USER });
      const conv = await t.conversation();
      await t.repos.conversations.update(conv.id, { aiPaused: true });
      await handleEvent(textEvent('1つ目'), t.deps);
      expect(t.notifier.userRepliedWhilePaused).toHaveBeenCalledTimes(1);
      expect(t.messenger.replies).toHaveLength(0);
    });

    it('24 時間たって AI が自動再開するときは通知しない（AI が返信する）', async () => {
      const t = setup({ now: NOON, extractions: [SEARCH] });
      await staffReplies(t);
      t.advance(24 * HOUR);
      await handleEvent(textEvent('渋谷で9万まで'), t.deps);
      expect((await t.conversation()).aiPaused).toBe(false);
      expect(t.messenger.replies).toHaveLength(1);
      expect(t.notifier.userRepliedWhilePaused).not.toHaveBeenCalled();
    });

    it('AI が動いている会話（ai_paused でない）では通知しない', async () => {
      const t = setup({ extractions: [SEARCH] });
      await handleEvent(textEvent('渋谷で9万まで'), t.deps);
      expect(t.notifier.userRepliedWhilePaused).not.toHaveBeenCalled();
    });

    it('通知が失敗（reject・同期例外）しても handleEvent は投げず、発言は保存されている', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const t = setup({ now: NOON });
        const conv = await staffReplies(t);
        vi.mocked(t.notifier.userRepliedWhilePaused).mockRejectedValueOnce(new Error('resend down'));
        t.advance(60 * 1000);
        await expect(handleEvent(textEvent('お返事です'), t.deps)).resolves.toBeUndefined();
        expect((await t.repos.messages.listByConversation(conv.id)).at(-1)).toMatchObject({ role: 'user', text: 'お返事です' });
        expect(error).toHaveBeenCalledTimes(1);

        const s = setup({ now: NOON });
        await staffReplies(s);
        vi.mocked(s.notifier.userRepliedWhilePaused).mockImplementationOnce(() => {
          throw new Error('sync failure');
        });
        s.advance(60 * 1000);
        await expect(handleEvent(textEvent('お返事です'), s.deps)).resolves.toBeUndefined();
        expect(error).toHaveBeenCalledTimes(2);
      } finally {
        error.mockRestore();
      }
    });

    it('営業カレンダーの読み出しが失敗しても handleEvent は投げず、発言は保存されている', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const t = setup({ now: NOON });
        const conv = await staffReplies(t);
        vi.spyOn(t.repos.businessCalendar, 'get').mockRejectedValueOnce(new Error('db down'));
        t.advance(60 * 1000);
        await expect(handleEvent(textEvent('お返事です'), t.deps)).resolves.toBeUndefined();
        expect(t.notifier.userRepliedWhilePaused).not.toHaveBeenCalled();
        expect((await t.repos.messages.listByConversation(conv.id)).at(-1)).toMatchObject({ role: 'user', text: 'お返事です' });
      } finally {
        error.mockRestore();
      }
    });
  });
});
