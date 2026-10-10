import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { theme } from './theme';
import { themeCss } from './themeCss';

describe('themeCss', () => {
  const css = themeCss();

  it('すべてのトークンをケバブケースの CSS 変数にする（ライトは :root、ダークは prefers-color-scheme）', () => {
    const [light, dark] = css.split('@media (prefers-color-scheme:dark)');
    expect(light).toContain('--background:#F4F5F7;');
    expect(light).toContain('--background-element:#FFFFFF;');
    expect(light).toContain('--on-accent:#FFFFFF;');
    expect(dark).toContain('--background:#1B1D20;');
    expect(dark).toContain('--accent-soft:');
    for (const name of ['light', 'dark'] as const) {
      const part = name === 'light' ? light : dark;
      for (const value of Object.values(theme[name])) expect(part).toContain(value);
    }
  });

  it('標準部品（日付・時刻の入力欄）もテーマに追従させる', () => {
    expect(css).toContain('color-scheme:light');
    expect(css).toContain('color-scheme:dark');
  });
});

// 不変条件 13: 色はテーマのトークン経由だけ。画面のコードに色の値を直書きしない
describe('画面に色の直書きが無い', () => {
  const appDir = path.resolve(__dirname, '..', 'app');

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return /\.(tsx?|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
    });
  }

  const files = sourceFiles(appDir);

  it('src/app の下に 16 進の色・rgb()/hsl() が無い', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/#[0-9A-Fa-f]{3,8}\b(?![\w-])/);
      expect(text, file).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/);
    }
  });

  it('太字は 600 まで（font-bold などを使わない）', () => {
    for (const file of files) {
      expect(fs.readFileSync(file, 'utf8'), file).not.toMatch(/\bfont-(?:bold|extrabold|black)\b/);
    }
  });
});
