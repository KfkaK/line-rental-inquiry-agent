/**
 * モデル別の料金表（USD / 100万トークン）と1回あたりの費用計算（DESIGN.md 4.4・10.2）。
 * 出典: claude-api スキルの「Current Models」表（2026-09-25 時点）と shared/prompt-caching.md。
 * キャッシュ書き込みは 5 分 TTL（既定）の 1.25 倍、キャッシュ読み込みは入力の 0.1 倍（Opus 5.5 だけ 0.05 倍）。
 * 1 時間 TTL（2 倍）は使わない。値が変わったらこの表だけを直す。
 */
import { baseModelId } from './models';

export interface TokenUsage {
  /** キャッシュに触れなかった入力トークン（Anthropic の `input_tokens`。キャッシュ分は含まない） */
  inputTokens: number;
  outputTokens: number;
  /** キャッシュへ書き込んだ入力トークン（`cache_creation_input_tokens`） */
  cacheWriteTokens: number;
  /** キャッシュから読んだ入力トークン（`cache_read_input_tokens`） */
  cacheReadTokens: number;
}

export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export const PRICING_USD_PER_MTOK: Readonly<Record<string, ModelPrice>> = {
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
};

export const EMPTY_USAGE: Readonly<TokenUsage> = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };

export function priceOf(model: string): ModelPrice | undefined {
  return PRICING_USD_PER_MTOK[baseModelId(model)];
}

/** 1回分の費用（USD）。料金表に無いモデルは黙って 0 にせず例外にする（費用上限の計算が狂うため） */
export function costUsd(model: string, usage: TokenUsage): number {
  const price = priceOf(model);
  if (!price) throw new Error(`料金表にないモデルです: ${model}（src/lib/llm/pricing.ts に追加してください）`);
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheWriteTokens * price.cacheWrite +
      usage.cacheReadTokens * price.cacheRead) /
    1_000_000
  );
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  };
}
