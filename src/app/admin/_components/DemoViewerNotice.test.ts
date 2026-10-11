import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DemoViewerNotice } from './DemoViewerNotice';

describe('DemoViewerNotice', () => {
  const html = renderToStaticMarkup(createElement(DemoViewerNotice, { email: 'viewer@example.com', password: 'public-demo-pass' }));

  it('閲覧用アカウントであること（読み取り専用・見られるのは架空のデモ会話だけ）と、メールアドレス・パスワードを出す', () => {
    expect(html).toContain('公開デモの閲覧用アカウント');
    expect(html).toContain('読み取り専用です。見られるのは架空のデモ会話だけです。');
    expect(html).toContain('メールアドレス');
    expect(html).toContain('viewer@example.com');
    expect(html).toContain('パスワード');
    expect(html).toContain('public-demo-pass');
  });

  it('値はクリックで全選択できる（コピーしやすい）。フォームへの自動入力はしない（入力欄・ボタンを持たない）', () => {
    expect(html.match(/select-all/g)).toHaveLength(2);
    expect(html).not.toMatch(/<(?:input|button|form|a)\b/);
  });

  it('太字は 600 まで・色はトークン経由（クラス名だけ）', () => {
    expect(html).not.toMatch(/font-(?:bold|extrabold|black)/);
    expect(html).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
  });

  it('値は文字列として出す（HTML として解釈させない）', () => {
    const escaped = renderToStaticMarkup(createElement(DemoViewerNotice, { email: 'a<b>@example.com', password: '"<script>' }));
    expect(escaped).not.toContain('<script>');
    expect(escaped).not.toContain('<b>');
  });
});
