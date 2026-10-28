/**
 * Claude が呼べるかの確かめ（毎朝の Cron から1回。引き継ぎ書11章）。
 * 利用者の発話が無い日でも、残高切れ・キーの失効（`line-rental-agent-2` は 2026-12-31 に失効）に翌朝までに気づくため。
 * Haiku に1トークンだけ答えさせる（1回 $0.00002 ほど。1日の費用上限には数えない）。残高とキーの両方を確かめられる無料の口が無いため
 */
import Anthropic from '@anthropic-ai/sdk';
import { optionalEnv } from '../env';
import { classifyLlmOutage, type LlmOutage } from './client';
import { MODEL_FAST } from './models';

export type AiAvailability =
  | { ok: true }
  /** outage が null なのは待てば直りうるエラー（429・5xx・時間切れ）。運営者には知らせず、ログだけ */
  | { ok: false; outage: LlmOutage | null; detail: string };

const CHECK_TIMEOUT_MS = 15_000;

export async function checkAiAvailability(options: { sdk?: Pick<Anthropic, 'messages'> } = {}): Promise<AiAvailability> {
  let sdk = options.sdk;
  if (!sdk) {
    const apiKey = optionalEnv('ANTHROPIC_API_KEY');
    if (!apiKey) return { ok: false, outage: 'auth', detail: 'ANTHROPIC_API_KEY が未設定' };
    sdk = new Anthropic({ apiKey, timeout: CHECK_TIMEOUT_MS, maxRetries: 1 });
  }
  try {
    await sdk.messages.create({ model: MODEL_FAST, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });
    return { ok: true };
  } catch (error) {
    // メッセージには応答の本文が入るので、ログに出すのは status と種類だけ
    const detail =
      error instanceof Anthropic.APIError
        ? `status=${String(error.status)} type=${error.type ?? 'unknown'}`
        : error instanceof Error
          ? error.name
          : 'unknown';
    return { ok: false, outage: classifyLlmOutage(error), detail };
  }
}
