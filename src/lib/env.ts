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
  'RESEND_API_KEY',
  'DAILY_COST_LIMIT_USD',
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
