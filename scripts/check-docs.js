// docs の壊れ方を CI で止める（npm run check:docs。意思決定ログ20）。CLAUDE.md の「お願い」のうち機械で確かめられるもの:
//  1. 意思決定ログの番号: 行頭の「N. 」が 1 から重複・欠番なしで並ぶ（並行セッションが同じ番号を振る事故が起きていた）
//  2. 見出しの重複: 「## 」見出しが同じファイルの中で重ならない（置換の事故で本文が3重に複製されたことがある）
//  3. 文字コードと改行: 追跡している .md が UTF-8・BOM なし・LF。改行は index の内容で見る（Windows の作業ツリーが CRLF でも誤検知しない）
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const DECISION_LOG = 'docs/意思決定ログ.md';
const errors = [];

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// コードブロック（``` / ~~~）の外の行だけを返す
function linesOutsideFences(text) {
  const out = [];
  let fence = null;
  for (const line of text.split('\n')) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (!fence) fence = m[1][0];
      else if (m[1][0] === fence) fence = null;
      continue;
    }
    if (!fence) out.push(line.replace(/\r$/, ''));
  }
  return out;
}

// -z で NUL 区切りにする（日本語のファイル名を引用符でエスケープさせない）。
// マージの衝突中は同じファイルが段階ごとに複数回出るので、重複を除く
const mdFiles = [...new Set(git(['ls-files', '-z', '--', '*.md']).split('\0').filter(Boolean))];
const decoder = new TextDecoder('utf-8', { fatal: true });

for (const file of mdFiles) {
  const abs = path.join(root, file);
  if (!fs.existsSync(abs)) continue; // 作業ツリーで消したばかりのファイル
  const bytes = fs.readFileSync(abs);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) errors.push(`${file}: 先頭に BOM がある（UTF-8・BOM なしで保存し直す）`);
  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    errors.push(`${file}: UTF-8 として読めない（UTF-8 で保存し直す）`);
    continue;
  }
  const counts = new Map();
  for (const line of linesOutsideFences(text)) {
    const m = /^## (.+?)\s*$/.exec(line);
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  for (const [heading, n] of counts) {
    if (n > 1) errors.push(`${file}: 見出し「## ${heading}」が ${n} 回ある（置換で本文が複製されていないか確かめる）`);
  }
}

// 改行: git ls-files --eol の「i/crlf」「i/mixed」は index に CRLF が入っている
for (const entry of git(['ls-files', '-z', '--eol', '--', '*.md']).split('\0').filter(Boolean)) {
  const [info, file] = entry.split('\t');
  const indexEol = info.trim().split(/\s+/)[0];
  if (indexEol === 'i/crlf' || indexEol === 'i/mixed') errors.push(`${file}: 改行に CRLF が入っている（LF にする）`);
}

// 意思決定ログの番号
const logPath = path.join(root, DECISION_LOG);
let entries = 0;
if (fs.existsSync(logPath)) {
  const numbers = linesOutsideFences(fs.readFileSync(logPath, 'utf8'))
    .map((line) => /^(\d+)\. /.exec(line))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  entries = numbers.length;
  const seen = new Map();
  for (const n of numbers) seen.set(n, (seen.get(n) ?? 0) + 1);
  for (const [n, c] of seen) {
    if (c > 1) errors.push(`${DECISION_LOG}: 番号 ${n} が ${c} 回ある（並行セッションの衝突。後から足した方を末尾の次の番号に振り直し、参照も直す）`);
  }
  const at = numbers.findIndex((n, i) => n !== i + 1);
  if (at >= 0) errors.push(`${DECISION_LOG}: ${at + 1} 件目の番号が ${numbers[at]}（1 から欠番なしで並べる。git fetch して origin/main の最大＋1 を振る）`);
}

const problems = [...new Set(errors)];
if (problems.length) {
  console.error(`check-docs: ${problems.length} 件の問題`);
  for (const e of problems) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`check-docs: OK（.md ${mdFiles.length} 本・意思決定ログ ${entries} 件）`);
