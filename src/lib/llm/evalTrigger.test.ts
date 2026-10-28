/**
 * 実 API の評価を PR で自動に回すファイル（.github/workflows/eval.yml の pull_request.paths）が、LLM のコードの import と食い違っていないか。
 * プロンプトに埋め込む定数や、出力の後処理・根拠検証を src/domain の新しいファイルに切り出したときに、評価が回らなくなるのを防ぐ
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LLM_DIR = 'src/lib/llm';

/** eval.yml の pull_request: の paths: の行（否定の '!…' は除く） */
function pullRequestPaths(): string[] {
  const lines = fs.readFileSync(path.join(ROOT, '.github/workflows/eval.yml'), 'utf8').split('\n');
  const start = lines.findIndex((l) => /^ {2}pull_request:/.test(l));
  const paths: string[] = [];
  let inPaths = false;
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line)) break;
    if (/^ {4}paths:/.test(line)) {
      inPaths = true;
      continue;
    }
    const m = /^ {6}- '([^']+)'/.exec(line);
    if (inPaths && m && !m[1].startsWith('!')) paths.push(m[1]);
  }
  return paths;
}

function resolveImport(from: string, spec: string): string | null {
  let target: string;
  if (spec.startsWith('.')) target = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  else if (spec.startsWith('@/')) target = `src/${spec.slice(2)}`;
  else return null;
  for (const candidate of [`${target}.ts`, `${target}/index.ts`, target]) {
    if (fs.existsSync(path.join(ROOT, candidate)) && candidate.endsWith('.ts')) return candidate;
  }
  return null;
}

/** src/lib/llm の本番のファイルから import をたどって届く src/domain と src/server のファイル */
function reachableFromLlm(): string[] {
  const queue = fs
    .readdirSync(path.join(ROOT, LLM_DIR))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'fixtures.ts')
    .map((f) => `${LLM_DIR}/${f}`);
  const seen = new Set<string>();
  const found = new Set<string>();
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const m of text.matchAll(/^(?:import|export)\s[^;]*?from\s+'([^']+)'/gm)) {
      const target = resolveImport(file, m[1]);
      if (!target) continue;
      if (target.startsWith('src/domain/')) {
        found.add(target);
        queue.push(target);
      } else if (target.startsWith('src/server/')) {
        found.add(target);
      } else if (target.startsWith(`${LLM_DIR}/`)) {
        queue.push(target);
      }
    }
  }
  return [...found].sort();
}

function covered(file: string, patterns: string[]): boolean {
  return patterns.some((p) => p === file || (p.endsWith('/**') && file.startsWith(p.slice(0, -2))));
}

describe('eval.yml の pull_request.paths', () => {
  const patterns = pullRequestPaths();

  it('読めている（LLM のコードと評価そのものを含む）', () => {
    expect(patterns).toEqual(expect.arrayContaining(['src/lib/llm/**', 'eval/**', 'data/**', '.github/workflows/eval.yml']));
  });

  it('LLM のコードが import する src/domain・src/server のファイルをすべて含む', () => {
    const reachable = reachableFromLlm();
    expect(reachable).toContain('src/domain/verify.ts');
    expect(reachable.filter((file) => !covered(file, patterns))).toEqual([]);
  });

  it('抽出器・回答器を組み立てる deps.ts と、LLM に渡す入力を組み立てる handleEvent.ts を含む', () => {
    expect(covered('src/server/deps.ts', patterns)).toBe(true);
    expect(covered('src/server/handleEvent.ts', patterns)).toBe(true);
  });

  it('書いてあるファイルは実在する（名前を変えたら直す）', () => {
    const missing = patterns.filter((p) => !p.includes('*') && !fs.existsSync(path.join(ROOT, p)));
    expect(missing).toEqual([]);
  });
});
