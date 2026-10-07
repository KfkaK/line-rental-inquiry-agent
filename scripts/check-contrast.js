#!/usr/bin/env node
/**
 * テーマのトークン（例: src/constants/theme.ts の `light: { ... }` / `dark: { ... }`）の配色が
 * WCAG 2.x AA を満たすことを検査する。「4.5:1 を下回らない」と宣言するだけでなく、実測で担保する。
 * - テキスト: 本文 4.5:1
 * - 非テキスト（グラフのセル・アイコンなど）: その地に対して 3:1（WCAG 1.4.11）
 *
 * 使い方: `npm run check:contrast`（CI でも回す）。1組でも下回れば終了コード 1
 *
 * 新しいアプリに入れるとき: THEME_PATH・THEMES・PAIRS・NON_TEXT_PAIRS をそのアプリのトークン名に合わせる。
 * 補助色（textMuted など）は「選択中の背景」の上にも載ることが多いので、その組も忘れずに入れる。
 * トークンは `key: '#RRGGBB'` の形で書かれている前提（6桁の16進）。
 */

const fs = require('fs');
const path = require('path');

const THEME_PATH = path.resolve(__dirname, '..', 'src', 'constants', 'theme.ts');
const THEMES = ['light', 'dark'];
const AA_RATIO = 4.5;
const NON_TEXT_RATIO = 3;

/** テキストの（前景, 背景）の組。全テーマに同じ組を適用する */
const PAIRS = [
  ['text', 'background'],
  ['text', 'backgroundElement'],
  ['textSecondary', 'background'],
  ['textSecondary', 'backgroundElement'],
  ['onAccent', 'accent'],
  ['accent', 'background'],
  ['accent', 'backgroundElement'],
  ['danger', 'background'],
  ['danger', 'backgroundElement'],
];

/** 非テキストの（部品, 地）の組 */
const NON_TEXT_PAIRS = [];

/** `light: { ... }` のようなブロックから `key: '#RRGGBB'` を拾う */
function extractTokens(source, themeName) {
  const blockMatch = source.match(new RegExp(`${themeName}:\\s*\\{([\\s\\S]*?)\\n\\s*\\},`));
  if (!blockMatch) throw new Error(`${path.basename(THEME_PATH)} に ${themeName} ブロックが見つかりません`);
  const tokens = {};
  for (const m of blockMatch[1].matchAll(/(\w+):\s*'(#[0-9A-Fa-f]{6})'/g)) {
    tokens[m[1]] = m[2];
  }
  return tokens;
}

/** WCAG 2.x 相対輝度 */
function luminance(hex) {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function main() {
  const source = fs.readFileSync(THEME_PATH, 'utf8');
  const rows = [];

  for (const themeName of THEMES) {
    const tokens = extractTokens(source, themeName);
    const addPairs = (pairs, threshold) => {
      for (const [fgKey, bgKey] of pairs) {
        const fg = tokens[fgKey];
        const bg = tokens[bgKey];
        if (!fg || !bg) {
          throw new Error(`${themeName}.${fgKey} / ${themeName}.${bgKey} が見つかりません`);
        }
        rows.push({ label: `${themeName}.${fgKey} on ${bgKey}`, fg, bg, ratio: contrast(fg, bg), threshold });
      }
    };
    addPairs(PAIRS, AA_RATIO);
    addPairs(NON_TEXT_PAIRS, NON_TEXT_RATIO);
  }

  const width = Math.max(...rows.map((r) => r.label.length));
  let failed = 0;
  for (const row of rows) {
    const ok = row.ratio >= row.threshold;
    if (!ok) failed += 1;
    console.log(
      `${row.label.padEnd(width)}  ${row.fg} / ${row.bg}  ${row.ratio.toFixed(2)}:1 (>= ${row.threshold}:1)  ${ok ? 'OK' : 'NG'}`
    );
  }
  console.log('');
  if (failed > 0) {
    console.error(`check:contrast NG — ${failed} 組が基準（テキスト ${AA_RATIO}:1・非テキスト ${NON_TEXT_RATIO}:1）を下回っています`);
    process.exit(1);
  }
  console.log(`check:contrast OK — ${rows.length} 組すべて基準以上（テキスト ${AA_RATIO}:1・非テキスト ${NON_TEXT_RATIO}:1）`);
}

main();
