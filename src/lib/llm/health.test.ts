import { afterEach, describe, expect, it, vi } from 'vitest';
import { anthropicApiError, CREDIT_TOO_LOW } from './fixtures';
import { checkAiAvailability } from './health';
import { MODEL_FAST } from './models';

const sdkOf = (create: ReturnType<typeof vi.fn>) => ({ messages: { create } }) as never;

describe('checkAiAvailability', () => {
  const original = process.env.ANTHROPIC_API_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = original;
  });

  it('Haiku に1トークンだけ答えさせ、返れば ok', async () => {
    const create = vi.fn().mockResolvedValue({});
    await expect(checkAiAvailability({ sdk: sdkOf(create) })).resolves.toEqual({ ok: true });
    expect(create).toHaveBeenCalledWith({ model: MODEL_FAST, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });
  });

  it('残高切れ・キーの失効は outage つき。detail は status と種類だけ（応答の本文を出さない）', async () => {
    const credit = await checkAiAvailability({ sdk: sdkOf(vi.fn().mockRejectedValue(CREDIT_TOO_LOW())) });
    expect(credit).toEqual({ ok: false, outage: 'credit', detail: 'status=400 type=invalid_request_error' });
    const auth = await checkAiAvailability({
      sdk: sdkOf(vi.fn().mockRejectedValue(anthropicApiError(401, 'authentication_error', 'invalid x-api-key'))),
    });
    expect(auth).toMatchObject({ ok: false, outage: 'auth' });
  });

  it('一時的な失敗は outage が null', async () => {
    const result = await checkAiAvailability({ sdk: sdkOf(vi.fn().mockRejectedValue(anthropicApiError(529, 'overloaded_error', 'Overloaded'))) });
    expect(result).toMatchObject({ ok: false, outage: null });
  });

  it('ANTHROPIC_API_KEY が無ければ呼ばずに auth', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(checkAiAvailability()).resolves.toEqual({ ok: false, outage: 'auth', detail: 'ANTHROPIC_API_KEY が未設定' });
  });
});
