/**
 * 画面のアクセシビリティの検査（e2e/a11y.spec.ts）。`npm run build` した本番ビルドを `next start` で開き、axe-core で調べる。
 * 使い方: `npm run build && npm run test:a11y`（CI は .github/workflows/a11y.yml）。ブラウザは `npx playwright install chromium` で入れる。
 *
 * ログイン画面（/admin/login）を開くため、Supabase の環境変数に**偽の値**を入れる。ログインしていなければ proxy も画面も
 * Supabase に問い合わせずにフォームを描く。本物のキーは入れない（管理画面の中は開けない。引き継ぎ書 6章③）
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = 3200;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  // 手元で Chromium を入れずに済ませるときは PLAYWRIGHT_CHANNEL=chrome（入っている Google Chrome を使う）。CI は入れた Chromium
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: process.env.PLAYWRIGHT_CHANNEL || undefined } }],
  webServer: {
    command: `npx next start -p ${PORT} -H 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      SUPABASE_URL: 'http://127.0.0.1:54321',
      SUPABASE_PUBLISHABLE_KEY: 'fake-publishable-key-for-a11y',
    },
  },
});
