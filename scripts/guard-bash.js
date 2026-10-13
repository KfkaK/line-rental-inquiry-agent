// Claude Code の PreToolUse フック（Bash / PowerShell）。.claude/settings.json から呼ばれる。
// CLAUDE.md の「お願い」のうち、破ると取り返しがつかない2つをハーネス側で止める（意思決定ログ20）:
//  1. このリポジトリの main への push（作業ブランチ → PR の約束。権限モードに関係なく止める）
//  2. 実キーの入った .env ファイルをコマンドで読む（Read / Grep ツールは settings.json の deny で止める）
// 止めるときは exit 2 で理由を stderr に書く（Claude に返る）。入力が読めないなどスクリプト側の不具合では通す（作業を止めない）
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROTECTED_BRANCH = 'main';
const projectRoot = path.resolve(__dirname, '..');

function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

// GitHub の URL から owner/repo を取り出す（https・ssh・認証情報つきのどれでも）
function repoSlug(url) {
  const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(url ?? '');
  return m ? m[1].toLowerCase() : null;
}

// コマンドを `&&` `||` `;` `|` `&` 改行で区切り、区間ごとの語の配列にする。引用符の中は区切らない
function segments(command) {
  const segs = [];
  let words = [];
  let cur = '';
  let quoted = false;
  let quote = null;
  const flushWord = () => {
    if (quoted || cur) words.push(cur);
    cur = '';
    quoted = false;
  };
  const flushSeg = () => {
    flushWord();
    if (words.length) segs.push(words);
    words = [];
  };
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
    } else if (ch === ';' || ch === '|' || ch === '&' || ch === '\n') {
      flushSeg();
    } else if (/\s/.test(ch)) {
      flushWord();
    } else {
      cur += ch;
    }
  }
  flushSeg();
  return segs;
}

function isGit(word) {
  const base = word.replace(/^[({]+/, '').split(/[\\/]/).pop().toLowerCase();
  return base === 'git' || base === 'git.exe';
}

// 値を取る push のオプション（`--opt value` の形のとき次の語を読み飛ばす）
const PUSH_OPTS_WITH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);

function pushTargetsMain(words, cwd) {
  const g = words.findIndex(isGit);
  if (g < 0) return false;
  let dir = cwd;
  let i = g + 1;
  // git 自体のオプション（-C <dir> / -c <k=v> など）
  while (i < words.length && words[i].startsWith('-')) {
    if (words[i] === '-C') {
      dir = path.resolve(cwd, words[i + 1] ?? '.');
      i += 2;
    } else if (words[i] === '-c') {
      i += 2;
    } else {
      i += 1;
    }
  }
  if (words[i] !== 'push') return false;

  const positional = [];
  let all = false;
  for (let j = i + 1; j < words.length; j++) {
    const w = words[j];
    if (w === '--all' || w === '--mirror') all = true;
    else if (PUSH_OPTS_WITH_VALUE.has(w)) j += 1;
    else if (!w.startsWith('-')) positional.push(w);
  }
  const [remote = 'origin', ...refspecs] = positional;

  // push 先がこのリポジトリか（別リポジトリ・別 URL への push は止めない）
  const isUrl = /:\/\/|^[^/\\]+@[^/\\]+:/.test(remote);
  const targetSlug = repoSlug(isUrl ? remote : git(dir, ['remote', 'get-url', remote]));
  const projectSlug = repoSlug(git(projectRoot, ['remote', 'get-url', 'origin']));
  if (targetSlug && projectSlug && targetSlug !== projectSlug) return false;

  if (all) return true;
  const current = () => git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (refspecs.length === 0) return current() === PROTECTED_BRANCH;
  return refspecs.some((spec) => {
    const s = spec.replace(/^\+/, '');
    let dst = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s;
    if (dst === 'HEAD' || dst === '@') dst = current();
    return (dst ?? '').replace(/^refs\/heads\//, '') === PROTECTED_BRANCH;
  });
}

// .env / .env.local / .env.production.local などを名指しするコマンド（.env.example は通す）
const ENV_FILE = /(?:^|[\s"'`=:;|&<>(/\\])(\.env[\w.*-]*)(?=$|[^\w.*-])/g;

function envFileIn(command) {
  for (const m of command.matchAll(ENV_FILE)) {
    if (!m[1].endsWith('.example')) return m[1];
  }
  return null;
}

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  const command = input?.tool_input?.command;
  if (typeof command !== 'string') return;
  const cwd = input.cwd || process.cwd();

  const envFile = envFileIn(command);
  if (envFile) {
    process.stderr.write(
      `${envFile} は実キーが入ったファイルなので、コマンドで読んだり名指ししたりしない（.claude/settings.json のフックで止めている）。` +
        '変数名が知りたいときは .env.example を読む。キーを使う処理は npm スクリプト経由で回す（スクリプトの内部で読むので通る）。' +
        '中身の確認や書き換えが必要なら、ユーザーに頼む。\n',
    );
    process.exit(2);
  }
  if (segments(command).some((words) => pushTargetsMain(words, cwd))) {
    process.stderr.write(
      `${PROTECTED_BRANCH} への直接の push は止めている（CLAUDE.md の約束を .claude/settings.json のフックで強制）。` +
        '作業ブランチに push して PR を作る。どうしても必要なときはユーザーに頼む。\n',
    );
    process.exit(2);
  }
}

main();
