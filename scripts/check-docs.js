// docs の壊れ方を CI で止める（npm run check:docs。意思決定ログ20）。CLAUDE.md の「お願い」のうち機械で確かめられるもの:
//  1. 意思決定ログの番号: 行頭の「N. 」が 1 から重複・欠番なしで並ぶ（並行セッションが同じ番号を振る事故が起きていた）
//  2. 見出しの重複: 「## 」見出しが同じファイルの中で重ならない（置換の事故で本文が3重に複製されたことがある）
//  3. 文字コードと改行: 追跡している .md が UTF-8・BOM なし・LF。改行は index の内容で見る（Windows の作業ツリーが CRLF でも誤検知しない）
//  4. 引き継ぎ書の大きさ: 「いま」だけを置く（終わった項目と経緯が溜まり、LifeOwner で 300KB になった。2026-10-26 に上限を決めた）
//     章ごとと全体の上限・2/6/7章の1行の長さ・6/7章に ✅・[x]・取り消し線を残さない（終わったら消す。経緯は意思決定ログ）
//  5. 意思決定ログの1件の大きさ: LOG_ENTRY_FROM 番以降の項目が上限を超えない（既存の項目には掛けない）
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const DECISION_LOG = 'docs/意思決定ログ.md';
const HANDOFF = 'docs/引き継ぎ書.md';
const KB = 1024;
const HANDOFF_LIMIT = 50 * KB;
// lines: 1行の長さを見る / marks: 終わった印（✅・[x]・取り消し線）を落とす
const SECTION_LIMITS = [
  { name: 'ユーザーの次の一手', re: /^## ユーザーの次の一手/, limit: 4 * KB, lines: false, marks: false },
  { name: '2章（現在地）', re: /^## 2\. /, limit: 6 * KB, lines: true, marks: false },
  { name: '6章（次にやること）', re: /^## 6\. /, limit: 15 * KB, lines: true, marks: true },
  { name: '7章（判断待ち）', re: /^## 7\. /, limit: 6 * KB, lines: true, marks: true },
];
const LINE_LIMIT = 600; // バイト。日本語で約200字。詳しくは意思決定ログの番号で指す
const DONE_MARK = /✅|\[[xX]\]|~~/;
const LOG_ENTRY_LIMIT = 3 * KB;
const LOG_ENTRY_FROM = 38; // 入れた時点（意思決定ログ38）の項目から見る。それより前の項目には掛けない
const errors = [];
const byteLen = (s) => Buffer.byteLength(s, 'utf8');

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

// 引き継ぎ書の大きさ
const handoffPath = path.join(root, HANDOFF);
let handoffSize = null;
if (fs.existsSync(handoffPath)) {
  const text = fs.readFileSync(handoffPath, 'utf8').replace(/\r\n/g, '\n');
  handoffSize = byteLen(text);
  if (handoffSize > HANDOFF_LIMIT) {
    errors.push(`${HANDOFF}: 全体が ${(handoffSize / KB).toFixed(1)}KB（上限 ${HANDOFF_LIMIT / KB}KB）。終わった項目を消し、経緯は意思決定ログの番号で指す`);
  }
  let current = null;
  let size = 0;
  let fence = null;
  const finish = () => {
    if (current && size > current.limit) {
      errors.push(`${HANDOFF}: ${current.name}が ${(size / KB).toFixed(1)}KB（上限 ${current.limit / KB}KB）。いま開いているものだけにする`);
    }
  };
  text.split('\n').forEach((line, i) => {
    if (!fence && /^## /.test(line)) {
      finish();
      current = SECTION_LIMITS.find((s) => s.re.test(line)) ?? null;
      size = 0;
    }
    if (current) size += byteLen(line) + 1;
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (!fence) fence = m[1][0];
      else if (m[1][0] === fence) fence = null;
      return;
    }
    if (!current || fence) return;
    const where = `${HANDOFF}:${i + 1}`;
    if (current.lines && byteLen(line) > LINE_LIMIT) {
      errors.push(`${where}: ${current.name}の1行が ${byteLen(line)} バイト（上限 ${LINE_LIMIT}。結論とログ番号だけにする）`);
    }
    if (current.marks && DONE_MARK.test(line)) {
      errors.push(`${where}: ${current.name}に終わった印（✅・[x]・取り消し線）がある（終わった項目は消す。経緯は意思決定ログ）`);
    }
  });
  finish();
}

// 意思決定ログの番号と1件の大きさ
const logPath = path.join(root, DECISION_LOG);
let entries = 0;
if (fs.existsSync(logPath)) {
  const lines = linesOutsideFences(fs.readFileSync(logPath, 'utf8'));
  const numbers = lines
    .map((line) => /^(\d+)\. /.exec(line))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  entries = numbers.length;
  // 1件は「N. 」の行から、次の「N. 」か「## 」見出しの手前まで
  let entry = null;
  const flush = () => {
    if (entry && entry.n >= LOG_ENTRY_FROM && entry.size > LOG_ENTRY_LIMIT) {
      errors.push(`${DECISION_LOG}: ${entry.n} 番が ${(entry.size / KB).toFixed(1)}KB（上限 ${LOG_ENTRY_LIMIT / KB}KB。決めたこと・理由・反映先に絞る）`);
    }
  };
  for (const line of lines) {
    const m = /^(\d+)\. /.exec(line);
    if (m || /^## /.test(line)) {
      flush();
      entry = m ? { n: Number(m[1]), size: 0 } : null;
    }
    if (entry) entry.size += byteLen(line) + 1;
  }
  flush();
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
const handoffNote = handoffSize === null ? '' : `・引き継ぎ書 ${(handoffSize / KB).toFixed(1)}KB／${HANDOFF_LIMIT / KB}KB`;
console.log(`check-docs: OK（.md ${mdFiles.length} 本・意思決定ログ ${entries} 件${handoffNote}）`);
