import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DailyJobResult } from '@/server/demoSeed';

type JobOptions = { demo: boolean; viewer?: { email: string; password: string } | null };
const runDailyJob = vi.fn<(client: unknown, now: Date, options: JobOptions) => Promise<DailyJobResult>>();
vi.mock('@/server/demoSeed', () => ({
  runDailyJob: (client: unknown, now: Date, options: JobOptions) => runDailyJob(client, now, options),
}));

const createServiceClient = vi.fn<() => unknown>();
vi.mock('@/lib/db', () => ({ createServiceClient: () => createServiceClient() }));

const checkAiAvailability = vi.fn<() => Promise<AiAvailability>>();
vi.mock('@/lib/llm/health', () => ({ checkAiAvailability: () => checkAiAvailability() }));

const ops = {
  aiUnavailable: vi.fn(async () => {}),
  costLimitReached: vi.fn(async () => {}),
  webhookFailed: vi.fn(async () => {}),
  dailyJobFailed: vi.fn(async () => {}),
};
vi.mock('@/server/deps', () => ({ createOpsNotifier: () => ops }));

import type { AiAvailability } from '@/lib/llm/health';
import { GET } from './route';

const SECRET = 'route-test-cron-secret';
const CLIENT = { name: 'fake-service-client' };

const OK_RESULT: DailyJobResult = {
  ok: true,
  demo: { status: 'ok', value: { dryRun: false, properties: 190, lineUsers: 6, conversations: 6, messages: 30, viewingRequests: 3, deleted: { conversations: 6, lineUsers: 6 } } },
  purge: { status: 'ok', value: { deleted: 4 } },
  viewer: { status: 'ok', value: { restored: true } },
};

function makeRequest(authorization: string | null): Request {
  const headers: Record<string, string> = {};
  if (authorization !== null) headers.authorization = authorization;
  return new Request('http://localhost/api/cron/daily', { method: 'GET', headers });
}

describe('GET /api/cron/daily', () => {
  const original = {
    cron: process.env.CRON_SECRET,
    demo: process.env.DEMO_MODE,
    viewerEmail: process.env.DEMO_VIEWER_EMAIL,
    viewerPassword: process.env.DEMO_VIEWER_PASSWORD,
  };

  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    delete process.env.DEMO_MODE;
    delete process.env.DEMO_VIEWER_EMAIL;
    delete process.env.DEMO_VIEWER_PASSWORD;
    runDailyJob.mockReset();
    runDailyJob.mockResolvedValue(OK_RESULT);
    createServiceClient.mockReset();
    createServiceClient.mockReturnValue(CLIENT);
    checkAiAvailability.mockReset();
    checkAiAvailability.mockResolvedValue({ ok: true });
    for (const fn of Object.values(ops)) fn.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (original.cron === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original.cron;
    if (original.demo === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = original.demo;
    if (original.viewerEmail === undefined) delete process.env.DEMO_VIEWER_EMAIL;
    else process.env.DEMO_VIEWER_EMAIL = original.viewerEmail;
    if (original.viewerPassword === undefined) delete process.env.DEMO_VIEWER_PASSWORD;
    else process.env.DEMO_VIEWER_PASSWORD = original.viewerPassword;
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
    await expect(response.json()).resolves.toEqual({ ...OK_RESULT, ai: 'ok' });
    expect(runDailyJob).toHaveBeenCalledTimes(1);
    expect(checkAiAvailability).toHaveBeenCalledTimes(1);
    expect(ops.dailyJobFailed).not.toHaveBeenCalled();
    expect(ops.aiUnavailable).not.toHaveBeenCalled();
    const [client, now, options] = runDailyJob.mock.calls[0];
    expect(client).toBe(CLIENT);
    expect(now).toBeInstanceOf(Date);
    expect(options).toEqual({ demo: false, viewer: null });
  });

  it('DEMO_MODE=1 ならデモの作り直しも指定する', async () => {
    process.env.DEMO_MODE = '1';
    await GET(makeRequest(`Bearer ${SECRET}`));
    expect(runDailyJob.mock.calls[0][2]).toEqual({ demo: true, viewer: null });
    process.env.DEMO_MODE = 'true';
    await GET(makeRequest(`Bearer ${SECRET}`));
    expect(runDailyJob.mock.calls[1][2]).toEqual({ demo: false, viewer: null });
  });

  it('閲覧用アカウントの環境変数が両方あるときだけ、資格情報を日次の処理に渡す（片方だけなら null）', async () => {
    process.env.DEMO_MODE = '1';
    process.env.DEMO_VIEWER_EMAIL = 'viewer@example.com';
    await GET(makeRequest(`Bearer ${SECRET}`));
    expect(runDailyJob.mock.calls[0][2]).toEqual({ demo: true, viewer: null });

    process.env.DEMO_VIEWER_PASSWORD = 'public-demo-pass';
    await GET(makeRequest(`Bearer ${SECRET}`));
    expect(runDailyJob.mock.calls[1][2]).toEqual({ demo: true, viewer: { email: 'viewer@example.com', password: 'public-demo-pass' } });
  });

  it('閲覧用アカウントの段階が失敗したら 500。応答にもログにもパスワード・メールアドレスは出さない（結果に含まれないため）', async () => {
    process.env.DEMO_MODE = '1';
    process.env.DEMO_VIEWER_EMAIL = 'viewer@example.com';
    process.env.DEMO_VIEWER_PASSWORD = 'public-demo-pass';
    runDailyJob.mockResolvedValue({ ...OK_RESULT, ok: false, viewer: { status: 'error', message: '役割が viewer ではないので、パスワードは変えていません' } });
    const response = await GET(makeRequest(`Bearer ${SECRET}`));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain('"viewer":{"status":"error"');
    expect(text).not.toContain('public-demo-pass');
    expect(text).not.toContain('viewer@example.com');
    const logged = [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls].flat().join('\n');
    expect(logged).toContain('[cron daily] viewer が失敗しました');
    expect(logged).not.toContain('public-demo-pass');
    expect(logged).not.toContain('viewer@example.com');
  });

  it('段階が失敗していたら 500（結果の本文は返す）で、失敗した段の名前だけを運営者に知らせる', async () => {
    runDailyJob.mockResolvedValue({
      ...OK_RESULT,
      ok: false,
      demo: { status: 'error', message: 'insert failed' },
      purge: { status: 'error', message: 'function does not exist' },
    });
    const response = await GET(makeRequest(`Bearer ${SECRET}`));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ ok: false, purge: { status: 'error' } });
    expect(ops.dailyJobFailed).toHaveBeenCalledWith({ steps: ['demo', 'purge'] });
  });

  it('Claude が残高切れ・キーの失効なら 500 にして運営者に知らせる', async () => {
    for (const outage of ['credit', 'auth'] as const) {
      checkAiAvailability.mockResolvedValueOnce({ ok: false, outage, detail: 'status=400 type=invalid_request_error' });
      const response = await GET(makeRequest(`Bearer ${SECRET}`));
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({ ok: true, ai: outage });
      expect(ops.aiUnavailable).toHaveBeenLastCalledWith({ outage, source: 'cron' });
    }
    expect(ops.dailyJobFailed).not.toHaveBeenCalled();
  });

  it('Claude の一時的な失敗（429・5xx・時間切れ）はログだけで 200（運営者には知らせない）', async () => {
    checkAiAvailability.mockResolvedValueOnce({ ok: false, outage: null, detail: 'status=529 type=overloaded_error' });
    const response = await GET(makeRequest(`Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ai: 'unavailable' });
    expect(ops.aiUnavailable).not.toHaveBeenCalled();
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('Claude を呼べません');
  });

  it('運営者への通知が投げても、応答は返す', async () => {
    runDailyJob.mockResolvedValue({ ...OK_RESULT, ok: false, purge: { status: 'error', message: 'x' } });
    ops.dailyJobFailed.mockRejectedValueOnce(new Error('resend down'));
    const response = await GET(makeRequest(`Bearer ${SECRET}`));
    expect(response.status).toBe(500);
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
    expect(ops.dailyJobFailed).toHaveBeenCalledWith({ steps: ['setup'] });
  });
});
