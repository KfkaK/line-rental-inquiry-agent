import { createServiceClient } from '@/lib/db';
import { isDemoMode, optionalEnv } from '@/lib/env';
import { checkAiAvailability } from '@/lib/llm/health';
import { isCronAuthorized } from '@/server/cronAuth';
import { runDailyJob } from '@/server/demoSeed';
import { demoViewerFromEnv } from '@/server/demoViewer';
import { createOpsNotifier } from '@/server/deps';
import { notifyOpsSafely, type DailyJobStep } from '@/server/opsAlert';

/**
 * Vercel Cron の日次ジョブ（vercel.json の crons。Hobby は1日1回）。
 *   1. デモ会話の作り直し（DEMO_MODE=1 のときだけ。朝の一覧の「夜間・休日分」から落ちないよう毎朝）
 *   2. 閲覧用アカウントのパスワードを環境変数の値に戻す（DEMO_MODE=1 で DEMO_VIEWER_EMAIL・DEMO_VIEWER_PASSWORD があるときだけ。
 *      資格情報を README とログイン画面に載せるので、ログインした誰かが変えて締め出されないように）
 *   3. 会話ログの90日削除（purge_old_messages）
 *   4. Claude が呼べるかの確かめ（残高切れ・キーの失効に、発話が無い日でも翌朝までに気づく。src/lib/llm/health.ts）
 *
 * 認証: Vercel は環境変数 CRON_SECRET があると `Authorization: Bearer <CRON_SECRET>` を付けて呼ぶ。
 * CRON_SECRET が未設定なら何もせず 500（未設定のまま公開して誰でも叩ける状態にしない）。無い・違うなら 401。
 * リクエストのヘッダーを最初に読むので、Cache Components 下でもビルド時には実行されず、リクエストごとに動く。
 * 1〜3 の段が失敗したとき・4 で残高切れかキーの失効が分かったときは 500 にして、運営者にメールで知らせる（引き継ぎ書11章）。
 * 4 の 429・5xx・時間切れは待てば直りうるので、ログだけ。本文は件数だけで、個人情報・秘密（閲覧用のパスワード・メールアドレスを含む）は含めない。
 */
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const authorization = request.headers.get('authorization');

  const secret = optionalEnv('CRON_SECRET');
  if (!secret) {
    console.error('[cron daily] CRON_SECRET が未設定です。何もしません');
    return Response.json({ error: 'server misconfigured' }, { status: 500 });
  }
  if (!isCronAuthorized(authorization, secret)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const ops = createOpsNotifier();
  let result;
  try {
    result = await runDailyJob(createServiceClient(), new Date(), { demo: isDemoMode(), viewer: demoViewerFromEnv() });
  } catch (error) {
    // 環境変数（SUPABASE_URL など）が無いときはクライアントを作れない
    console.error('[cron daily] 実行できませんでした', error instanceof Error ? error.message : error);
    await notifyOpsSafely('毎朝のジョブの失敗', () => ops.dailyJobFailed({ steps: ['setup'] }));
    return Response.json({ error: 'server misconfigured' }, { status: 500 });
  }

  const failed: DailyJobStep[] = [];
  for (const [name, step] of [['demo', result.demo], ['viewer', result.viewer], ['purge', result.purge]] as const) {
    if (step.status === 'error') {
      console.error(`[cron daily] ${name} が失敗しました: ${step.message}`);
      failed.push(name);
    }
  }
  if (failed.length > 0) await notifyOpsSafely('毎朝のジョブの失敗', () => ops.dailyJobFailed({ steps: failed }));

  const ai = await checkAiAvailability();
  if (!ai.ok) {
    console.error(`[cron daily] Claude を呼べません 原因=${ai.outage ?? '一時的な失敗'} ${ai.detail}`);
    const outage = ai.outage;
    if (outage) await notifyOpsSafely('AI の停止', () => ops.aiUnavailable({ outage, source: 'cron' }));
  }
  const aiStatus = ai.ok ? 'ok' : (ai.outage ?? 'unavailable');

  console.log('[cron daily]', JSON.stringify({ ...result, ai: aiStatus }));
  const ok = result.ok && (ai.ok || ai.outage === null);
  return Response.json({ ...result, ai: aiStatus }, { status: ok ? 200 : 500 });
}
