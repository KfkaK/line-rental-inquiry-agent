/**
 * 色のトークン。管理画面（CSS 変数）と LINE の Flex Message の両方がここから色を取る。
 * 直書きの色は使わない。足したら `npm run check:contrast` で AA（本文 4.5:1）を実測する。
 * 暫定パレット: 生成りオフホワイト地 ＋ 白カード ＋ スレートブルー（ユーザー確認前）
 */
export const theme = {
  light: {
    background: '#F7F5F0',
    backgroundElement: '#FFFFFF',
    border: '#DDD8CE',
    text: '#1F2933',
    textSecondary: '#5B6670',
    accent: '#3E5C76',
    onAccent: '#FFFFFF',
    danger: '#9A3B32',
  },
  dark: {
    background: '#1E1C1A',
    backgroundElement: '#2A2724',
    border: '#3D3934',
    text: '#ECE8E2',
    textSecondary: '#B3ACA3',
    accent: '#9DB8CE',
    onAccent: '#1E1C1A',
    danger: '#E59A90',
  },
} as const;

export type ThemeName = keyof typeof theme;
export type ThemeTokens = (typeof theme)[ThemeName];
