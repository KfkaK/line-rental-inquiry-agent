/**
 * テスト用: Anthropic の API が返すエラーを、SDK が投げるのと同じ形（APIError.generate）で作る。
 * 本番のコードからは使わない
 */
import Anthropic from '@anthropic-ai/sdk';

export function anthropicApiError(status: number, type: string, message: string): InstanceType<typeof Anthropic.APIError> {
  return Anthropic.APIError.generate(status, { type: 'error', error: { type, message } }, undefined, new Headers());
}

/** 2026-10-10 に実際に返った残高切れ（引き継ぎ書8章） */
export const CREDIT_TOO_LOW = () =>
  anthropicApiError(
    400,
    'invalid_request_error',
    'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
  );
