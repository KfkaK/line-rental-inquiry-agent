import { afterEach, describe, expect, it, vi } from 'vitest';
import { notifyOpsSafely, throttleOps, type OpsNotifier } from './opsAlert';

const HOUR = 60 * 60 * 1000;

function setup() {
  let now = Date.parse('2026-10-28T00:00:00Z');
  const inner: OpsNotifier = {
    aiUnavailable: vi.fn(async () => {}),
    costLimitReached: vi.fn(async () => {}),
    webhookFailed: vi.fn(async () => {}),
    dailyJobFailed: vi.fn(async () => {}),
  };
  const ops = throttleOps(inner, { intervalMs: 6 * HOUR, clock: () => new Date(now) });
  return {
    inner,
    ops,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('throttleOps', () => {
  it('同じ種類の通知は間隔の中で1回だけ。間隔が過ぎたらまた送る', async () => {
    const t = setup();
    await t.ops.aiUnavailable({ outage: 'credit', source: 'webhook' });
    t.advance(HOUR);
    await t.ops.aiUnavailable({ outage: 'credit', source: 'webhook' });
    expect(t.inner.aiUnavailable).toHaveBeenCalledTimes(1);
    t.advance(5 * HOUR);
    await t.ops.aiUnavailable({ outage: 'credit', source: 'webhook' });
    expect(t.inner.aiUnavailable).toHaveBeenCalledTimes(2);
  });

  it('残高切れとキーの失効は別に数える。Webhook の失敗も別', async () => {
    const t = setup();
    await t.ops.aiUnavailable({ outage: 'credit', source: 'webhook' });
    await t.ops.aiUnavailable({ outage: 'auth', source: 'webhook' });
    await t.ops.webhookFailed({ eventType: 'message' });
    await t.ops.webhookFailed({ eventType: 'postback' });
    expect(t.inner.aiUnavailable).toHaveBeenCalledTimes(2);
    expect(t.inner.webhookFailed).toHaveBeenCalledTimes(1);
  });

  it('同時に届いても1通（送る前に記録する）', async () => {
    const t = setup();
    await Promise.all([
      t.ops.aiUnavailable({ outage: 'credit', source: 'webhook' }),
      t.ops.aiUnavailable({ outage: 'credit', source: 'webhook' }),
    ]);
    expect(t.inner.aiUnavailable).toHaveBeenCalledTimes(1);
  });

  it('毎朝のジョブの失敗は間引かない（1日1回しか起きない）', async () => {
    const t = setup();
    await t.ops.dailyJobFailed({ steps: ['demo'] });
    await t.ops.dailyJobFailed({ steps: ['purge'] });
    expect(t.inner.dailyJobFailed).toHaveBeenCalledTimes(2);
  });
});

describe('notifyOpsSafely', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('通知が投げても握りつぶし、エラーの種類だけをログに出す（本文は出さない）', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      notifyOpsSafely('AI の停止', async () => {
        throw new TypeError('to=ops@example.com');
      }),
    ).resolves.toBeUndefined();
    const logged = error.mock.calls.flat().join(' ');
    expect(logged).toContain('AI の停止');
    expect(logged).toContain('TypeError');
    expect(logged).not.toContain('ops@example.com');
  });
});
