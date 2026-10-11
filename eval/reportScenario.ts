/**
 * シナリオの評価（到達率・応答時間・1会話の費用）のとりまとめ・結果ファイル・Markdown のレポート（純関数。I/O は持たない）。
 * 台本を回すのは eval/scenario.ts、採点は eval/scoreScenario.ts。ここは採点結果を並べるだけ。
 */
import {
  buildResultConfig,
  formatJst,
  formatMs,
  formatRateWithFraction,
  formatSettingsLines,
  formatUsd,
  formatUsdJpy,
  truncate,
  turnRecord,
  type RunMeta,
} from './reportCommon';
import type { ScenarioRun } from './scenario';
import {
  scoreScenario,
  summarizeScenarios,
  type LatencySummary,
  type ReachRates,
  type ScenarioScore,
  type ScenarioSummary,
} from './scoreScenario';
import { EVAL_USD_JPY, type Ratio, type Reach, type ScenarioInput } from './types';

/** 1シナリオの実行結果と採点 */
export interface ScenarioCaseRun {
  run: ScenarioRun;
  score: ScenarioScore;
  /** 抽出・回答生成が logger.error に出したもの（検証の失敗・根拠検証の不一致など） */
  logs: string[];
}

export type ScenarioReportInput = RunMeta & {
  runs: readonly ScenarioCaseRun[];
  summary: ScenarioSummary;
};

export function scoreScenarioRun(run: ScenarioRun, logs: string[]): ScenarioCaseRun {
  return { run, score: scoreScenario(run), logs };
}

export function summarizeScenarioRuns(runs: readonly ScenarioCaseRun[]): ScenarioSummary {
  return summarizeScenarios(runs.map((r) => r.score));
}

/** 手番が例外を投げた（API の障害など）シナリオ */
export const hasTurnError = (r: ScenarioCaseRun): boolean => r.run.turns.some((t) => t.error !== null);
export const countScenarioErrors = (runs: readonly ScenarioCaseRun[]): number => runs.filter(hasTurnError).length;
export const totalScenarioCostUsd = (runs: readonly ScenarioCaseRun[]): number => runs.reduce((sum, r) => sum + r.score.costUsd, 0);

/** 進捗の1行。例: `[2/15] sc-02 ok 7/7手番 $0.0123`（ok=合格・ng=不合格・error=手番が例外を投げた） */
export function formatScenarioProgress(index: number, total: number, r: ScenarioCaseRun): string {
  const status = hasTurnError(r) ? 'error' : r.score.passed ? 'ok' : 'ng';
  return `[${index}/${total}] ${r.score.id} ${status} ${r.score.steps.correct}/${r.score.steps.total}手番 ${formatUsd(r.score.costUsd)}`;
}

// ---------- 結果ファイル ----------

/** 結果の JSON（シナリオごとの台本の概要・手番の記録・採点・計測・ログ・エラーを含む） */
export function buildScenarioResultFile(input: ScenarioReportInput): unknown {
  return {
    config: buildResultConfig(input, input.runs.length),
    summary: input.summary,
    totalCostUsd: totalScenarioCostUsd(input.runs),
    errors: countScenarioErrors(input.runs),
    cases: input.runs.map((r) => ({
      id: r.score.id,
      title: r.score.title,
      start: r.run.scenario.start,
      expectedReach: r.run.scenario.expectedReach,
      score: r.score,
      aborted: r.run.aborted,
      turns: r.run.turns.map(turnRecord),
      costUsd: r.score.costUsd,
      logs: r.logs,
      error: hasTurnError(r) ? r.run.turns.flatMap((t) => (t.error === null ? [] : [t.error])).join(' / ') : null,
    })),
  };
}

// ---------- Markdown のレポート ----------

const REACH_LABELS: Record<Reach, string> = {
  viewing: 'viewing（内見の仮受付）',
  handoff: 'handoff（引き継ぎ）',
  none: 'none（到達なし）',
};

/** 台本の手番の入力を読める形に */
export function describeInput(input: ScenarioInput): string {
  switch (input.kind) {
    case 'follow':
      return '友だち追加';
    case 'text':
      return `「${truncate(input.text, 40)}」`;
    case 'tap':
      return `ボタン「${input.label}」`;
    case 'tapIndex':
      return `${input.index + 1} 番目のボタン`;
    case 'card':
      return `${input.position} 番目のカードの${input.button === 'detail' ? '詳細' : '内見'}ボタン`;
  }
}

const reachRow = (label: string, r: ReachRates): string =>
  `| ${label} | ${formatRateWithFraction(r.all)} | ${formatRateWithFraction(r.inHours)} | ${formatRateWithFraction(r.outsideHours)} |`;

const latencyRow = (label: string, l: LatencySummary): string => `| ${label} | ${l.n} | ${formatMs(l.p50Ms)} | ${formatMs(l.p95Ms)} |`;

const ratioLine = (label: string, r: Ratio): string => `- ${label}: ${formatRateWithFraction(r)}`;

export function formatScenarioReport(input: ScenarioReportInput): string {
  const { runs, summary } = input;
  const out: string[] = [];

  out.push('# シナリオの評価レポート', '');

  out.push('## 設定', '');
  out.push(...formatSettingsLines(input, runs.length, '本'));
  out.push('');

  out.push('## 到達率（主要指標）', '');
  out.push('| 構成 | 全体 | 営業時間内 | 営業時間外 |', '|---|---:|---:|---:|');
  out.push(reachRow(`${input.config}（優先順位つき）`, summary.reach));
  out.push(reachRow('ベースライン（全条件 AND＋優先順位確認なし）', summary.baselineReach));
  out.push('');
  out.push('- 到達 = 内見の仮受付、または引き継ぎメモが1件でもあった会話。目標は全体 60% 以上・時間外 70% 以上（DESIGN.md 7章）');
  out.push(
    '- ベースラインの仮定: Web サイト式の検索は 0 件の画面で緩和の提案を出さず、利用者は条件を直せないまま離れる（全条件 AND の件数が 0 になった手番で行き止まり）。実際の利用者が言い直して先へ進む可能性は見ない模擬で、実ログから測った数字ではありません',
  );
  out.push('');

  out.push('## 期待との一致', '');
  out.push(ratioLine('到達の種類が台本の期待どおり', summary.reachMatch));
  out.push(ratioLine('手番の合格率（全シナリオの手番の合計）', summary.steps));
  out.push(ratioLine('シナリオの合格率（打ち切りなし・全手番合格・到達が期待どおり）', summary.passed));
  out.push('');

  out.push('## 応答時間と費用', '');
  out.push('| 対象 | 手番数 | p50 | p95 |', '|---|---:|---:|---:|');
  out.push(latencyRow('自由文の手番', summary.latency));
  out.push(latencyRow('回答生成を呼んだ手番（抽出も含む）', summary.answerLatency));
  out.push('');
  out.push(
    `- 1会話の費用: 平均 ${formatUsdJpy(summary.cost.meanUsd)}・最大 ${formatUsdJpy(summary.cost.maxUsd)}・合計 ${formatUsd(runs.length === 0 ? null : totalScenarioCostUsd(runs))}`,
  );
  out.push(`- 円換算は 1 USD = ${EVAL_USD_JPY} 円の固定値（\`EVAL_USD_JPY\`）。応答時間は handleEvent が保存した AI の発言の計測で、返信しなかった手番は含みません`);
  out.push('');

  out.push('## 全条件 AND では 0 件、優先順位つきでは N 件の例', '');
  if (summary.andZeroExamples.length === 0) out.push('該当する手番はありませんでした。', '');
  else {
    const titles = new Map(runs.map((r) => [r.score.id, r.score.title]));
    for (const e of summary.andZeroExamples) {
      out.push(`- ${e.id}「${titles.get(e.id) ?? ''}」手番 ${e.step + 1}: 全条件 AND では 0 件 → 優先順位つきでは ${e.mustTotal} 件`);
    }
    out.push('');
  }

  out.push('## シナリオ一覧', '');
  if (runs.length === 0) out.push('評価するシナリオがありません（評価セットが空か、絞り込みの結果が 0 本です）。', '');
  else {
    out.push('| id | タイトル | 開始（JST） | 期待 | 実際 | ベースライン | 手番 | 結果 | 費用 |', '|---|---|---|---|---|---|---:|---|---:|');
    for (const r of runs) {
      const s = r.score;
      const start = `${formatJst(new Date(r.run.scenario.start))}${s.startedOutsideHours ? '（時間外）' : ''}`;
      const result = hasTurnError(r) ? '例外' : s.passed ? '合格' : '不合格';
      out.push(
        `| ${s.id} | ${s.title} | ${start} | ${s.expectedReach} | ${s.reach} | ${s.baselineReach} | ${s.steps.correct}/${s.steps.total} | ${result} | ${formatUsd(s.costUsd)} |`,
      );
    }
    out.push('');
  }

  const failed = runs.filter((r) => !r.score.passed);
  out.push(`## 不合格のシナリオ（${failed.length} 本）`, '');
  if (runs.length > 0 && failed.length === 0) out.push('すべて合格しました。', '');
  for (const r of failed) {
    const { score, run } = r;
    out.push(`### ${score.id} ${score.title}`, '');
    if (!score.reachOk) out.push(`- 到達: 期待 ${REACH_LABELS[score.expectedReach]} → 実際 ${REACH_LABELS[score.reach]}`);
    for (const f of score.failures) {
      const input = run.scenario.steps[f.step]?.input;
      const what = input ? describeInput(input) : '';
      out.push(`- 手番 ${f.step + 1}${what ? `（${what}）` : ''}: ${f.problems.join(' / ')}`);
    }
    if (run.aborted) {
      const skipped = run.scenario.steps.length - run.aborted.step;
      out.push(`- 手番 ${run.aborted.step + 1} 以降の ${skipped} 手番は実行していません（台本の途中で止めた）`);
    }
    if (r.logs.length > 0) out.push(`- 抽出・回答生成のログ: ${r.logs.length} 件（結果ファイルに全文）`);
    if (run.scenario.note) out.push(`- 台本の狙い: ${truncate(run.scenario.note, 120)}`);
    out.push('');
  }

  return `${out.join('\n').trimEnd()}\n`;
}
