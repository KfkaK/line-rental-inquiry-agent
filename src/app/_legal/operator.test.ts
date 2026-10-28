import { describe, expect, it } from 'vitest';
import { OPERATOR, TO_FILL, productLegalProblems, unfilledFields, type OperatorInfo } from './operator';

const filled: OperatorInfo = {
  businessName: '株式会社サンプル不動産',
  address: '東京都渋谷区サンプル1-2-3',
  representative: '代表 太郎',
  contactWindow: '個人情報窓口（メール）',
  disclosureProcedure: '窓口へ書面で請求',
  profileRetention: '最後のメッセージから1年',
};

describe('unfilledFields', () => {
  it('印が残っている欄と空の欄を返す', () => {
    expect(unfilledFields({ ...filled, address: TO_FILL, representative: '  ' })).toEqual(['address', 'representative']);
  });

  it('文の中に印が残っていても未記入と見なす', () => {
    expect(unfilledFields({ ...filled, contactWindow: `電話 ${TO_FILL}` })).toEqual(['contactWindow']);
  });

  it('すべて埋まっていれば空', () => {
    expect(unfilledFields(filled)).toEqual([]);
  });

  it('いまの OPERATOR はすべて未記入（まだ発注者がいない）', () => {
    expect(unfilledFields(OPERATOR)).toHaveLength(Object.keys(OPERATOR).length);
  });
});

describe('productLegalProblems', () => {
  it('製品の本番（Vercel の Production で DEMO_MODE が 1 でない）では、デモの文面と未記入の欄を挙げる', () => {
    const problems = productLegalProblems({ VERCEL_ENV: 'production' }, { ...filled, address: TO_FILL }, 'demo');
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('公開デモの文面のまま');
    expect(problems[1]).toContain('address');
  });

  it('DEMO_MODE が 1 以外の値でも製品として扱う', () => {
    expect(productLegalProblems({ VERCEL_ENV: 'production', DEMO_MODE: '0' }, filled, 'demo')).toHaveLength(1);
  });

  it('製品用の文面ですべて埋まっていれば通す', () => {
    expect(productLegalProblems({ VERCEL_ENV: 'production' }, filled, 'product')).toEqual([]);
  });

  it.each([
    ['公開デモの本番', { VERCEL_ENV: 'production', DEMO_MODE: '1' }],
    ['Preview', { VERCEL_ENV: 'preview' }],
    ['Vercel の外（CI・手元）', {}],
  ])('%s では確かめない', (_name, env) => {
    expect(productLegalProblems(env)).toEqual([]);
  });

  it('いまの設定のまま製品の本番に出すと落ちる', () => {
    expect(productLegalProblems({ VERCEL_ENV: 'production' }).length).toBeGreaterThan(0);
  });
});
