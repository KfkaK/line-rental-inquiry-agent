import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DailyJobResult } from '@/server/demoSeed';

const runDailyJob = vi.fn<(client: unknown, now: Date, options: { demo: boolean }) => Promise<DailyJobResult>>();
vi.mock('@/server/demoSeed', () => ({
  runDailyJob: (client: unknown, now: Date, options: { demo: boolean }) => runDailyJob(client, now, options),
}));

const createServiceClient = vi.fn<() => unknown>();
vi.mock('@/lib/db', () => ({ createServiceClient: () => createServiceClient() }));

import { GET } from './route';

const SECRET = 'route-test-cron-secret';
const CLIENT = { name: 'fake-service-client' };

const OK_RESULT: DailyJobResult = {
  ok: true,
  demo: { status: 'ok', value: { dryRun: false, properties: 190, lineUsers: 6, conversations: 6, messages: 30, viewingRequests: 3, deleted: { conversations: 6, lineUsers: 6 } } },
  purge: { status: 'ok', value: { deleted: 4 } },
};

function makeRequest(authorization: string | null): Request {
  const headers: Record<string, string> = {};
  if (authorization !== null) headers.authorization = authorization;
  return new Request('http://localhost/api/cron/daily', { method: 'GET', headers });
}

describe('GET /api/cron/daily', () => {
  const original = { cron: process.env.CRON_SECRET, demo: process.env.DEMO_MODE };

  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    delete process.env.DEMO_MODE;
    runDailyJob.mockReset();
    runDailyJob.mockResolvedValue(OK_RESULT);
    createServiceClient.mockReset();
    createServiceClient.mockReturnValue(CLIENT);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (original.cron === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original.cron;
    if (original.demo === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = original.demo;
    vi.restoreAllMocks();
  });

  it('CRON_SECRET が未設定なら 500 で何もしない（ヘッダーが付いていても）', async () => {
    delete process.env.CRON_SECRET;
    for (const authorization of [null, 'Bearer ', 'Bearer undefined', `Bearer ${SECRET}`]) {
      const response = await GET(makeRequest(authorization));
      expect(response.status).toBe(500);
    }
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(runDailyJob).not.toHaveBeenCalled();
  });

  it('CRON_SECRET が空文字でも未設定と同じ（500）', async () => {
    process.env.CRON_SECRET = '';
    expect((await GET(makeRequest('Bearer '))).status).toBe(500);
    expect(runDailyJob).not.toHaveBeenCalled();
  });

  it('ヘッダーが無い・違うなら 401 で何もしない', async () => {
    for (const authorization of [null, '', 'Bearer wrong', SECRET, `Basic ${SECRET}`]) {
      const response = await GET(makeRequest(authorization));
      expect(response.status).toBe(401);
    }
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(runDailyJob).not.toHaveBeenCalled();
  });

  it('正しい Bearer なら日次の処理を走らせ、結果（件数）を 200 で返す。DEMO_MODE が無ければデモの作り直しはしない指定', async () => {
    const response = await GET(makeRequest(`Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(OK_RESULT);
    expect(runDailyJob).toHaveBeenCalledTimes(1);
    const [client, now, options] = runDailyJob.mock.calls[0];
    expect(client).toBe(CLIENT);
    expect(now).toBeInstanceOf(Date);
    expect(options).toEqual({ demo: false });
  });

  it('DEMO_MODE=1 ならデモの作り直しも指定する', async () => {
    process.env.DEMO_MODE = '1';
    await GET(makeRequest(`Bearer ${SECRET}`));
    expect(runDailyJob.mock.calls[0][2]).toEqual({ demo: true });
    process.env.DEMO_MODE = 'true';
    await GET(makeRequest(`Bearer ${SECRET}`));
    expect(runDailyJob.mock.calls[1][2]).toEqual({ demo: false });
  });

  it('段階が失敗していたら 500（結果の本文は返す）', async () => {
    runDailyJob.mockResolvedValue({ ...OK_RESULT, ok: false, purge: { status: 'error', message: 'function does not exist' } });
    const response = await GET(makeRequest(`Bearer ${SECRET}`));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ ok: false, purge: { status: 'error' } });
  });

  it('vercel.json の crons がこのルートを1日1回（Hobby の上限）、JST の朝（UTC 21 時）に呼ぶ', () => {
    const config = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../../vercel.json', import.meta.url)), 'utf8')) as {
      crons: { path: string; schedule: string }[];
    };
    expect(config.crons).toEqual([{ path: '/api/cron/daily', schedule: '0 21 * * *' }]);
  });

  it('Supabase の環境変数が無くクライアントを作れなければ 500（秘密・内部の詳細は返さない）', async () => {
    createServiceClient.mockImplementation(() => {
      throw new Error('環境変数 SUPABASE_URL が設定されていません');
    });
    const response = await GET(makeRequest(`Bearer ${SECRET}`));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain('SUPABASE_URL');
    expect(text).not.toContain(SECRET);
    expect(runDailyJob).not.toHaveBeenCalled();
  });
});
