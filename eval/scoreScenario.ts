/**
 * シナリオの採点（純関数。DESIGN.md 7章「到達率」「応答時間とコスト」、10.2 の「ベースラインとの比較」）。LLM も I/O も呼ばない。
 * ランナー（scripts/eval.ts）が `runScenario` の結果（ScenarioRun）を渡す。
 *
 * - 手番の合格: 台本の `expect` に書いた項目を `checkStep` で1つずつ確かめる。台本の手番の総数を母数にし、
 *   打ち切りで実行されなかった手番は不合格に数える
 * - 到達: 内見の仮受付が1件でもあれば viewing、無くて引き継ぎメモがあれば handoff、どちらも無ければ none。
 *   時間帯別（営業時間内／外）にも出す。ベースライン（全条件 AND＋優先順位確認なし）と並べる
 * - 応答時間と費用: 自由文の手番の応答時間（latencyMs）と、1会話の費用（USD と円）
 */
import { defaultCalendar, isOpenAt } from '@/domain/businessHours';
import { PRIORITY_LABEL } from '@/domain/messages';
import { listConditions, sameRef } from '@/domain/slots';
import type { ConditionRef, ScalarSlotKey } from '@/domain/types';
import type { HarnessTurn } from './harness';
import type { ScenarioRun } from './scenario';
import { percentile, ratio } from './score';
import { EVAL_USD_JPY, type Ratio, type Reach, type StepExpectation } from './types';

// ---------- 手番の検査 ----------

const SLOT_NAME: Record<ScalarSlotKey, string> = {
  area: 'エリア',
  rentMax: '予算',
  layouts: '間取り',
  walkMax: '徒歩',
  floorMin: '階',
  moveIn: '入居時期',
};

const refName = (ref: ConditionRef): string => (ref.kind === 'tag' ? ref.tag : SLOT_NAME[ref.key]);

/** 手番の結果が `expect` を満たしているかを確かめ、満たさなかった項目の説明を返す（空なら合格）。書いた項目だけを見る */
export function checkStep(expect: StepExpectation, turn: HarnessTurn): string[] {
  const problems: string[] = [];
  // 例外（API の障害など）は、期待の項目に関わらず不合格にする。エンジンは「混み合っています」で返して続けるので、気づけなくなる
  if (turn.error !== null) problems.push(`例外: ${turn.error}`);

  if (expect.state !== undefined && turn.state !== expect.state) {
    problems.push(`状態: 期待 ${expect.state} / 実際 ${turn.state}`);
  }
  if (expect.cards !== undefined) {
    const shown = turn.cardIds.length > 0;
    if (shown !== expect.cards) {
      problems.push(`カード: 期待 ${expect.cards ? 'あり' : 'なし'} / 実際 ${shown ? `あり（${turn.cardIds.length}件）` : 'なし'}`);
    }
  }
  if (expect.total !== undefined) {
    const { min, max } = expect.total;
    if (turn.mustTotal === null) {
      problems.push('must 通過件数: エリアか予算が無く数えられない');
    } else if ((min !== undefined && turn.mustTotal < min) || (max !== undefined && turn.mustTotal > max)) {
      const range = min !== undefined && min === max ? `${min}` : `${min ?? ''}〜${max ?? ''}`;
      problems.push(`must 通過件数: 期待 ${range} / 実際 ${turn.mustTotal}`);
    }
  }
  const text = turn.texts.join('\n');
  for (const word of expect.includes ?? []) {
    if (!text.includes(word)) problems.push(`返信に「${word}」が無い`);
  }
  for (const word of expect.excludes ?? []) {
    if (text.includes(word)) problems.push(`返信に「${word}」がある`);
  }
  if (expect.handoff !== undefined) {
    const added = turn.handoffAdded.length > 0;
    if (added !== expect.handoff) problems.push(`引き継ぎメモ: 期待 ${expect.handoff ? '増える' : '増えない'} / 実際 ${added ? '増えた' : '増えない'}`);
  }
  if (expect.viewing !== undefined) {
    const created = turn.viewingCreated.length > 0;
    if (created !== expect.viewing) problems.push(`内見の仮受付: 期待 ${expect.viewing ? '保存される' : '保存されない'} / 実際 ${created ? '保存された' : '保存されない'}`);
  }

  const conditions = listConditions(turn.slots);
  for (const want of expect.conditions ?? []) {
    const found = conditions.find((c) => sameRef(c.ref, want.ref));
    if (!found) {
      problems.push(`条件「${refName(want.ref)}」が無い`);
    } else if (want.priority !== undefined && found.priority !== want.priority) {
      problems.push(`条件「${refName(want.ref)}」の優先度: 期待 ${PRIORITY_LABEL[want.priority]} / 実際 ${PRIORITY_LABEL[found.priority]}`);
    }
  }
  for (const ref of expect.absent ?? []) {
    if (conditions.some((c) => sameRef(c.ref, ref))) problems.push(`条件「${refName(ref)}」が残っている`);
  }
  const labels = turn.quickReplies.map((q) => q.label);
  for (const label of expect.quickReplies ?? []) {
    if (!labels.includes(label)) problems.push(`クイックリプライ「${label}」が無い（あるもの: ${labels.join(' / ') || 'なし'}）`);
  }
  return problems;
}

// ---------- 到達 ----------

/** 実際の到達と、到達した手番（最初に内見の仮受付／引き継ぎメモが増えた手番の番号・0 始まり） */
export function reachOf(turns: readonly HarnessTurn[]): { reach: Reach; step: number | null } {
  const viewing = turns.findIndex((t) => t.viewingCreated.length > 0);
  if (viewing >= 0) return { reach: 'viewing', step: viewing };
  const handoff = turns.findIndex((t) => t.handoffAdded.length > 0);
  if (handoff >= 0) return { reach: 'handoff', step: handoff };
  return { reach: 'none', step: null };
}

/**
 * ベースライン（全条件 AND＋優先順位確認なし。Web サイトの絞り込み検索）の到達の模擬。
 *
 * 実際の到達が none でなく、到達した手番まで（その手番を含む）のどの手番でも全条件 AND の件数（andTotal）が 0 にならなかったら、
 * 実際と同じ到達とする。0 になった手番があれば、そこで行き止まり（none）とみなす。
 *
 * 仮定: Web サイト式の検索は 0 件の画面で「〇〇を『できれば』にすると N 件増えます」のような緩和の提案を出さず、
 * 利用者は条件を直せないまま離れる。実際の利用者が条件を言い直して先へ進む可能性は見ない（優先順位つきの会話が
 * 行き止まりを救う効果だけを取り出すための模擬で、実ログから測った数字ではない）。
 * andTotal が null の手番（エリアか予算がまだ無い）は行き止まりに数えない
 */
export function baselineReachOf(turns: readonly HarnessTurn[]): Reach {
  const { reach, step } = reachOf(turns);
  if (reach === 'none' || step === null) return 'none';
  return turns.slice(0, step + 1).some((t) => t.andTotal === 0) ? 'none' : reach;
}

// ---------- 1シナリオの採点 ----------

export interface StepFailure {
  /** 台本の手番の番号（0 始まり） */
  step: number;
  problems: string[];
}

/** 検索できる条件（エリアと予算）が揃った手番の、手番の後のスロットでの件数 */
export interface SearchPoint {
  step: number;
  /** must 通過件数（優先順位つき） */
  mustTotal: number;
  /** 全条件を must にした（Web サイト式の）件数 */
  andTotal: number;
}

export interface ScenarioScore {
  id: string;
  title: string;
  /** 手番の合格数。母数は台本の手番の総数（打ち切りで実行されなかった手番は不合格） */
  steps: Ratio;
  /** 不合格の手番と理由。打ち切られた手番は「打ち切り: 理由」（それ以降の未実行の手番は載せない） */
  failures: StepFailure[];
  aborted: ScenarioRun['aborted'];
  expectedReach: Reach;
  /** 実際の到達 */
  reach: Reach;
  /** 到達が期待どおり */
  reachOk: boolean;
  /** 会話の開始時刻が営業時間外（定休日を含む。既定の営業カレンダーで判定） */
  startedOutsideHours: boolean;
  /** 打ち切りなし・全手番合格・到達が期待どおり */
  passed: boolean;
  /** 自由文の手番の応答時間（latencyMs） */
  textLatenciesMs: number[];
  /** 回答生成を呼んだ手番の応答時間（抽出も含む。質問の手番は2回呼ぶので遅い） */
  answerLatenciesMs: number[];
  /** 1会話の費用（各手番の costUsd の合計） */
  costUsd: number;
  costJpy: number;
  /** 検索できる条件が揃った手番ごとの must 件数と AND 件数 */
  searches: SearchPoint[];
  /** ベースライン（全条件 AND＋優先順位確認なし）の到達。定義は `baselineReachOf` */
  baselineReach: Reach;
}

/** 会話の開始時刻が営業時間外か（既定の営業カレンダー: 平日・土日 10〜19時、水曜定休。インメモリ DB の既定と同じ） */
export function startedOutsideHours(start: string): boolean {
  return !isOpenAt(new Date(start), defaultCalendar());
}

export function scoreScenario(run: ScenarioRun): ScenarioScore {
  const { scenario, turns, aborted } = run;
  const failures: StepFailure[] = [];
  let correct = 0;
  for (const [step, turn] of turns.entries()) {
    const problems = checkStep(scenario.steps[step]?.expect ?? {}, turn);
    if (problems.length === 0) correct += 1;
    else failures.push({ step, problems });
  }
  if (aborted) failures.push({ step: aborted.step, problems: [`打ち切り: ${aborted.reason}`] });

  const { reach } = reachOf(turns);
  const reachOk = reach === scenario.expectedReach;
  const costUsd = turns.reduce((sum, t) => sum + (t.costUsd ?? 0), 0);
  const measured = (pick: (t: HarnessTurn) => boolean): number[] =>
    turns.flatMap((t) => (pick(t) && t.latencyMs !== null ? [t.latencyMs] : []));

  return {
    id: scenario.id,
    title: scenario.title,
    steps: ratio(correct, scenario.steps.length),
    failures,
    aborted,
    expectedReach: scenario.expectedReach,
    reach,
    reachOk,
    startedOutsideHours: startedOutsideHours(scenario.start),
    passed: aborted === null && correct === scenario.steps.length && reachOk,
    textLatenciesMs: measured((t) => t.input.kind === 'text'),
    answerLatenciesMs: measured((t) => t.answers.length > 0),
    costUsd,
    costJpy: costUsd * EVAL_USD_JPY,
    searches: turns.flatMap((t, step) =>
      t.mustTotal !== null && t.andTotal !== null ? [{ step, mustTotal: t.mustTotal, andTotal: t.andTotal }] : [],
    ),
    baselineReach: baselineReachOf(turns),
  };
}

// ---------- 集計 ----------

/** 到達した（none でない）会話の割合を、全体・営業時間内・営業時間外で */
export interface ReachRates {
  all: Ratio;
  inHours: Ratio;
  outsideHours: Ratio;
}

export interface LatencySummary {
  n: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

/** 「全条件 AND では 0 件、優先順位つきでは N 件」の例。シナリオごとに、N が最大の手番を1つ */
export interface AndZeroExample {
  id: string;
  /** 台本の手番の番号（0 始まり） */
  step: number;
  /** 優先順位つきの件数 */
  mustTotal: number;
}

export interface ScenarioSummary {
  scenarios: number;
  /** 到達率（主要指標）と、ベースライン（全条件 AND＋優先順位確認なし）の到達率 */
  reach: ReachRates;
  baselineReach: ReachRates;
  /** 到達の種類が期待どおりだったシナリオの割合 */
  reachMatch: Ratio;
  /** 手番の合格率（全シナリオの手番の合計） */
  steps: Ratio;
  /** シナリオの合格率（打ち切りなし・全手番合格・到達が期待どおり） */
  passed: Ratio;
  /** 自由文の手番の応答時間 */
  latency: LatencySummary;
  /** 回答生成を呼んだ手番だけの応答時間 */
  answerLatency: LatencySummary;
  /** 1会話の費用の平均と最大 */
  cost: { meanUsd: number | null; maxUsd: number | null; meanJpy: number | null; maxJpy: number | null };
  /** 「AND では 0 件、優先順位つきでは N 件」の例（N の大きい順） */
  andZeroExamples: AndZeroExample[];
}

function latencySummary(values: readonly number[]): LatencySummary {
  return { n: values.length, p50Ms: percentile(values, 50), p95Ms: percentile(values, 95) };
}

function reachRates(scores: readonly ScenarioScore[], pick: (s: ScenarioScore) => Reach): ReachRates {
  const rate = (among: (s: ScenarioScore) => boolean): Ratio => {
    const group = scores.filter(among);
    return ratio(group.filter((s) => pick(s) !== 'none').length, group.length);
  };
  return {
    all: rate(() => true),
    inHours: rate((s) => !s.startedOutsideHours),
    outsideHours: rate((s) => s.startedOutsideHours),
  };
}

export function summarizeScenarios(scores: readonly ScenarioScore[]): ScenarioSummary {
  const costs = scores.map((s) => s.costUsd);
  const mean = (values: readonly number[]): number | null =>
    values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
  const max = (values: readonly number[]): number | null => (values.length === 0 ? null : Math.max(...values));

  const andZeroExamples: AndZeroExample[] = [];
  for (const s of scores) {
    const hits = s.searches.filter((p) => p.andTotal === 0 && p.mustTotal > 0);
    if (hits.length === 0) continue;
    // 件数が同じなら先の手番
    const best = hits.reduce((a, b) => (b.mustTotal > a.mustTotal ? b : a));
    andZeroExamples.push({ id: s.id, step: best.step, mustTotal: best.mustTotal });
  }
  andZeroExamples.sort((a, b) => b.mustTotal - a.mustTotal || (a.id < b.id ? -1 : 1));

  return {
    scenarios: scores.length,
    reach: reachRates(scores, (s) => s.reach),
    baselineReach: reachRates(scores, (s) => s.baselineReach),
    reachMatch: ratio(scores.filter((s) => s.reachOk).length, scores.length),
    steps: ratio(
      scores.reduce((sum, s) => sum + s.steps.correct, 0),
      scores.reduce((sum, s) => sum + s.steps.total, 0),
    ),
    passed: ratio(scores.filter((s) => s.passed).length, scores.length),
    latency: latencySummary(scores.flatMap((s) => s.textLatenciesMs)),
    answerLatency: latencySummary(scores.flatMap((s) => s.answerLatenciesMs)),
    cost: {
      meanUsd: mean(costs),
      maxUsd: max(costs),
      meanJpy: mean(costs.map((c) => c * EVAL_USD_JPY)),
      maxJpy: max(costs.map((c) => c * EVAL_USD_JPY)),
    },
    andZeroExamples,
  };
}
