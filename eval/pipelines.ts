/**
 * 評価で比べる構成（EvalConfig）を、harness に差し込む Pipeline にする（DESIGN.md 4.4・7.2・10.2）。
 *
 * - two-model: 本番と同じ（`src/server/deps.ts` の `createExtractor`（Haiku 4.5）＋ `createAnswerer`（Sonnet 5.5））。
 *   回答生成のクライアントは本番と同じ短いタイムアウト・再試行なし（`createAnswerer` の既定）を使う
 * - haiku-answer: 回答生成も Haiku 4.5（引き継ぎ書6章②の (b)）
 * - one-model: Sonnet 5.5 の1回で抽出と回答を兼ねる（`src/lib/llm/combined.ts`。引き継ぎ書6章②の (a)）
 *
 * one-model は回答を内部に預けるので、**会話（ケース・シナリオ）ごとに作り直す**。ほかの構成も同じく毎回作ってよい。
 */
import { createAnthropicClient, type LlmClient, type Logger } from '@/lib/llm/client';
import { createCombinedPipeline } from '@/lib/llm/combined';
import { MODEL_FAST, MODEL_SMART } from '@/lib/llm/models';
import { createAnswerer, createExtractor } from '@/server/deps';
import type { Pipeline } from './harness';
import type { EvalConfig } from './types';

export interface PipelineOptions {
  /** 抽出のクライアント（one-model では抽出と回答の両方）。既定は本番と同じ createAnthropicClient() */
  client?: LlmClient;
  /** 回答生成のクライアント（two-model・haiku-answer）。既定は createAnswerer の既定（短いタイムアウト・再試行なし） */
  answerClient?: LlmClient;
  logger?: Logger;
  /** false で抽出の前段の辞書を通さない（two-model・haiku-answer の抽出だけに効く） */
  useDictionary?: boolean;
  /** 抽出のモデルの上書き（ランナーの `--model`。one-model では抽出と回答を兼ねるモデル）。省略時は CONFIG_MODELS */
  extractModel?: string;
}

/** 構成ごとに使うモデル（結果ファイルとレポートに残す） */
export const CONFIG_MODELS: Record<EvalConfig, { extract: string; answer: string }> = {
  'two-model': { extract: MODEL_FAST, answer: MODEL_SMART },
  'haiku-answer': { extract: MODEL_FAST, answer: MODEL_FAST },
  'one-model': { extract: MODEL_SMART, answer: MODEL_SMART },
};

export function createPipeline(config: EvalConfig, options: PipelineOptions = {}): Pipeline {
  const { logger } = options;
  const models = CONFIG_MODELS[config];
  const extractModel = options.extractModel ?? models.extract;
  if (config === 'one-model') {
    const { extract, answer } = createCombinedPipeline(options.client ?? createAnthropicClient(), { model: extractModel, logger });
    return { name: config, extract, answer };
  }
  return {
    name: config,
    extract: createExtractor(options.client, { model: extractModel, logger, useDictionary: options.useDictionary }),
    answer: createAnswerer(options.answerClient, { model: models.answer, logger }),
  };
}
