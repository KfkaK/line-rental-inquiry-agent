/**
 * 評価ランナー（scripts/eval.ts）の純関数: 引数の解析・ケースの絞り込み・条件抽出の採点のとりまとめとレポート。
 * I/O（ファイル・API・標準出力）は持たない。使い方と指標の定義は eval/README.md。
 * 攻撃的質問のレポートは eval/reportAttack.ts、シナリオは eval/reportScenario.ts、共通の整形は eval/reportCommon.ts。
 */
import type { ExtractionResult, Property } from '@/domain/types';
import {
  EVAL_SETS,
  buildResultConfig,
  formatFraction,
  formatJst,
  formatMs,
  formatRate,
  formatSettingsLines,
  formatUsd,
  oneLine,
  resultFileName,
  type EvalSet,
  type RunMeta,
} from './reportCommon';
import {
  scoreExtractionCase,
  summarizeExtraction,
  summarizeMeasures,
  type ExtractionCaseScore,
  type ExtractionSummary,
  type MeasureSummary,
  type SlotUnit,
  type SlotUnitResult,
} from './score';
import { EVAL_CONFIGS, EXTRACTION_CATEGORIES, type EvalConfig, type ExtractionCase, type ExtractionCategory, type Ratio } from './types';

// 共通の整形は reportCommon.ts にある。テストと呼び出し側が './report' から読めるよう、よく使うものを再エクスポートする
export { EVAL_SETS, formatFraction, formatJst, formatRate, resultFileName, type EvalSet };

// ---------- 引数 ----------

/** --set に書けるもの。all は3つの評価セットを順に回す */
export const EVAL_SET_ARGS = [...EVAL_SETS, 'all'] as const;
export type EvalSetArg = (typeof EVAL_SET_ARGS)[number];

/** 引数の set が回す評価セット（all は3つを extraction → attack → scenario の順に） */
export const setsOf = (set: EvalSetArg): readonly EvalSet[] => (set === 'all' ? EVAL_SETS : [set]);

export const DEFAULT_OUT_DIR = 'eval/results';
/** --max-cost の既定（USD）。累計の費用がこの額に達したら、次のケースを始めずに打ち切る */
export const DEFAULT_MAX_COST_USD = 2;
export const DEFAULT_CONFIG: EvalConfig = 'two-model';

export interface EvalArgs {
  set: EvalSetArg;
  config: EvalConfig;
  /** false で抽出の前段の辞書を通さない（--no-dictionary。two-model と haiku-answer だけ） */
  dictionary: boolean;
  /** 条件抽出のモデルの上書き（--model。--set=extraction のときだけ）。null なら構成の既定 */
  model: string | null;
  /** 先頭から N 件だけ回す。null なら全件 */
  limit: number | null;
  /** 指定した id のケースだけ（その順）。null なら全件 */
  ids: string[] | null;
  /** 実 API を使わず、偽物のクライアントで流れだけ確かめる */
  fake: boolean;
  /** 累計の費用（USD）の上限。--set=all では3つの評価セットを通した累計 */
  maxCostUsd: number;
  /** 結果の JSON を書くディレクトリ */
  out: string;
}

export const EVAL_USAGE = [
  '使い方: npm run eval -- [オプション]',
  `  --set=<名前>         評価セット: ${EVAL_SET_ARGS.join(' / ')}（省略時 extraction。all は3つを順に）`,
  `  --config=<名前>      比べる構成: ${EVAL_CONFIGS.join(' / ')}（省略時 ${DEFAULT_CONFIG}）`,
  '  --no-dictionary      抽出の前段の辞書を通さない（two-model と haiku-answer だけ）',
  '  --model=<id>         条件抽出のモデルの上書き（--set=extraction のときだけ。省略時は構成の既定）',
  '  --limit=N            先頭から N 件（シナリオは N 本）だけ回す。--set=all では評価セットごとに',
  '  --ids=ex-001,ex-002  指定した id のケースだけ回す（この順。--set=all では使えない）',
  '  --fake               実 API を使わず、偽物で流れだけ確かめる',
  `  --max-cost=<USD>     累計の費用がこの額に達したら、次のケースを始めずに打ち切る（省略時 ${DEFAULT_MAX_COST_USD}）`,
  `  --out=<dir>          結果の JSON を書くディレクトリ（省略時 ${DEFAULT_OUT_DIR}。--fake のときは一時ディレクトリ）`,
].join('\n');

/** 値が要るオプションの値を取り出す（`--model` だけ・`--model=` は誤り） */
function valueOf(name: string, value: string | null): string {
  if (value === null || value === '') throw new Error(`${name}=<値> の形で指定してください`);
  return value;
}

/** 値を取らないオプション（`--fake=true` は誤り） */
function assertFlag(name: string, value: string | null): void {
  if (value !== null) throw new Error(`${name} は値を取りません`);
}

export function parseEvalArgs(argv: readonly string[]): EvalArgs {
  const args: EvalArgs = {
    set: 'extraction',
    config: DEFAULT_CONFIG,
    dictionary: true,
    model: null,
    limit: null,
    ids: null,
    fake: false,
    maxCostUsd: DEFAULT_MAX_COST_USD,
    out: DEFAULT_OUT_DIR,
  };
  for (const arg of argv) {
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const value = eq === -1 ? null : arg.slice(eq + 1);
    switch (name) {
      case '--fake':
        assertFlag(name, value);
        args.fake = true;
        break;
      case '--no-dictionary':
        assertFlag(name, value);
        args.dictionary = false;
        break;
      case '--set': {
        const set = valueOf(name, value);
        if (!(EVAL_SET_ARGS as readonly string[]).includes(set)) throw new Error(`--set は ${EVAL_SET_ARGS.join(' / ')} のどれか: ${set}`);
        args.set = set as EvalSetArg;
        break;
      }
      case '--config': {
        const config = valueOf(name, value);
        if (!(EVAL_CONFIGS as readonly string[]).includes(config)) throw new Error(`--config は ${EVAL_CONFIGS.join(' / ')} のどれか: ${config}`);
        args.config = config as EvalConfig;
        break;
      }
      case '--max-cost': {
        const text = valueOf(name, value);
        if (!/^\d+(\.\d+)?$/.test(text) || Number(text) <= 0) throw new Error(`--max-cost は 0 より大きい数（USD）: ${text}`);
        args.maxCostUsd = Number(text);
        break;
      }
      case '--model':
        args.model = valueOf(name, value);
        break;
      case '--limit': {
        const text = valueOf(name, value);
        if (!/^[1-9]\d*$/.test(text)) throw new Error(`--limit は 1 以上の整数: ${text}`);
        args.limit = Number(text);
        break;
      }
      case '--ids': {
        const ids = valueOf(name, value)
          .split(',')
          .map((id) => id.trim());
        if (ids.some((id) => id === '')) throw new Error('--ids に空の id があります');
        const dup = ids.find((id, i) => ids.indexOf(id) !== i);
        if (dup !== undefined) throw new Error(`--ids に重複があります: ${dup}`);
        args.ids = ids;
        break;
      }
      case '--out':
        args.out = valueOf(name, value);
        break;
      default:
        throw new Error(`未知のオプション: ${arg}`);
    }
  }
  // 組み合わせの誤りは、API を呼ぶ前に止める
  if (!args.dictionary && args.config === 'one-model') {
    throw new Error('--no-dictionary は two-model と haiku-answer だけ（one-model は常に辞書のヒントを通す構成で、切り替えられないため）');
  }
  if (args.model !== null && args.set !== 'extraction') throw new Error('--model は --set=extraction のときだけ指定できます');
  if (args.ids !== null && args.set === 'all') throw new Error('--ids は --set=all では使えません（評価セットごとに id が違うため。--set を1つに決めてください）');
  return args;
}

// ---------- ケースの絞り込み・入力の組み立て ----------

/** ids 指定はその順の部分集合（評価セットに無い id は例外）。limit はそのうちの先頭から */
export function selectCases<T extends { id: string }>(
  cases: readonly T[],
  options: { limit?: number | null; ids?: readonly string[] | null } = {},
): T[] {
  const { limit = null, ids = null } = options;
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) throw new Error(`limit は 1 以上の整数: ${limit}`);
  let selected: T[] = [...cases];
  if (ids !== null) {
    const byId = new Map(cases.map((c) => [c.id, c]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length > 0) throw new Error(`評価セットに無い id: ${missing.join(', ')}`);
    selected = ids.flatMap((id) => byId.get(id) ?? []);
  }
  return limit === null ? selected : selected.slice(0, limit);
}

/** shownIds を表示番号（1 から）つきの公開物件にする。公開物件に無い id は例外 */
export function resolveShown(
  shownIds: readonly string[] | undefined,
  properties: readonly Property[],
): { position: number; property: Property }[] {
  const byId = new Map(properties.filter((p) => p.status === 'public').map((p) => [p.id, p]));
  return (shownIds ?? []).map((id, i) => {
    const property = byId.get(id);
    if (!property) throw new Error(`shownIds の ${id} が公開物件に見つかりません`);
    return { position: i + 1, property };
  });
}

// ---------- 実行結果のとりまとめ ----------

/** 1ケースの実行結果（採点前） */
export interface RawCaseRun {
  case: ExtractionCase;
  /** API エラーのときは fallbackExtraction() */
  actual: ExtractionResult;
  /** API エラーで計測できなかったときは null */
  latencyMs: number | null;
  costUsd: number | null;
  /** 抽出器が logger.error に出したもの（検証の失敗・辞書で解決できず捨てた値など） */
  logs: string[];
  /** API エラーの文言。無ければ null */
  error: string | null;
}

export interface CaseRun extends RawCaseRun {
  score: ExtractionCaseScore;
}

/**
 * 1ケースを採点する。API エラーのケースは fallbackExtraction() で採点したうえで、完全一致には数えない
 * （正解が「何もしない offTopic」でも、本番ではエラーで返せていないため）。
 */
export function scoreRun(raw: RawCaseRun): CaseRun {
  const score = scoreExtractionCase(raw.case, raw.actual);
  return { ...raw, score: raw.error === null ? score : { ...score, exact: false } };
}

/** 全ケースの集計。応答時間と費用は、計測できたケース（API エラーでないもの）だけで出す */
export function summarizeRuns(runs: readonly CaseRun[]): { summary: ExtractionSummary; measures: MeasureSummary } {
  const summary = summarizeExtraction(
    runs.map((r) => r.case),
    runs.map((r) => r.score),
    runs.map((r) => r.actual),
  );
  const measures = summarizeMeasures(
    runs.flatMap((r) => (r.latencyMs === null || r.costUsd === null ? [] : [{ latencyMs: r.latencyMs, costUsd: r.costUsd }])),
  );
  return { summary, measures };
}

export const countErrors = (runs: readonly CaseRun[]): number => runs.filter((r) => r.error !== null).length;

export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** logger.error(message, ...rest) の1回分を1行の文字列にする（console に流さずに集めるため） */
export function formatLogEntry(message: string, rest: readonly unknown[]): string {
  const tail = rest.map((item) => {
    if (typeof item === 'string') return item;
    if (item instanceof Error) return describeError(item);
    try {
      return JSON.stringify(item) ?? String(item);
    } catch {
      return String(item);
    }
  });
  return [message, ...tail].join(' ');
}

/** 進捗の1行。例: `[3/32] ex-003 ok 1234ms`（ok=完全一致・ng=不一致・error=API エラー） */
export function formatProgress(index: number, total: number, run: CaseRun): string {
  const status = run.error !== null ? 'error' : run.score.exact ? 'ok' : 'ng';
  const time = run.latencyMs === null ? '' : ` ${run.latencyMs}ms`;
  const detail = run.error !== null ? `  ${run.error}` : '';
  return `[${index}/${total}] ${run.case.id} ${status}${time}${detail}`;
}

// ---------- 結果ファイル ----------

export type ExtractionReportInput = RunMeta & {
  runs: readonly CaseRun[];
  summary: ExtractionSummary;
  measures: MeasureSummary;
};

/** 結果の JSON（ケースごとの正解・実際・採点・計測・ログ・エラーを含む） */
export function buildResultFile(input: ExtractionReportInput): unknown {
  return {
    config: buildResultConfig(input, input.runs.length),
    summary: input.summary,
    measures: input.measures,
    errors: countErrors(input.runs),
    cases: input.runs.map((r) => ({
      id: r.case.id,
      category: r.case.category,
      utterance: r.case.utterance,
      expected: r.case.expected,
      actual: r.actual,
      score: r.score,
      latencyMs: r.latencyMs,
      costUsd: r.costUsd,
      logs: r.logs,
      error: r.error,
    })),
  };
}

// ---------- Markdown のレポート ----------

const CATEGORY_LABELS: Record<ExtractionCategory, string> = {
  basic: '単純な条件',
  variant: '表記ゆれ',
  compound: '複合条件',
  change: '条件の変更',
  priority: '優先度',
  reference: '物件への参照',
  viewing: '内見',
  forbidden: '禁止トピック',
  other: 'その他',
  tradeoff: 'トレードオフへの答え',
};

/** 単位の値を読める形に（エリアは駅・区、間取りは並べる） */
function unitValueText(key: string, unit: SlotUnit): string {
  try {
    if (key === 'area') {
      const area = JSON.parse(unit.value) as { stations: string[]; wards: string[] };
      return [...area.stations, ...area.wards].join('・') || '（空）';
    }
    if (key === 'layouts') return (JSON.parse(unit.value) as string[]).join('・');
  } catch {
    // 想定外の形ならそのまま出す
  }
  return unit.value;
}

/** 値と優先度。単位が無ければ「なし」 */
const unitText = (key: string, unit: SlotUnit | null): string => (unit === null ? 'なし' : `${unitValueText(key, unit)}（${unit.priority}）`);

const listText = (items: readonly (string | number)[]): string => `[${items.join(', ')}]`;

/** 1ケースの不一致の中身（Markdown の箇条書きの行） */
export function describeMismatch(run: CaseRun): string[] {
  const { case: c, actual, score } = run;
  const lines: string[] = [];
  if (!score.intentOk) {
    const also = c.expected.alsoAcceptIntents ?? [];
    const accepted = also.length > 0 ? `（${also.join('・')} も可）` : '';
    lines.push(`意図: 期待 ${c.expected.intent}${accepted} → 実際 ${actual.intent}`);
  }
  const unitLine = (label: string, u: SlotUnitResult): string =>
    `${label} ${u.key}: 期待 ${unitText(u.key, u.expected)} → 実際 ${unitText(u.key, u.actual)}`;
  for (const u of score.units) {
    if (!u.valueOk) lines.push(unitLine('値が違う単位', u));
  }
  for (const u of score.units) {
    if (u.valueOk && !u.priorityOk) {
      const value = u.expected ? unitValueText(u.key, u.expected) : '';
      lines.push(`優先度だけ違う単位 ${u.key}: 期待 ${u.expected?.priority} → 実際 ${u.actual?.priority}（値 ${value}）`);
    }
  }
  if (!score.targetsOk) lines.push(`表示番号: 期待 ${listText(c.expected.targetPositions ?? [])} → 実際 ${listText(actual.targetPositions)}`);
  if (!score.viewingTimesOk) lines.push(`内見の日時: 期待 ${listText(c.expected.viewingTimes ?? [])} → 実際 ${listText(actual.viewingTimes)}`);
  if (!score.forbiddenOk) lines.push(`禁止トピック: 期待 ${c.expected.forbiddenTopic ?? 'なし'} → 実際 ${actual.forbiddenTopic ?? 'なし'}`);
  if (run.error !== null) lines.push(`API エラー: ${run.error}（fallbackExtraction で採点）`);
  return lines;
}

export function formatExtractionReport(input: ExtractionReportInput): string {
  const { runs, summary, measures } = input;
  const out: string[] = [];

  out.push('# 条件抽出の評価レポート', '');

  out.push('## 設定', '');
  out.push(...formatSettingsLines(input, runs.length));
  // haiku-answer は回答生成だけが two-model と違う。条件抽出は同じ呼び出しなので、数字は two-model の再測定にあたる
  if (input.config === 'haiku-answer') {
    out.push('- 注: haiku-answer の条件抽出は two-model と同じです（違うのは回答生成だけ）。この数字は two-model の再測定にあたります');
  }
  out.push('');

  out.push('## 指標', '');
  out.push('| 指標 | 割合 | 正解数/母数 |', '|---|---:|---:|');
  const rows: [string, Ratio][] = [
    ['発話単位の完全一致', summary.exact],
    ['意図', summary.intent],
    ['条件抽出の正確さ（スロット単位）', summary.slotValue],
    ['優先度判定の正確さ', summary.priority],
    ['　うち単発の手がかり（トレードオフ以外）', summary.priorityCue],
    ['　うちトレードオフへの答え（tradeoff）', summary.priorityTradeoff],
    ['禁止トピックの再現率', summary.forbiddenRecall],
    ['表示番号', summary.targets],
    ['内見の日時', summary.viewingTimes],
  ];
  for (const [label, r] of rows) out.push(`| ${label} | ${formatRate(r)} | ${formatFraction(r)} |`);
  out.push('', `禁止トピックの誤検出: ${summary.forbiddenFalsePositives} 件`, '');

  out.push('## 応答時間と費用', '');
  out.push('| p50 | p95 | max |', '|---:|---:|---:|');
  out.push(`| ${formatMs(measures.p50Ms)} | ${formatMs(measures.p95Ms)} | ${formatMs(measures.maxMs)} |`);
  out.push('', `- 費用: 1件平均 ${formatUsd(measures.meanCostUsd)}・合計 ${formatUsd(measures.n === 0 ? null : measures.totalCostUsd)}`);
  out.push(`- 計測できたのは ${measures.n} 件（API エラーのケースは含みません）`, '');

  const errored = runs.filter((r) => r.error !== null);
  const logged = runs.filter((r) => r.logs.length > 0);
  out.push('## エラー', '');
  out.push(`- API エラー: ${errored.length} 件${errored.length > 0 ? `（${errored.map((r) => r.case.id).join(', ')}）` : ''}`);
  out.push(`- 抽出のログ（検証の失敗など）が出たケース: ${logged.length} 件${logged.length > 0 ? `（${logged.map((r) => r.case.id).join(', ')}）` : ''}`);
  out.push('');

  out.push('## カテゴリ別の完全一致', '');
  out.push('| カテゴリ | 割合 | 正解数/母数 |', '|---|---:|---:|');
  for (const category of EXTRACTION_CATEGORIES) {
    const r = summary.byCategory[category];
    if (r) out.push(`| ${category}（${CATEGORY_LABELS[category]}） | ${formatRate(r)} | ${formatFraction(r)} |`);
  }
  out.push('');

  const mismatched = runs.filter((r) => !r.score.exact);
  out.push(`## 不一致のケース（${mismatched.length} 件）`, '');
  if (runs.length === 0) out.push('評価するケースがありません（評価セットが空か、絞り込みの結果が 0 件です）。', '');
  else if (mismatched.length === 0) out.push('すべて一致しました。', '');
  for (const run of mismatched) {
    out.push(`### ${run.case.id}（${run.case.category}）`, '');
    out.push(`- 発話: 「${oneLine(run.case.utterance)}」`);
    for (const line of describeMismatch(run)) out.push(`- ${line}`);
    if (run.case.note) out.push(`- 正解の根拠: ${oneLine(run.case.note)}`);
    out.push('');
  }

  return `${out.join('\n').trimEnd()}\n`;
}
