/**
 * 画面のアクセシビリティを axe-core で調べる（WCAG 2.x の A と AA の規則。文字と背景のコントラストも実際の画面で測る）。
 * ライトとダークの両方で開き、違反が1件でもあれば落とす。設定と使い方は playwright.config.ts。
 * 管理画面の中（/admin）はログインが要るので、まだ調べていない（引き継ぎ書 6章③）
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const PAGES = [
  { path: '/', ready: (page: Page) => page.getByRole('heading', { name: 'お部屋探しAI' }) },
  { path: '/privacy', ready: (page: Page) => page.getByRole('heading', { level: 1 }) },
  { path: '/terms', ready: (page: Page) => page.getByRole('heading', { level: 1 }) },
  // 偽の Supabase の環境変数で、フォームまで描かれることを確かめてから調べる（「設定がありません」の表示で通らないように）
  { path: '/admin/login', ready: (page: Page) => page.getByLabel('パスワード') },
];

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(colorScheme, () => {
    test.use({ colorScheme });

    for (const { path, ready } of PAGES) {
      test(`${path} に wcag2a・wcag2aa の違反が無い`, async ({ page }) => {
        await page.goto(path);
        await expect(ready(page)).toBeVisible();

        const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
        // 落ちたときに何を直せばよいか分かるよう、規則・影響・該当する要素を出す
        const summary = violations.map((v) => ({
          rule: v.id,
          impact: v.impact,
          help: v.help,
          targets: v.nodes.map((n) => n.target.join(' ')),
        }));
        expect(summary).toEqual([]);
      });
    }
  });
}
