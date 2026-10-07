import { describe, expect, it, vi } from 'vitest';
import {
  chunkForPush,
  clampLoadingSeconds,
  createFakeMessenger,
  createLineMessenger,
  MAX_MESSAGES_PER_CALL,
  truncateForReply,
  type LineApiClient,
  type LineMessage,
} from './messenger';

function texts(n: number): LineMessage[] {
  return Array.from({ length: n }, (_, i) => ({ type: 'text', text: `m${i + 1}` }));
}

function labels(messages: LineMessage[]): string[] {
  return messages.map((m) => (m.type === 'text' ? m.text : m.type));
}

describe('送信数の上限', () => {
  it('reply: 5 通までは全部・超えたら先頭 5 通だけ残す', () => {
    expect(MAX_MESSAGES_PER_CALL).toBe(5);
    expect(truncateForReply(texts(5))).toEqual({ sent: texts(5), dropped: 0 });
    const { sent, dropped } = truncateForReply(texts(8));
    expect(labels(sent)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(dropped).toBe(3);
  });

  it('push: 5 通ずつに分割する（順序は保つ）', () => {
    expect(chunkForPush([])).toEqual([]);
    expect(chunkForPush(texts(5)).map((c) => c.length)).toEqual([5]);
    const chunks = chunkForPush(texts(12));
    expect(chunks.map((c) => c.length)).toEqual([5, 5, 2]);
    expect(labels(chunks.flat())).toEqual(texts(12).map((m) => (m as { text: string }).text));
  });

  it('入力中アニメーションの秒数は 5〜60 の 5 の倍数に丸める', () => {
    expect(clampLoadingSeconds(0)).toBe(5);
    expect(clampLoadingSeconds(-10)).toBe(5);
    expect(clampLoadingSeconds(12)).toBe(10);
    expect(clampLoadingSeconds(13)).toBe(15);
    expect(clampLoadingSeconds(60)).toBe(60);
    expect(clampLoadingSeconds(999)).toBe(60);
    expect(clampLoadingSeconds(Number.NaN)).toBe(5);
  });
});

describe('createFakeMessenger', () => {
  it('reply・push・showLoading を記録し、実装と同じ上限を適用する', async () => {
    const fake = createFakeMessenger();
    await fake.reply('token-1', texts(7));
    await fake.push('U1', texts(7));
    await fake.showLoading('U1', 8);

    expect(fake.replies).toHaveLength(1);
    expect(fake.replies[0].messages).toHaveLength(5);
    expect(fake.replies[0].dropped).toBe(2);
    expect(fake.pushes.map((p) => p.messages.length)).toEqual([5, 2]);
    expect(fake.loadings).toEqual([{ userId: 'U1', seconds: 10 }]);
  });

  it('空配列は何も記録しない', async () => {
    const fake = createFakeMessenger();
    await fake.reply('t', []);
    await fake.push('U1', []);
    expect(fake.replies).toHaveLength(0);
    expect(fake.pushes).toHaveLength(0);
  });

  it('getProfile: 登録があれば返し、無ければ null', async () => {
    const fake = createFakeMessenger({ profiles: { U1: { displayName: '太郎' } } });
    expect(await fake.getProfile('U1')).toEqual({ displayName: '太郎' });
    expect(await fake.getProfile('U2')).toBeNull();
    fake.setProfile('U2', { displayName: '花子' });
    expect(await fake.getProfile('U2')).toEqual({ displayName: '花子' });
  });

  it('failReplyWith を設定すると reply が失敗する（push への切り替えのテスト用）', async () => {
    const fake = createFakeMessenger();
    fake.failReplyWith = new Error('Invalid reply token');
    await expect(fake.reply('t', texts(1))).rejects.toThrow('Invalid reply token');
    expect(fake.replies).toHaveLength(0);
    fake.failReplyWith = null;
    await fake.reply('t', texts(1));
    expect(fake.replies).toHaveLength(1);
  });
});

describe('createLineMessenger（偽のクライアントで）', () => {
  function makeClient() {
    return {
      replyMessage: vi.fn(async () => ({ sentMessages: [] })),
      pushMessage: vi.fn(async () => ({ sentMessages: [] })),
      showLoadingAnimation: vi.fn(async () => ({})),
      getProfile: vi.fn(async (userId: string) => ({ userId, displayName: '太郎', pictureUrl: 'https://example.com/a.png' })),
    };
  }
  const asClient = (c: ReturnType<typeof makeClient>) => c as unknown as LineApiClient;

  it('reply は 1 回の API 呼び出しで先頭 5 通だけ送る（警告を出す）', async () => {
    const client = makeClient();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await createLineMessenger(asClient(client)).reply('tok', texts(6));

    expect(client.replyMessage).toHaveBeenCalledTimes(1);
    expect(client.replyMessage).toHaveBeenCalledWith({ replyToken: 'tok', messages: texts(5) });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('push は 5 通ずつ分割して順に送る', async () => {
    const client = makeClient();
    await createLineMessenger(asClient(client)).push('U1', texts(11));
    const sizes = (client.pushMessage.mock.calls as unknown as [{ messages: unknown[] }][]).map(([req]) => req.messages.length);
    expect(sizes).toEqual([5, 5, 1]);
  });

  it('空配列は API を呼ばない', async () => {
    const client = makeClient();
    const messenger = createLineMessenger(asClient(client));
    await messenger.reply('tok', []);
    await messenger.push('U1', []);
    expect(client.replyMessage).not.toHaveBeenCalled();
    expect(client.pushMessage).not.toHaveBeenCalled();
  });

  it('reply・push の失敗は呼び出し側に伝える', async () => {
    const client = makeClient();
    client.replyMessage.mockRejectedValue(new Error('expired'));
    await expect(createLineMessenger(asClient(client)).reply('tok', texts(1))).rejects.toThrow('expired');
  });

  it('showLoading は秒数を丸めて chatId で呼び、失敗しても例外にしない', async () => {
    const client = makeClient();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const messenger = createLineMessenger(asClient(client));
    await messenger.showLoading('U1', 7);
    expect(client.showLoadingAnimation).toHaveBeenCalledWith({ chatId: 'U1', loadingSeconds: 5 });

    client.showLoadingAnimation.mockRejectedValue(new Error('group chat'));
    await expect(messenger.showLoading('U1', 20)).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it('getProfile は表示名を返し、失敗したら null', async () => {
    const client = makeClient();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const messenger = createLineMessenger(asClient(client));
    expect(await messenger.getProfile('U1')).toEqual({ displayName: '太郎', pictureUrl: 'https://example.com/a.png' });

    client.getProfile.mockRejectedValue(new Error('404'));
    expect(await messenger.getProfile('U1')).toBeNull();
    warn.mockRestore();
  });

  it('クライアントを渡さず、トークンも無ければ名前つきのエラー（モジュール読み込み時には読まない）', () => {
    const saved = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    try {
      expect(() => createLineMessenger()).toThrow('LINE_CHANNEL_ACCESS_TOKEN');
    } finally {
      if (saved !== undefined) process.env.LINE_CHANNEL_ACCESS_TOKEN = saved;
    }
  });
});
