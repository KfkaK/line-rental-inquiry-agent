/**
 * 環境変数の読み口（サーバー専用）。読んだ時点で無ければ名前つきで落とす。
 * モジュールの読み込み時には読まない（実キーなしでテストが通るように）。
 */

/** 使う環境変数の一覧（.env.example と Vercel の設定の正） */
export const ENV_NAMES = [
  'LINE_CHANNEL_SECRET',
  'LINE_CHANNEL_ACCESS_TOKEN',
  'ANTHROPIC_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  /** 管理画面のログイン（sb_publishable_…）。RLS が効くクライアントを作る */
  'SUPABASE_PUBLISHABLE_KEY',
  'RESEND_API_KEY',
  /** 担当者通知メールの宛先。RESEND_API_KEY と両方あるときだけメールを送る（無ければログだけ） */
  'STAFF_NOTIFY_EMAIL',
  /** 担当者通知メールの差出人。省略時は Resend の検証用アドレス */
  'NOTIFY_FROM_EMAIL',
  /** 通知メールに載せる管理画面の URL の起点（例: https://line-rental-agent.vercel.app）。省略時は Vercel の本番 URL */
  'APP_BASE_URL',
  'DAILY_COST_LIMIT_USD',
  /** ローカル開発専用: '1' で管理画面をインメモリのデモデータで開く（ログイン不要）。本番ビルドでは無視する */
  'ADMIN_PREVIEW',
  /** '1' で公開デモの文面にする（あいさつと引き継ぎ・仮受付の文に「デモのため担当者からの連絡はありません」を足す） */
  'DEMO_MODE',
] as const;
export type EnvName = (typeof ENV_NAMES)[number];

export function requireEnv(name: EnvName): string {
  const value = process.env[name];
  if (!value) throw new Error(`環境変数 ${name} が設定されていません（.env.local または Vercel の設定）`);
  return value;
}

export function optionalEnv(name: EnvName): string | undefined {
  return process.env[name] || undefined;
}

/** 公開デモの文面にするか（DEMO_MODE=1 のときだけ。それ以外の値・未設定は false） */
export function isDemoMode(): boolean {
  return optionalEnv('DEMO_MODE') === '1';
}
