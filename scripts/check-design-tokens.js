#!/usr/bin/env node
/**
 * 見た目の決まり（docs/visual-design.md の YAML の `colors`）が、色の正本（src/constants/theme.ts）の写しになっていることを検査する。
 * design.md の色は写しで、値を変えるのは theme.ts だけ（不変条件 13）。写しがずれると、design.md を読んで作った画面が古い色を使う。
 *
 * 対応: theme.ts の light の `backgroundElement` → design.md の `background-element`、dark は頭に `dark-` を付ける。
 * `primary` は design.md の書式が求める名前で、light の `accent` と同じ値でなければならない。
 * 値が違う・片方にしか無い色があれば終了コード 1。使い方: `npm run check:design-tokens`（`npm run check` と CI に含む）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const THEME_PATH = path.join(ROOT, 'src', 'constants', 'theme.ts');
const DESIGN_PATH = path.join(ROOT, 'docs', 'visual-design.md');
const THEMES = { light: '', dark: 'dark-' };
/** design.md にだけある別名 → 同じ値でなければならない theme.ts のトークン */
const ALIASES = { primary: 'accent' };

/** `light: { ... }` のようなブロックから `key: '#RRGGBB'` を拾う（check-contrast.js と同じ読み方） */
function themeTokens(source, themeName) {
  const block = source.match(new RegExp(`${themeName}:\\s*\\{([\\s\\S]*?)\\n\\s*\\},`));
  if (!block) throw new Error(`theme.ts に ${themeName} ブロックが見つかりません`);
  const tokens = {};
  for (const m of block[1].matchAll(/(\w+):\s*'(#[0-9A-Fa-f]{6})'/g)) tokens[m[1]] = m[2];
  return tokens;
}

/** YAML の前付け（先頭の `---` から次の `---` まで）の `colors:` の下の `  name: "#RRGGBB"` を拾う */
function designColors(source) {
  const front = source.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n/);
  if (!front) throw new Error('visual-design.md の先頭に YAML の前付け（---）がありません');
  const lines = front[1].split('\n');
  const start = lines.findIndex((l) => /^colors:\s*$/.test(l));
  if (start < 0) throw new Error('visual-design.md の前付けに colors: がありません');
  const colors = {};
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // 次の最上位のキー
    if (/^\s*(#.*)?$/.test(line)) continue; // 空行とコメント
    const m = line.match(/^\s+([\w-]+):\s*["']?([^"'\s]+)["']?(\s+#.*)?\s*$/);
    if (!m) throw new Error(`visual-design.md の colors の行が読めません: ${line.trim()}`);
    colors[m[1]] = m[2];
  }
  return colors;
}

const kebab = (key) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function main() {
  const themeSource = fs.readFileSync(THEME_PATH, 'utf8');
  const design = designColors(fs.readFileSync(DESIGN_PATH, 'utf8'));

  /** design.md での名前 → theme.ts での出どころと値 */
  const expected = {};
  for (const [themeName, prefix] of Object.entries(THEMES)) {
    for (const [key, value] of Object.entries(themeTokens(themeSource, themeName))) {
      expected[`${prefix}${kebab(key)}`] = { from: `${themeName}.${key}`, value };
    }
  }
  for (const [alias, key] of Object.entries(ALIASES)) {
    expected[alias] = { ...expected[key], from: `${expected[key].from}（${alias} は ${key} の別名）` };
  }

  const problems = [];
  for (const [name, { from, value }] of Object.entries(expected)) {
    if (!(name in design)) problems.push(`${name}: design.md に無い（theme.ts の ${from} = ${value}）`);
    else if (design[name].toUpperCase() !== value.toUpperCase()) {
      problems.push(`${name}: design.md は ${design[name]}、theme.ts の ${from} は ${value}`);
    }
  }
  for (const name of Object.keys(design)) {
    if (!(name in expected)) problems.push(`${name}: theme.ts に無い色が design.md にある（色を足すときは theme.ts の light と dark に足す）`);
  }

  if (problems.length > 0) {
    console.error('check:design-tokens NG — docs/visual-design.md の colors が src/constants/theme.ts の写しになっていません');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('theme.ts が正本です。theme.ts を変えたなら design.md の colors を合わせて直してください');
    process.exit(1);
  }
  console.log(`check:design-tokens OK — ${Object.keys(expected).length} 色が theme.ts と一致`);
}

main();
