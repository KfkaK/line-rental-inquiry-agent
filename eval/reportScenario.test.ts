/**
 * シナリオのレポート・結果ファイル・進捗の純関数のテスト。実 API と会話の実行は使わず、手で組み立てた手番を採点して並べる。
 */
import { describe, expect, it } from 'vitest';
import type { HandoffNote } from '@/domain/types';
import type { ViewingRequestListItem } from '@/lib/db';
import { MODEL_FAST, MODEL_SMART } from '@/lib/llm/models';
import type { HarnessTurn } from './harness';
import type { RunMeta } from './reportCommon';
import {
  buildScenarioResultFile,
  countScenarioErrors,
  describeInput,
  formatScenarioProgress,
  formatScenarioReport,
  scoreScenarioRun,
  summarizeScenarioRuns,
  totalScenarioCostUsd,
  type ScenarioCaseRun,
  type ScenarioReportInput,
} from './reportScenario';
import type { ScenarioRun } from './scenario';
import type { AnswerOutput } from '@/server/handleEvent';
import type { ScenarioCase, ScenarioStep } from './types';

// ---------- 道具 ----------

const AT = new Date('2026-10-15T21:30:00+09:00');

function makeMeta(overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    set: 'scenario',
    config: 'two-model',
    dictionary: true,
    models: { extract: MODEL_FAST, answer: MODEL_SMART },
    modelOverride: false,
    fake: false,
    limit: null,
    ids: null,
    totalCases: 3,
    maxCostUsd: 2,
    cutoff: null,
    at: AT,
    ...overrides,
  };
}

function makeTurn(partial: Partial<HarnessTurn> = {}): HarnessTurn {
  return {
    input: { kind: 'text', text: 'x' },
    texts: [],
    cardIds: [],
    quickReplies: [],
    state: 'hearing',
    slots: { tags: [] },
    shownPropertyIds: [],
    handoffAdded: [],
    viewingCreated: [],
    extraction: null,
    answers: [],
    latencyMs: null,
    costUsd: null,
    mustTotal: null,
    andTotal: null,
    error: null,
    ...partial,
  };
}

const note: HandoffNote = { text: '空いてますか', topic: 'vacancy', propertyIds: ['P0001'], at: '2026-10-15T12:30:00.000Z' };
const viewing = { id: 'v1', conversationId: 'c1', propertyId: 'P0001', candidateTimes: ['2026-10-17T14:00'] } as ViewingRequestListItem;
const answer: AnswerOutput = { text: '記載どおりです', handoff: null, verification: 'ok', latencyMs: 1500, costUsd: 0.005 };

const step = (input: ScenarioStep['input'], expect?: ScenarioStep['expect']): ScenarioStep => ({ input, ...(expect ? { expect } : {}) });

function makeScenario(partial: Partial<ScenarioCase>): ScenarioCase {
  return { id: 'sc-xx', title: 'テスト用', start: '2026-10-16T13:30:00+09:00', steps: [], expectedReach: 'viewing', ...partial };
}

// sc-01: 営業時間内（金曜 13:30）。1手番目で全条件 AND が 0 件（優先順位つきは 7 件）→ 内見まで到達（ベースラインは行き止まり）
const s1 = makeScenario({
  id: 'sc-01',
  title: '緩和して内見',
  steps: [step({ kind: 'text', text: '渋谷で8万以内、静かな部屋' }, { state: 'presenting' }), step({ kind: 'card', button: 'detail', position: 1 }), step({ kind: 'tapIndex', index: 0 }, { viewing: true })],
});
const run1: ScenarioRun = {
  scenario: s1,
  pipeline: 'two-model',
  aborted: null,
  turns: [
    makeTurn({ state: 'presenting', mustTotal: 7, andTotal: 0, latencyMs: 2000, costUsd: 0.01, answers: [answer] }),
    makeTurn({ input: { kind: 'postback', data: 'd', label: '詳細' }, latencyMs: 500, costUsd: 0 }),
    makeTurn({ input: { kind: 'postback', data: 'v', label: '内見' }, viewingCreated: [viewing], latencyMs: 800, costUsd: 0 }),
  ],
};

// sc-02: 営業時間外（木曜 21:30）。提示物件への質問で引き継ぎまで到達
const s2 = makeScenario({
  id: 'sc-02',
  title: '質問で引き継ぎ',
  start: '2026-10-15T21:30:00+09:00',
  expectedReach: 'handoff',
  steps: [step({ kind: 'text', text: '渋谷で8万以内' }), step({ kind: 'text', text: '1番目、空いてる？' }, { handoff: true })],
});
const run2: ScenarioRun = {
  scenario: s2,
  pipeline: 'two-model',
  aborted: null,
  turns: [
    makeTurn({ state: 'presenting', mustTotal: 3, andTotal: 3, latencyMs: 1000, costUsd: 0.004 }),
    makeTurn({ state: 'qa', handoffAdded: [note], latencyMs: 3000, costUsd: 0.02, answers: [answer] }),
  ],
};

// sc-03: 営業時間外。1手番目で例外・期待と違う状態、2手番目のボタンが見つからず台本を止めた → 到達なし（内見を期待）
const s3 = makeScenario({
  id: 'sc-03',
  title: 'API 障害で止まる',
  start: '2026-10-17T20:40:00+09:00',
  note: '障害で止まったときの扱い',
  steps: [step({ kind: 'text', text: '渋谷で8万以内' }, { state: 'presenting' }), step({ kind: 'tap', label: '候補日' }), step({ kind: 'follow' }), step({ kind: 'follow' }), step({ kind: 'follow' })],
});
const run3: ScenarioRun = {
  scenario: s3,
  pipeline: 'two-model',
  aborted: { step: 1, reason: 'クイックリプライ「候補日」が見つかりません' },
  turns: [makeTurn({ error: 'handleEvent: boom' })],
};

const runs: ScenarioCaseRun[] = [run1, run2, run3].map((r) => scoreScenarioRun(r, r === run1 ? ['[answer] 根拠検証の不一致'] : []));
const summary = summarizeScenarioRuns(runs);
const base: ScenarioReportInput = { ...makeMeta(), runs, summary };
const report = formatScenarioReport(base);
const lines = report.split('\n');

// ---------- 集計・進捗 ----------

describe('summarizeScenarioRuns・費用・エラー', () => {
  it('到達率（全体・時間内・時間外）とベースライン', () => {
    expect(summary.scenarios).toBe(3);
    expect(summary.reach.all).toEqual({ correct: 2, total: 3, rate: 2 / 3 });
    expect(summary.reach.inHours).toEqual({ correct: 1, total: 1, rate: 1 });
    expect(summary.reach.outsideHours).toEqual({ correct: 1, total: 2, rate: 0.5 });
    // sc-01 は手番 1 で全条件 AND が 0 件 → ベースラインは行き止まり
    expect(summary.baselineReach.all).toEqual({ correct: 1, total: 3, rate: 1 / 3 });
    expect(summary.baselineReach.inHours).toEqual({ correct: 0, total: 1, rate: 0 });
  });

  it('1会話の費用の合計と、例外を投げた手番のあるシナリオの数', () => {
    expect(totalScenarioCostUsd(runs)).toBeCloseTo(0.034, 10);
    expect(countScenarioErrors(runs)).toBe(1);
  });
});

describe('formatScenarioProgress', () => {
  it('ok（合格）・ng（不合格）・error（例外）に、手番の合格数と費用', () => {
    expect(formatScenarioProgress(1, 15, runs[0])).toBe('[1/15] sc-01 ok 3/3手番 $0.0100');
    expect(formatScenarioProgress(2, 15, runs[1])).toBe('[2/15] sc-02 ok 2/2手番 $0.0240');
    expect(formatScenarioProgress(3, 15, runs[2])).toBe('[3/15] sc-03 error 0/5手番 $0.0000');
  });

  it('合格でも例外でもなければ ng', () => {
    const bad = scoreScenarioRun({ ...run1, turns: [makeTurn({ state: 'hearing' }), ...run1.turns.slice(1)] }, []);
    expect(formatScenarioProgress(1, 15, bad)).toBe('[1/15] sc-01 ng 2/3手番 $0.0000');
  });
});

describe('describeInput', () => {
  it('台本の入力を読める形に', () => {
    expect(describeInput({ kind: 'follow' })).toBe('友だち追加');
    expect(describeInput({ kind: 'text', text: '渋谷で8万' })).toBe('「渋谷で8万」');
    expect(describeInput({ kind: 'tap', label: '候補日' })).toBe('ボタン「候補日」');
    expect(describeInput({ kind: 'tapIndex', index: 1 })).toBe('2 番目のボタン');
    expect(describeInput({ kind: 'card', button: 'viewing', position: 3 })).toBe('3 番目のカードの内見ボタン');
    expect(describeInput({ kind: 'card', button: 'detail', position: 1 })).toBe('1 番目のカードの詳細ボタン');
  });

  it('長い発話は切る', () => {
    expect(describeInput({ kind: 'text', text: 'あ'.repeat(60) })).toBe(`「${'あ'.repeat(40)}…」`);
  });
});

// ---------- レポート ----------

describe('formatScenarioReport', () => {
  it('Markdown の見出しがそろい、末尾は改行1つ', () => {
    expect(lines[0]).toBe('# シナリオの評価レポート');
    expect(lines.filter((l) => l.startsWith('## '))).toEqual([
      '## 設定',
      '## 到達率（主要指標）',
      '## 期待との一致',
      '## 応答時間と費用',
      '## 全条件 AND では 0 件、優先順位つきでは N 件の例',
      '## シナリオ一覧',
      '## 不合格のシナリオ（1 本）',
    ]);
    expect(report.endsWith('\n')).toBe(true);
    expect(report.endsWith('\n\n')).toBe(false);
  });

  it('設定: 評価セット・構成・モデル・本数・日時', () => {
    expect(lines).toContain('- 評価セット: scenario（シナリオ・到達率と応答時間と費用）');
    expect(lines).toContain('- 構成: two-model');
    expect(lines).toContain('- モデル: 抽出 claude-haiku-4-5・回答生成 claude-sonnet-5-5');
    expect(lines).toContain('- 本数: 3');
    expect(lines).toContain('- 日時: 2026-10-15 21:30 JST');
  });

  it('到達率の表: 全体・営業時間内・営業時間外を、この構成とベースラインで並べる', () => {
    expect(lines).toContain('| 構成 | 全体 | 営業時間内 | 営業時間外 |');
    expect(lines).toContain('| two-model（優先順位つき） | 66.7%（2/3） | 100.0%（1/1） | 50.0%（1/2） |');
    expect(lines).toContain('| ベースライン（全条件 AND＋優先順位確認なし） | 33.3%（1/3） | 0.0%（0/1） | 50.0%（1/2） |');
    expect(report).toContain('ベースラインの仮定');
  });

  it('期待との一致: 到達の種類・手番の合格率・シナリオの合格率', () => {
    expect(lines).toContain('- 到達の種類が台本の期待どおり: 66.7%（2/3）');
    expect(lines).toContain('- 手番の合格率（全シナリオの手番の合計）: 50.0%（5/10）');
    expect(lines).toContain('- シナリオの合格率（打ち切りなし・全手番合格・到達が期待どおり）: 66.7%（2/3）');
  });

  it('応答時間: 自由文の手番と回答生成の手番の p50/p95。費用は USD と円（EVAL_USD_JPY を明記）', () => {
    expect(lines).toContain('| 対象 | 手番数 | p50 | p95 |');
    expect(lines).toContain('| 自由文の手番 | 3 | 2000 ms | 3000 ms |');
    expect(lines).toContain('| 回答生成を呼んだ手番（抽出も含む） | 2 | 2000 ms | 3000 ms |');
    expect(lines).toContain('- 1会話の費用: 平均 $0.0113（1.7 円）・最大 $0.0240（3.6 円）・合計 $0.0340');
    expect(report).toContain('1 USD = 150 円の固定値（`EVAL_USD_JPY`）');
  });

  it('全条件 AND では 0 件の例', () => {
    expect(lines).toContain('- sc-01「緩和して内見」手番 1: 全条件 AND では 0 件 → 優先順位つきでは 7 件');
  });

  it('該当が無ければ「該当する手番はありませんでした」', () => {
    const only = [runs[1]];
    const text = formatScenarioReport({ ...base, runs: only, summary: summarizeScenarioRuns(only) });
    expect(text).toContain('該当する手番はありませんでした。');
  });

  it('シナリオ一覧: 開始時刻（時間外の印）・期待／実際／ベースラインの到達・手番・結果・費用', () => {
    expect(lines).toContain('| id | タイトル | 開始（JST） | 期待 | 実際 | ベースライン | 手番 | 結果 | 費用 |');
    expect(lines).toContain('| sc-01 | 緩和して内見 | 2026-10-16 13:30 | viewing | viewing | none | 3/3 | 合格 | $0.0100 |');
    expect(lines).toContain('| sc-02 | 質問で引き継ぎ | 2026-10-15 21:30（時間外） | handoff | handoff | handoff | 2/2 | 合格 | $0.0240 |');
    expect(lines).toContain('| sc-03 | API 障害で止まる | 2026-10-17 20:40（時間外） | viewing | none | none | 0/5 | 例外 | $0.0000 |');
  });

  it('不合格のシナリオ: 到達の違い・不合格の手番の問題・台本を止めた手番・台本の狙い。合格したものは出さない', () => {
    expect(lines).toContain('### sc-03 API 障害で止まる');
    expect(lines).toContain('- 到達: 期待 viewing（内見の仮受付） → 実際 none（到達なし）');
    expect(lines).toContain('- 手番 1（「渋谷で8万以内」）: 例外: handleEvent: boom / 状態: 期待 presenting / 実際 hearing');
    expect(lines).toContain('- 手番 2（ボタン「候補日」）: 打ち切り: クイックリプライ「候補日」が見つかりません');
    expect(lines).toContain('- 手番 2 以降の 4 手番は実行していません（台本の途中で止めた）');
    expect(lines).toContain('- 台本の狙い: 障害で止まったときの扱い');
    expect(report).not.toContain('### sc-01');
    expect(report).not.toContain('### sc-02');
  });

  it('すべて合格なら「すべて合格しました」', () => {
    const only = [runs[0], runs[1]];
    const text = formatScenarioReport({ ...base, runs: only, summary: summarizeScenarioRuns(only) });
    expect(text).toContain('## 不合格のシナリオ（0 本）');
    expect(text).toContain('すべて合格しました。');
    expect(text).not.toContain('### ');
  });

  it('シナリオが 0 本でも整形できる', () => {
    const text = formatScenarioReport({ ...base, runs: [], summary: summarizeScenarioRuns([]) });
    expect(text).toContain('評価するシナリオがありません');
    expect(text).toContain('| two-model（優先順位つき） | — | — | — |');
    expect(text).toContain('| 自由文の手番 | 0 | — | — |');
    expect(text).toContain('- 1会話の費用: 平均 —・最大 —・合計 —');
    expect(text).not.toContain('すべて合格しました');
  });

  it('費用の上限で打ち切った回は、設定に「本」で打ち切りを出す', () => {
    const text = formatScenarioReport({
      ...base,
      ...makeMeta({ totalCases: 15, cutoff: { reason: 'maxCost', spentUsd: 0.0123, maxCostUsd: 0.01, completed: 3, planned: 15 } }),
    });
    expect(text).toContain('- 本数: 3（全 15 本のうち）');
    expect(text).toContain('- **打ち切り**: 費用が上限 $0.01（--max-cost）に達したため、15 本のうち 3 本で止めました（累計 $0.0123）');
  });
});

// ---------- 結果の JSON ----------

describe('buildScenarioResultFile', () => {
  const file = JSON.parse(JSON.stringify(buildScenarioResultFile(base))) as {
    config: Record<string, unknown>;
    summary: { scenarios: number };
    totalCostUsd: number;
    errors: number;
    cases: Record<string, unknown>[];
  };

  it('設定・集計・合計費用・エラー件数を持つ', () => {
    expect(file.config).toMatchObject({ set: 'scenario', config: 'two-model', caseCount: 3, totalCases: 3, cutoff: null, usdJpy: 150 });
    expect(file.summary.scenarios).toBe(3);
    expect(file.totalCostUsd).toBeCloseTo(0.034, 10);
    expect(file.errors).toBe(1);
  });

  it('シナリオごとに、台本の概要・採点・手番の記録・計測・ログ・エラーを残す', () => {
    expect(file.cases).toHaveLength(3);
    expect(Object.keys(file.cases[0]).sort()).toEqual(
      ['aborted', 'costUsd', 'error', 'expectedReach', 'id', 'logs', 'score', 'start', 'title', 'turns'].sort(),
    );
    expect(file.cases[0]).toMatchObject({ id: 'sc-01', expectedReach: 'viewing', logs: ['[answer] 根拠検証の不一致'], error: null });
    const turns = file.cases[0].turns as { viewingCreated: { id: string }[]; answers: unknown[]; mustTotal: number | null }[];
    expect(turns).toHaveLength(3);
    expect(turns[0]).toMatchObject({ mustTotal: 7 });
    expect(turns[2].viewingCreated).toEqual([{ id: 'v1', propertyId: 'P0001', candidateTimes: ['2026-10-17T14:00'] }]);
    expect(file.cases[2]).toMatchObject({ id: 'sc-03', error: 'handleEvent: boom', aborted: { step: 1 } });
  });
});
