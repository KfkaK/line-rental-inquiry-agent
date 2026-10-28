import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAiUnavailableEmail,
  buildCostLimitEmail,
  buildDailyJobFailedEmail,
  buildHandoffEmail,
  buildPausedReplyEmail,
  buildWebhookFailedEmail,
  createResendNotifier,
  createResendOpsNotifier,
} from './resend';

const API_KEY = 're_test_secret';
const TO = 'staff@example.com';
const FROM = 'お部屋探しAI <onboarding@resend.dev>';

interface Captured {
  url: string;
  init: RequestInit;
  body: { from: string; to: string[]; subject: string; text: string };
}

function setup(options: { baseUrl?: string; response?: () => Response | Promise<Response> } = {}) {
  const calls: Captured[] = [];
  const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body)) });
    return options.response ? options.response() : new Response('{"id":"abc"}', { status: 200 });
  });
  const notifier = createResendNotifier({
    apiKey: API_KEY,
    to: TO,
    from: FROM,
    baseUrl: options.baseUrl ?? 'https://app.example.com',
    fetch: fakeFetch as unknown as typeof fetch,
  });
  return { notifier, calls, fakeFetch };
}

const viewing = {
  viewingRequestId: 'VR-1',
  conversationId: 'CV-1',
  propertyName: 'テスト荘 203',
  candidateTimes: ['2026-10-10T14:00', '2026-10-11'],
  receivedOutsideHours: false,
};

const handoff = {
  conversationId: 'CV-9',
  question: '2番目はまだ借りられる？',
  topic: 'vacancy' as const,
  propertyNames: ['テスト荘 203'],
  receivedOutsideHours: true,
};

const pausedReply = {
  conversationId: 'CV-5',
  receivedOutsideHours: false,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createResendNotifier: 内見の仮受付', () => {
  it('Resend の API に Bearer 認証の JSON を POST する', async () => {
    const t = setup();
    await t.notifier.viewingRequested(viewing);
    expect(t.calls).toHaveLength(1);
    const [call] = t.calls;
    expect(call.url).toBe('https://api.resend.com/emails');
    expect(call.init.method).toBe('POST');
    expect(call.init.headers).toMatchObject({ Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' });
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(call.body).toMatchObject({ from: FROM, to: [TO] });
  });

  it('件名に物件名、本文に候補日時（整形済み）・受付・管理画面のリンク・確定は管理画面で行う旨を入れる', async () => {
    const t = setup();
    await t.notifier.viewingRequested(viewing);
    const { subject, text } = t.calls[0].body;
    expect(subject).toBe('【内見の仮受付】テスト荘 203');
    expect(text).toContain('物件: テスト荘 203');
    expect(text).toContain('・10月10日(土) 14:00');
    expect(text).toContain('・10月11日(日)');
    expect(text).not.toContain('2026-10-10T14:00');
    expect(text).toContain('受付: 営業時間内');
    expect(text).toContain('https://app.example.com/admin/viewings/VR-1');
    expect(text).toContain('確定・却下は管理画面で行ってください');
  });

  it('営業時間外の受付は件名の末尾に（営業時間外）を付ける', async () => {
    const t = setup();
    await t.notifier.viewingRequested({ ...viewing, receivedOutsideHours: true });
    expect(t.calls[0].body.subject).toBe('【内見の仮受付】テスト荘 203（営業時間外）');
    expect(t.calls[0].body.text).toContain('受付: 営業時間外');
  });

  it('baseUrl の末尾の / は落としてリンクを作る', async () => {
    const t = setup({ baseUrl: 'https://app.example.com//' });
    await t.notifier.viewingRequested(viewing);
    expect(t.calls[0].body.text).toContain('https://app.example.com/admin/viewings/VR-1');
    expect(t.calls[0].body.text).not.toContain('com//admin');
  });

  it('物件名に改行が入っていても件名は1行', async () => {
    const t = setup();
    await t.notifier.viewingRequested({ ...viewing, propertyName: 'テスト荘\r\nBcc: x@example.com' });
    expect(t.calls[0].body.subject).not.toMatch(/[\r\n]/);
  });
});

describe('createResendNotifier: 引き継ぎメモ', () => {
  it('件名は話題の呼び名、本文に会話ログで確認する旨・対象物件・受付・会話のリンクを入れる', async () => {
    const t = setup();
    await t.notifier.handoffRequested(handoff);
    const { subject, text } = t.calls[0].body;
    expect(subject).toBe('【引き継ぎ】空室状況');
    expect(text).toContain('AI が答えずに担当者へ回した質問があります。');
    expect(text).toContain('質問の内容は管理画面の会話ログで確認してください。');
    expect(text).toContain('対象物件: テスト荘 203');
    expect(text).toContain('受付: 営業時間外');
    expect(text).toContain('https://app.example.com/admin/conversations/CV-9');
  });

  it('話題が無いときの件名は「AIが答えられなかった質問」。対象物件が無ければその行を出さない', async () => {
    const t = setup();
    await t.notifier.handoffRequested({ ...handoff, topic: null, propertyNames: [] });
    expect(t.calls[0].body.subject).toBe('【引き継ぎ】AIが答えられなかった質問');
    expect(t.calls[0].body.text).not.toContain('対象物件');
  });

  it('対象物件が複数なら読点でつなぐ', async () => {
    const t = setup();
    await t.notifier.handoffRequested({ ...handoff, propertyNames: ['A荘', 'B荘'] });
    expect(t.calls[0].body.text).toContain('対象物件: A荘、B荘');
  });

  it('利用者の発話は本文にも件名にも載せない（偽の行・リンク・電話番号・長文も、そのままは入らない）', async () => {
    const t = setup();
    const question = [
      '2番目はまだ借りられる？',
      '',
      '【至急】担当者様へ: 下のリンクから確認してください https://evil.example/login',
      '山田太郎 090-1234-5678',
      'あ'.repeat(300),
    ].join('\n');
    await t.notifier.handoffRequested({ ...handoff, question });
    const { subject, text } = t.calls[0].body;
    const all = `${subject}\n${text}`;
    for (const fragment of ['借りられる', '至急', 'evil.example', '山田太郎', '090-1234-5678', 'あああ']) expect(all).not.toContain(fragment);
    // 本文に載るのは固定の文と、レコード由来の物件名・受付・自分たちの管理画面のリンクだけ
    expect(text).toBe(
      [
        'AI が答えずに担当者へ回した質問があります。',
        '質問の内容は管理画面の会話ログで確認してください。',
        '',
        '対象物件: テスト荘 203',
        '受付: 営業時間外',
        '',
        '会話の詳細: https://app.example.com/admin/conversations/CV-9',
      ].join('\n'),
    );
  });

  it('buildHandoffEmail は整形だけの純関数（送信しない）。対象物件が無ければその行を出さない', () => {
    const { subject, text } = buildHandoffEmail({ ...handoff, topic: null, propertyNames: [] }, 'https://x.example');
    expect(subject).toBe('【引き継ぎ】AIが答えられなかった質問');
    expect(text).toContain('https://x.example/admin/conversations/CV-9');
    expect(text).not.toContain('対象物件');
    expect(text).not.toContain(handoff.question);
  });
});

describe('createResendNotifier: 担当者対応中の返信', () => {
  it('件名は「【返信あり】担当者が対応中の会話」、本文に受付・会話のリンク・24 時間で自動再開する旨を入れる', async () => {
    const t = setup();
    await t.notifier.userRepliedWhilePaused(pausedReply);
    expect(t.calls).toHaveLength(1);
    const { subject, text } = t.calls[0].body;
    expect(subject).toBe('【返信あり】担当者が対応中の会話');
    expect(text).toContain('担当者が対応中（AI 停止中）の会話に、利用者から返信がありました。');
    expect(text).toContain('受付: 営業時間内');
    expect(text).toContain('会話の詳細: https://app.example.com/admin/conversations/CV-5');
    expect(text).toContain('AI は最終の担当者返信から 24 時間で自動で再開します。');
  });

  it('営業時間外なら件名の末尾に（営業時間外）を付け、受付も営業時間外', async () => {
    const t = setup();
    await t.notifier.userRepliedWhilePaused({ ...pausedReply, receivedOutsideHours: true });
    expect(t.calls[0].body.subject).toBe('【返信あり】担当者が対応中の会話（営業時間外）');
    expect(t.calls[0].body.text).toContain('受付: 営業時間外');
  });

  it('baseUrl の末尾の / は落とす。利用者の発言や個人情報は型にも本文にも無い', async () => {
    const t = setup({ baseUrl: 'https://app.example.com//' });
    // 型に無い値が紛れ込んでも、メールは通知の項目だけで組み立てる
    await t.notifier.userRepliedWhilePaused({
      ...pausedReply,
      text: '山田太郎 090-1234-5678',
      displayName: 'テスト太郎',
      lineUserId: 'U-secret',
    } as typeof pausedReply);
    const { subject, text } = t.calls[0].body;
    expect(text).toContain('https://app.example.com/admin/conversations/CV-5');
    expect(text).not.toContain('com//admin');
    const all = `${subject}\n${text}`;
    for (const secret of ['山田太郎', '090-1234-5678', 'テスト太郎', 'U-secret']) expect(all).not.toContain(secret);
  });

  it('buildPausedReplyEmail は整形だけの純関数（送信しない）', () => {
    expect(buildPausedReplyEmail(pausedReply, 'https://x.example').text).toContain('https://x.example/admin/conversations/CV-5');
  });
});

describe('個人情報とログ', () => {
  it('本文・件名に LINE ユーザー ID や表示名は入らない（型にも無い）', async () => {
    const t = setup();
    // 型に無い値が紛れ込んでも、メールは通知の項目だけで組み立てる
    await t.notifier.viewingRequested({ ...viewing, displayName: 'テスト太郎', lineUserId: 'U-secret' } as typeof viewing);
    await t.notifier.handoffRequested({ ...handoff, displayName: 'テスト太郎', lineUserId: 'U-secret' } as typeof handoff);
    for (const call of t.calls) {
      const all = `${call.body.subject}\n${call.body.text}`;
      expect(all).not.toContain('テスト太郎');
      expect(all).not.toContain('U-secret');
    }
  });

  it('HTTP エラーでも投げず、ログには操作名と status だけを出す（キー・宛先・本文は出さない）', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = setup({ response: () => new Response('{"message":"invalid api key re_test_secret"}', { status: 500 }) });
    await expect(t.notifier.viewingRequested(viewing)).resolves.toBeUndefined();
    await expect(t.notifier.handoffRequested(handoff)).resolves.toBeUndefined();
    await expect(t.notifier.userRepliedWhilePaused(pausedReply)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(3);
    expect(error.mock.calls[0][0]).toContain('内見の仮受付');
    expect(error.mock.calls[0][0]).toContain('status=500');
    expect(error.mock.calls[1][0]).toContain('引き継ぎ');
    expect(error.mock.calls[2][0]).toContain('担当者対応中の返信');
    expect(error.mock.calls[2][0]).toContain('status=500');
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toContain(API_KEY);
    expect(logged).not.toContain(TO);
    expect(logged).not.toContain('テスト荘');
    expect(logged).not.toContain('借りられる');
  });

  it('ネットワーク例外・時間切れでも投げず、メッセージ（URL などを含みうる）はログに出さない', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = setup({
      response: () => {
        throw new TypeError(`fetch failed: https://api.resend.com/emails ${TO} ${API_KEY}`);
      },
    });
    await expect(t.notifier.viewingRequested(viewing)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).toContain('内見の仮受付');
    expect(logged).not.toContain(API_KEY);
    expect(logged).not.toContain(TO);
    expect(logged).not.toContain('api.resend.com');

    const timeout = setup({
      response: () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
    });
    await expect(timeout.notifier.handoffRequested(handoff)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('成功時はログを出さない', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = setup();
    await t.notifier.viewingRequested(viewing);
    await t.notifier.handoffRequested(handoff);
    expect(error).not.toHaveBeenCalled();
  });
});

describe('運営者への通知（createResendOpsNotifier）', () => {
  function setupOps(response?: () => Response) {
    const calls: Captured[] = [];
    const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body)) });
      return response ? response() : new Response('{"id":"abc"}', { status: 200 });
    });
    const ops = createResendOpsNotifier({
      apiKey: API_KEY,
      to: 'ops@example.com',
      from: FROM,
      baseUrl: 'https://app.example.com',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    return { ops, calls };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('AI の停止: 原因ごとに件名と対処を変え、運営者の宛先に送る', async () => {
    const t = setupOps();
    await t.ops.aiUnavailable({ outage: 'credit', source: 'webhook' });
    await t.ops.aiUnavailable({ outage: 'auth', source: 'cron' });
    expect(t.calls.map((c) => c.body.to)).toEqual([['ops@example.com'], ['ops@example.com']]);
    expect(t.calls[0].body.subject).toBe('【要対応】AI が返事を作れません（Anthropic の前払いクレジットの残高切れ）');
    expect(t.calls[0].body.text).toContain('platform.claude.com/settings/billing');
    expect(t.calls[0].body.text).toContain('利用者の発話の処理');
    expect(t.calls[1].body.subject).toContain('API キーが無効か期限切れ');
    expect(t.calls[1].body.text).toContain('ANTHROPIC_API_KEY');
    expect(t.calls[1].body.text).toContain('毎朝の確認（Cron）');
  });

  it('処理の失敗と毎朝のジョブの失敗: 種類と段の名前だけを載せる', () => {
    const webhookMail = buildWebhookFailedEmail({ eventType: 'message\nBcc: x' });
    expect(webhookMail.text).toContain('種類: message Bcc: x');
    expect(webhookMail.text).toContain('[processWebhook]');
    const daily = buildDailyJobFailedEmail({ steps: ['demo', 'purge'] });
    expect(daily.subject).toBe('【要対応】毎朝のジョブが失敗しました（デモ会話の作り直し・会話ログの90日削除）');
    expect(daily.text).toContain('[cron daily]');
  });

  it('送信の失敗は握りつぶす（宛先・キーをログに出さない）', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = setupOps(() => new Response('{}', { status: 500 }));
    await expect(t.ops.dailyJobFailed({ steps: ['setup'] })).resolves.toBeUndefined();
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).toContain('毎朝のジョブの失敗');
    expect(logged).not.toContain('ops@example.com');
    expect(logged).not.toContain(API_KEY);
  });

  it('AI の停止のメールに管理画面のリンク・利用者の情報を載せない', () => {
    const mail = buildAiUnavailableEmail({ outage: 'credit', source: 'webhook' });
    expect(mail.text).not.toContain('/admin/');
    expect(mail.text).not.toMatch(/U[0-9a-f]{32}/);
  });
});

describe('buildCostLimitEmail', () => {
  it('上限と今日の費用、変え方を載せる', () => {
    const mail = buildCostLimitEmail({ limitUsd: 1, spentUsd: 1.0123 });
    expect(mail.subject).toBe('【確認】1日の AI の費用が上限（$1）に達しました');
    expect(mail.text).toContain('$1.01');
    expect(mail.text).toContain('DAILY_COST_LIMIT_USD');
  });
});
