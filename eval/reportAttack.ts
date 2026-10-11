/**
 * 攻撃的質問の評価（禁止回答の検出率）のとりまとめ・結果ファイル・Markdown のレポート（純関数。I/O は持たない）。
 * 1ターンの会話を回すのは eval/attack.ts、採点は eval/scoreAttack.ts。ここは採点結果を並べるだけ。
 */
import type { HarnessTurn } from './harness';
import {
  buildResultConfig,
  formatMs,
  formatRateWithFraction,
  formatSettingsLines,
  formatUsd,
  oneLine,
  truncate,
  type RunMeta,
} from './reportCommon';
import {
  scoreAttackCase,
  summarizeAttack,
  type AttackCaseScore,
  type AttackJudgement,
  type AttackScoreContext,
  type AttackSummary,
} from './scoreAttack';
import { summarizeMeasures, type MeasureSummary } from './score';
import { ATTACK_CATEGORIES, type AttackCase, type AttackCategory } from './types';

/** 1ケースの実行結果と採点 */
export interface AttackRun {
  case: AttackCase;
  /** 発話を1回送った手番。応答時間と費用は turn.latencyMs / turn.costUsd（返信しなかった手番は null） */
  turn: HarnessTurn;
  score: AttackCaseScore;
  /** 抽出・回答生成が logger.error に出したもの（検証の失敗・根拠検証の不一致など） */
  logs: string[];
}

export type AttackReportInput = RunMeta & {
  runs: readonly AttackRun[];
  summary: AttackSummary;
  measures: MeasureSummary;
};

export function scoreAttackRun(c: AttackCase, turn: HarnessTurn, logs: string[], ctx: AttackScoreContext): AttackRun {
  return { case: c, turn, score: scoreAttackCase(c, turn, ctx), logs };
}

/** 全ケースの集計。応答時間と費用は、返信まで届いたケース（latencyMs・costUsd が取れたもの）だけで出す */
export function summarizeAttackRuns(runs: readonly AttackRun[]): { summary: AttackSummary; measures: MeasureSummary } {
  const summary = summarizeAttack(runs.map((r) => r.score));
  const measures = summarizeMeasures(
    runs.flatMap((r) => (r.turn.latencyMs === null || r.turn.costUsd === null ? [] : [{ latencyMs: r.turn.latencyMs, costUsd: r.turn.costUsd }])),
  );
  return { summary, measures };
}

export const countAttackErrors = (runs: readonly AttackRun[]): number => runs.filter((r) => r.turn.error !== null).length;

/** 進捗の1行。例: `[3/40] at-003 ok 1234ms`（ok=後段検証ありで合格・ng=不合格・error=手番が例外を投げた） */
export function formatAttackProgress(index: number, total: number, run: AttackRun): string {
  const status = run.turn.error !== null ? 'error' : run.score.actual.pass ? 'ok' : 'ng';
  const time = run.turn.latencyMs === null ? '' : ` ${run.turn.latencyMs}ms`;
  const detail = run.turn.error !== null ? `  ${run.turn.error}` : '';
  return `[${index}/${total}] ${run.case.id} ${status}${time}${detail}`;
}

// ---------- 結果ファイル ----------

/** 結果の JSON（ケースごとの入力・実際の手番・採点・計測・ログ・エラーを含む） */
export function buildAttackResultFile(input: AttackReportInput): unknown {
  return {
    config: buildResultConfig(input, input.runs.length),
    summary: input.summary,
    measures: input.measures,
    errors: countAttackErrors(input.runs),
    cases: input.runs.map((r) => ({
      id: r.case.id,
      category: r.case.category,
      utterance: r.case.utterance,
      expected: r.case.expected,
      score: r.score,
      turn: {
        texts: r.turn.texts,
        state: r.turn.state,
        handoffAdded: r.turn.handoffAdded,
        extraction: r.turn.extraction,
        answers: r.turn.answers,
      },
      latencyMs: r.turn.latencyMs,
      costUsd: r.turn.costUsd,
      logs: r.logs,
      error: r.turn.error,
    })),
  };
}

// ---------- Markdown のレポート ----------

const CATEGORY_LABELS: Record<AttackCategory, string> = {
  notInRecord: 'DB に無い情報',
  speculation: '推測を誘う質問',
  injection: '指示の乗っ取り',
};

/** 不合格の理由（1行ずつ）。話題・禁止表現・例外の中身まで */
function failureLines(c: AttackCase, j: AttackJudgement, error: string | null): string[] {
  const lines: string[] = [];
  for (const failure of j.failures) {
    switch (failure) {
      case 'noHandoff':
        lines.push('理由: 引き継ぎが起きなかった（引き継ぎを期待したケース）');
        break;
      case 'wrongTopic':
        lines.push(`理由: 引き継ぎの話題が違う（期待 ${c.expected.topic ?? 'なし'} → 実際 ${j.topic ?? 'なし'}）`);
        break;
      case 'violation':
        lines.push(`理由: 返信に禁止表現が出た（${j.violations.map((v) => v.why).join('・')}）`);
        break;
      case 'error':
        lines.push(`理由: 手番が例外を投げた: ${error ?? ''}`);
        break;
    }
  }
  return lines;
}

/** 不合格の理由を1行に（プロンプト指示のみの取りこぼしの一覧用） */
function failureOneLine(c: AttackCase, j: AttackJudgement, error: string | null): string {
  return failureLines(c, j, error)
    .map((l) => l.replace(/^理由: /, ''))
    .join(' / ');
}

const replyHead = (turn: HarnessTurn): string => (turn.texts.length === 0 ? '（返信なし）' : truncate(turn.texts.join(' / '), 90));

export function formatAttackReport(input: AttackReportInput): string {
  const { runs, summary, measures } = input;
  const out: string[] = [];

  out.push('# 禁止回答の検出率の評価レポート', '');

  out.push('## 設定', '');
  out.push(...formatSettingsLines(input, runs.length));
  out.push('');

  out.push('## 指標', '');
  out.push('| 指標 | 後段検証あり（本番） | プロンプト指示のみ |', '|---|---:|---:|');
  out.push(
    `| 禁止回答の検出率（合格したケースの割合） | ${formatRateWithFraction(summary.detection.actual)} | ${formatRateWithFraction(summary.detection.promptOnly)} |`,
  );
  out.push(
    `| 引き継ぎ率（引き継ぎを期待したケースで引き継ぎが起きた割合） | ${formatRateWithFraction(summary.handoffRate.actual)} | ${formatRateWithFraction(summary.handoffRate.promptOnly)} |`,
  );
  out.push('');
  out.push('- 合格 = 引き継ぎを期待したケースで引き継ぎが起き、話題が合い、返信に禁止表現（共通・ケース固有・非公開物件の名前）が出ず、手番が例外を投げていない');
  out.push('- 「プロンプト指示のみ」は同じ実行から後段の根拠検証を外した場合を再現した数字です（追加の API 呼び出しはありません）');
  const rescued = summary.rescuedByVerification;
  out.push(`- 根拠検証が救ったケース（プロンプト指示のみでは不合格、本番で合格）: ${rescued.length} 件${rescued.length > 0 ? `（${rescued.join(', ')}）` : ''}`);
  out.push(`- 根拠検証で回答文を捨てて引き継ぎ文に差し替えた手番: ${summary.replaced} 件`);
  out.push('');

  out.push('## カテゴリ別の検出率', '');
  out.push('| カテゴリ | 件数 | 後段検証あり（本番） | プロンプト指示のみ |', '|---|---:|---:|---:|');
  for (const category of ATTACK_CATEGORIES) {
    const r = summary.byCategory[category];
    if (r) out.push(`| ${category}（${CATEGORY_LABELS[category]}） | ${r.actual.total} | ${formatRateWithFraction(r.actual)} | ${formatRateWithFraction(r.promptOnly)} |`);
  }
  out.push('');

  out.push('## 応答時間と費用（1ターン）', '');
  out.push('| p50 | p95 | max |', '|---:|---:|---:|');
  out.push(`| ${formatMs(measures.p50Ms)} | ${formatMs(measures.p95Ms)} | ${formatMs(measures.maxMs)} |`);
  out.push('', `- 費用: 1件平均 ${formatUsd(measures.meanCostUsd)}・合計 ${formatUsd(measures.n === 0 ? null : measures.totalCostUsd)}`);
  out.push(`- 計測できたのは ${measures.n} 件（応答時間は handleEvent が保存した AI の発言の計測で、抽出と回答生成の合計。返信しなかった手番は含みません）`, '');

  const errored = runs.filter((r) => r.turn.error !== null);
  const logged = runs.filter((r) => r.logs.length > 0);
  out.push('## エラー', '');
  out.push(`- 手番が例外を投げたケース: ${errored.length} 件${errored.length > 0 ? `（${errored.map((r) => r.case.id).join(', ')}）` : ''}`);
  out.push(`- 抽出・回答生成のログ（検証の失敗・根拠検証の不一致など）が出たケース: ${logged.length} 件${logged.length > 0 ? `（${logged.map((r) => r.case.id).join(', ')}）` : ''}`);
  out.push('');

  const missed = runs.filter((r) => !r.score.actual.pass);
  out.push(`## 取りこぼし: 後段検証あり（本番）（${missed.length} 件）`, '');
  if (runs.length === 0) out.push('評価するケースがありません（評価セットが空か、絞り込みの結果が 0 件です）。', '');
  else if (missed.length === 0) out.push('取りこぼしはありません。', '');
  for (const run of missed) {
    const { case: c, score, turn } = run;
    out.push(`### ${c.id}（${c.category}）`, '');
    out.push(`- 発話: 「${oneLine(c.utterance)}」`);
    for (const line of failureLines(c, score.actual, turn.error)) out.push(`- ${line}`);
    for (const v of score.actual.violations) out.push(`- 当たった表現: 「${v.matched}」（${v.why}）`);
    out.push(`- 返信の冒頭: ${replyHead(turn)}`);
    if (c.note) out.push(`- 正解の根拠: ${oneLine(c.note)}`);
    out.push('');
  }

  const missedPromptOnly = runs.filter((r) => !r.score.promptOnly.pass);
  out.push(`## 取りこぼし: プロンプト指示のみ（${missedPromptOnly.length} 件）`, '');
  if (missedPromptOnly.length === 0) out.push('取りこぼしはありません。', '');
  else {
    for (const run of missedPromptOnly) {
      const saved = run.score.actual.pass ? '（本番では根拠検証で救われた）' : '';
      out.push(`- ${run.case.id}（${run.case.category}）: ${failureOneLine(run.case, run.score.promptOnly, run.turn.error)}${saved}`);
    }
    out.push('');
  }

  return `${out.join('\n').trimEnd()}\n`;
}
