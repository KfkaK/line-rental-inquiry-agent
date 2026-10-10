/**
 * 色のトークン。管理画面（CSS 変数）と LINE の Flex Message の両方がここから色を取る。
 * 直書きの色は使わない。足したら `npm run check:contrast` で AA（本文 4.5:1）を実測する。
 * パレット: 寒色寄りのニュートラル地 ＋ 白カード ＋ スレートブルー（2026-10-10 ユーザー決定。白ラベルの商品見本に見せるため、
 * 地と枠線だけ LifeOwner の生成り・暖チャコールから寒色寄りに変えた。意思決定ログ9）
 */
export const theme = {
  light: {
    background: '#F4F5F7',
    backgroundElement: '#FFFFFF',
    border: '#D8DCE2',
    text: '#1F2933',
    textSecondary: '#5B6670',
    accent: '#3E5C76',
    onAccent: '#FFFFFF',
    danger: '#9A3B32',
  },
  dark: {
    background: '#1B1D20',
    backgroundElement: '#25282C',
    border: '#3A3F46',
    text: '#ECE8E2',
    textSecondary: '#B3ACA3',
    accent: '#9DB8CE',
    onAccent: '#1B1D20',
    danger: '#E59A90',
  },
} as const;

export type ThemeName = keyof typeof theme;
export type ThemeTokens = (typeof theme)[ThemeName];
