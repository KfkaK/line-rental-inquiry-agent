import { createServiceClient } from '@/lib/db';
import { isDemoMode, optionalEnv } from '@/lib/env';
import { isCronAuthorized } from '@/server/cronAuth';
import { runDailyJob } from '@/server/demoSeed';
import { demoViewerFromEnv } from '@/server/demoViewer';

/**
 * Vercel Cron の日次ジョブ（vercel.json の crons。Hobby は1日1回）。
 *   1. デモ会話の作り直し（DEMO_MODE=1 のときだけ。朝の一覧の「夜間・休日分」から落ちないよう毎朝）
 *   2. 閲覧用アカウントのパスワードを環境変数の値に戻す（DEMO_MODE=1 で DEMO_VIEWER_EMAIL・DEMO_VIEWER_PASSWORD があるときだけ。
 *      資格情報を README とログイン画面に載せるので、ログインした誰かが変えて締め出されないように）
 *   3. 会話ログの90日削除（purge_old_messages）
 *
 * 認証: Vercel は環境変数 CRON_SECRET があると `Authorization: Bearer <CRON_SECRET>` を付けて呼ぶ。
 * CRON_SECRET が未設定なら何もせず 500（未設定のまま公開して誰でも叩ける状態にしない）。無い・違うなら 401。
 * リクエストのヘッダーを最初に読むので、Cache Components 下でもビルド時には実行されず、リクエストごとに動く。
 * 失敗した段階があると 500（Vercel のログで分かる）。本文は件数だけで、個人情報・秘密（閲覧用のパスワード・メールアドレスを含む）は含めない。
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

  let result;
  try {
    result = await runDailyJob(createServiceClient(), new Date(), { demo: isDemoMode(), viewer: demoViewerFromEnv() });
  } catch (error) {
    // 環境変数（SUPABASE_URL など）が無いときはクライアントを作れない
    console.error('[cron daily] 実行できませんでした', error instanceof Error ? error.message : error);
    return Response.json({ error: 'server misconfigured' }, { status: 500 });
  }

  for (const [name, step] of [['demo', result.demo], ['viewer', result.viewer], ['purge', result.purge]] as const) {
    if (step.status === 'error') console.error(`[cron daily] ${name} が失敗しました: ${step.message}`);
  }
  console.log('[cron daily]', JSON.stringify(result));
  return Response.json(result, { status: result.ok ? 200 : 500 });
}
