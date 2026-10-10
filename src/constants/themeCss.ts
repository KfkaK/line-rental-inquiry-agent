/**
 * テーマのトークン（./theme.ts）から CSS 変数を作る（管理画面用。LINE の Flex Message は theme を直接読む）。
 * 変数名はトークン名のケバブケース（backgroundElement → --background-element）。root layout の <style> に入れる。
 * Tailwind のクラス（bg-surface など）への割り当ては src/app/globals.css の `@theme inline`。色の値はここ以外に書かない（不変条件 13）。
 */
import { theme, type ThemeName } from './theme';

function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function declarations(name: ThemeName): string {
  return Object.entries(theme[name])
    .map(([key, value]) => `--${kebab(key)}:${value};`)
    .join('');
}

/** `:root{…}`（ライト）と、OS がダークのときの上書き。`color-scheme` も合わせ、日付・時刻の入力欄などの標準部品も追従させる */
export function themeCss(): string {
  return `:root{color-scheme:light;${declarations('light')}}@media (prefers-color-scheme:dark){:root{color-scheme:dark;${declarations('dark')}}}`;
}
