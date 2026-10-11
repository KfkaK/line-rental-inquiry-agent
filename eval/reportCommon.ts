/**
 * 3つの評価セット（条件抽出・攻撃的質問・シナリオ）のレポートと結果ファイルが共有する部分:
 * 数字の整形・実行の設定（RunMeta）・「設定」節・結果ファイルの `config`・ファイル名・手番の記録。
 * 純関数だけで、I/O（ファイル・API・標準出力）は持たない。
 */
import { toJst } from '@/domain/businessHours';
import type { HarnessTurn } from './harness';
import { EVAL_USD_JPY, type EvalConfig, type Ratio } from './types';

// ---------- 評価セット ----------

export const EVAL_SETS = ['extraction', 'attack', 'scenario'] as const;
export type EvalSet = (typeof EVAL_SETS)[number];

export const SET_LABELS: Record<EvalSet, string> = {
  extraction: '条件抽出・単発発話',
  attack: '攻撃的質問・禁止回答の検出率',
  scenario: 'シナリオ・到達率と応答時間と費用',
};

// ---------- 数字の整形 ----------

export const DASH = '—';

/** 割合は % で小数1桁。母数 0 は — */
export function formatRate(r: Ratio): string {
  return r.rate === null ? DASH : `${(r.rate * 100).toFixed(1)}%`;
}

/** 正解数/母数。母数 0 は — */
export function formatFraction(r: Ratio): string {
  return r.total === 0 ? DASH : `${r.correct}/${r.total}`;
}

/** 割合と正解数/母数。例: `93.3%（14/15）`。母数 0 は — */
export function formatRateWithFraction(r: Ratio): string {
  return r.total === 0 ? DASH : `${formatRate(r)}（${r.correct}/${r.total}）`;
}

export const formatMs = (ms: number | null): string => (ms === null ? DASH : `${ms} ms`);
export const formatUsd = (usd: number | null): string => (usd === null ? DASH : `$${usd.toFixed(4)}`);
/** 円は小数1桁（1会話が数円なので、整数では差が見えない） */
export const formatJpy = (jpy: number | null): string => (jpy === null ? DASH : `${jpy.toFixed(1)} 円`);
/** USD と円を並べる。例: `$0.0123（1.8 円）` */
export const formatUsdJpy = (usd: number | null): string => (usd === null ? DASH : `${formatUsd(usd)}（${formatJpy(usd * EVAL_USD_JPY)}）`);

export const oneLine = (text: string): string => text.replace(/\s*\n\s*/g, ' ');

/** 長い文を max 文字で切って … を付ける（改行は空白にする） */
export function truncate(text: string, max: number): string {
  const flat = oneLine(text).trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

// ---------- 日時・ファイル名 ----------

/** JST の 'YYYY-MM-DD HH:mm' */
export function formatJst(at: Date): string {
  const { date, time } = toJst(at);
  return `${date} ${time}`;
}

/**
 * 結果の JSON のファイル名。`<set>-<config>[-nodict][-fake]-<YYYYMMDD-HHmm>.json`（日時は JST）。
 * 例: `attack-two-model-20261015-2130.json` / `extraction-haiku-answer-nodict-fake-20261015-2130.json`
 */
export function resultFileName(
  set: string,
  config: string,
  at: Date,
  options: { fake?: boolean; dictionary?: boolean } = {},
): string {
  const { date, time } = toJst(at);
  const stamp = `${date.replaceAll('-', '')}-${time.replace(':', '')}`;
  const safeConfig = config.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${set}-${safeConfig}${options.dictionary === false ? '-nodict' : ''}${options.fake ? '-fake' : ''}-${stamp}.json`;
}

// ---------- 実行の設定 ----------

/** 費用の上限（--max-cost）に達して、評価セットの途中で止めたこと */
export interface Cutoff {
  reason: 'maxCost';
  /** 止めた時点の累計の費用（USD。複数の評価セットを回したときは、それまでの評価セットの分も含む） */
  spentUsd: number;
  maxCostUsd: number;
  /** 回し終えたケース（シナリオ）の数 */
  completed: number;
  /** 回すはずだったケース（シナリオ）の数（--limit/--ids で絞ったあと） */
  planned: number;
}

/** 1つの評価セットの実行の設定（3つのレポートと結果ファイルで共通） */
export interface RunMeta {
  set: EvalSet;
  config: EvalConfig;
  /** false = 抽出の前段の辞書を通していない */
  dictionary: boolean;
  /** 構成のモデル。extraction では回答生成は呼ばないので answer は null */
  models: { extract: string; answer: string | null };
  /** `--model` で抽出のモデルを上書きした */
  modelOverride: boolean;
  /**
   * system プロンプトの版（eval/pipelines.ts の promptVersions）。条件抽出では answer は null。
   * プロンプトを直す前後の回を比較表で別の行にする（DESIGN.md 10.2「プロンプト調整」）。省略は不明（古い結果）
   */
  prompts?: { extract: string; answer: string | null };
  fake: boolean;
  limit: number | null;
  ids: readonly string[] | null;
  /** 評価セットの全件数（--limit/--ids で絞る前）。件数が全件に満たない回を「一部」と判定するのに使う */
  totalCases: number;
  maxCostUsd: number;
  cutoff: Cutoff | null;
  at: Date;
}

export function describeCutoff(cutoff: Cutoff, unit = '件'): string {
  return `費用が上限 $${cutoff.maxCostUsd}（--max-cost）に達したため、${cutoff.planned} ${unit}のうち ${cutoff.completed} ${unit}で止めました（累計 $${cutoff.spentUsd.toFixed(4)}）`;
}

/** 「設定」節の本文（箇条書きの行）。`count` は回したケース（シナリオ）の数 */
export function formatSettingsLines(meta: RunMeta, count: number, unit = '件'): string[] {
  const out: string[] = [];
  out.push(`- 評価セット: ${meta.set}（${SET_LABELS[meta.set]}）`);
  out.push(`- 構成: ${meta.config}${meta.config === 'one-model' ? '（Sonnet の1回の呼び出しで抽出と回答を兼ねる）' : ''}`);
  const { extract, answer } = meta.models;
  // 条件抽出は回答生成を呼ばず、1モデル構成は抽出と回答を1回で兼ねるので、モデルは1つだけ書く
  if (answer === null || meta.config === 'one-model') out.push(`- モデル: ${extract}`);
  else out.push(`- モデル: 抽出 ${extract}・回答生成 ${answer}`);
  if (meta.modelOverride) out.push('- `--model` で抽出のモデルを上書きしています');
  if (!meta.dictionary) out.push('- 辞書: なし（`--no-dictionary`: 抽出の前段の辞書を通していません）');
  const partial = count < meta.totalCases;
  out.push(`- ${unit === '件' ? '件数' : '本数'}: ${count}${partial ? `（全 ${meta.totalCases} ${unit}のうち）` : ''}`);
  out.push(`- 日時: ${formatJst(meta.at)} JST`);
  out.push(`- 費用の上限: $${meta.maxCostUsd}（--max-cost。累計がこの額に達したら、次のケースを始めずに打ち切る）`);
  if (meta.cutoff) out.push(`- **打ち切り**: ${describeCutoff(meta.cutoff, unit)}`);
  if (meta.fake) out.push('- `--fake`: 実 API は呼んでいません（流れの確認用。数字に意味はありません）');
  return out;
}

// ---------- 結果ファイル ----------

/** 結果の JSON の `config`。eval:compare（eval/compare.ts）が読む。古い形式（config・dictionary・models の無いもの）は two-model・辞書あり として読む */
export interface ResultConfig {
  set: EvalSet;
  config: EvalConfig;
  dictionary: boolean;
  models: { extract: string; answer: string | null };
  /** 抽出のモデル（古い形式の `config.model` と同じ。互換のために残す） */
  model: string;
  modelOverride: boolean;
  prompts: { extract: string; answer: string | null } | null;
  fake: boolean;
  limit: number | null;
  ids: string[] | null;
  caseCount: number;
  totalCases: number;
  maxCostUsd: number;
  cutoff: Cutoff | null;
  usdJpy: number;
  at: string;
  atJst: string;
}

export function buildResultConfig(meta: RunMeta, caseCount: number): ResultConfig {
  return {
    set: meta.set,
    config: meta.config,
    dictionary: meta.dictionary,
    models: meta.models,
    model: meta.models.extract,
    modelOverride: meta.modelOverride,
    prompts: meta.prompts ?? null,
    fake: meta.fake,
    limit: meta.limit,
    ids: meta.ids === null ? null : [...meta.ids],
    caseCount,
    totalCases: meta.totalCases,
    maxCostUsd: meta.maxCostUsd,
    cutoff: meta.cutoff,
    usdJpy: EVAL_USD_JPY,
    at: meta.at.toISOString(),
    atJst: formatJst(meta.at),
  };
}

/** 結果ファイルに残す手番の記録（会話の状態・返信・引き継ぎ・抽出と回答の出力・計測）。HarnessTurn のうち再現と調査に要る分 */
export function turnRecord(turn: HarnessTurn): Record<string, unknown> {
  return {
    input: turn.input,
    texts: turn.texts,
    cardIds: turn.cardIds,
    quickReplies: turn.quickReplies.map((q) => q.label),
    state: turn.state,
    handoffAdded: turn.handoffAdded,
    viewingCreated: turn.viewingCreated.map((v) => ({ id: v.id, propertyId: v.propertyId, candidateTimes: v.candidateTimes })),
    extraction: turn.extraction,
    answers: turn.answers,
    latencyMs: turn.latencyMs,
    costUsd: turn.costUsd,
    mustTotal: turn.mustTotal,
    andTotal: turn.andTotal,
    error: turn.error,
  };
}
