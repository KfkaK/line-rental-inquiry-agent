/**
 * シナリオ（複数ターンの台本）を本番と同じ経路（handleEvent）で回す（DESIGN.md 7章・7.1 の3）。
 *
 * - `runScenario`: 台本の手番を順に会話の土台（eval/harness.ts）へ流し、手番ごとの結果（HarnessTurn）を集める
 * - `oraclePipeline`: LLM の代わりに台本の「正解の抽出」と「正解の回答」を返す偽物。`npm test` が全シナリオをこれで回し、
 *   期待（expect）が会話エンジンの仕様と合っているかを確かめる（期待の書き損じを、LLM の不正解と取り違えないため）
 */
import type { Property } from '@/domain/types';
import { createConversationHarness, type ConversationHarness, type HarnessTurn, type Pipeline } from './harness';
import type { ScenarioCase, ScenarioInput } from './types';

export interface ScenarioRun {
  scenario: ScenarioCase;
  /** 回した構成の名前（Pipeline.name） */
  pipeline: string;
  /** 手番ごとの結果（台本の手番と同じ順）。打ち切られたら、打ち切られる手前までの手番だけ */
  turns: HarnessTurn[];
  /**
   * 打ち切り。押すボタンが見つからない・提示リストに番号が無いなどで手番を実行できなかったとき、そこで台本を止める。
   * LLM の抽出がずれると次のボタンが出ないことがあるので、これは不合格に数える（採点は scoreScenario）。
   * `step` は台本の手番の番号（0 始まり。`scenario.steps[step]` が実行できなかった手番）
   */
  aborted: { step: number; reason: string } | null;
}

/** 台本の手番を順に回す。会話ごとに作り直した土台で、開始時刻は `s.start` */
export async function runScenario(
  s: ScenarioCase,
  pipeline: Pipeline,
  properties: readonly Property[],
): Promise<ScenarioRun> {
  const harness = createConversationHarness({ properties, pipeline, start: new Date(s.start) });
  const turns: HarnessTurn[] = [];
  let aborted: ScenarioRun['aborted'] = null;
  for (const [step, { input }] of s.steps.entries()) {
    try {
      turns.push(await perform(harness, input));
    } catch (error) {
      aborted = { step, reason: error instanceof Error ? error.message : String(error) };
      break;
    }
  }
  return { scenario: s, pipeline: pipeline.name, turns, aborted };
}

function perform(harness: ConversationHarness, input: ScenarioInput): Promise<HarnessTurn> {
  switch (input.kind) {
    case 'follow':
      return harness.send({ kind: 'follow' });
    case 'text':
      return harness.send({ kind: 'text', text: input.text });
    case 'tap':
      return harness.tap(input.label);
    case 'tapIndex':
      return harness.tapIndex(input.index);
    case 'card':
      return harness.card(input.button, input.position);
  }
}

// ---------- 正解の偽物 ----------

/** 偽の抽出・回答生成が記録する応答時間（ミリ秒）と費用（USD）。実測ではなく、型を埋めるだけの小さな固定値 */
export const ORACLE_LATENCY_MS = 1;
export const ORACLE_EXTRACT_COST_USD = 0.001;
export const ORACLE_ANSWER_COST_USD = 0.002;

/**
 * 台本の正解で動く偽のパイプライン。
 * - 抽出: text の手番の `extraction` を、呼ばれた順に返す（会話エンジンが抽出を呼ぶのは text の手番だけ）
 * - 回答生成: `answer` を持つ手番を、呼ばれた順に対応させる。answered はレコードで答えられた短い定型の回答文（引き継ぎなし）、
 *   handoff は本文なしで担当者へ回す（エンジンが定型の引き継ぎ文とメモを足す）
 *
 * 台本より多く呼ばれたら（台本の書き損じ・エンジンの仕様変更）例外を投げる。土台が記録して手番の `error` に残るので、
 * 期待の検査で落ちる
 */
export function oraclePipeline(s: ScenarioCase): Pipeline {
  const extractions = s.steps.flatMap((step) => (step.input.kind === 'text' ? [step.extraction] : []));
  const answers = s.steps.flatMap((step) => (step.answer ? [step.answer] : []));
  let extractCalls = 0;
  let answerCalls = 0;
  return {
    name: 'oracle',
    extract: async () => {
      const result = extractions[extractCalls++];
      if (!result) throw new Error(`${s.id}: 正解の抽出が足りません（${extractCalls} 回目の呼び出し。text の手番に extraction を書く）`);
      return { result, latencyMs: ORACLE_LATENCY_MS, costUsd: ORACLE_EXTRACT_COST_USD, model: 'oracle' };
    },
    answer: async ({ targets }) => {
      const kind = answers[answerCalls++];
      if (!kind) throw new Error(`${s.id}: 正解の回答が足りません（${answerCalls} 回目の呼び出し。質問の手番に answer を書く）`);
      const base = { verification: 'ok' as const, latencyMs: ORACLE_LATENCY_MS, costUsd: ORACLE_ANSWER_COST_USD };
      if (kind === 'handoff') return { ...base, text: null, handoff: { topic: null } };
      const names = targets.map((t) => `「${t.property.name}」`).join('と');
      return { ...base, text: `${names}について、物件情報の記載どおりにお答えしました。`, handoff: null };
    },
  };
}
