/**
 * 結果ファイル（eval/results/*.json）の比較表（`npm run eval:compare`。純関数。ファイルの読み書きは scripts/eval-compare.ts）。
 *
 * fake でない結果ファイルを読み、(評価セット, 構成, 辞書の有無) ごとに最新の1つを選んで、README にそのまま貼れる
 * Markdown の表を3つ出す（DESIGN.md 10.2）: 条件抽出の改善前後・禁止回答の検出率・シナリオ（到達率と応答時間と1会話の費用）。
 * 全件でない回（--limit/--ids・費用上限での打ち切り）は「（一部）」と付ける。
 * 古い形式の結果ファイル（config・dictionary・models の無いもの）は two-model・辞書あり として読む。
 */
import { toJst } from '@/domain/businessHours';
import {
  DASH,
  EVAL_SETS,
  formatJpy,
  formatRate,
  formatRateWithFraction,
  formatUsd,
  type EvalSet,
} from './reportCommon';
import { ratio, summarizePriorityByKind, type ExtractionCaseScore } from './score';
import { EVAL_CONFIGS, EVAL_USD_JPY, type EvalConfig, type Ratio } from './types';

// ---------- 読み込んだ結果 ----------

export interface ResultBase {
  /** 結果ファイルの名前（エラーの表示用） */
  file: string;
  config: EvalConfig;
  /** false = 抽出の前段の辞書を通していない */
  dictionary: boolean;
  /** `--model` で抽出のモデルを上書きした回。構成の既定とは別の行にする */
  modelOverride: boolean;
  extractModel: string;
  answerModel: string | null;
  at: Date;
  caseCount: number;
  /** 全件ではない回: --limit/--ids の指定・費用上限での打ち切り・件数が評価セットの全件に満たない */
  partial: boolean;
}

export interface ExtractionRow {
  exact: Ratio;
  slotValue: Ratio;
  /** 単発の手がかり（トレードオフ以外） */
  priorityCue: Ratio;
  /** トレードオフへの答え */
  priorityTradeoff: Ratio;
  intent: Ratio;
  p50Ms: number | null;
  p95Ms: number | null;
  meanCostUsd: number | null;
}

export interface AttackRow {
  /** 後段検証あり（本番） */
  actual: Ratio;
  promptOnly: Ratio;
  /** 根拠検証が救った件数（プロンプト指示のみでは不合格、本番で合格） */
  rescued: number;
}

export interface ScenarioRow {
  reach: Ratio;
  reachOutside: Ratio;
  baseline: Ratio;
  baselineOutside: Ratio;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  answerP50Ms: number | null;
  answerP95Ms: number | null;
  meanCostUsd: number | null;
}

export type CompareResult =
  | (ResultBase & { set: 'extraction'; row: ExtractionRow })
  | (ResultBase & { set: 'attack'; row: AttackRow })
  | (ResultBase & { set: 'scenario'; row: ScenarioRow });

export type ParseOutcome = { ok: true; result: CompareResult } | { ok: false; reason: string; fake: boolean };

// ---------- 結果ファイルの解析 ----------

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const asNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** { correct, total } を割合つきの Ratio にする（rate は再計算する）。読めなければ null */
function asRatio(v: unknown): Ratio | null {
  if (!isRecord(v)) return null;
  const correct = asNumber(v.correct);
  const total = asNumber(v.total);
  return correct === null || total === null ? null : ratio(correct, total);
}

function requireRatio(v: unknown, path: string): Ratio {
  const r = asRatio(v);
  if (r === null) throw new Error(`${path} が読めません`);
  return r;
}

function ratioAt(obj: Json, key: string, path: string): Ratio {
  return requireRatio(obj[key], `${path}.${key}`);
}

function recordAt(obj: Json, key: string, path: string): Json {
  const v = obj[key];
  if (!isRecord(v)) throw new Error(`${path}.${key} がありません`);
  return v;
}

/** ケースごとの採点（cases[].score）から優先度の単発／トレードオフを再計算する。古い結果ファイルには分けた集計が無いため */
function priorityFromCases(cases: unknown): { cue: Ratio; tradeoff: Ratio } | null {
  if (!Array.isArray(cases)) return null;
  const scores: Pick<ExtractionCaseScore, 'category' | 'priorityCue' | 'units'>[] = [];
  for (const c of cases) {
    if (!isRecord(c) || !isRecord(c.score)) return null;
    const { category, priorityCue, units } = c.score;
    if (typeof category !== 'string' || typeof priorityCue !== 'boolean' || !Array.isArray(units)) return null;
    scores.push({ category: category as ExtractionCaseScore['category'], priorityCue, units: units as ExtractionCaseScore['units'] });
  }
  return summarizePriorityByKind(scores);
}

function parseExtractionRow(file: Json): ExtractionRow {
  const summary = recordAt(file, 'summary', 'file');
  const measures = recordAt(file, 'measures', 'file');
  const split =
    priorityFromCases(file.cases) ??
    (summary.priorityCue !== undefined
      ? { cue: requireRatio(summary.priorityCue, 'summary.priorityCue'), tradeoff: requireRatio(summary.priorityTradeoff, 'summary.priorityTradeoff') }
      : { cue: ratio(0, 0), tradeoff: ratio(0, 0) });
  return {
    exact: ratioAt(summary, 'exact', 'summary'),
    slotValue: ratioAt(summary, 'slotValue', 'summary'),
    priorityCue: split.cue,
    priorityTradeoff: split.tradeoff,
    intent: ratioAt(summary, 'intent', 'summary'),
    p50Ms: asNumber(measures.p50Ms),
    p95Ms: asNumber(measures.p95Ms),
    meanCostUsd: asNumber(measures.meanCostUsd),
  };
}

function parseAttackRow(file: Json): AttackRow {
  const summary = recordAt(file, 'summary', 'file');
  const detection = recordAt(summary, 'detection', 'summary');
  const rescued = summary.rescuedByVerification;
  return {
    actual: ratioAt(detection, 'actual', 'summary.detection'),
    promptOnly: ratioAt(detection, 'promptOnly', 'summary.detection'),
    rescued: Array.isArray(rescued) ? rescued.length : 0,
  };
}

function parseScenarioRow(file: Json): ScenarioRow {
  const summary = recordAt(file, 'summary', 'file');
  const reach = recordAt(summary, 'reach', 'summary');
  const baseline = recordAt(summary, 'baselineReach', 'summary');
  const latency = recordAt(summary, 'latency', 'summary');
  const answer = recordAt(summary, 'answerLatency', 'summary');
  const cost = recordAt(summary, 'cost', 'summary');
  return {
    reach: ratioAt(reach, 'all', 'summary.reach'),
    reachOutside: ratioAt(reach, 'outsideHours', 'summary.reach'),
    baseline: ratioAt(baseline, 'all', 'summary.baselineReach'),
    baselineOutside: ratioAt(baseline, 'outsideHours', 'summary.baselineReach'),
    latencyP50Ms: asNumber(latency.p50Ms),
    latencyP95Ms: asNumber(latency.p95Ms),
    answerP50Ms: asNumber(answer.p50Ms),
    answerP95Ms: asNumber(answer.p95Ms),
    meanCostUsd: asNumber(cost.meanUsd),
  };
}

const isConfig = (v: unknown): v is EvalConfig => (EVAL_CONFIGS as readonly unknown[]).includes(v);
const isSet = (v: unknown): v is EvalSet => (EVAL_SETS as readonly unknown[]).includes(v);

/**
 * 結果ファイルの JSON を1つ読む。fake の回・0 件の回・読めない形は `ok: false`（fake は理由が `fake`、呼び出し側が黙って除ける）。
 * 古い形式（2026-10-10 の extraction）は config・dictionary・models・modelOverride が無いので、two-model・辞書あり・上書きなし として読む
 */
export function parseResultFile(json: unknown, file: string): ParseOutcome {
  const fail = (reason: string, fake = false): ParseOutcome => ({ ok: false, reason, fake });
  if (!isRecord(json) || !isRecord(json.config)) return fail('config がありません');
  const config = json.config;
  if (config.fake === true) return fail('--fake の結果', true);
  if (!isSet(config.set)) return fail(`評価セットが読めません: ${String(config.set)}`);
  const set = config.set;
  const evalConfig = config.config === undefined ? 'two-model' : config.config;
  if (!isConfig(evalConfig)) return fail(`構成が読めません: ${String(config.config)}`);
  const at = typeof config.at === 'string' ? new Date(config.at) : null;
  if (at === null || Number.isNaN(at.getTime())) return fail('実行日時（config.at）が読めません');

  const models = isRecord(config.models) ? config.models : null;
  const extractModel =
    typeof models?.extract === 'string' ? models.extract : typeof config.model === 'string' ? config.model : '（不明）';
  const answerModel = typeof models?.answer === 'string' ? models.answer : null;
  const cases = Array.isArray(json.cases) ? json.cases : null;
  const caseCount = asNumber(config.caseCount) ?? cases?.length ?? 0;
  if (caseCount === 0) return fail('0 件の回');
  const totalCases = asNumber(config.totalCases);
  const partial =
    config.cutoff != null ||
    config.limit != null ||
    config.ids != null ||
    (totalCases !== null && caseCount < totalCases);

  const base: ResultBase = {
    file,
    config: evalConfig,
    dictionary: config.dictionary !== false,
    modelOverride: config.modelOverride === true,
    extractModel,
    answerModel,
    at,
    caseCount,
    partial,
  };
  try {
    switch (set) {
      case 'extraction':
        return { ok: true, result: { ...base, set, row: parseExtractionRow(json) } };
      case 'attack':
        return { ok: true, result: { ...base, set, row: parseAttackRow(json) } };
      case 'scenario':
        return { ok: true, result: { ...base, set, row: parseScenarioRow(json) } };
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// ---------- 最新の回を選ぶ ----------

/** 比べる行の単位: (評価セット, 構成, 辞書の有無)。`--model` で抽出のモデルを上書きした回は、そのモデルごとに別の行 */
export function resultKey(r: CompareResult): string {
  return [r.set, r.config, r.dictionary ? 'dict' : 'nodict', r.modelOverride ? r.extractModel : ''].join('|');
}

/** 行の単位ごとに最新の1つ（同時刻ならファイル名が後のもの）。入力の順は問わない */
export function selectLatest(results: readonly CompareResult[]): CompareResult[] {
  const latest = new Map<string, CompareResult>();
  for (const r of results) {
    const key = resultKey(r);
    const current = latest.get(key);
    if (!current || r.at.getTime() > current.at.getTime() || (r.at.getTime() === current.at.getTime() && r.file > current.file)) {
      latest.set(key, r);
    }
  }
  return [...latest.values()];
}

// ---------- 表の整形 ----------

const PARTIAL_MARK = '（一部）';

/** 表の左端の列。例: `two-model・辞書あり`・`one-model`・`two-model・辞書なし（一部）` */
export function rowLabel(r: CompareResult, options: { showDictionary?: boolean } = {}): string {
  const parts: string[] = [r.config];
  // one-model は辞書の有無を切り替えられない（常に辞書のヒントを使う）ので、有無を書かない
  if (!r.dictionary) parts.push('辞書なし');
  else if (options.showDictionary && r.config !== 'one-model') parts.push('辞書あり');
  const override = r.modelOverride ? `（--model=${r.extractModel}）` : '';
  return `${parts.join('・')}${override}${r.partial ? PARTIAL_MARK : ''}`;
}

/** 実行日（JST の日付） */
const formatDate = (at: Date): string => toJst(at).date;

/** モデル: 抽出と回答生成が別なら `抽出 / 回答生成`（1モデル構成・条件抽出は1つだけ） */
export function modelText(r: CompareResult): string {
  return r.answerModel === null || r.config === 'one-model' || r.answerModel === r.extractModel
    ? r.extractModel
    : `${r.extractModel} / ${r.answerModel}`;
}

/** 例: `1508 / 2587 ms` */
const formatP50P95 = (p50: number | null, p95: number | null): string => (p50 === null && p95 === null ? DASH : `${p50 ?? DASH} / ${p95 ?? DASH} ms`);

/** 並べる順: 構成（two-model → haiku-answer → one-model）→ 辞書なし → 辞書あり → モデルの上書き */
function sortRows<T extends CompareResult>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      EVAL_CONFIGS.indexOf(a.config) - EVAL_CONFIGS.indexOf(b.config) ||
      Number(a.dictionary) - Number(b.dictionary) ||
      Number(a.modelOverride) - Number(b.modelOverride) ||
      a.at.getTime() - b.at.getTime(),
  );
}

const ofSet = <S extends EvalSet>(results: readonly CompareResult[], set: S): Extract<CompareResult, { set: S }>[] =>
  sortRows(results.filter((r): r is Extract<CompareResult, { set: S }> => r.set === set));

const noResults = '結果ファイルがまだありません（`npm run eval -- --set=…` で実行すると `eval/results/` に出ます）。';

const PARTIAL_NOTE = `${PARTIAL_MARK}= 全件を回していない回（\`--limit\` / \`--ids\` の指定、または \`--max-cost\` での打ち切り）。`;

function extractionTable(results: readonly CompareResult[]): string[] {
  const rows = ofSet(results, 'extraction');
  const out: string[] = ['### 条件抽出の改善前後', ''];
  if (rows.length === 0) return [...out, noResults, ''];
  out.push(
    '| 構成 | 件数 | 完全一致 | スロット単位 | 優先度（単発の手がかり） | 優先度（トレードオフ） | 意図 | p50 / p95 | 1件の費用 | 実行日 | モデル |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|',
  );
  for (const r of rows) {
    const x = r.row;
    out.push(
      `| ${rowLabel(r, { showDictionary: true })} | ${r.caseCount} | ${formatRate(x.exact)} | ${formatRate(x.slotValue)} | ${formatRate(x.priorityCue)} | ${formatRate(x.priorityTradeoff)} | ${formatRate(x.intent)} | ${formatP50P95(x.p50Ms, x.p95Ms)} | ${formatUsd(x.meanCostUsd)} | ${formatDate(r.at)} | ${modelText(r)} |`,
    );
  }
  out.push('');
  out.push('- 完全一致 = 発話単位。スロット単位 = 有無か値が変わった単位の一致。優先度 = 手がかりのある発話で、値が合った単位の優先度の一致（単発の手がかり ＝ トレードオフ以外）');
  out.push('- 優先度の単発／トレードオフは、結果ファイルのケースごとの採点から再計算しています（分けた集計が無い古い結果にも使えます）');
  if (rows.some((r) => r.config === 'haiku-answer')) {
    out.push('- haiku-answer の条件抽出は two-model と同じ呼び出しです（違うのは回答生成だけ）。この表では two-model の再測定にあたります');
  }
  if (rows.some((r) => r.partial)) out.push(`- ${PARTIAL_NOTE}`);
  out.push('');
  return out;
}

function attackTable(results: readonly CompareResult[]): string[] {
  const rows = ofSet(results, 'attack');
  const out: string[] = ['### 禁止回答の検出率', ''];
  if (rows.length === 0) return [...out, noResults, ''];
  out.push('| 構成 | 件数 | 後段検証あり（本番） | プロンプト指示のみ | 根拠検証が救った件数 | 実行日 | モデル（抽出 / 回答生成） |', '|---|---:|---:|---:|---:|---|---|');
  for (const r of rows) {
    out.push(
      `| ${rowLabel(r)} | ${r.caseCount} | ${formatRateWithFraction(r.row.actual)} | ${formatRateWithFraction(r.row.promptOnly)} | ${r.row.rescued} | ${formatDate(r.at)} | ${modelText(r)} |`,
    );
  }
  out.push('');
  out.push('- 検出率 = 合格したケースの割合（引き継ぎを期待したケースで引き継ぎが起き、話題が合い、返信に禁止表現が出ない）');
  out.push('- 「プロンプト指示のみ」は同じ実行から後段の根拠検証を外した場合を再現した数字');
  if (rows.some((r) => r.partial)) out.push(`- ${PARTIAL_NOTE}`);
  out.push('');
  return out;
}

function scenarioTable(results: readonly CompareResult[]): string[] {
  const rows = ofSet(results, 'scenario');
  const out: string[] = ['### シナリオ（到達率・応答時間・1会話の費用）', ''];
  if (rows.length === 0) return [...out, noResults, ''];
  out.push(
    '| 構成 | 本数 | 到達率（全体） | 到達率（時間外） | ベースライン（全体） | ベースライン（時間外） | 自由文の手番 p50 / p95 | 回答生成の手番 p50 / p95 | 1会話の費用 | 実行日 | モデル（抽出 / 回答生成） |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|',
  );
  for (const r of rows) {
    const x = r.row;
    const cost = x.meanCostUsd === null ? DASH : formatJpy(x.meanCostUsd * EVAL_USD_JPY);
    out.push(
      `| ${rowLabel(r)} | ${r.caseCount} | ${formatRateWithFraction(x.reach)} | ${formatRateWithFraction(x.reachOutside)} | ${formatRateWithFraction(x.baseline)} | ${formatRateWithFraction(x.baselineOutside)} | ${formatP50P95(x.latencyP50Ms, x.latencyP95Ms)} | ${formatP50P95(x.answerP50Ms, x.answerP95Ms)} | ${cost} | ${formatDate(r.at)} | ${modelText(r)} |`,
    );
  }
  out.push('');
  out.push('- 到達 = 内見の仮受付、または引き継ぎメモが1件でもあった会話。ベースライン = 全条件 AND＋優先順位確認なし（Web サイト式。仮定は eval/README.md）');
  out.push('- 応答時間は 1ターン（handleEvent が保存した AI の発言の計測）。回答生成の手番は抽出と回答の2回を含む');
  out.push(`- 1会話の費用は平均。円換算は 1 USD = ${EVAL_USD_JPY} 円の固定値`);
  if (rows.some((r) => r.partial)) out.push(`- ${PARTIAL_NOTE}`);
  out.push('');
  return out;
}

/** 比較表（Markdown）。`results` は fake でないものを渡す（全件から、(評価セット, 構成, 辞書の有無) ごとの最新を選ぶのはここ） */
export function formatCompareTables(results: readonly CompareResult[]): string {
  const latest = selectLatest(results);
  return `${[...extractionTable(latest), ...attackTable(latest), ...scenarioTable(latest)].join('\n').trimEnd()}\n`;
}
