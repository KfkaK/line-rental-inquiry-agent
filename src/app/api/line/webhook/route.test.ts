import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `after` はリクエストの外では動かないので、渡されたコールバックを記録するだけの偽物に差し替える
const afterCallbacks: Array<() => Promise<void> | void> = [];
vi.mock('next/server', () => ({
  after: (callback: () => Promise<void> | void) => {
    afterCallbacks.push(callback);
  },
}));

const processWebhook = vi.fn<(body: unknown) => Promise<void>>();
vi.mock('@/server/processWebhook', () => ({
  processWebhook: (body: unknown) => processWebhook(body),
}));

import { POST } from './route';

const SECRET = 'route-test-secret';

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('base64');
}

function makeRequest(body: string, signature: string | null): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (signature !== null) headers['x-line-signature'] = signature;
  return new Request('http://localhost/api/line/webhook', { method: 'POST', headers, body });
}

const validBody = JSON.stringify({
  destination: 'Uxxxx',
  events: [{ type: 'message', message: { type: 'text', text: 'こんにちは' } }],
});

describe('POST /api/line/webhook', () => {
  const originalSecret = process.env.LINE_CHANNEL_SECRET;

  beforeEach(() => {
    process.env.LINE_CHANNEL_SECRET = SECRET;
    afterCallbacks.length = 0;
    processWebhook.mockReset();
    processWebhook.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.LINE_CHANNEL_SECRET;
    else process.env.LINE_CHANNEL_SECRET = originalSecret;
    vi.restoreAllMocks();
  });

  it('署名が正しければ 200 を返し、処理は after に渡す（レスポンスの前には走らない）', async () => {
    const response = await POST(makeRequest(validBody, sign(validBody)));

    expect(response.status).toBe(200);
    expect(afterCallbacks).toHaveLength(1);
    expect(processWebhook).not.toHaveBeenCalled();

    await afterCallbacks[0]();
    expect(processWebhook).toHaveBeenCalledTimes(1);
    expect(processWebhook).toHaveBeenCalledWith(JSON.parse(validBody));
  });

  it('署名が間違っていれば 401（after に何も渡さない）', async () => {
    const response = await POST(makeRequest(validBody, sign('別のボディ')));
    expect(response.status).toBe(401);
    expect(afterCallbacks).toHaveLength(0);
    expect(processWebhook).not.toHaveBeenCalled();
  });

  it('署名ヘッダが無ければ 401', async () => {
    const response = await POST(makeRequest(validBody, null));
    expect(response.status).toBe(401);
    expect(afterCallbacks).toHaveLength(0);
  });

  it('加工前のボディで検証する（整形し直したボディの署名は通らない）', async () => {
    const pretty = JSON.stringify(JSON.parse(validBody), null, 2);
    const response = await POST(makeRequest(validBody, sign(pretty)));
    expect(response.status).toBe(401);
  });

  it('署名が正しくても JSON でなければ 400・events が無ければ 400', async () => {
    const notJson = 'これは JSON ではない';
    expect((await POST(makeRequest(notJson, sign(notJson)))).status).toBe(400);

    const noEvents = JSON.stringify({ destination: 'U1' });
    expect((await POST(makeRequest(noEvents, sign(noEvents)))).status).toBe(400);

    const nullBody = 'null';
    expect((await POST(makeRequest(nullBody, sign(nullBody)))).status).toBe(400);
    expect(afterCallbacks).toHaveLength(0);
  });

  it('events が空（LINE の疎通確認）でも 200', async () => {
    const verifyBody = JSON.stringify({ destination: 'U1', events: [] });
    const response = await POST(makeRequest(verifyBody, sign(verifyBody)));
    expect(response.status).toBe(200);
  });

  it('チャネルシークレットが未設定なら 500（署名なしで通さない）', async () => {
    delete process.env.LINE_CHANNEL_SECRET;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await POST(makeRequest(validBody, sign(validBody)));
    expect(response.status).toBe(500);
    expect(afterCallbacks).toHaveLength(0);
  });

  it('processWebhook が例外を投げても after の中で捕まえてログに出す', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    processWebhook.mockRejectedValue(new Error('boom'));

    const response = await POST(makeRequest(validBody, sign(validBody)));
    expect(response.status).toBe(200);

    await expect(afterCallbacks[0]()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
  });
});
