/**
 * 3つのレポートが共有する整形・設定・結果ファイルの `config` の純関数のテスト。
 */
import { describe, expect, it } from 'vitest';
import {
  buildResultConfig,
  describeCutoff,
  formatJpy,
  formatMs,
  formatRateWithFraction,
  formatSettingsLines,
  formatUsd,
  formatUsdJpy,
  oneLine,
  truncate,
  type RunMeta,
} from './reportCommon';
import { ratio } from './score';

const AT = new Date('2026-10-15T21:30:00+09:00');

function makeMeta(overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    set: 'attack',
    config: 'two-model',
    dictionary: true,
    models: { extract: 'claude-haiku-4-5', answer: 'claude-sonnet-5-5' },
    modelOverride: false,
    fake: false,
    limit: null,
    ids: null,
    totalCases: 40,
    maxCostUsd: 2,
    cutoff: null,
    at: AT,
    ...overrides,
  };
}

describe('数字の整形', () => {
  it('割合と正解数/母数は「93.3%（14/15）」。母数 0 は —', () => {
    expect(formatRateWithFraction(ratio(14, 15))).toBe('93.3%（14/15）');
    expect(formatRateWithFraction(ratio(0, 0))).toBe('—');
  });

  it('応答時間は ms、費用は USD 小数4桁と円（小数1桁）。計測できなければ —', () => {
    expect(formatMs(1508)).toBe('1508 ms');
    expect(formatMs(null)).toBe('—');
    expect(formatUsd(0.0123)).toBe('$0.0123');
    expect(formatUsd(null)).toBe('—');
    expect(formatJpy(1.845)).toBe('1.8 円');
    expect(formatJpy(null)).toBe('—');
    // 1 USD = 150 円
    expect(formatUsdJpy(0.012)).toBe('$0.0120（1.8 円）');
    expect(formatUsdJpy(null)).toBe('—');
  });

  it('oneLine は改行を空白に、truncate は長い文を … で切る', () => {
    expect(oneLine('a\n  b')).toBe('a b');
    expect(truncate('短い', 10)).toBe('短い');
    expect(truncate('あいうえおかきくけこさ', 10)).toBe('あいうえおかきくけこ…');
    expect(truncate('あ\nい', 10)).toBe('あ い');
  });
});

describe('formatSettingsLines', () => {
  it('評価セット・構成・モデル・件数・日時・費用の上限。実 API の全件の回には打ち切りも --fake も出さない', () => {
    expect(formatSettingsLines(makeMeta(), 40)).toEqual([
      '- 評価セット: attack（攻撃的質問・禁止回答の検出率）',
      '- 構成: two-model',
      '- モデル: 抽出 claude-haiku-4-5・回答生成 claude-sonnet-5-5',
      '- 件数: 40',
      '- 日時: 2026-10-15 21:30 JST',
      '- 費用の上限: $2（--max-cost。累計がこの額に達したら、次のケースを始めずに打ち切る）',
    ]);
  });

  it('1モデル構成はモデルを1つだけ書く。条件抽出（回答生成を呼ばない）も1つ', () => {
    const one = formatSettingsLines(makeMeta({ config: 'one-model', models: { extract: 'claude-sonnet-5-5', answer: 'claude-sonnet-5-5' } }), 40);
    expect(one).toContain('- 構成: one-model（Sonnet の1回の呼び出しで抽出と回答を兼ねる）');
    expect(one).toContain('- モデル: claude-sonnet-5-5');
    expect(formatSettingsLines(makeMeta({ set: 'extraction', models: { extract: 'claude-haiku-4-5', answer: null } }), 100)).toContain('- モデル: claude-haiku-4-5');
  });

  it('全件に満たなければ「全 N 件のうち」、シナリオは「本」。辞書なし・--model の上書き・--fake・打ち切りを出す', () => {
    const lines = formatSettingsLines(
      makeMeta({
        set: 'scenario',
        dictionary: false,
        modelOverride: true,
        fake: true,
        totalCases: 15,
        cutoff: { reason: 'maxCost', spentUsd: 2.5, maxCostUsd: 2, completed: 7, planned: 15 },
      }),
      7,
      '本',
    );
    expect(lines).toContain('- 本数: 7（全 15 本のうち）');
    expect(lines.some((l) => l.startsWith('- 辞書: なし'))).toBe(true);
    expect(lines).toContain('- `--model` で抽出のモデルを上書きしています');
    expect(lines).toContain('- `--fake`: 実 API は呼んでいません（流れの確認用。数字に意味はありません）');
    expect(lines).toContain('- **打ち切り**: 費用が上限 $2（--max-cost）に達したため、15 本のうち 7 本で止めました（累計 $2.5000）');
  });

  it('describeCutoff は件数の単位を選べる', () => {
    const cutoff = { reason: 'maxCost' as const, spentUsd: 0.01, maxCostUsd: 0.01, completed: 1, planned: 3 };
    expect(describeCutoff(cutoff)).toContain('3 件のうち 1 件で止めました');
    expect(describeCutoff(cutoff, '本')).toContain('3 本のうち 1 本で止めました');
  });
});

describe('buildResultConfig', () => {
  it('設定と件数を結果の config にする（ids は配列のコピー、日時は ISO と JST）', () => {
    const ids = ['at-001', 'at-002'];
    const config = buildResultConfig(makeMeta({ ids, limit: 5, totalCases: 40 }), 2);
    expect(config).toEqual({
      set: 'attack',
      config: 'two-model',
      dictionary: true,
      models: { extract: 'claude-haiku-4-5', answer: 'claude-sonnet-5-5' },
      model: 'claude-haiku-4-5',
      modelOverride: false,
      prompts: null,
      fake: false,
      limit: 5,
      ids: ['at-001', 'at-002'],
      caseCount: 2,
      totalCases: 40,
      maxCostUsd: 2,
      cutoff: null,
      usdJpy: 150,
      at: '2026-10-15T12:30:00.000Z',
      atJst: '2026-10-15 21:30',
    });
    expect(config.ids).not.toBe(ids);
  });
});
