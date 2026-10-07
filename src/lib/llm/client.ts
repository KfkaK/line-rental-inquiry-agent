/**
 * Claude を「ツール呼び出しで構造化出力を1回取る」だけの薄い口（DESIGN.md 4.1・不変条件 10）。
 * 呼び出し側は `LlmClient` だけに依存し、テストは `createFakeLlmClient`、本番は `createAnthropicClient` を渡す。
 * 実キーなしで `npm test` が通るよう、API キーは `createAnthropicClient` の中（最初の呼び出し時）まで読まない。
 */
import Anthropic from '@anthropic-ai/sdk';
import { requireEnv } from '../env';
import { supportsForcedToolChoice, supportsSampling, usesRefusalFallback } from './models';
import type { TokenUsage } from './pricing';

export type { TokenUsage } from './pricing';

export interface Logger {
  error(message: string, ...rest: unknown[]): void;
}

export interface LlmToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; [key: string]: unknown };
}

export interface LlmCallRequest {
  model: string;
  /**
   * 固定のシステムプロンプト。キャッシュの対象なので、日時・ユーザー発話・スロットなど毎回変わるものは入れない
   * （1バイトでも変わると、ツール定義とこの文章のキャッシュがすべて無効になる）。
   */
  system: string;
  /** 毎回変わる入力（現在日時・スロット・ユーザー発話）。キャッシュの対象外 */
  user: string;
  tool: LlmToolDef;
  maxTokens?: number;
  /** サンプリング指定を受け付けないモデル（Sonnet 5.5 など）では無視する */
  temperature?: number;
  /** ツール入力のスキーマ保証（`strict`）。スキーマが strict の制約（additionalProperties: false など）を満たすときだけ */
  strict?: boolean;
  /** システムプロンプトとツール定義に cache_control を付ける（既定 true） */
  cache?: boolean;
}

export interface LlmCallResult<T> {
  /** ツールに渡された入力。検証されていないので、呼び出し側が zod などで検証する */
  input: T;
  usage: TokenUsage;
  latencyMs: number;
  /** 実際に応答したモデル（日付つきの ID のことがある） */
  model: string;
}

export interface LlmClient {
  callTool<T = unknown>(req: LlmCallRequest): Promise<LlmCallResult<T>>;
}

/** API 自体は成功したが、ツール呼び出しが得られなかった（呼ばれなかった・拒否・出力の途中切れ）。再試行の対象 */
export class LlmToolCallError extends Error {
  constructor(
    message: string,
    readonly reason: 'no_tool_use' | 'refusal' | 'max_tokens',
  ) {
    super(message);
    this.name = 'LlmToolCallError';
  }
}

// ---------- リクエストの組み立て（純関数。テストしやすいよう分けている） ----------

const DEFAULT_MAX_TOKENS = 1024;

/**
 * Messages API のリクエスト。
 * - キャッシュは接頭辞一致（tools → system → messages の順）。ツール定義の末尾とシステムプロンプトの末尾に
 *   ブレークポイントを置き、毎回変わる `user` はその後ろに置く。
 * - キャッシュの最小トークン数に届かない接頭辞は、cache_control を付けても黙って効かない（エラーも出ない）。
 *   Haiku 4.5 は 4096、Sonnet 5.5 は 512（models.ts の minCacheableTokens）。効いたかは usage.cacheReadTokens で見る。
 * - Sonnet 5.5 / Opus 5.5 は `tool_choice` の強制（tool / any）が 400 になるので、`auto` ＋ 呼ぶ指示で代える。
 */
export function buildMessageParams(req: LlmCallRequest): Anthropic.MessageCreateParamsNonStreaming {
  const forced = supportsForcedToolChoice(req.model);
  const cache = req.cache !== false;
  const cacheControl = { type: 'ephemeral' as const };
  const user = forced
    ? req.user
    : `${req.user}\n\n（${req.tool.name} ツールを必ず1回だけ呼んで回答してください。ツール以外の文章は出力しないでください。）`;
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: req.model,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: [{ type: 'text', text: req.system, ...(cache ? { cache_control: cacheControl } : {}) }],
    tools: [
      {
        name: req.tool.name,
        description: req.tool.description,
        input_schema: req.tool.inputSchema,
        ...(req.strict ? { strict: true } : {}),
        ...(cache ? { cache_control: cacheControl } : {}),
      },
    ],
    tool_choice: forced
      ? { type: 'tool', name: req.tool.name, disable_parallel_tool_use: true }
      : { type: 'auto', disable_parallel_tool_use: true },
    messages: [{ role: 'user', content: user }],
  };
  if (req.temperature !== undefined && supportsSampling(req.model)) params.temperature = req.temperature;
  return params;
}

/** SDK の Message（beta 版も）のうち、ここで読む部分だけ */
export interface MessageLike {
  model: string;
  stop_reason: string | null;
  content: Array<{ type: string; name?: string; input?: unknown }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
}

export function usageOf(message: Pick<MessageLike, 'usage'>): TokenUsage {
  return {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
  };
}

/** 応答からツール入力を取り出す。得られなければ LlmToolCallError */
export function parseToolMessage(message: MessageLike, toolName: string): { input: unknown; usage: TokenUsage; model: string } {
  if (message.stop_reason === 'refusal') {
    throw new LlmToolCallError('モデルが応答を拒否しました（stop_reason: refusal）', 'refusal');
  }
  const block = message.content.find((b) => b.type === 'tool_use' && b.name === toolName);
  if (!block) throw new LlmToolCallError(`ツール ${toolName} が呼ばれませんでした（stop_reason: ${String(message.stop_reason)}）`, 'no_tool_use');
  // max_tokens で切れたツール入力は、一見妥当な途中までの JSON として返ることがあるので使わない
  if (message.stop_reason === 'max_tokens') {
    throw new LlmToolCallError('ツール入力が max_tokens で途中切れです', 'max_tokens');
  }
  return { input: block.input, usage: usageOf(message), model: message.model };
}

// ---------- Anthropic SDK の実装 ----------

export interface AnthropicClientOptions {
  /** 省略時は環境変数 ANTHROPIC_API_KEY（最初の呼び出し時に読む） */
  apiKey?: string;
  /** 1回のリクエストのタイムアウト（ミリ秒）。LINE の返信は待たせられないので SDK の既定（10 分）より短くする */
  timeoutMs?: number;
  /** SDK の自動再試行（429・5xx・接続エラー）の回数 */
  maxRetries?: number;
  /**
   * 安全分類器が拒否したとき、サーバー側で別モデルに引き継ぐ（`fallbacks: 'default'`・beta）。
   * 回答生成（Sonnet 5.5）で有効にすることを推奨。Haiku 4.5 には効かせない。既定 false。
   * フォールバックが働くと応答のモデルが変わるので、費用は応答の `model` で引く（pricing.ts に載っている必要がある）。
   */
  refusalFallback?: boolean;
  /** テスト用に SDK を差し替える */
  sdk?: Pick<Anthropic, 'messages' | 'beta'>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 1;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export function createAnthropicClient(options: AnthropicClientOptions = {}): LlmClient {
  let sdk = options.sdk;
  const getSdk = (): Pick<Anthropic, 'messages' | 'beta'> => {
    sdk ??= new Anthropic({
      apiKey: options.apiKey ?? requireEnv('ANTHROPIC_API_KEY'),
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    });
    return sdk;
  };

  return {
    async callTool<T = unknown>(req: LlmCallRequest): Promise<LlmCallResult<T>> {
      const client = getSdk();
      const params = buildMessageParams(req);
      const started = performance.now();
      const message: MessageLike =
        options.refusalFallback && usesRefusalFallback(req.model)
          ? await client.beta.messages.create({
              ...params,
              betas: [FALLBACK_BETA],
              fallbacks: 'default',
            } as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming)
          : await client.messages.create(params);
      const latencyMs = Math.round(performance.now() - started);
      const parsed = parseToolMessage(message, req.tool.name);
      return { input: parsed.input as T, usage: parsed.usage, latencyMs, model: parsed.model };
    },
  };
}

// ---------- テスト用の偽物 ----------

export type FakeResponse =
  | { input: unknown; usage?: Partial<TokenUsage>; latencyMs?: number; model?: string }
  | { error: Error };

export interface FakeLlmClient extends LlmClient {
  /** 受け取ったリクエスト（呼び出し順） */
  readonly calls: LlmCallRequest[];
}

/**
 * 応答を順番に返す偽物。関数を渡すとリクエストを見て応答を決められる。応答が尽きたら例外。
 * `{ error }` を渡すと、その例外を投げる（LlmToolCallError を渡せば「ツールが呼ばれなかった」を再現できる）。
 */
export function createFakeLlmClient(responses: ReadonlyArray<FakeResponse | ((req: LlmCallRequest) => FakeResponse)>): FakeLlmClient {
  const calls: LlmCallRequest[] = [];
  let next = 0;
  return {
    calls,
    async callTool<T = unknown>(req: LlmCallRequest): Promise<LlmCallResult<T>> {
      calls.push(req);
      const entry = responses[next++];
      if (entry === undefined) throw new Error('偽物の LLM クライアントの応答が尽きました');
      const response = typeof entry === 'function' ? entry(req) : entry;
      if ('error' in response) throw response.error;
      return {
        input: structuredClone(response.input) as T,
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          ...response.usage,
        },
        latencyMs: response.latencyMs ?? 5,
        model: response.model ?? req.model,
      };
    },
  };
}
