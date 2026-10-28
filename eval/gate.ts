/**
 * 評価の関門（`npm run eval:gate`）: 実 API の評価結果を「基準値」（eval/baseline.json）と比べ、落ちていたら知らせる純関数。
 * ファイルの読み書きと終了コードは scripts/eval-gate.ts、使い方・落とす条件・幅の根拠は eval/README.md の「基準値と CI の関門」。
 *
 * - 結果ファイル（eval/results/*.json）の読み込み: `parseGateResult`（古い形式は compare.ts と同じく two-model・辞書あり として読む）
 * - 比べる結果の選び方: `selectGateResults`（セットごとに、基準値と同じ構成の fake でない最新の1つ）
 * - 比較: `evaluateGate`（落とす条件 a〜i・落とさないメモ・表の数字）と、ジョブの要約に貼る Markdown: `formatGateReport`
 * - 基準値の作り直し: `buildBaseline`（`--update` 用）
 */
import { toJst } from '@/domain/businessHours';
import {
  DASH,
  EVAL_SETS,
  formatJst,
  formatRateWithFraction,
  type Cutoff,
  type EvalSet,
} from './reportCommon';
import { ratio } from './score';
import { EVAL_CONFIGS, type EvalConfig, type Ratio, type Reach } from './types';

/** 浮動小数の誤差の余裕（-1pt ちょうどの 99/100 などを落とさない） */
export const GATE_EPSILON = 1e-9;

export const DEFAULT_BASELINE_PATH = 'eval/baseline.json';

const SET_NAMES: Record<EvalSet, string> = { extraction: '条件抽出', attack: '攻撃的質問', scenario: 'シナリオ' };
const SET_UNITS: Record<EvalSet, string> = { extraction: '件', attack: '件', scenario: '本' };
const REACHES: readonly Reach[] = ['viewing', 'handoff', 'none'];

// ---------- 基準値 ----------

/** eval/baseline.json の中身 */
export interface GateBaseline {
  /** 人向けの説明（更新のしかた・幅の根拠）。--update が引き継ぐ */
  note: string;
  /** 基準にした結果の実行日（JST）。3つの結果のうち最も新しいもの */
  updated: string;
  config: EvalConfig;
  prompts: { extract: string; answer: string };
  /** 基準にした結果ファイル（eval/results/ の中のファイル名） */
  sources: Record<EvalSet, string>;
  extraction: {
    exact: { correct: number; total: number; rate: number };
    /** 完全一致から外れたケースの id */
    misses: string[];
    /** 完全一致率を基準値から何ポイントまで下げてよいか（--update が引き継ぐ） */
    maxDropPt: number;
  };
  attack: {
    /** 後段検証あり（本番）で合格した数 */
    passed: number;
    total: number;
    /** 許す不合格の数（--update が引き継ぐ） */
    maxMisses: number;
    caseIds: string[];
  };
  scenario: {
    /** 到達した（none でない）シナリオの id。いま到達していなければ落とす */
    reached: string[];
    /** 到達しないのが正解の台本の id */
    expectedNone: string[];
  };
}

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const asNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const isSet = (v: unknown): v is EvalSet => (EVAL_SETS as readonly unknown[]).includes(v);
const isConfig = (v: unknown): v is EvalConfig => (EVAL_CONFIGS as readonly unknown[]).includes(v);
const isReach = (v: unknown): v is Reach => (REACHES as readonly unknown[]).includes(v);

function baselineRecord(obj: Json, key: string, path: string): Json {
  const v = obj[key];
  if (!isRecord(v)) throw new Error(`基準値の ${path}${key} がありません`);
  return v;
}

function baselineNumber(obj: Json, key: string, path: string, min = 0): number {
  const v = asNumber(obj[key]);
  if (v === null || v < min) throw new Error(`基準値の ${path}${key} は ${min} 以上の数にしてください`);
  return v;
}

function baselineString(obj: Json, key: string, path: string): string {
  const v = asString(obj[key]);
  if (v === null || v === '') throw new Error(`基準値の ${path}${key} は空でない文字列にしてください`);
  return v;
}

function baselineIds(obj: Json, key: string, path: string): string[] {
  const v = obj[key];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x === '')) throw new Error(`基準値の ${path}${key} は id の配列にしてください`);
  const ids = v as string[];
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup !== undefined) throw new Error(`基準値の ${path}${key} に重複があります: ${dup}`);
  return ids;
}

/** 手で直されることがあるので、形と数字のつじつまを確かめる。誤りは Error（日本語） */
export function parseBaseline(json: unknown): GateBaseline {
  if (!isRecord(json)) throw new Error('基準値が JSON のオブジェクトではありません');
  const config = json.config;
  if (!isConfig(config)) throw new Error(`基準値の config は ${EVAL_CONFIGS.join(' / ')} のどれか: ${String(config)}`);
  const updated = baselineString(json, 'updated', '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(updated)) throw new Error(`基準値の updated は YYYY-MM-DD: ${updated}`);

  const prompts = baselineRecord(json, 'prompts', '');
  const sources = baselineRecord(json, 'sources', '');
  const extraction = baselineRecord(json, 'extraction', '');
  const exact = baselineRecord(extraction, 'exact', 'extraction.');
  const correct = baselineNumber(exact, 'correct', 'extraction.exact.');
  const total = baselineNumber(exact, 'total', 'extraction.exact.', 1);
  const rate = baselineNumber(exact, 'rate', 'extraction.exact.');
  if (correct > total) throw new Error('基準値の extraction.exact.correct が total を超えています');
  if (Math.abs(rate - correct / total) > GATE_EPSILON) throw new Error('基準値の extraction.exact.rate が correct / total と合いません');
  const attack = baselineRecord(json, 'attack', '');
  const passed = baselineNumber(attack, 'passed', 'attack.');
  const attackTotal = baselineNumber(attack, 'total', 'attack.', 1);
  if (passed > attackTotal) throw new Error('基準値の attack.passed が total を超えています');
  const scenario = baselineRecord(json, 'scenario', '');
  const reached = baselineIds(scenario, 'reached', 'scenario.');
  const expectedNone = baselineIds(scenario, 'expectedNone', 'scenario.');
  const both = reached.find((id) => expectedNone.includes(id));
  if (both !== undefined) throw new Error(`基準値の scenario.reached と expectedNone の両方に ${both} があります`);

  return {
    note: asString(json.note) ?? '',
    updated,
    config,
    prompts: { extract: baselineString(prompts, 'extract', 'prompts.'), answer: baselineString(prompts, 'answer', 'prompts.') },
    sources: {
      extraction: baselineString(sources, 'extraction', 'sources.'),
      attack: baselineString(sources, 'attack', 'sources.'),
      scenario: baselineString(sources, 'scenario', 'sources.'),
    },
    extraction: {
      exact: { correct, total, rate },
      misses: baselineIds(extraction, 'misses', 'extraction.'),
      maxDropPt: baselineNumber(extraction, 'maxDropPt', 'extraction.'),
    },
    attack: {
      passed,
      total: attackTotal,
      maxMisses: baselineNumber(attack, 'maxMisses', 'attack.'),
      caseIds: baselineIds(attack, 'caseIds', 'attack.'),
    },
    scenario: { reached, expectedNone },
  };
}

// ---------- 結果ファイルの読み込み ----------

interface GateMeta {
  /** 結果ファイルの名前（パスでなくファイル名） */
  file: string;
  config: EvalConfig;
  /** false = 抽出の前段の辞書を通していない */
  dictionary: boolean;
  /** `--model` で抽出のモデルを上書きした回 */
  modelOverride: boolean;
  fake: boolean;
  /** 費用の上限で打ち切った回なら、その中身 */
  cutoff: Cutoff | null;
  /** --limit / --ids の指定、または件数が評価セットの全件に満たない（打ち切りは cutoff で別に見る） */
  partial: boolean;
  /** system プロンプトの版。古い結果ファイルは null */
  prompts: { extract: string; answer: string | null } | null;
  at: Date;
  /** API エラー（手番が例外を投げた）の件数と、そのケースの id */
  errors: number;
  errorIds: string[];
}

export type ExtractionGateResult = GateMeta & {
  set: 'extraction';
  /** 発話単位の完全一致 */
  exact: Ratio;
  /** 完全一致から外れたケースの id（API エラーのケースを含む） */
  missIds: string[];
};

export type AttackGateResult = GateMeta & {
  set: 'attack';
  /** 禁止回答の検出率（後段検証あり＝本番） */
  detection: Ratio;
  /** 本番で不合格のケースの id（summary.missedActual） */
  missIds: string[];
  caseIds: string[];
};

export type ScenarioGateResult = GateMeta & {
  set: 'scenario';
  cases: { id: string; reach: Reach; expectedReach: Reach }[];
};

export type GateResult = ExtractionGateResult | AttackGateResult | ScenarioGateResult;

/** 比べる3つの結果。無いセットは null */
export interface GateResults {
  extraction: ExtractionGateResult | null;
  attack: AttackGateResult | null;
  scenario: ScenarioGateResult | null;
}

export type GateParse = { ok: true; result: GateResult } | { ok: false; reason: string };

function asRatio(v: unknown): Ratio | null {
  if (!isRecord(v)) return null;
  const correct = asNumber(v.correct);
  const total = asNumber(v.total);
  return correct === null || total === null ? null : ratio(correct, total);
}

function asCutoff(v: unknown): Cutoff {
  const c = isRecord(v) ? v : {};
  return {
    reason: 'maxCost',
    spentUsd: asNumber(c.spentUsd) ?? 0,
    maxCostUsd: asNumber(c.maxCostUsd) ?? 0,
    completed: asNumber(c.completed) ?? 0,
    planned: asNumber(c.planned) ?? 0,
  };
}

/**
 * 結果ファイルの JSON を1つ読む。読めない形は `ok: false`（理由つき）。
 * 古い形式（config・dictionary・models の無いもの）は、eval:compare と同じく two-model・辞書あり として読む。
 * fake の回も読む（関門が fake を理由に落とすため）。
 */
export function parseGateResult(json: unknown, file: string): GateParse {
  const fail = (reason: string): GateParse => ({ ok: false, reason });
  if (!isRecord(json) || !isRecord(json.config)) return fail('config がありません');
  const config = json.config;
  if (!isSet(config.set)) return fail(`評価セットが読めません: ${String(config.set)}`);
  const set = config.set;
  const evalConfig = config.config === undefined ? 'two-model' : config.config;
  if (!isConfig(evalConfig)) return fail(`構成が読めません: ${String(config.config)}`);
  const at = typeof config.at === 'string' ? new Date(config.at) : null;
  if (at === null || Number.isNaN(at.getTime())) return fail('実行日時（config.at）が読めません');
  if (!Array.isArray(json.cases)) return fail('cases がありません');

  const cases: Json[] = [];
  for (const c of json.cases) {
    if (!isRecord(c) || typeof c.id !== 'string') return fail('ケースの id が読めません');
    cases.push(c);
  }
  const errorIds = cases.filter((c) => c.error !== null && c.error !== undefined).map((c) => c.id as string);
  const caseCount = asNumber(config.caseCount) ?? cases.length;
  const totalCases = asNumber(config.totalCases);
  const cutoff = config.cutoff != null ? asCutoff(config.cutoff) : null;
  const prompts = isRecord(config.prompts) && typeof config.prompts.extract === 'string'
    ? { extract: config.prompts.extract, answer: asString(config.prompts.answer) }
    : null;

  const meta: GateMeta = {
    file,
    config: evalConfig,
    dictionary: config.dictionary !== false,
    modelOverride: config.modelOverride === true,
    fake: config.fake === true,
    cutoff,
    partial: config.limit != null || config.ids != null || (cutoff === null && totalCases !== null && caseCount < totalCases),
    prompts,
    at,
    errors: Math.max(asNumber(json.errors) ?? 0, errorIds.length),
    errorIds,
  };
  const summary = isRecord(json.summary) ? json.summary : null;
  if (summary === null) return fail('summary がありません');

  switch (set) {
    case 'extraction': {
      const exact = asRatio(summary.exact);
      if (exact === null) return fail('summary.exact が読めません');
      const missIds: string[] = [];
      for (const c of cases) {
        if (!isRecord(c.score) || typeof c.score.exact !== 'boolean') return fail(`ケース ${String(c.id)} の score.exact が読めません`);
        if (!c.score.exact) missIds.push(c.id as string);
      }
      return { ok: true, result: { ...meta, set, exact, missIds } };
    }
    case 'attack': {
      const detection = isRecord(summary.detection) ? asRatio(summary.detection.actual) : null;
      if (detection === null) return fail('summary.detection.actual が読めません');
      let missIds: string[];
      if (Array.isArray(summary.missedActual) && summary.missedActual.every((x) => typeof x === 'string')) {
        missIds = summary.missedActual as string[];
      } else {
        missIds = [];
        for (const c of cases) {
          const actual = isRecord(c.score) && isRecord(c.score.actual) ? c.score.actual : null;
          if (actual === null || typeof actual.pass !== 'boolean') return fail(`ケース ${String(c.id)} の score.actual.pass が読めません`);
          if (!actual.pass) missIds.push(c.id as string);
        }
      }
      return { ok: true, result: { ...meta, set, detection, missIds, caseIds: cases.map((c) => c.id as string) } };
    }
    case 'scenario': {
      const scenarios: ScenarioGateResult['cases'] = [];
      for (const c of cases) {
        const score = isRecord(c.score) ? c.score : null;
        const expectedReach = score?.expectedReach ?? c.expectedReach;
        if (score === null || !isReach(score.reach) || !isReach(expectedReach)) return fail(`シナリオ ${String(c.id)} の到達が読めません`);
        scenarios.push({ id: c.id as string, reach: score.reach, expectedReach });
      }
      return { ok: true, result: { ...meta, set, cases: scenarios } };
    }
  }
}

// ---------- 比べる結果の選び方 ----------

export interface GateSelection {
  results: GateResults;
  /** 結果が選べなかった評価セットの、選ばなかった理由（失敗の文言に添える） */
  hints: Partial<Record<EvalSet, string>>;
  /** 読めなくて飛ばした結果ファイル */
  skipped: { file: string; reason: string }[];
}

const newer = (a: GateResult, b: GateResult): boolean =>
  a.at.getTime() > b.at.getTime() || (a.at.getTime() === b.at.getTime() && a.file > b.file);

function latest<T extends GateResult>(list: readonly T[]): T | null {
  let best: T | null = null;
  for (const r of list) if (best === null || newer(r, best)) best = r;
  return best;
}

/**
 * ディレクトリの結果ファイルから、評価セットごとに「基準値と同じ構成・辞書あり・モデルの上書きなし」の fake でない最新の1つを選ぶ。
 * 該当が fake の回だけのときは、その最新を選ぶ（関門が fake を理由に落とすため）。
 * 構成が違う回・辞書なしの回・読めないファイルは選ばない（選べなかったセットには hints で理由を残す）。
 */
export function selectGateResults(files: readonly { name: string; json: unknown }[], baselineConfig: EvalConfig): GateSelection {
  const skipped: GateSelection['skipped'] = [];
  const parsed: GateResult[] = [];
  for (const { name, json } of files) {
    const outcome = parseGateResult(json, name);
    if (outcome.ok) parsed.push(outcome.result);
    else skipped.push({ file: name, reason: outcome.reason });
  }

  const results: GateResults = { extraction: null, attack: null, scenario: null };
  const hints: GateSelection['hints'] = {};
  const same = (r: GateResult): boolean => r.config === baselineConfig && r.dictionary && !r.modelOverride;
  const pick = <T extends GateResult>(candidates: readonly T[]): T | null => {
    const matching = candidates.filter(same);
    return latest(matching.filter((r) => !r.fake)) ?? latest(matching.filter((r) => r.fake));
  };

  results.extraction = pick(parsed.filter((r): r is ExtractionGateResult => r.set === 'extraction'));
  results.attack = pick(parsed.filter((r): r is AttackGateResult => r.set === 'attack'));
  results.scenario = pick(parsed.filter((r): r is ScenarioGateResult => r.set === 'scenario'));

  for (const set of EVAL_SETS) {
    if (results[set] !== null) continue;
    const candidates = parsed.filter((r) => r.set === set);
    if (candidates.length === 0) continue;
    const reasons = new Set<string>();
    for (const r of candidates) {
      if (r.config !== baselineConfig) reasons.add(`構成 ${r.config}`);
      if (!r.dictionary) reasons.add('辞書なし');
      if (r.modelOverride) reasons.add('--model の上書き');
    }
    hints[set] = `この評価セットの結果は ${candidates.length} 件ありましたが、基準値と同じ条件（構成 ${baselineConfig}・辞書あり・モデルの上書きなし）ではないため選びませんでした（${[...reasons].join('・')}）`;
  }
  return { results, hints, skipped };
}

// ---------- 比較 ----------

/** 表の1行（指標ごとの 基準値・今回・落とす境目）。ok が null = 今回の結果が無い・比べられない */
export interface GateRow {
  metric: string;
  baseline: string;
  current: string;
  limit: string;
  ok: boolean | null;
}

export interface GateOutcome {
  ok: boolean;
  /** 落とす理由（どのケースかの id を含む） */
  failures: string[];
  /** 落とさないが見てほしいこと（新しく外れた id・新しいケース・プロンプトの版の違い・確かめ直しのコマンドなど） */
  notes: string[];
  rows: GateRow[];
}

/** 長い id の一覧は先頭だけ（残りは件数） */
function listIds(ids: readonly string[], max = 10): string {
  return ids.length <= max ? ids.join(', ') : `${ids.slice(0, max).join(', ')} …ほか ${ids.length - max} 件`;
}

const percent = (rate: number): string => `${(rate * 100).toFixed(2)}%`;
const minus = (a: readonly string[], b: readonly string[]): string[] => a.filter((id) => !b.includes(id));

function evalCommand(baseline: GateBaseline, set: EvalSet, ids: readonly string[]): string {
  const config = baseline.config === 'two-model' ? '' : ` --config=${baseline.config}`;
  return `npm run eval -- --set=${set} --ids=${ids.join(',')}${config}`;
}

/** 数字を比べてよい結果か。だめな理由（b〜e・i）は失敗に積む */
function checkRunConditions(set: EvalSet, r: GateResult, baseline: GateBaseline, failures: string[]): boolean {
  const name = SET_NAMES[set];
  const unit = SET_UNITS[set];
  let usable = true;
  if (r.cutoff !== null) {
    failures.push(
      `${name}: 費用の上限（--max-cost）で打ち切られています（${r.cutoff.planned} ${unit}のうち ${r.cutoff.completed} ${unit}で停止・累計 $${r.cutoff.spentUsd.toFixed(4)}）。全件を回していないので基準値と比べられません（${r.file}）`,
    );
    usable = false;
  }
  if (r.fake) {
    failures.push(`${name}: --fake の結果です（実 API を呼んでいないので数字に意味がありません）。--fake なしの実 API の結果を渡してください（${r.file}）`);
    usable = false;
  }
  if (r.config !== baseline.config) {
    failures.push(`${name}: 構成が基準値と違います（基準値 ${baseline.config} → 今回 ${r.config}。${r.file}）`);
    usable = false;
  }
  const conditions = [...(r.dictionary ? [] : ['辞書なし']), ...(r.modelOverride ? ['--model で抽出のモデルを上書き'] : [])];
  if (conditions.length > 0) {
    failures.push(`${name}: 基準値と同じ条件ではありません（${conditions.join('・')}。${r.file}）`);
    usable = false;
  }
  if (r.partial) {
    failures.push(`${name}: 全件を回していません（--limit / --ids の指定、または件数が評価セットの全件に満たない）。基準値と比べられません（${r.file}）`);
    usable = false;
  }
  if (r.errors > 0) {
    const ids = r.errorIds.length > 0 ? `（${listIds(r.errorIds)}）` : '';
    failures.push(
      `${name}: API エラーが ${r.errors} ${unit}あります${ids}。残高切れ・キーの無効や期限切れ・障害の可能性があります。この結果は基準値と比べられません（${r.file}）`,
    );
    usable = false;
  }
  return usable;
}

function missingResult(set: EvalSet, hint: string | undefined, failures: string[]): void {
  const why = '費用の上限で打ち切って結果ファイルが作られなかったか、実行に失敗したか、--set=all で回していない可能性があります';
  failures.push(`${SET_NAMES[set]}: 結果がありません。${why}${hint ? `（${hint}）` : ''}`);
}

function checkExtraction(baseline: GateBaseline, r: ExtractionGateResult | null, hint: string | undefined, failures: string[], notes: string[]): GateRow {
  const base = baseline.extraction;
  const floor = base.exact.rate - base.maxDropPt / 100;
  const baseText = formatRateWithFraction(ratio(base.exact.correct, base.exact.total));
  const limitText = (total: number): string => `${percent(floor)} 未満（${Math.ceil(floor * total - GATE_EPSILON)}/${total} 未満）`;
  const row: GateRow = { metric: '条件抽出: 完全一致', baseline: baseText, current: DASH, limit: `${limitText(base.exact.total)}で不合格（基準値 −${base.maxDropPt}pt）`, ok: null };
  if (r === null) {
    missingResult('extraction', hint, failures);
    return row;
  }
  if (!checkRunConditions('extraction', r, baseline, failures)) return row;

  row.current = formatRateWithFraction(r.exact);
  row.limit = `${limitText(r.exact.total)}で不合格（基準値 −${base.maxDropPt}pt）`;
  const newMisses = minus(r.missIds, base.misses);
  const fixed = minus(base.misses, r.missIds);
  const failed = r.exact.rate === null || r.exact.rate < floor - GATE_EPSILON;
  row.ok = !failed;
  if (failed) {
    const shown = newMisses.length > 0 ? `新しく外れた id: ${listIds(newMisses)}` : `外れた id: ${listIds(r.missIds)}`;
    failures.push(
      `条件抽出: 完全一致が ${formatRateWithFraction(r.exact)}に下がりました。基準値 ${baseText}から −${base.maxDropPt}pt の下限 ${percent(floor)} を下回っています。${shown}`,
    );
  } else if (newMisses.length > 0) {
    notes.push(`条件抽出で新しく外れた id（許す範囲）: ${listIds(newMisses)}`);
  }
  const retry = newMisses.length > 0 ? newMisses : failed ? r.missIds : [];
  if (retry.length > 0) notes.push(`ローカルで確かめ直す（条件抽出）: \`${evalCommand(baseline, 'extraction', retry)}\``);
  if (fixed.length > 0) notes.push(`条件抽出で、基準値では外れていて今回は合った id: ${listIds(fixed)}`);
  if (r.exact.rate !== null && r.exact.rate > base.exact.rate + GATE_EPSILON) {
    notes.push(`条件抽出の完全一致が基準値より良くなっています（${baseText} → ${formatRateWithFraction(r.exact)}）。意図した改善なら、基準値を更新する`);
  }
  if (r.exact.total !== base.exact.total) {
    notes.push(`条件抽出の件数が基準値と違います（${base.exact.total} → ${r.exact.total}）。評価セットを変えたなら、基準値を更新する`);
  }
  return row;
}

function checkAttack(baseline: GateBaseline, r: AttackGateResult | null, hint: string | undefined, failures: string[], notes: string[]): GateRow {
  const base = baseline.attack;
  const row: GateRow = {
    metric: '攻撃的質問: 不合格（後段検証あり・本番）',
    baseline: `${base.total - base.passed} 件（${base.total} 件中）`,
    current: DASH,
    limit: `${base.maxMisses} 件を超えたら不合格`,
    ok: null,
  };
  if (r === null) {
    missingResult('attack', hint, failures);
    return row;
  }
  if (!checkRunConditions('attack', r, baseline, failures)) return row;

  row.current = `${r.missIds.length} 件（${r.detection.total} 件中）`;
  const failed = r.missIds.length > base.maxMisses;
  row.ok = !failed;
  if (failed) {
    failures.push(`攻撃的質問: 後段検証ありの不合格が ${r.missIds.length} 件で、許す ${base.maxMisses} 件を超えました: ${listIds(r.missIds)}`);
  } else if (r.missIds.length > 0) {
    notes.push(`攻撃的質問の不合格（許す範囲）: ${listIds(r.missIds)}`);
  }
  if (r.missIds.length > 0) notes.push(`ローカルで確かめ直す（攻撃的質問）: \`${evalCommand(baseline, 'attack', r.missIds)}\``);
  const added = minus(r.caseIds, base.caseIds);
  const removed = minus(base.caseIds, r.caseIds);
  if (added.length > 0) notes.push(`基準値に無い攻撃的質問のケース（${added.length} 件）: ${listIds(added)}。ケースを足したなら、基準値を更新する`);
  if (removed.length > 0) notes.push(`基準値にあって今回無い攻撃的質問のケース（${removed.length} 件）: ${listIds(removed)}`);
  return row;
}

function checkScenario(baseline: GateBaseline, r: ScenarioGateResult | null, hint: string | undefined, failures: string[], notes: string[]): GateRow {
  const base = baseline.scenario;
  const row: GateRow = {
    metric: 'シナリオ: 基準値で到達した台本',
    baseline: `${base.reached.length} 本が到達`,
    current: DASH,
    limit: '1 本でも到達しなくなったら不合格',
    ok: null,
  };
  if (r === null) {
    missingResult('scenario', hint, failures);
    return row;
  }
  if (!checkRunConditions('scenario', r, baseline, failures)) return row;

  const byId = new Map(r.cases.map((c) => [c.id, c]));
  const lost = base.reached.filter((id) => (byId.get(id)?.reach ?? 'none') === 'none');
  row.current = `${base.reached.length - lost.length}/${base.reached.length} 本が到達`;
  row.ok = lost.length === 0;
  if (lost.length > 0) {
    const detail = lost.map((id) => `${id}（${byId.has(id) ? '到達なし' : 'ケースなし'}）`).join(', ');
    failures.push(`シナリオ: 基準値で到達していた台本が到達しなくなりました: ${detail}`);
    const retry = lost.filter((id) => byId.has(id));
    if (retry.length > 0) notes.push(`ローカルで確かめ直す（シナリオ）: \`${evalCommand(baseline, 'scenario', retry)}\``);
  }
  const known = [...base.reached, ...base.expectedNone];
  const added = r.cases.filter((c) => !known.includes(c.id));
  if (added.length > 0) {
    notes.push(`基準値に無いシナリオ: ${added.map((c) => `${c.id}（到達 ${c.reach}）`).join(', ')}。台本を足したなら、基準値を更新する`);
  }
  const unexpected = base.expectedNone.filter((id) => (byId.get(id)?.reach ?? 'none') !== 'none');
  if (unexpected.length > 0) {
    notes.push(`到達しないのが正解の台本が到達しました: ${unexpected.map((id) => `${id}（${byId.get(id)?.reach}）`).join(', ')}`);
  }
  const gone = base.expectedNone.filter((id) => !byId.has(id));
  if (gone.length > 0) notes.push(`基準値にあって今回無いシナリオ: ${gone.join(', ')}`);
  return row;
}

/** プロンプトの版が基準値と違うことをメモに。意図した変更なら基準値を更新する */
function promptNotes(baseline: GateBaseline, present: readonly GateResult[]): string[] {
  const drift = new Map<string, string[]>();
  const add = (key: string, set: EvalSet): void => {
    drift.set(key, [...(drift.get(key) ?? []), SET_NAMES[set]]);
  };
  for (const r of present) {
    if (r.prompts === null) {
      add('版が結果ファイルに無い（古い結果）', r.set);
      continue;
    }
    if (r.prompts.extract !== baseline.prompts.extract) add(`抽出 ${baseline.prompts.extract} → ${r.prompts.extract}`, r.set);
    if (r.prompts.answer !== null && r.prompts.answer !== baseline.prompts.answer) add(`回答 ${baseline.prompts.answer} → ${r.prompts.answer}`, r.set);
  }
  if (drift.size === 0) return [];
  const text = [...drift].map(([key, sets]) => `${key}（${sets.join('・')}）`).join('、');
  return [
    `プロンプトの版が基準値と違います: ${text}。意図した変更なら、良くなったことを確かめてから基準値を更新する（\`npm run --silent eval:gate -- --update --results=<結果のディレクトリ>\`）`,
  ];
}

/**
 * 結果3つを基準値と比べる。落とす条件:
 * (a) セットの結果が無い (b) 費用の上限で打ち切り (c) fake (d) 構成が基準値と違う（辞書なし・モデル上書きも）
 * (e) API エラーが 1 件以上 (f) 条件抽出の完全一致率が 基準値 − maxDropPt/100 を下回る
 * (g) 攻撃的質問の不合格（後段検証あり）が maxMisses を超える (h) 基準値で到達したシナリオが到達していない
 * (i) 全件を回していない（--limit / --ids）。(b)〜(e)・(i) に当たったセットは数字を比べない（原因が先）。
 */
export function evaluateGate(
  baseline: GateBaseline,
  results: GateResults,
  options: { hints?: Partial<Record<EvalSet, string>> } = {},
): GateOutcome {
  const failures: string[] = [];
  const notes: string[] = [];
  const { hints = {} } = options;
  const rows: GateRow[] = [
    checkExtraction(baseline, results.extraction, hints.extraction, failures, notes),
    checkAttack(baseline, results.attack, hints.attack, failures, notes),
    checkScenario(baseline, results.scenario, hints.scenario, failures, notes),
  ];

  const present = [results.extraction, results.attack, results.scenario].filter((r): r is GateResult => r !== null);
  rows.push({
    metric: 'API エラー（3つの合計）',
    baseline: '0 件',
    current: present.length === 0 ? DASH : `${present.reduce((sum, r) => sum + r.errors, 0)} 件`,
    limit: '1 件でもあれば不合格',
    ok: present.length === 0 ? null : present.every((r) => r.errors === 0),
  });
  notes.push(...promptNotes(baseline, present));
  return { ok: failures.length === 0, failures, notes, rows };
}

// ---------- Markdown のレポート ----------

/** GITHUB_STEP_SUMMARY に貼る Markdown */
export function formatGateReport(baseline: GateBaseline, results: GateResults, outcome: GateOutcome): string {
  const out: string[] = ['## 基準値との比較', ''];
  out.push(outcome.ok ? '**合格**: 基準値から落ちたものはありません。' : `**不合格**: ${outcome.failures.length} 件の失敗があります。`, '');
  out.push(`- 基準値: ${baseline.updated} 更新（構成 ${baseline.config}・プロンプト 抽出 ${baseline.prompts.extract} / 回答 ${baseline.prompts.answer}）`);
  for (const set of EVAL_SETS) {
    const r = results[set];
    out.push(`- 今回の${SET_NAMES[set]}: ${r === null ? 'なし' : `\`${r.file}\`（${formatJst(r.at)} JST）`}`);
  }
  out.push('');

  out.push('| 指標 | 基準値 | 今回 | 落とす境目 | 判定 |', '|---|---:|---:|---|---|');
  for (const row of outcome.rows) {
    const verdict = row.ok === null ? DASH : row.ok ? '合格' : '**不合格**';
    out.push(`| ${row.metric} | ${row.baseline} | ${row.current} | ${row.limit} | ${verdict} |`);
  }
  out.push('');

  out.push('### 失敗', '');
  if (outcome.failures.length === 0) out.push('なし。', '');
  else out.push(...outcome.failures.map((f) => `- ${f}`), '');

  out.push('### メモ', '');
  if (outcome.notes.length === 0) out.push('なし。', '');
  else out.push(...outcome.notes.map((n) => `- ${n}`), '');

  return `${out.join('\n').trimEnd()}\n`;
}

// ---------- 基準値の作り直し（--update） ----------

/** 基準値にしてよくない結果の問題を集める（空なら作れる） */
function baselineSourceProblems(results: GateResults): string[] {
  const problems: string[] = [];
  for (const set of EVAL_SETS) {
    const r = results[set];
    if (r === null) {
      problems.push(`${SET_NAMES[set]}の結果がありません`);
      continue;
    }
    const issues: string[] = [];
    if (r.fake) issues.push('--fake の結果');
    if (r.cutoff !== null) issues.push('費用の上限で打ち切った回');
    if (r.partial) issues.push('全件でない回（--limit / --ids）');
    if (!r.dictionary) issues.push('辞書なしの回');
    if (r.modelOverride) issues.push('--model の上書きの回');
    if (r.errors > 0) issues.push(`API エラーが ${r.errors} 件`);
    if (issues.length > 0) problems.push(`${SET_NAMES[set]}（${r.file}）は基準値にできません: ${issues.join('・')}`);
  }
  return problems;
}

/**
 * 結果3つから基準値を作り直す。maxDropPt・maxMisses・note は `previous` から引き継ぐ。
 * `updated` は結果のうち最も新しい実行日（JST）にする（現在時刻を読まないので、同じ結果から同じ基準値ができる）。
 * fake・打ち切り・全件でない回・API エラーのある回・構成やプロンプトの版がそろわない結果は Error（日本語）。
 */
export function buildBaseline(previous: GateBaseline, results: GateResults): GateBaseline {
  const problems = baselineSourceProblems(results);
  const { extraction, attack, scenario } = results;
  if (problems.length > 0 || extraction === null || attack === null || scenario === null) {
    throw new Error(`基準値を作り直せません:\n${problems.map((p) => `- ${p}`).join('\n')}`);
  }

  const configs = new Set([extraction.config, attack.config, scenario.config]);
  if (configs.size > 1) throw new Error(`基準値を作り直せません: 3つの結果の構成がそろっていません（${[...configs].join(' / ')}）`);

  const extractVersions = new Set([extraction.prompts?.extract, attack.prompts?.extract, scenario.prompts?.extract]);
  const answerVersions = new Set([attack.prompts?.answer, scenario.prompts?.answer]);
  const [extractVersion] = [...extractVersions];
  const [answerVersion] = [...answerVersions];
  if (extractVersions.size > 1 || !extractVersion) {
    throw new Error('基準値を作り直せません: 3つの結果の抽出プロンプトの版がそろっていない、または結果ファイルに版がありません');
  }
  if (answerVersions.size > 1 || !answerVersion) {
    throw new Error('基準値を作り直せません: 攻撃的質問とシナリオの回答プロンプトの版がそろっていない、または結果ファイルに版がありません');
  }

  const unreachedButExpected = scenario.cases.filter((c) => c.reach === 'none' && c.expectedReach !== 'none').map((c) => c.id);
  if (unreachedButExpected.length > 0) {
    throw new Error(`基準値を作り直せません: 到達するはずのシナリオが到達していません（${unreachedButExpected.join(', ')}）。台本か実装を直してから`);
  }

  const latestAt = [extraction, attack, scenario].reduce((a, b) => (b.at.getTime() > a.getTime() ? b.at : a), extraction.at);
  return {
    note: previous.note,
    updated: toJst(latestAt).date,
    config: extraction.config,
    prompts: { extract: extractVersion, answer: answerVersion },
    sources: { extraction: extraction.file, attack: attack.file, scenario: scenario.file },
    extraction: {
      exact: { correct: extraction.exact.correct, total: extraction.exact.total, rate: extraction.exact.rate ?? 0 },
      misses: extraction.missIds,
      maxDropPt: previous.extraction.maxDropPt,
    },
    attack: {
      passed: attack.detection.correct,
      total: attack.detection.total,
      maxMisses: previous.attack.maxMisses,
      caseIds: attack.caseIds,
    },
    scenario: {
      reached: scenario.cases.filter((c) => c.reach !== 'none').map((c) => c.id),
      expectedNone: scenario.cases.filter((c) => c.expectedReach === 'none').map((c) => c.id),
    },
  };
}

// ---------- 引数 ----------

export interface GateArgs {
  /** 結果ファイルのディレクトリ */
  results: string;
  baseline: string;
  /** 基準値を作り直して書く */
  update: boolean;
  /** --update で、基準値と別の構成の結果から作る（基準値を付け替える）ときの構成。null なら基準値の構成 */
  config: EvalConfig | null;
}

export const GATE_USAGE = [
  '使い方: npm run --silent eval:gate -- --results=<dir> [オプション]',
  '  --results=<dir>      結果ファイル（*.json）のあるディレクトリ（必須。CI では評価の --out に渡した、そのジョブだけのディレクトリ）',
  `  --baseline=<path>    基準値のファイル（省略時 ${DEFAULT_BASELINE_PATH}）`,
  '  --update             比べずに、選んだ3つの結果から基準値を作り直して書く（人が意図して基準値を上げる・付け替えるとき）',
  `  --config=<名前>      --update のとき、この構成の結果から作る: ${EVAL_CONFIGS.join(' / ')}（省略時は基準値の構成）`,
  '合格なら終了コード 0・不合格なら 1。引数の誤りや読み込みの失敗も 1（標準エラーに理由）。',
].join('\n');

export function parseGateArgs(argv: readonly string[]): GateArgs {
  const args: GateArgs = { results: '', baseline: DEFAULT_BASELINE_PATH, update: false, config: null };
  for (const arg of argv) {
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const value = eq === -1 ? null : arg.slice(eq + 1);
    const need = (): string => {
      if (value === null || value === '') throw new Error(`${name}=<値> の形で指定してください`);
      return value;
    };
    switch (name) {
      case '--results':
        args.results = need();
        break;
      case '--baseline':
        args.baseline = need();
        break;
      case '--update':
        if (value !== null) throw new Error('--update は値を取りません');
        args.update = true;
        break;
      case '--config': {
        const config = need();
        if (!isConfig(config)) throw new Error(`--config は ${EVAL_CONFIGS.join(' / ')} のどれか: ${config}`);
        args.config = config;
        break;
      }
      default:
        throw new Error(`未知のオプション: ${arg}`);
    }
  }
  if (args.results === '') throw new Error('--results=<dir> を指定してください');
  if (args.config !== null && !args.update) throw new Error('--config は --update のときだけ指定できます（比較は常に基準値の構成の結果で行います）');
  return args;
}
