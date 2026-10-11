/**
 * 公開デモの閲覧用アカウントの資格情報を環境変数から読む（サーバー専用）。
 *
 * - 日次の Cron（src/app/api/cron/daily/route.ts）は、この値でアカウントのパスワードを戻す（src/server/demoSeed.ts）
 * - ログイン画面（src/app/admin/login/page.tsx）は、DEMO_MODE=1 のときだけこの値を画面に載せる
 * 環境変数は読んだ時点の値を使う。呼ぶ側は、ビルド時の値で固まらないよう先に `connection()` を呼ぶこと（引き継ぎ書8章）
 */
import { isDemoMode, optionalEnv } from '@/lib/env';

/** 閲覧用アカウントの資格情報（環境変数 DEMO_VIEWER_EMAIL・DEMO_VIEWER_PASSWORD。ログイン画面と README に載せる公開の値） */
export interface DemoViewerCredentials {
  email: string;
  password: string;
}

/** DEMO_VIEWER_EMAIL・DEMO_VIEWER_PASSWORD が両方あるときだけ返す。前後の空白は取る（Vercel に貼ったときの改行などで、表示と実際の値がずれないように） */
export function demoViewerFromEnv(): DemoViewerCredentials | null {
  const email = optionalEnv('DEMO_VIEWER_EMAIL')?.trim();
  const password = optionalEnv('DEMO_VIEWER_PASSWORD')?.trim();
  return email && password ? { email, password } : null;
}

/** ログイン画面に載せる資格情報。DEMO_MODE=1 のときだけ（デモでない環境では、環境変数があっても載せない） */
export function publicDemoViewer(): DemoViewerCredentials | null {
  return isDemoMode() ? demoViewerFromEnv() : null;
}
