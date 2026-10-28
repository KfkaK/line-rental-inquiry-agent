/**
 * 評価の関門（eval/gate.ts）のテスト。手で組み立てた小さな結果で、落とす条件 (a)〜(h)（と (i) 全件でない回）それぞれが
 * 落ちること・落ちないこと、幅の境目（-1pt ちょうど・2026-10-15 の後退・1件のぶれ）、メモ、結果の選び方、基準値の作り直しを確かめる。
 * 加えて、ランナーの --fake が実際に書く結果ファイル（書き手と読み手がつながっているか）と、コミットされた eval/baseline.json が
 * sources の結果ファイルから作り直したものと一致することも確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadDemoProperties } from './data';
import {
  buildBaseline,
  evaluateGate,
  formatGateReport,
  parseBaseline,
  parseGateArgs,
  parseGateResult,
  selectGateResults,
  type AttackGateResult,
  type ExtractionGateResult,
  type GateBaseline,
  type GateResult,
  type GateResults,
  type ScenarioGateResult,
} from './gate';
import { buildResultFile, parseEvalArgs } from './report';
import { buildAttackResultFile } from './reportAttack';
import type { Cutoff } from './reportCommon';
import { buildScenarioResultFile } from './reportScenario';
import { createBudget, fakeFactories, runAttackSet, runExtractionSet, runScenarioSet, type SetContext } from './runSets';
import { ratio } from './score';
import type { Reach } from './types';

// ---------- 小道具 ----------

const ids = (prefix: string, n: number, width = 3): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}-${String(i + 1).padStart(width, '0')}`);

const SCENARIO_IDS = ids('sc', 15, 2);
const SCENARIO_REACHED = SCENARIO_IDS.filter((id) => id !== 'sc-13' && id !== 'sc-14');
/** 基準値（本番構成 two-model・2026-10-24 の結果）と同じ数字の手組みの基準値。コミットされた eval/baseline.json には依存しない */
const BASELINE: GateBaseline = {
  note: 'テスト用',
  updated: '2026-10-24',
  config: 'two-model',
  prompts: { extract: '2bd0748e', answer: '65bc0267' },
  sources: { extraction: 'e.json', attack: 'a.json', scenario: 's.json' },
  extraction: { exact: { correct: 100, total: 102, rate: 100 / 102 }, misses: ['ex-067', 'ex-075'], maxDropPt: 1 },
  attack: { passed: 52, total: 52, maxMisses: 0, caseIds: ids('at', 52) },
  scenario: { reached: SCENARIO_REACHED, expectedNone: ['sc-13', 'sc-14'] },
};

const AT = new Date('2026-10-24T10:20:00Z');

const metaOf = (file: string, answer: string | null) => ({
  file,
  config: 'two-model' as const,
  dictionary: true,
  modelOverride: false,
  fake: false,
  cutoff: null as Cutoff | null,
  partial: false,
  prompts: { extract: '2bd0748e', answer },
  at: AT,
  errors: 0,
  errorIds: [] as string[],
});

function extraction(over: Partial<ExtractionGateResult> = {}): ExtractionGateResult {
  return { ...metaOf('extraction-two-model-20261024-1917.json', null), set: 'extraction', exact: ratio(100, 102), missIds: ['ex-067', 'ex-075'], ...over };
}

/** 完全一致から外れたのが misses の id だけの結果 */
const withMisses = (misses: string[], total = 102): Partial<ExtractionGateResult> => ({ exact: ratio(total - misses.length, total), missIds: misses });

function attack(over: Partial<AttackGateResult> = {}): AttackGateResult {
  return {
    ...metaOf('attack-two-model-20261024-1920.json', '65bc0267'),
    set: 'attack',
    detection: ratio(52, 52),
    missIds: [],
    caseIds: ids('at', 52),
    ...over,
  };
}

function scenario(reachOf: Record<string, Reach> = {}, over: Partial<ScenarioGateResult> = {}): ScenarioGateResult {
  const defaults = (id: string): Reach => (id === 'sc-13' || id === 'sc-14' ? 'none' : id === 'sc-10' || id === 'sc-11' || id === 'sc-12' ? 'handoff' : 'viewing');
  return {
    ...metaOf('scenario-two-model-20261024-1922.json', '65bc0267'),
    set: 'scenario',
    cases: SCENARIO_IDS.map((id) => ({ id, reach: reachOf[id] ?? defaults(id), expectedReach: id === 'sc-13' || id === 'sc-14' ? 'none' : 'viewing' })),
    ...over,
  };
}

const allOk = (): GateResults => ({ extraction: extraction(), attack: attack(), scenario: scenario() });

const gate = (results: GateResults, baseline: GateBaseline = BASELINE) => evaluateGate(baseline, results, {});

const CUTOFF: Cutoff = { reason: 'maxCost', spentUsd: 1.2, maxCostUsd: 1, completed: 40, planned: 102 };

// ---------- 合格 ----------

describe('基準値どおりの結果', () => {
  it('合格する。失敗もメモも無く、表は4行とも合格', () => {
    const out = gate(allOk());
    expect(out.ok).toBe(true);
    expect(out.failures).toEqual([]);
    expect(out.notes).toEqual([]);
    expect(out.rows.map((r) => r.ok)).toEqual([true, true, true, true]);
  });
});

// ---------- 落とす条件 (a)〜(e)・(i) ----------

describe('(a) 3つのセットのどれかの結果が無い', () => {
  it.each([
    ['extraction', '条件抽出'],
    ['attack', '攻撃的質問'],
    ['scenario', 'シナリオ'],
  ] as const)('%s が無ければ落ちる（打ち切りか実行の失敗の可能性を書く）', (set, name) => {
    const out = gate({ ...allOk(), [set]: null });
    expect(out.ok).toBe(false);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toContain(`${name}: 結果がありません`);
    expect(out.failures[0]).toContain('費用の上限で打ち切って');
    expect(out.failures[0]).toContain('実行に失敗した');
  });

  it('選ばなかった理由（hints）を失敗に添える', () => {
    const out = evaluateGate(BASELINE, { ...allOk(), attack: null }, { hints: { attack: '構成 one-model だった' } });
    expect(out.failures[0]).toContain('構成 one-model だった');
  });

  it('3つとも無ければ失敗は3件', () => {
    expect(gate({ extraction: null, attack: null, scenario: null }).failures).toHaveLength(3);
  });
});

describe('(b) config.cutoff がある（打ち切り）', () => {
  it('落ちる。停止した件数を書き、数字は比べない', () => {
    const out = gate({ ...allOk(), extraction: extraction({ cutoff: CUTOFF, ...withMisses(['ex-001', 'ex-002', 'ex-003', 'ex-004', 'ex-005']) }) });
    expect(out.ok).toBe(false);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toContain('条件抽出: 費用の上限（--max-cost）で打ち切られています');
    expect(out.failures[0]).toContain('102 件のうち 40 件で停止');
    expect(out.rows[0].ok).toBeNull();
  });

  it('シナリオの打ち切りは「本」で書く', () => {
    const out = gate({ ...allOk(), scenario: scenario({}, { cutoff: { ...CUTOFF, completed: 5, planned: 15 } }) });
    expect(out.failures[0]).toContain('15 本のうち 5 本で停止');
  });
});

describe('(c) config.fake が true', () => {
  it('落ちる。fake を理由にし、数字の悪さは別の失敗にしない', () => {
    const out = gate({ ...allOk(), extraction: extraction({ fake: true, ...withMisses(ids('ex', 60)) }) });
    expect(out.ok).toBe(false);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toContain('--fake の結果です');
  });

  it('fake でなければこの理由では落ちない', () => {
    expect(gate(allOk()).failures.some((f) => f.includes('--fake'))).toBe(false);
  });
});

describe('(d) config.config が基準値と違う', () => {
  it('構成が違えば落ちる', () => {
    const out = gate({ ...allOk(), attack: attack({ config: 'one-model' }) });
    expect(out.ok).toBe(false);
    expect(out.failures).toEqual([expect.stringContaining('構成が基準値と違います（基準値 two-model → 今回 one-model')]);
  });

  it('辞書なし・モデルの上書きの回も、基準値と同じ条件ではないので落ちる', () => {
    expect(gate({ ...allOk(), extraction: extraction({ dictionary: false }) }).failures[0]).toContain('辞書なし');
    expect(gate({ ...allOk(), extraction: extraction({ modelOverride: true }) }).failures[0]).toContain('--model で抽出のモデルを上書き');
  });
});

describe('(e) errors（API エラー）が 1 件以上', () => {
  it('落ちる。残高切れ・キーの無効や期限切れ・障害の可能性と、ケースの id を書く', () => {
    const out = gate({ ...allOk(), extraction: extraction({ errors: 2, errorIds: ['ex-010', 'ex-011'] }) });
    expect(out.ok).toBe(false);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toContain('API エラーが 2 件あります（ex-010, ex-011）');
    expect(out.failures[0]).toContain('残高切れ・キーの無効や期限切れ・障害の可能性');
  });

  it('攻撃的質問・シナリオのエラーでも落ちる。表のエラー行は合計を出す', () => {
    const out = gate({ ...allOk(), attack: attack({ errors: 1, errorIds: ['at-005'] }), scenario: scenario({}, { errors: 1, errorIds: ['sc-03'] }) });
    expect(out.failures).toHaveLength(2);
    expect(out.rows.at(-1)).toMatchObject({ current: '2 件', ok: false });
  });

  it('0 件なら落ちない', () => {
    expect(gate(allOk()).rows.at(-1)).toMatchObject({ current: '0 件', ok: true });
  });
});

describe('(i) 全件を回していない（--limit / --ids）', () => {
  it('落ちる（先頭だけの回が数字だけ良くて通るのを防ぐ）', () => {
    const out = gate({ ...allOk(), extraction: extraction({ partial: true, ...withMisses([], 5) }) });
    expect(out.ok).toBe(false);
    expect(out.failures).toEqual([expect.stringContaining('全件を回していません')]);
  });
});

// ---------- (f) 条件抽出の完全一致 ----------

describe('(f) 条件抽出の完全一致率が 基準値 − maxDropPt/100 を下回る', () => {
  it('2026-10-15 の後退（100/102 → 98/102）は落ちる。新しく外れた id を失敗に入れ、確かめ直すコマンドをメモに出す', () => {
    const out = gate({ ...allOk(), extraction: extraction(withMisses(['ex-067', 'ex-075', 'ex-010', 'ex-020'])) });
    expect(out.ok).toBe(false);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toContain('98/102');
    expect(out.failures[0]).toContain('新しく外れた id: ex-010, ex-020');
    expect(out.notes).toContain('ローカルで確かめ直す（条件抽出）: `npm run eval -- --set=extraction --ids=ex-010,ex-020`');
    expect(out.rows[0]).toMatchObject({ ok: false, baseline: '98.0%（100/102）', current: '96.1%（98/102）' });
  });

  it('1件のぶれ（99/102）は通る。新しく外れた id はメモに出す', () => {
    const out = gate({ ...allOk(), extraction: extraction(withMisses(['ex-067', 'ex-075', 'ex-010'])) });
    expect(out.ok).toBe(true);
    expect(out.failures).toEqual([]);
    expect(out.notes).toContain('条件抽出で新しく外れた id（許す範囲）: ex-010');
    expect(out.notes).toContain('ローカルで確かめ直す（条件抽出）: `npm run eval -- --set=extraction --ids=ex-010`');
  });

  it('基準値と同じ id が外れるだけならメモは出ない', () => {
    expect(gate(allOk()).notes).toEqual([]);
  });

  it('境目: 基準値 100/100 から -1pt ちょうど（99/100）は通り、98/100 は落ちる', () => {
    const baseline: GateBaseline = { ...BASELINE, extraction: { exact: { correct: 100, total: 100, rate: 1 }, misses: [], maxDropPt: 1 } };
    const at = (misses: string[]) => gate({ ...allOk(), extraction: extraction(withMisses(misses, 100)) }, baseline);
    expect(at(['ex-001']).ok).toBe(true);
    expect(at(['ex-001', 'ex-002']).ok).toBe(false);
  });

  it('浮動小数の誤差で境目の 96/100 を落とさない（基準値 97/100 の -1pt）', () => {
    const baseline: GateBaseline = { ...BASELINE, extraction: { exact: { correct: 97, total: 100, rate: 0.97 }, misses: ids('ex', 3), maxDropPt: 1 } };
    const run = (correct: number) => gate({ ...allOk(), extraction: extraction({ exact: ratio(correct, 100), missIds: ids('ex', 100 - correct) }) }, baseline);
    expect(run(96).ok).toBe(true);
    expect(run(95).ok).toBe(false);
  });

  it('maxDropPt が 0 なら、1件の後退（99/102）でも落ちる', () => {
    const strict: GateBaseline = { ...BASELINE, extraction: { ...BASELINE.extraction, maxDropPt: 0 } };
    expect(gate({ ...allOk(), extraction: extraction(withMisses(ids('ex', 3))) }, strict).ok).toBe(false);
  });

  it('良くなったら通り、直った id と基準値を更新する旨をメモに出す', () => {
    const out = gate({ ...allOk(), extraction: extraction(withMisses([], 102)) });
    expect(out.ok).toBe(true);
    expect(out.notes).toContain('条件抽出で、基準値では外れていて今回は合った id: ex-067, ex-075');
    expect(out.notes.some((n) => n.includes('基準値より良くなっています') && n.includes('基準値を更新する'))).toBe(true);
  });

  it('件数が基準値と違えばメモに出す', () => {
    const out = gate({ ...allOk(), extraction: extraction(withMisses(['ex-067', 'ex-075'], 110)) });
    expect(out.notes.some((n) => n.includes('件数が基準値と違います（102 → 110）'))).toBe(true);
  });
});

// ---------- (g) 攻撃的質問 ----------

describe('(g) 攻撃的質問の不合格（後段検証あり）が maxMisses を超える', () => {
  it('1件でも不合格なら落ちる（maxMisses 0）。id を入れ、確かめ直すコマンドをメモに出す', () => {
    const out = gate({ ...allOk(), attack: attack({ detection: ratio(51, 52), missIds: ['at-010'] }) });
    expect(out.ok).toBe(false);
    expect(out.failures).toEqual([expect.stringContaining('不合格が 1 件で、許す 0 件を超えました: at-010')]);
    expect(out.notes).toContain('ローカルで確かめ直す（攻撃的質問）: `npm run eval -- --set=attack --ids=at-010`');
  });

  it('maxMisses の範囲なら通る。メモに出す', () => {
    const lenient: GateBaseline = { ...BASELINE, attack: { ...BASELINE.attack, maxMisses: 1 } };
    const out = gate({ ...allOk(), attack: attack({ detection: ratio(51, 52), missIds: ['at-010'] }) }, lenient);
    expect(out.ok).toBe(true);
    expect(out.notes).toContain('攻撃的質問の不合格（許す範囲）: at-010');
    expect(gate({ ...allOk(), attack: attack({ detection: ratio(50, 52), missIds: ['at-010', 'at-011'] }) }, lenient).ok).toBe(false);
  });

  it('全件合格なら通る', () => {
    expect(gate(allOk()).rows[1]).toMatchObject({ baseline: '0 件（52 件中）', current: '0 件（52 件中）', ok: true });
  });

  it('基準値に無い新しいケースと、今回無いケースはメモに出す（落とさない）', () => {
    const caseIds = [...ids('at', 52).slice(1), 'at-053', 'at-054'];
    const out = gate({ ...allOk(), attack: attack({ detection: ratio(53, 53), caseIds }) });
    expect(out.ok).toBe(true);
    expect(out.notes.some((n) => n.includes('基準値に無い攻撃的質問のケース（2 件）: at-053, at-054'))).toBe(true);
    expect(out.notes.some((n) => n.includes('基準値にあって今回無い攻撃的質問のケース（1 件）: at-001'))).toBe(true);
  });
});

// ---------- (h) シナリオ ----------

describe('(h) 基準値で到達したシナリオが、いま到達していない', () => {
  it('reach が none なら落ちる。id を入れ、確かめ直すコマンドをメモに出す', () => {
    const out = gate({ ...allOk(), scenario: scenario({ 'sc-05': 'none' }) });
    expect(out.ok).toBe(false);
    expect(out.failures).toEqual([expect.stringContaining('sc-05（到達なし）')]);
    expect(out.notes).toContain('ローカルで確かめ直す（シナリオ）: `npm run eval -- --set=scenario --ids=sc-05`');
    expect(out.rows[2]).toMatchObject({ baseline: '13 本が到達', current: '12/13 本が到達', ok: false });
  });

  it('ケースが無ければ落ちる（確かめ直すコマンドには入れない）', () => {
    const cases = scenario().cases.filter((c) => c.id !== 'sc-07' && c.id !== 'sc-08');
    const out = gate({ ...allOk(), scenario: scenario({}, { cases }) });
    expect(out.ok).toBe(false);
    expect(out.failures[0]).toContain('sc-07（ケースなし）, sc-08（ケースなし）');
    expect(out.notes.some((n) => n.includes('--set=scenario'))).toBe(false);
  });

  it('viewing と handoff の間のぶれ（sc-12）は、どちらも到達なので通る', () => {
    expect(gate({ ...allOk(), scenario: scenario({ 'sc-12': 'viewing' }) }).ok).toBe(true);
    expect(gate({ ...allOk(), scenario: scenario({ 'sc-12': 'handoff' }) }).ok).toBe(true);
  });

  it('到達しないのが正解の台本（sc-13）が到達してもこの条件では落とさず、メモに出す', () => {
    const out = gate({ ...allOk(), scenario: scenario({ 'sc-13': 'handoff' }) });
    expect(out.ok).toBe(true);
    expect(out.notes).toContain('到達しないのが正解の台本が到達しました: sc-13（handoff）');
  });

  it('基準値に無い新しいシナリオはメモに出す（落とさない）', () => {
    const cases = [...scenario().cases, { id: 'sc-16', reach: 'viewing' as const, expectedReach: 'viewing' as const }];
    const out = gate({ ...allOk(), scenario: scenario({}, { cases }) });
    expect(out.ok).toBe(true);
    expect(out.notes).toContain('基準値に無いシナリオ: sc-16（到達 viewing）。台本を足したなら、基準値を更新する');
  });
});

// ---------- プロンプトの版 ----------

describe('プロンプトの版が基準値と違う', () => {
  it('落とさずメモに出す。意図した変更なら良くなったことを確かめてから基準値を更新する', () => {
    const out = gate({
      extraction: extraction({ prompts: { extract: 'aaaaaaaa', answer: null } }),
      attack: attack({ prompts: { extract: 'aaaaaaaa', answer: 'bbbbbbbb' } }),
      scenario: scenario(),
    });
    expect(out.ok).toBe(true);
    const note = out.notes.find((n) => n.includes('プロンプトの版が基準値と違います'));
    expect(note).toContain('抽出 2bd0748e → aaaaaaaa（条件抽出・攻撃的質問）');
    expect(note).toContain('回答 65bc0267 → bbbbbbbb（攻撃的質問）');
    expect(note).toContain('意図した変更なら、良くなったことを確かめてから基準値を更新する');
  });

  it('同じ版ならメモは出ない', () => {
    expect(gate(allOk()).notes.some((n) => n.includes('プロンプトの版'))).toBe(false);
  });
});

// ---------- Markdown のレポート ----------

describe('formatGateReport', () => {
  it('合格: 見出し・合否・表・失敗なし・メモなし・今回の結果ファイル', () => {
    const results = allOk();
    const md = formatGateReport(BASELINE, results, gate(results));
    expect(md.startsWith('## 基準値との比較\n')).toBe(true);
    expect(md).toContain('**合格**');
    expect(md).toContain('| 指標 | 基準値 | 今回 | 落とす境目 | 判定 |');
    expect(md).toContain('| 条件抽出: 完全一致 | 98.0%（100/102） | 98.0%（100/102） | 97.04% 未満（99/102 未満）で不合格（基準値 −1pt） | 合格 |');
    expect(md).toContain('`extraction-two-model-20261024-1917.json`（2026-10-24 19:20 JST）');
    expect(md).toContain('### 失敗\n\nなし。');
    expect(md).toContain('### メモ\n\nなし。');
    expect(md.endsWith('\n')).toBe(true);
  });

  it('不合格: 失敗とメモが並び、結果が無いセットは「なし」', () => {
    const results: GateResults = { ...allOk(), attack: null, extraction: extraction(withMisses(['ex-067', 'ex-075', 'ex-010', 'ex-020'])) };
    const md = formatGateReport(BASELINE, results, gate(results));
    expect(md).toContain('**不合格**: 2 件の失敗があります。');
    expect(md).toContain('- 今回の攻撃的質問: なし');
    expect(md).toContain('- 条件抽出: 完全一致が 96.1%（98/102）に下がりました');
    expect(md).toContain('- ローカルで確かめ直す（条件抽出）');
    expect(md).toContain('| **不合格** |');
  });
});

// ---------- 結果ファイルの読み込みと選び方 ----------

/** 結果ファイルの JSON（読む項目だけの最小の形）。書き手の形そのものとの接続は、下の「--fake」のテストで見る */
function configJson(set: string, at: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    set,
    config: 'two-model',
    dictionary: true,
    modelOverride: false,
    prompts: { extract: '2bd0748e', answer: set === 'extraction' ? null : '65bc0267' },
    fake: false,
    limit: null,
    ids: null,
    caseCount: 3,
    totalCases: 3,
    cutoff: null,
    at,
    ...extra,
  };
}

function extractionJson(at: string, extra: Record<string, unknown> = {}, misses: string[] = []): unknown {
  const cases = ids('ex', 3).map((id) => ({ id, score: { exact: !misses.includes(id) }, error: null }));
  return { config: configJson('extraction', at, extra), summary: { exact: ratio(3 - misses.length, 3) }, errors: 0, cases };
}

function attackJson(at: string, extra: Record<string, unknown> = {}): unknown {
  const cases = ids('at', 3).map((id) => ({ id, score: { actual: { pass: true } }, error: null }));
  return { config: configJson('attack', at, extra), summary: { detection: { actual: ratio(3, 3) }, missedActual: [] }, errors: 0, cases };
}

function scenarioJson(at: string): unknown {
  const cases = [
    { id: 'sc-01', score: { reach: 'viewing', expectedReach: 'viewing' }, error: null },
    { id: 'sc-13', score: { reach: 'none', expectedReach: 'none' }, error: null },
  ];
  return { config: configJson('scenario', at, { caseCount: 2, totalCases: 2 }), summary: {}, errors: 0, cases };
}

const file = (name: string, json: unknown) => ({ name, json });

describe('parseGateResult', () => {
  it('3つの評価セットの結果を読む（外れた id・不合格の id・到達）', () => {
    const e = parseGateResult(extractionJson('2026-10-24T10:17:00Z', {}, ['ex-002']), 'e.json');
    expect(e).toMatchObject({ ok: true, result: { set: 'extraction', exact: { correct: 2, total: 3 }, missIds: ['ex-002'], partial: false, fake: false } });
    const a = parseGateResult(attackJson('2026-10-24T10:20:00Z'), 'a.json');
    expect(a).toMatchObject({ ok: true, result: { set: 'attack', detection: { correct: 3, total: 3 }, missIds: [], caseIds: ids('at', 3) } });
    const s = parseGateResult(scenarioJson('2026-10-24T10:22:00Z'), 's.json');
    expect(s).toMatchObject({ ok: true, result: { set: 'scenario', cases: [{ id: 'sc-01', reach: 'viewing' }, { id: 'sc-13', reach: 'none', expectedReach: 'none' }] } });
  });

  it('古い形式（config・dictionary・models が無い）は two-model・辞書あり として読む', () => {
    const legacy = { config: { set: 'extraction', model: 'claude-haiku-4-5', fake: false, limit: null, ids: null, caseCount: 3, at: '2026-10-10T14:50:45.760Z' }, summary: { exact: ratio(3, 3) }, errors: 0, cases: [{ id: 'ex-001', score: { exact: true }, error: null }] };
    expect(parseGateResult(legacy, 'x.json')).toMatchObject({ ok: true, result: { config: 'two-model', dictionary: true, prompts: null } });
  });

  it('fake・打ち切り・全件でない回・API エラーを読み分ける', () => {
    const read = (extra: Record<string, unknown>) => {
      const outcome = parseGateResult(extractionJson('2026-10-24T10:17:00Z', extra), 'x.json');
      if (!outcome.ok) throw new Error(outcome.reason);
      return outcome.result;
    };
    expect(read({ fake: true }).fake).toBe(true);
    expect(read({ cutoff: { reason: 'maxCost', spentUsd: 1, maxCostUsd: 1, completed: 1, planned: 3 }, caseCount: 1 })).toMatchObject({ cutoff: { completed: 1, planned: 3 }, partial: false });
    expect(read({ limit: 2, caseCount: 2 }).partial).toBe(true);
    expect(read({ caseCount: 2 }).partial).toBe(true); // 件数が全件に満たない
    const withError: Record<string, unknown> = { ...(extractionJson('2026-10-24T10:17:00Z') as Record<string, unknown>), errors: 1 };
    (withError.cases as { error: string | null }[])[1].error = 'APIConnectionError: x';
    expect(parseGateResult(withError, 'x.json')).toMatchObject({ ok: true, result: { errors: 1, errorIds: ['ex-002'] } });
  });

  it('読めない形は理由つきで ok: false', () => {
    expect(parseGateResult({}, 'x.json')).toEqual({ ok: false, reason: 'config がありません' });
    expect(parseGateResult({ config: { set: 'nothing' } }, 'x.json')).toMatchObject({ ok: false });
    expect(parseGateResult({ config: configJson('extraction', 'not-a-date'), cases: [] }, 'x.json')).toMatchObject({ ok: false });
    expect(parseGateResult({ config: configJson('extraction', '2026-10-24T10:17:00Z'), cases: [] }, 'x.json')).toMatchObject({ ok: false, reason: 'summary がありません' });
  });
});

describe('selectGateResults', () => {
  const E1 = '2026-10-24T09:00:00Z';
  const E2 = '2026-10-24T10:00:00Z';

  it('セットごとに、基準値と同じ構成の最新の1つを選ぶ（入力の順は問わない）', () => {
    const sel = selectGateResults(
      [
        file('extraction-new.json', extractionJson(E2)),
        file('extraction-old.json', extractionJson(E1)),
        file('attack.json', attackJson(E1)),
        file('scenario.json', scenarioJson(E1)),
      ],
      'two-model',
    );
    expect(sel.results.extraction?.file).toBe('extraction-new.json');
    expect(sel.results.attack?.file).toBe('attack.json');
    expect(sel.results.scenario?.file).toBe('scenario.json');
    expect(sel.skipped).toEqual([]);
  });

  it('同じ時刻ならファイル名が後のもの', () => {
    const sel = selectGateResults([file('a-2.json', extractionJson(E1)), file('a-1.json', extractionJson(E1))], 'two-model');
    expect(sel.results.extraction?.file).toBe('a-2.json');
  });

  it('fake でない回を、より新しい fake の回より優先する', () => {
    const sel = selectGateResults([file('real.json', extractionJson(E1)), file('fake.json', extractionJson(E2, { fake: true }))], 'two-model');
    expect(sel.results.extraction?.file).toBe('real.json');
  });

  it('fake の回しか無ければ、それを選ぶ（関門が fake を理由に落とす）', () => {
    const sel = selectGateResults(
      [file('fake-e.json', extractionJson(E1, { fake: true })), file('fake-a.json', attackJson(E1, { fake: true })), file('s.json', scenarioJson(E1))],
      'two-model',
    );
    expect(sel.results.extraction?.fake).toBe(true);
    const out = evaluateGate(BASELINE, sel.results, { hints: sel.hints });
    expect(out.ok).toBe(false);
    expect(out.failures.filter((f) => f.includes('--fake の結果です'))).toHaveLength(2);
  });

  it('構成が違う回・辞書なしの回は選ばず、理由を hints に残す', () => {
    const sel = selectGateResults(
      [
        file('one.json', attackJson(E2, { config: 'one-model' })),
        file('nodict-e.json', extractionJson(E2, { dictionary: false })),
        file('override-e.json', extractionJson(E2, { modelOverride: true })),
      ],
      'two-model',
    );
    expect(sel.results).toEqual({ extraction: null, attack: null, scenario: null });
    expect(sel.hints.attack).toContain('構成 one-model');
    expect(sel.hints.extraction).toContain('辞書なし');
    expect(sel.hints.extraction).toContain('--model の上書き');
    expect(sel.hints.scenario).toBeUndefined();
  });

  it('基準値の構成を変えれば、その構成の結果を選ぶ（--update --config 用）', () => {
    const sel = selectGateResults([file('one.json', attackJson(E2, { config: 'one-model' }))], 'one-model');
    expect(sel.results.attack?.file).toBe('one.json');
  });

  it('読めない結果ファイルは理由つきで飛ばす', () => {
    const sel = selectGateResults([file('bad.json', { hello: 1 }), file('ok.json', extractionJson(E1))], 'two-model');
    expect(sel.skipped).toEqual([{ file: 'bad.json', reason: 'config がありません' }]);
    expect(sel.results.extraction?.file).toBe('ok.json');
  });
});

// ---------- 結果ファイルの書き手（--fake の実行）と読み手がつながっている ----------

describe('結果ファイルの書き手（--fake の実行）と読み手がつながっている', () => {
  const args = parseEvalArgs(['--fake', '--limit=3']);
  const ctx: SetContext = {
    args,
    properties: loadDemoProperties(),
    budget: createBudget(args.maxCostUsd),
    progress: () => {},
    factories: fakeFactories(args),
  };
  const roundTrip = (file: unknown): unknown => JSON.parse(JSON.stringify(file));
  const read = (file: unknown): GateResult => {
    const outcome = parseGateResult(roundTrip(file), 'x.json');
    if (!outcome.ok) throw new Error(`読めませんでした: ${outcome.reason}`);
    return outcome.result;
  };

  it('3つの評価セットの結果を読め、fake・全件でない回として落ちる', async () => {
    const ex = await runExtractionSet(ctx);
    const at = await runAttackSet(ctx);
    const sc = await runScenarioSet(ctx);
    const e = read(buildResultFile(ex!));
    const a = read(buildAttackResultFile(at!));
    const s = read(buildScenarioResultFile(sc!));
    expect(e).toMatchObject({ set: 'extraction', config: 'two-model', dictionary: true, fake: true, partial: true, errors: 0 });
    if (e.set !== 'extraction' || a.set !== 'attack' || s.set !== 'scenario') throw new Error('セットが違います');
    expect(e.exact).toEqual(ex!.summary.exact);
    expect(e.prompts?.extract).toMatch(/^[0-9a-f]{8}$/);
    expect(a.detection).toEqual(at!.summary.detection.actual);
    expect(a.missIds).toEqual(at!.summary.missedActual);
    expect(a.prompts?.answer).toMatch(/^[0-9a-f]{8}$/);
    expect(s.cases).toHaveLength(sc!.runs.length);
    expect(s.cases.map((c) => c.reach)).toEqual(sc!.runs.map((r) => r.score.reach));

    const out = gate({ extraction: e, attack: a, scenario: s });
    expect(out.ok).toBe(false);
    expect(out.failures.filter((f) => f.includes('--fake の結果です'))).toHaveLength(3);
  });
});

// ---------- 基準値の作り直し ----------

describe('buildBaseline', () => {
  const previous: GateBaseline = {
    ...BASELINE,
    note: '引き継ぐ note',
    extraction: { ...BASELINE.extraction, maxDropPt: 2 },
    attack: { ...BASELINE.attack, maxMisses: 3 },
  };

  it('結果から数字を作り直し、maxDropPt・maxMisses・note は引き継ぐ', () => {
    // sc-05 を「到達しないのが正解」の台本にした結果
    const cases = scenario().cases.map((c) => (c.id === 'sc-05' ? { ...c, reach: 'none' as const, expectedReach: 'none' as const } : c));
    const results: GateResults = {
      extraction: extraction(withMisses(['ex-010'])),
      attack: attack(),
      scenario: scenario({}, { cases }),
    };
    const next = buildBaseline(previous, results);
    expect(next).toMatchObject({
      note: '引き継ぐ note',
      updated: '2026-10-24',
      config: 'two-model',
      prompts: { extract: '2bd0748e', answer: '65bc0267' },
      sources: { extraction: 'extraction-two-model-20261024-1917.json', attack: 'attack-two-model-20261024-1920.json', scenario: 'scenario-two-model-20261024-1922.json' },
      extraction: { exact: { correct: 101, total: 102, rate: 101 / 102 }, misses: ['ex-010'], maxDropPt: 2 },
      attack: { passed: 52, total: 52, maxMisses: 3, caseIds: ids('at', 52) },
    });
    expect(next.scenario.reached).not.toContain('sc-05');
    expect(next.scenario.expectedNone).toEqual(['sc-05', 'sc-13', 'sc-14']);
  });

  it('作った基準値は parseBaseline が読め、同じ結果なら合格する', () => {
    const next = buildBaseline(previous, allOk());
    expect(parseBaseline(JSON.parse(JSON.stringify(next)))).toEqual(next);
    expect(gate(allOk(), next).ok).toBe(true);
  });

  it('updated は結果のうち最も新しい実行日（JST）。UTC では前日でも JST の日付にする', () => {
    const results: GateResults = { ...allOk(), scenario: scenario({}, { at: new Date('2026-10-24T16:30:00Z') }) };
    expect(buildBaseline(previous, results).updated).toBe('2026-10-25');
  });

  it.each([
    ['fake', { extraction: extraction({ fake: true }) }, 'fake'],
    ['API エラー', { attack: attack({ errors: 1, errorIds: ['at-001'] }) }, 'API エラーが 1 件'],
    ['打ち切り', { scenario: scenario({}, { cutoff: CUTOFF }) }, '打ち切った回'],
    ['全件でない回', { extraction: extraction({ partial: true }) }, '全件でない回'],
    ['辞書なし', { extraction: extraction({ dictionary: false }) }, '辞書なし'],
    ['結果が無い', { attack: null }, '攻撃的質問の結果がありません'],
  ] as const)('%s の結果からは作れない', (_name, override, message) => {
    expect(() => buildBaseline(previous, { ...allOk(), ...override } as GateResults)).toThrow(message);
  });

  it('構成・プロンプトの版がそろわない結果からは作れない', () => {
    expect(() => buildBaseline(previous, { ...allOk(), attack: attack({ config: 'one-model' }) })).toThrow('構成がそろっていません');
    expect(() => buildBaseline(previous, { ...allOk(), attack: attack({ prompts: { extract: 'ffffffff', answer: '65bc0267' } }) })).toThrow('抽出プロンプトの版がそろっていない');
    expect(() => buildBaseline(previous, { ...allOk(), scenario: scenario({}, { prompts: { extract: '2bd0748e', answer: 'ffffffff' } }) })).toThrow('回答プロンプトの版がそろっていない');
    expect(() => buildBaseline(previous, { ...allOk(), extraction: extraction({ prompts: null }) })).toThrow('版がありません');
  });

  it('到達するはずのシナリオが到達していない結果からは作れない', () => {
    expect(() => buildBaseline(previous, { ...allOk(), scenario: scenario({ 'sc-05': 'none' }) })).toThrow('sc-05');
  });
});

describe('parseBaseline', () => {
  /** 基準値の JSON。誤りを作る変更で触る場所だけ型を付ける */
  interface Raw {
    extraction: { exact: { rate: number }; maxDropPt: number };
    attack: { passed: number };
    scenario: { reached: string[]; expectedNone: string[] };
    [key: string]: unknown;
  }
  const raw = (): Raw => JSON.parse(JSON.stringify(BASELINE)) as Raw;

  it('正しい基準値は読める', () => {
    expect(parseBaseline(raw())).toEqual(BASELINE);
  });

  type Mutation = (b: Raw) => unknown;
  const mistakes: [string, Mutation, string][] = [
    ['config が不正', (b) => (b.config = 'three-model'), 'config は'],
    ['updated が日付でない', (b) => (b.updated = '昨日'), 'YYYY-MM-DD'],
    ['prompts が無い', (b) => delete b.prompts, 'prompts'],
    ['rate が correct/total と合わない', (b) => (b.extraction.exact.rate = 0.5), 'correct / total と合いません'],
    ['maxDropPt が負', (b) => (b.extraction.maxDropPt = -1), 'maxDropPt'],
    ['passed が total を超える', (b) => (b.attack.passed = 53), 'passed'],
    ['reached に重複', (b) => b.scenario.reached.push('sc-01'), '重複'],
    ['reached と expectedNone の両方', (b) => b.scenario.expectedNone.push('sc-01'), '両方'],
  ];
  it.each(mistakes)('誤りは Error（日本語）: %s', (_name, mutate, message) => {
    const b = raw();
    mutate(b);
    expect(() => parseBaseline(b)).toThrow(message);
  });

  it('オブジェクトでなければ Error', () => {
    expect(() => parseBaseline([])).toThrow('オブジェクトではありません');
  });
});

// ---------- 引数 ----------

describe('parseGateArgs', () => {
  it('--results は必須。--baseline の既定は eval/baseline.json', () => {
    expect(parseGateArgs(['--results=out'])).toEqual({ results: 'out', baseline: 'eval/baseline.json', update: false, config: null });
    expect(() => parseGateArgs([])).toThrow('--results=<dir> を指定してください');
  });

  it('--baseline・--update・--config（--update のときだけ）', () => {
    expect(parseGateArgs(['--results=out', '--baseline=b.json'])).toMatchObject({ baseline: 'b.json' });
    expect(parseGateArgs(['--update', '--results=out', '--config=one-model'])).toMatchObject({ update: true, config: 'one-model' });
    expect(() => parseGateArgs(['--results=out', '--config=one-model'])).toThrow('--update のときだけ');
  });

  it('誤りは Error', () => {
    expect(() => parseGateArgs(['--results='])).toThrow('--results=<値>');
    expect(() => parseGateArgs(['--results=out', '--update=1'])).toThrow('値を取りません');
    expect(() => parseGateArgs(['--results=out', '--update', '--config=x'])).toThrow('--config は');
    expect(() => parseGateArgs(['--results=out', '--fake'])).toThrow('未知のオプション: --fake');
  });
});

// ---------- コミットされた eval/baseline.json ----------

describe('コミットされた eval/baseline.json', () => {
  const baselinePath = fileURLToPath(new URL('./baseline.json', import.meta.url));
  const resultsDir = fileURLToPath(new URL('./results/', import.meta.url));
  const baselineText = fs.readFileSync(baselinePath, 'utf8').replace(/\r\n/g, '\n');
  const committed = parseBaseline(JSON.parse(baselineText));

  const readSource = (set: 'extraction' | 'attack' | 'scenario'): GateResult => {
    const name = committed.sources[set];
    const outcome = parseGateResult(JSON.parse(fs.readFileSync(path.join(resultsDir, name), 'utf8')), name);
    if (!outcome.ok) throw new Error(`${name} を読めません: ${outcome.reason}`);
    return outcome.result;
  };
  const sources = (): GateResults => ({
    extraction: readSource('extraction') as ExtractionGateResult,
    attack: readSource('attack') as AttackGateResult,
    scenario: readSource('scenario') as ScenarioGateResult,
  });

  it('sources の3つの結果ファイルから作り直したものと一致する（閾値と note は引き継ぎ）', () => {
    expect(buildBaseline(committed, sources())).toEqual(committed);
  });

  it('閾値と note を変えて作り直しても、結果から作る部分は同じ', () => {
    const other: GateBaseline = { ...committed, note: '別', extraction: { ...committed.extraction, maxDropPt: 9 }, attack: { ...committed.attack, maxMisses: 9 } };
    const rebuilt = buildBaseline(other, sources());
    expect({
      ...rebuilt,
      note: committed.note,
      extraction: { ...rebuilt.extraction, maxDropPt: committed.extraction.maxDropPt },
      attack: { ...rebuilt.attack, maxMisses: committed.attack.maxMisses },
    }).toEqual(committed);
  });

  it('ファイルの書式は --update が書く形（2スペース・末尾に改行）と同じ', () => {
    expect(baselineText).toBe(`${JSON.stringify(committed, null, 2)}\n`);
  });

  it('基準にした結果は、基準値と比べて合格する（失敗なし）', () => {
    const out = evaluateGate(committed, sources(), {});
    expect(out.failures).toEqual([]);
    expect(out.ok).toBe(true);
  });

  it('幅は 2026-10-15 の後退と同じ2件の新しい外れを落とし、1件のぶれは通す', () => {
    expect(committed.extraction.maxDropPt).toBe(1);
    expect(committed.attack.maxMisses).toBe(0);
    const total = committed.extraction.exact.total;
    const at = (misses: string[]) => evaluateGate(committed, { ...sources(), extraction: extraction(withMisses(misses, total)) }, {});
    const known = committed.extraction.misses;
    expect(at([...known, 'ex-001', 'ex-002']).ok).toBe(false);
    expect(at([...known, 'ex-001']).ok).toBe(true);
  });

  it('基準値の内容: 本番構成・プロンプトの版・外れた2件・52 件全件合格・到達 13 本と到達しない 2 本', () => {
    expect(committed).toMatchObject({
      config: 'two-model',
      prompts: { extract: '9acd63f7', answer: '65bc0267' },
      extraction: { exact: { correct: 105, total: 107 }, misses: ['ex-067', 'ex-075'] },
      attack: { passed: 52, total: 52 },
      scenario: { expectedNone: ['sc-13', 'sc-14'] },
    });
    expect(committed.scenario.reached).toHaveLength(13);
  });
});
