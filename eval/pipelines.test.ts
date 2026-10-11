/**
 * 評価で比べる構成（eval/pipelines.ts）のテスト。偽のクライアントに渡るリクエストで、モデル・辞書・構成ごとの経路を確かめる。
 */
import { describe, expect, it } from 'vitest';
import { createFakeLlmClient } from '@/lib/llm/client';
import { MODEL_FAST, MODEL_SMART } from '@/lib/llm/models';
import { CONFIG_MODELS, createPipeline } from './pipelines';
import { EVAL_CONFIGS } from './types';

const INPUT = { intent: 'offTopic', ops: [], targetPositions: [], viewingTimes: [], forbiddenTopic: null };
const request = { utterance: '渋谷で8万以内', slots: { tags: [] }, shown: [], now: new Date('2026-10-15T21:30:00+09:00') };
const quiet = { error: () => {} };

describe('CONFIG_MODELS', () => {
  it('3つの構成すべてにモデルがある', () => {
    expect(Object.keys(CONFIG_MODELS).sort()).toEqual([...EVAL_CONFIGS].sort());
    expect(CONFIG_MODELS['two-model']).toEqual({ extract: MODEL_FAST, answer: MODEL_SMART });
    expect(CONFIG_MODELS['haiku-answer']).toEqual({ extract: MODEL_FAST, answer: MODEL_FAST });
    expect(CONFIG_MODELS['one-model']).toEqual({ extract: MODEL_SMART, answer: MODEL_SMART });
  });
});

describe('createPipeline', () => {
  it('Pipeline の名前は構成の名前', () => {
    for (const config of EVAL_CONFIGS) expect(createPipeline(config, { client: createFakeLlmClient([]) }).name).toBe(config);
  });

  it('two-model・haiku-answer の抽出は Haiku、one-model の抽出は Sonnet で呼ぶ', async () => {
    for (const [config, model] of [
      ['two-model', MODEL_FAST],
      ['haiku-answer', MODEL_FAST],
      ['one-model', MODEL_SMART],
    ] as const) {
      const client = createFakeLlmClient([{ input: { ...INPUT, answer: null } }]);
      await createPipeline(config, { client, logger: quiet }).extract(request);
      expect(client.calls[0].model, config).toBe(model);
    }
  });

  it('extractModel で抽出のモデルを上書きできる', async () => {
    const client = createFakeLlmClient([{ input: INPUT }]);
    await createPipeline('two-model', { client, logger: quiet, extractModel: 'claude-sonnet-5-5' }).extract(request);
    expect(client.calls[0].model).toBe('claude-sonnet-5-5');
  });

  it('useDictionary: false なら、抽出の前段の辞書のヒントを渡さない（ユーザーメッセージが変わる）', async () => {
    const withDict = createFakeLlmClient([{ input: INPUT }]);
    const withoutDict = createFakeLlmClient([{ input: INPUT }]);
    await createPipeline('two-model', { client: withDict, logger: quiet }).extract(request);
    await createPipeline('two-model', { client: withoutDict, logger: quiet, useDictionary: false }).extract(request);
    expect(withDict.calls[0].user).not.toBe(withoutDict.calls[0].user);
    expect(withDict.calls[0].system).toBe(withoutDict.calls[0].system);
  });

  it('one-model は抽出と回答を同じツール（submit_turn）の1回の呼び出しで兼ねる', async () => {
    const client = createFakeLlmClient([{ input: { ...INPUT, answer: null } }]);
    await createPipeline('one-model', { client, logger: quiet }).extract(request);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].tool.name).toBe('submit_turn');
  });
});
