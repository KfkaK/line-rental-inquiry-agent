import type { webhook } from '@line/bot-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeProperty } from '@/domain/fixtures';
import { createMemoryRepositories } from '@/lib/db';
import { createFakeMessenger } from '@/lib/line/messenger';
import type { Deps } from './handleEvent';
import type { OpsNotifier } from './opsAlert';
import { processWebhook } from './processWebhook';

function setup() {
  const repos = createMemoryRepositories({ properties: [makeProperty({ id: 'P1' })] });
  const ops: OpsNotifier = {
    aiUnavailable: vi.fn(async () => {}),
    costLimitReached: vi.fn(async () => {}),
    webhookFailed: vi.fn(async () => {}),
    dailyJobFailed: vi.fn(async () => {}),
  };
  const deps: Deps = {
    repos,
    messenger: createFakeMessenger(),
    extract: vi.fn(),
    answer: vi.fn(),
    notifier: { viewingRequested: vi.fn(), handoffRequested: vi.fn(), userRepliedWhilePaused: vi.fn() },
    clock: () => new Date('2026-10-28T03:00:00Z'),
    dailyCostLimitUsd: 5,
    ops,
  };
  return { deps, repos, ops };
}

const event = (id: string) =>
  ({
    type: 'unfollow',
    mode: 'active',
    timestamp: 0,
    source: { type: 'user', userId: 'U-1' },
    webhookEventId: id,
    deliveryContext: { isRedelivery: false },
  }) as webhook.Event;

describe('processWebhook', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('イベントの処理が投げたら、残りを続け、運営者には種類だけを知らせる（本文・ユーザー ID は渡さない）', async () => {
    const t = setup();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const markIfNew = vi.spyOn(t.repos.webhookEvents, 'markIfNew').mockRejectedValueOnce(new Error('db down'));
    await processWebhook({ destination: 'D', events: [event('EV1'), event('EV2')] }, t.deps);
    expect(markIfNew).toHaveBeenCalledTimes(2);
    expect(t.ops.webhookFailed).toHaveBeenCalledTimes(1);
    expect(t.ops.webhookFailed).toHaveBeenCalledWith({ eventType: 'unfollow' });
    expect(error.mock.calls.flat().join(' ')).not.toContain('U-1');
  });

  it('通知が投げても例外を外へ出さない', async () => {
    const t = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(t.repos.webhookEvents, 'markIfNew').mockRejectedValueOnce(new Error('db down'));
    vi.mocked(t.ops.webhookFailed).mockRejectedValueOnce(new Error('resend down'));
    await expect(processWebhook({ destination: 'D', events: [event('EV3')] }, t.deps)).resolves.toBeUndefined();
  });
});
