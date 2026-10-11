/**
 * 公開デモの閲覧用アカウントに見せるデモ会話を、本番の Supabase に手で1回書く（毎朝の作り直しは Vercel Cron）。
 *
 * 使い方（環境変数は .env.local から読む。SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が要る）:
 *   npm run demo:seed -- --dry-run   # 何も書かず、作る件数だけを表示する（物件を読むだけ）
 *   npm run demo:seed                # 既存のデモ会話（is_demo・'demo-' の LINE ユーザー）を消して入れ直す
 *
 * 消すのは is_demo の会話と、line_user_id が 'demo-' で始まる line_users だけ（src/server/demoSeed.ts）。
 * 公開物件（properties.status = public）が 0 件なら何もしない。
 */
import { createServiceClient } from '@/lib/db';
import { refreshDemoData } from '@/server/demoSeed';

function parseArgs(argv: string[]): { dryRun: boolean } {
  let dryRun = false;
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else throw new Error(`未知のオプション: ${arg}`);
  }
  return { dryRun };
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    // .env.local が無ければ、環境変数がすでに設定されている前提で続ける
  }
  const { dryRun } = parseArgs(process.argv.slice(2));

  const result = await refreshDemoData(createServiceClient(), new Date(), { dryRun });
  console.log(`公開物件: ${result.properties} 件から種を作りました`);
  console.log(
    `デモ会話 ${result.conversations} 件・メッセージ ${result.messages} 件・内見の仮受付 ${result.viewingRequests} 件・LINE ユーザー ${result.lineUsers} 件`,
  );
  if (result.deleted) {
    console.log(`消した既存のデモ: 会話 ${result.deleted.conversations} 件・LINE ユーザー ${result.deleted.lineUsers} 件`);
    console.log('書きました');
  } else {
    console.log('--dry-run のため書きません');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
