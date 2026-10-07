/**
 * モデル ID と、モデルごとの API の癖（DESIGN.md 4.1）。
 * ID は claude-api スキルの「Current Models」表（2026-09-25 時点）から。日付つきの別名は付けない。
 */

/** 意図分類＋条件抽出・タグ抽出・根拠検証（安い・速い）。Haiku 4.5: $1 / $5 per MTok */
export const MODEL_FAST = 'claude-haiku-4-5';

/** 回答生成（高性能）。Sonnet 5.5: $2 / $10 per MTok */
export const MODEL_SMART = 'claude-sonnet-5-5';

/** API が返す `model` は日付つき（claude-haiku-4-5-20251001）のことがあるので、比較・料金表の引き当ては基本 ID に直す */
export function baseModelId(model: string): string {
  return model.replace(/-\d{8}$/, '');
}

/**
 * `tool_choice` の `tool` / `any`（ツールの強制）が 400 になるモデル。
 * 強制できないモデルでは `auto` ＋ 「このツールを呼ぶこと」の指示で代える（client.ts）。
 */
const FORCED_TOOL_CHOICE_REJECTED = new Set(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-mythos-5-1']);

export function supportsForcedToolChoice(model: string): boolean {
  return !FORCED_TOOL_CHOICE_REJECTED.has(baseModelId(model));
}

/** `temperature` などサンプリング指定を受け付けない（既定値以外は 400）モデル */
const SAMPLING_REJECTED = new Set(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-mythos-5-1']);

export function supportsSampling(model: string): boolean {
  return !SAMPLING_REJECTED.has(baseModelId(model));
}

/**
 * サーバー側のフォールバック（`fallbacks: 'default'`）の対象にすべきモデル。
 * 安全分類器が応答を拒否（stop_reason: 'refusal'）しうるモデル。Haiku 4.5 は対象外。
 */
const REFUSAL_FALLBACK_MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1']);

export function usesRefusalFallback(model: string): boolean {
  return REFUSAL_FALLBACK_MODELS.has(baseModelId(model));
}

/**
 * プロンプトキャッシュの最小トークン数（これに届かない接頭辞は cache_control を付けても黙って効かない）。
 * 出典: claude-api スキル shared/prompt-caching.md。Sonnet 5.5 は「要確認」と注記されている値。
 */
const MIN_CACHEABLE_TOKENS: Record<string, number> = {
  'claude-haiku-4-5': 4096,
  'claude-sonnet-5-5': 512,
  'claude-opus-5-5': 512,
};

export function minCacheableTokens(model: string): number | undefined {
  return MIN_CACHEABLE_TOKENS[baseModelId(model)];
}
