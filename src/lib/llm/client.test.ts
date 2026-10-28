import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildMessageParams,
  classifyLlmOutage,
  createAnthropicClient,
  createFakeLlmClient,
  LlmToolCallError,
  parseToolMessage,
  type LlmCallRequest,
  type MessageLike,
} from './client';
import { anthropicApiError, CREDIT_TOO_LOW } from './fixtures';
import { MODEL_FAST, MODEL_SMART, minCacheableTokens, supportsForcedToolChoice, supportsSampling } from './models';

const TOOL = {
  name: 'submit',
  description: 'テスト用のツール',
  inputSchema: { type: 'object' as const, properties: { x: { type: 'string' } }, required: ['x'] },
};

const request = (model: string, extra: Partial<LlmCallRequest> = {}): LlmCallRequest => ({
  model,
  system: '固定のシステムプロンプト',
  user: '毎回変わる入力',
  tool: TOOL,
  ...extra,
});

const message = (overrides: Partial<MessageLike> = {}): MessageLike => ({
  model: 'claude-haiku-4-5-20251001',
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', name: 'submit', input: { x: 'ok' } }],
  usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 4000, cache_read_input_tokens: 0 },
  ...overrides,
});

describe('モデルの癖', () => {
  it('Haiku 4.5 はツールを強制でき、サンプリング指定も受ける。キャッシュの最小は 4096', () => {
    expect(supportsForcedToolChoice(MODEL_FAST)).toBe(true);
    expect(supportsSampling(MODEL_FAST)).toBe(true);
    expect(minCacheableTokens(MODEL_FAST)).toBe(4096);
  });

  it('Sonnet 5.5 はツールを強制できず、サンプリング指定も受けない。キャッシュの最小は 512', () => {
    expect(supportsForcedToolChoice(MODEL_SMART)).toBe(false);
    expect(supportsForcedToolChoice('claude-sonnet-5-5-20260101')).toBe(false);
    expect(supportsSampling(MODEL_SMART)).toBe(false);
    expect(minCacheableTokens(MODEL_SMART)).toBe(512);
  });
});

describe('buildMessageParams', () => {
  it('Haiku: ツールを強制し、システムプロンプトとツール定義に cache_control を付け、発話は後ろの user に置く', () => {
    const params = buildMessageParams(request(MODEL_FAST, { temperature: 0, maxTokens: 700 }));
    expect(params.model).toBe(MODEL_FAST);
    expect(params.max_tokens).toBe(700);
    expect(params.tool_choice).toEqual({ type: 'tool', name: 'submit', disable_parallel_tool_use: true });
    expect(params.temperature).toBe(0);
    expect(params.system).toEqual([{ type: 'text', text: '固定のシステムプロンプト', cache_control: { type: 'ephemeral' } }]);
    expect(params.tools).toEqual([
      { name: 'submit', description: 'テスト用のツール', input_schema: TOOL.inputSchema, cache_control: { type: 'ephemeral' } },
    ]);
    expect(params.messages).toEqual([{ role: 'user', content: '毎回変わる入力' }]);
  });

  it('Sonnet 5.5: ツールを強制せず（auto）、呼ぶ指示を user に足し、temperature は送らない', () => {
    const params = buildMessageParams(request(MODEL_SMART, { temperature: 0 }));
    expect(params.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect(params).not.toHaveProperty('temperature');
    const content = params.messages[0].content as string;
    expect(content.startsWith('毎回変わる入力')).toBe(true);
    expect(content).toContain('submit ツールを必ず1回だけ呼んで');
  });

  it('cache: false なら cache_control を付けない。strict: true はツールに付く', () => {
    const params = buildMessageParams(request(MODEL_FAST, { cache: false, strict: true }));
    expect(JSON.stringify(params)).not.toContain('cache_control');
    expect(params.tools?.[0]).toMatchObject({ strict: true });
  });

  it('同じ system・tool なら、user が違ってもキャッシュされる接頭辞（tools と system）は同じ', () => {
    const a = buildMessageParams(request(MODEL_FAST, { user: '発話A' }));
    const b = buildMessageParams(request(MODEL_FAST, { user: '発話B' }));
    expect(JSON.stringify([a.tools, a.system])).toBe(JSON.stringify([b.tools, b.system]));
  });
});

describe('parseToolMessage', () => {
  it('ツール入力と使用量（キャッシュ分を含む）を取り出す', () => {
    const parsed = parseToolMessage(message({ usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 4000, cache_read_input_tokens: 7 } }), 'submit');
    expect(parsed.input).toEqual({ x: 'ok' });
    expect(parsed.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheWriteTokens: 4000, cacheReadTokens: 7 });
    expect(parsed.model).toBe('claude-haiku-4-5-20251001');
  });

  it('キャッシュの項目が null / 欠けでも 0 として扱う', () => {
    const parsed = parseToolMessage(message({ usage: { input_tokens: 5, output_tokens: 6, cache_creation_input_tokens: null } }), 'submit');
    expect(parsed.usage).toEqual({ inputTokens: 5, outputTokens: 6, cacheWriteTokens: 0, cacheReadTokens: 0 });
  });

  it('ツールが呼ばれなければ LlmToolCallError（no_tool_use）', () => {
    const err = catchSync(() => parseToolMessage(message({ stop_reason: 'end_turn', content: [{ type: 'text' }] }), 'submit'));
    expect(err).toBeInstanceOf(LlmToolCallError);
    expect((err as LlmToolCallError).reason).toBe('no_tool_use');
  });

  it('別名のツールが呼ばれたときも no_tool_use', () => {
    const err = catchSync(() => parseToolMessage(message({ content: [{ type: 'tool_use', name: 'other', input: {} }] }), 'submit'));
    expect((err as LlmToolCallError).reason).toBe('no_tool_use');
  });

  it('拒否（refusal）と途中切れ（max_tokens）は使わない', () => {
    expect((catchSync(() => parseToolMessage(message({ stop_reason: 'refusal' }), 'submit')) as LlmToolCallError).reason).toBe('refusal');
    expect((catchSync(() => parseToolMessage(message({ stop_reason: 'max_tokens' }), 'submit')) as LlmToolCallError).reason).toBe('max_tokens');
  });
});

describe('createAnthropicClient', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('作る時点では API キーを読まず、最初の呼び出しで読む（実キーなしで import できる）', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const client = createAnthropicClient();
    await expect(client.callTool(request(MODEL_FAST))).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it('SDK の messages.create を呼び、入力・使用量・モデルを返す', async () => {
    const create = vi.fn().mockResolvedValue(message());
    const client = createAnthropicClient({ sdk: { messages: { create }, beta: { messages: { create: vi.fn() } } } as never });
    const res = await client.callTool<{ x: string }>(request(MODEL_FAST));
    expect(res.input).toEqual({ x: 'ok' });
    expect(res.usage.cacheWriteTokens).toBe(4000);
    expect(res.model).toBe('claude-haiku-4-5-20251001');
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].tool_choice).toMatchObject({ type: 'tool', name: 'submit' });
  });

  it('refusalFallback は Sonnet 5.5 だけ beta 経由（fallbacks: default）。Haiku には効かせない', async () => {
    const create = vi.fn().mockResolvedValue(message());
    const betaCreate = vi.fn().mockResolvedValue(message({ model: MODEL_SMART }));
    const client = createAnthropicClient({
      refusalFallback: true,
      sdk: { messages: { create }, beta: { messages: { create: betaCreate } } } as never,
    });
    await client.callTool(request(MODEL_SMART));
    expect(betaCreate).toHaveBeenCalledTimes(1);
    expect(betaCreate.mock.calls[0][0]).toMatchObject({ fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] });
    expect(create).not.toHaveBeenCalled();

    await client.callTool(request(MODEL_FAST));
    expect(create).toHaveBeenCalledTimes(1);
    expect(betaCreate).toHaveBeenCalledTimes(1);
  });

  it('既定では beta のフォールバックを使わない', async () => {
    const create = vi.fn().mockResolvedValue(message({ model: MODEL_SMART }));
    const betaCreate = vi.fn();
    const client = createAnthropicClient({ sdk: { messages: { create }, beta: { messages: { create: betaCreate } } } as never });
    await client.callTool(request(MODEL_SMART));
    expect(create).toHaveBeenCalledTimes(1);
    expect(betaCreate).not.toHaveBeenCalled();
  });

  it('ツールが得られない応答は LlmToolCallError', async () => {
    const create = vi.fn().mockResolvedValue(message({ stop_reason: 'end_turn', content: [{ type: 'text' }] }));
    const client = createAnthropicClient({ sdk: { messages: { create }, beta: { messages: { create: vi.fn() } } } as never });
    await expect(client.callTool(request(MODEL_FAST))).rejects.toBeInstanceOf(LlmToolCallError);
  });
});

describe('classifyLlmOutage', () => {
  it('残高切れ: 400 の「credit balance is too low」と 402（billing_error）', () => {
    expect(classifyLlmOutage(CREDIT_TOO_LOW())).toBe('credit');
    expect(classifyLlmOutage(anthropicApiError(402, 'billing_error', 'There is an issue with your billing.'))).toBe('credit');
  });

  it('キーの無効・失効・権限なし: 401 と 403', () => {
    expect(classifyLlmOutage(anthropicApiError(401, 'authentication_error', 'invalid x-api-key'))).toBe('auth');
    expect(classifyLlmOutage(anthropicApiError(403, 'permission_error', 'not allowed'))).toBe('auth');
  });

  it('待てば直るもの・ほかの 400・API の外の例外は null', () => {
    expect(classifyLlmOutage(anthropicApiError(429, 'rate_limit_error', 'rate limited'))).toBeNull();
    expect(classifyLlmOutage(anthropicApiError(529, 'overloaded_error', 'Overloaded'))).toBeNull();
    expect(classifyLlmOutage(anthropicApiError(500, 'api_error', 'internal'))).toBeNull();
    expect(classifyLlmOutage(anthropicApiError(400, 'invalid_request_error', 'messages: roles must alternate'))).toBeNull();
    expect(classifyLlmOutage(new LlmToolCallError('no tool', 'no_tool_use'))).toBeNull();
    expect(classifyLlmOutage(new Error('credit balance is too low'))).toBeNull();
  });
});

describe('createFakeLlmClient', () => {
  it('応答を順に返し、リクエストを記録する', async () => {
    const fake = createFakeLlmClient([{ input: { a: 1 } }, { input: { a: 2 }, usage: { inputTokens: 7 }, latencyMs: 40, model: 'm' }]);
    const first = await fake.callTool(request(MODEL_FAST));
    const second = await fake.callTool(request(MODEL_FAST));
    expect(first).toMatchObject({ input: { a: 1 }, latencyMs: 5, model: MODEL_FAST });
    expect(second).toMatchObject({ input: { a: 2 }, latencyMs: 40, model: 'm' });
    expect(second.usage).toEqual({ inputTokens: 7, outputTokens: 50, cacheWriteTokens: 0, cacheReadTokens: 0 });
    expect(fake.calls).toHaveLength(2);
  });

  it('応答が尽きたら例外、{ error } はそのまま投げる、関数はリクエストを見て決める', async () => {
    const fake = createFakeLlmClient([{ error: new LlmToolCallError('no', 'no_tool_use') }, (req) => ({ input: { echo: req.user } })]);
    await expect(fake.callTool(request(MODEL_FAST))).rejects.toBeInstanceOf(LlmToolCallError);
    expect((await fake.callTool(request(MODEL_FAST, { user: 'こんにちは' }))).input).toEqual({ echo: 'こんにちは' });
    await expect(fake.callTool(request(MODEL_FAST))).rejects.toThrow(/尽きました/);
  });

  it('返した入力を書き換えても元の応答に影響しない', async () => {
    const response = { input: { list: [1] } };
    const fake = createFakeLlmClient([response]);
    const res = await fake.callTool<{ list: number[] }>(request(MODEL_FAST));
    res.input.list.push(2);
    expect(response.input.list).toEqual([1]);
  });
});

function catchSync(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}
