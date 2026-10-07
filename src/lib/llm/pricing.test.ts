import { describe, expect, it } from 'vitest';
import { MODEL_FAST, MODEL_SMART } from './models';
import { addUsage, costUsd, EMPTY_USAGE, PRICING_USD_PER_MTOK, priceOf } from './pricing';

describe('料金表', () => {
  it('Haiku 4.5 は入力 $1・出力 $5（スキルの料金表）', () => {
    expect(priceOf(MODEL_FAST)).toEqual({ input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 });
  });

  it('Sonnet 5.5 は入力 $2・出力 $10（キャッシュ読み込み $0.20）', () => {
    expect(priceOf(MODEL_SMART)).toEqual({ input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 });
  });

  it('キャッシュ書き込みは入力の 1.25 倍（5 分 TTL）、読み込みは 0.1 倍（Opus 5.5 だけ 0.05 倍）', () => {
    for (const [model, p] of Object.entries(PRICING_USD_PER_MTOK)) {
      expect(p.cacheWrite, model).toBeCloseTo(p.input * 1.25, 10);
      expect(p.cacheRead, model).toBeCloseTo(model === 'claude-opus-5-5' ? p.input * 0.05 : p.input * 0.1, 10);
    }
  });

  it('日付つきのモデル ID（API が返す形）も引ける', () => {
    expect(priceOf('claude-haiku-4-5-20251001')).toEqual(priceOf('claude-haiku-4-5'));
  });
});

describe('costUsd', () => {
  it('入力・出力・キャッシュ書き込み・キャッシュ読み込みを別々の単価で足す', () => {
    // Haiku: 入力 2,000 × $1 + 出力 500 × $5 + 書き込み 4,000 × $1.25 + 読み込み 10,000 × $0.1（per MTok）
    const usage = { inputTokens: 2000, outputTokens: 500, cacheWriteTokens: 4000, cacheReadTokens: 10000 };
    expect(costUsd(MODEL_FAST, usage)).toBeCloseTo((2000 * 1 + 500 * 5 + 4000 * 1.25 + 10000 * 0.1) / 1_000_000, 12);
  });

  it('Sonnet 5.5 の1回分', () => {
    const usage = { inputTokens: 1000, outputTokens: 300, cacheWriteTokens: 0, cacheReadTokens: 3000 };
    expect(costUsd(MODEL_SMART, usage)).toBeCloseTo((1000 * 2 + 300 * 10 + 3000 * 0.2) / 1_000_000, 12);
  });

  it('キャッシュが効くと同じ入力でも安くなる', () => {
    const cold = costUsd(MODEL_SMART, { inputTokens: 5000, outputTokens: 200, cacheWriteTokens: 0, cacheReadTokens: 0 });
    const warm = costUsd(MODEL_SMART, { inputTokens: 500, outputTokens: 200, cacheWriteTokens: 0, cacheReadTokens: 4500 });
    expect(warm).toBeLessThan(cold);
  });

  it('使用量が 0 なら 0', () => {
    expect(costUsd(MODEL_FAST, EMPTY_USAGE)).toBe(0);
  });

  it('日付つきのモデル ID でも計算できる', () => {
    const usage = { inputTokens: 1000, outputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0 };
    expect(costUsd('claude-haiku-4-5-20251001', usage)).toBe(costUsd(MODEL_FAST, usage));
  });

  it('料金表に無いモデルは 0 にせず例外（費用上限の計算が狂うのを防ぐ）', () => {
    expect(() => costUsd('claude-unknown-9', EMPTY_USAGE)).toThrow(/料金表にないモデル/);
  });
});

describe('addUsage', () => {
  it('項目ごとに足す（入力を書き換えない）', () => {
    const a = { inputTokens: 1, outputTokens: 2, cacheWriteTokens: 3, cacheReadTokens: 4 };
    const b = { inputTokens: 10, outputTokens: 20, cacheWriteTokens: 30, cacheReadTokens: 40 };
    expect(addUsage(a, b)).toEqual({ inputTokens: 11, outputTokens: 22, cacheWriteTokens: 33, cacheReadTokens: 44 });
    expect(a.inputTokens).toBe(1);
  });
});
