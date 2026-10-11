/**
 * シナリオの評価セットの検査（LLM は呼ばない）。
 * (a) 正解そのものの検査: 件数・ID・開始時刻・正解の抽出が本番の語彙と正規化に合っているか
 * (b) 正解の偽物（oraclePipeline）で全シナリオを handleEvent に通し、期待（expect）が会話エンジンの仕様と合っているか。
 *     期待の書き損じをここで落とす（本物の LLM で回して、正解の書き損じが LLM の不正解に数えられるのを防ぐ）
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { toJst } from '@/domain/businessHours';
import { canonicalizeOpsWithReport, canonicalizeViewingTime } from '@/domain/normalize';
import { applySlotOps } from '@/domain/slots';
import { STATIONS, WARDS } from '@/domain/stations';
import type { SlotOp, Slots } from '@/domain/types';
import { loadDemoProperties } from '../data';
import { HARNESS_GAP_MS, type HarnessTurn } from '../harness';
import { oraclePipeline, runScenario, type ScenarioRun } from '../scenario';
import { slotUnits } from '../score';
import { scoreScenario, startedOutsideHours, summarizeScenarios, type ScenarioScore } from '../scoreScenario';
import type { ScenarioCase } from '../types';
import { SCENARIO_CASES } from './scenarios';

const properties = loadDemoProperties();
const stationNames = new Set(STATIONS.map((s) => s.name));
const wardNames = new Set(WARDS);

let runs: ScenarioRun[] = [];
let scores: ScenarioScore[] = [];
beforeAll(async () => {
  runs = [];
  for (const s of SCENARIO_CASES) runs.push(await runScenario(s, oraclePipeline(s), properties));
  scores = runs.map(scoreScenario);
});

/** 手番 i の前の会話（スロットと提示リスト）。最初の手番は会話なし */
const before = (run: ScenarioRun, i: number): { slots: Slots; shown: number } => ({
  slots: run.turns[i - 1]?.slots ?? { tags: [] },
  shown: run.turns[i - 1]?.shownPropertyIds.length ?? 0,
});

const MINUTES_FROM_BOUNDARY = 30;
const OPEN_MINUTES = 10 * 60;
const CLOSE_MINUTES = 19 * 60;

describe('シナリオの評価セット（eval/datasets/scenarios.ts）の正解', () => {
  it('15 本で、ID は sc-01 から連番で重複しない', () => {
    expect(SCENARIO_CASES).toHaveLength(15);
    expect(SCENARIO_CASES.map((s) => s.id)).toEqual(Array.from({ length: 15 }, (_, i) => `sc-${String(i + 1).padStart(2, '0')}`));
    expect(new Set(SCENARIO_CASES.map((s) => s.title)).size).toBe(15);
  });

  it('開始時刻は JST のオフセットつきの日時で、営業時間外が 9 本以上・営業時間内が 4 本以上', () => {
    for (const s of SCENARIO_CASES) {
      expect(s.start, s.id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/);
      expect(Number.isNaN(Date.parse(s.start)), s.id).toBe(false);
    }
    const outside = SCENARIO_CASES.filter((s) => startedOutsideHours(s.start)).length;
    expect(outside).toBeGreaterThanOrEqual(9);
    expect(SCENARIO_CASES.length - outside).toBeGreaterThanOrEqual(4);
  });

  it('開始時刻は開店・閉店の前後 30 分と日付の切り替わりを避け、会話の途中で営業時間の内外が変わらない', () => {
    for (const s of SCENARIO_CASES) {
      const start = new Date(s.start);
      const minutes = Number(toJst(start).time.slice(0, 2)) * 60 + Number(toJst(start).time.slice(3));
      expect(Math.abs(minutes - OPEN_MINUTES), `${s.id}: 開店`).toBeGreaterThanOrEqual(MINUTES_FROM_BOUNDARY);
      expect(Math.abs(minutes - CLOSE_MINUTES), `${s.id}: 閉店`).toBeGreaterThanOrEqual(MINUTES_FROM_BOUNDARY);
      // 手番は HARNESS_GAP_MS 間隔で進む。会話の終わり（＋余裕）まで同じ日・同じ営業時間の内外にいる
      const end = new Date(start.getTime() + s.steps.length * HARNESS_GAP_MS + MINUTES_FROM_BOUNDARY * 60_000);
      expect(toJst(end).date, `${s.id}: 日付`).toBe(toJst(start).date);
      expect(startedOutsideHours(end.toISOString()), `${s.id}: 営業時間の内外`).toBe(startedOutsideHours(s.start));
    }
  });

  it('全手番に expect があり、extraction があるのは text の手番だけ', () => {
    for (const s of SCENARIO_CASES) {
      expect(s.steps.length, s.id).toBeGreaterThan(0);
      s.steps.forEach((step, i) => {
        const where = `${s.id} の手番 ${i}`;
        expect(step.expect, `${where}: expect`).toBeDefined();
        if (step.input.kind === 'text') {
          expect(step.input.text.trim().length, where).toBeGreaterThan(0);
          expect(step.extraction, `${where}: extraction`).toBeDefined();
        } else {
          expect(step.extraction, `${where}: text 以外に extraction`).toBeUndefined();
          expect(step.answer, `${where}: text 以外に answer`).toBeUndefined();
        }
      });
    }
  });

  it('answer を書くのは、提示物件への質問（propertyQuestion）の手番だけで、その手番には必ず書く', () => {
    for (const s of SCENARIO_CASES) {
      s.steps.forEach((step, i) => {
        const isQuestion = step.extraction?.intent === 'propertyQuestion';
        expect(step.answer !== undefined, `${s.id} の手番 ${i}`).toBe(isQuestion);
      });
    }
  });

  it('正解の抽出の駅・区は駅マスタ・区の一覧にあり、本番の正規化（canonicalizeOpsWithReport）で捨てられず同じスロットになる', () => {
    runs.forEach((run) => {
      run.scenario.steps.forEach((step, i) => {
        if (!step.extraction) return;
        const where = `${run.scenario.id} の手番 ${i}`;
        const ops: SlotOp[] = step.extraction.ops;
        for (const op of ops) {
          if (op.op === 'set' && op.key === 'area') {
            expect(op.value.stations.filter((x) => !stationNames.has(x)), `${where}: 駅マスタに無い駅`).toEqual([]);
            expect(op.value.wards.filter((x) => !wardNames.has(x)), `${where}: 区・市の一覧に無い`).toEqual([]);
          }
        }
        const { ops: canonical, dropped } = canonicalizeOpsWithReport(ops);
        expect(dropped, where).toEqual([]);
        const { slots } = before(run, i);
        expect(slotUnits(applySlotOps(slots, canonical)), where).toEqual(slotUnits(applySlotOps(slots, ops)));
      });
    });
  });

  it('優先度だけを変える差分は、対象の条件があるときだけ（無いと何も起きない）', () => {
    runs.forEach((run) => {
      run.scenario.steps.forEach((step, i) => {
        if (!step.extraction) return;
        let slots = before(run, i).slots;
        for (const op of step.extraction.ops) {
          if (op.op === 'setPriority') expect(slots[op.key], `${run.scenario.id} の手番 ${i}: ${op.key}`).toBeDefined();
          if (op.op === 'setTagPriority') {
            expect(slots.tags.some((t) => t.value === op.tag), `${run.scenario.id} の手番 ${i}: ${op.tag}`).toBe(true);
          }
          slots = applySlotOps(slots, [op]);
        }
      });
    });
  });

  it('内見の日時は正規形（YYYY-MM-DD か YYYY-MM-DDTHH:mm）で、会話の開始日より後', () => {
    for (const s of SCENARIO_CASES) {
      const today = toJst(new Date(s.start)).date;
      for (const [i, step] of s.steps.entries()) {
        for (const t of step.extraction?.viewingTimes ?? []) {
          expect(canonicalizeViewingTime(t), `${s.id} の手番 ${i}: ${t}`).toBe(t);
          expect(t.slice(0, 10) > today, `${s.id} の手番 ${i}: ${t} は ${today} より後`).toBe(true);
        }
      }
    }
  });

  it('表示番号は、その手番の前の提示リストの範囲内（本番の抽出も範囲外の番号は捨てる）', () => {
    runs.forEach((run) => {
      run.scenario.steps.forEach((step, i) => {
        const { shown } = before(run, i);
        for (const n of step.extraction?.targetPositions ?? []) {
          expect(Number.isInteger(n) && n >= 1 && n <= shown, `${run.scenario.id} の手番 ${i}: 表示番号 ${n}（提示 ${shown} 件）`).toBe(true);
        }
      });
    });
  });
});

describe('正解の偽物（oraclePipeline）で全シナリオを回す', () => {
  it('どのシナリオも、打ち切りなし・全手番の期待が合格・到達が期待どおり', () => {
    expect(runs).toHaveLength(SCENARIO_CASES.length);
    for (const [i, run] of runs.entries()) {
      const score = scores[i];
      expect(run.aborted, `${run.scenario.id}: 打ち切り`).toBeNull();
      expect(run.turns, `${run.scenario.id}: 手番数`).toHaveLength(run.scenario.steps.length);
      expect(score.failures, run.scenario.id).toEqual([]);
      expect(score.reach, `${run.scenario.id}: 到達`).toBe(run.scenario.expectedReach);
      expect(score.passed, run.scenario.id).toBe(true);
    }
  });

  it('偽の抽出・回答生成は台本の分だけ呼ばれ、例外は出ない', () => {
    for (const run of runs) {
      for (const [i, turn] of run.turns.entries()) {
        expect(turn.error, `${run.scenario.id} の手番 ${i}`).toBeNull();
        const step = run.scenario.steps[i];
        expect(turn.extraction !== null, `${run.scenario.id} の手番 ${i}: 抽出`).toBe(step.input.kind === 'text');
        expect(turn.answers.length > 0, `${run.scenario.id} の手番 ${i}: 回答生成`).toBe(step.answer !== undefined);
      }
    }
  });

  it('押すボタンが見つからなければ、そこで台本を打ち切って理由を残す（打ち切りは不合格）', async () => {
    const s: ScenarioCase = {
      id: 'sc-test',
      title: '打ち切りの確認',
      start: '2026-10-15T21:30:00+09:00',
      expectedReach: 'none',
      steps: [
        { input: { kind: 'follow' }, expect: { state: 'hearing' } },
        { input: { kind: 'tap', label: '存在しないボタン' }, expect: {} },
        { input: { kind: 'text', text: '渋谷で9万まで' }, extraction: { intent: 'conditions', ops: [], targetPositions: [], viewingTimes: [], forbiddenTopic: null }, expect: {} },
      ],
    };
    const run = await runScenario(s, oraclePipeline(s), properties);
    expect(run.turns).toHaveLength(1);
    expect(run.aborted?.step).toBe(1);
    expect(run.aborted?.reason).toContain('クイックリプライ「存在しないボタン」が見つかりません');
    const score = scoreScenario(run);
    expect(score.steps).toMatchObject({ correct: 1, total: 3 });
    expect(score.passed).toBe(false);

    const noCard = await runScenario({ ...s, steps: [{ input: { kind: 'card', button: 'viewing', position: 1 }, expect: {} }] }, oraclePipeline(s), properties);
    expect(noCard.aborted?.step).toBe(0);
    expect(noCard.aborted?.reason).toContain('提示リストに 1 番目がありません');
  });

  it('偽の抽出が台本より多く呼ばれたら、手番の error に残して不合格になる（期待の書き損じを黙って通さない）', async () => {
    const s: ScenarioCase = {
      id: 'sc-test',
      title: '正解の抽出が足りない',
      start: '2026-10-15T21:30:00+09:00',
      expectedReach: 'none',
      steps: [{ input: { kind: 'text', text: '渋谷で9万まで' }, expect: {} }],
    };
    const run = await runScenario(s, oraclePipeline(s), properties);
    expect(run.aborted).toBeNull();
    expect(run.turns[0].error).toContain('正解の抽出が足りません');
    expect(scoreScenario(run).failures[0].problems[0]).toContain('例外');
  });

  it('集計: 全体の到達率はベースライン（全条件 AND＋優先順位確認なし）より高く、時間帯別にも分かれる', () => {
    const summary = summarizeScenarios(scores);
    expect(summary.scenarios).toBe(15);
    expect(summary.passed).toMatchObject({ correct: 15, total: 15 });
    expect(summary.reachMatch).toMatchObject({ correct: 15, total: 15 });
    expect(summary.steps.correct).toBe(summary.steps.total);
    expect(summary.reach.inHours.total + summary.reach.outsideHours.total).toBe(15);
    // DESIGN.md 7章の目標: 到達率 60% 以上
    expect(summary.reach.all.rate).toBeGreaterThanOrEqual(0.6);
    expect(summary.baselineReach.all.rate!).toBeLessThan(summary.reach.all.rate!);
    expect(summary.baselineReach.outsideHours.rate!).toBeLessThan(summary.reach.outsideHours.rate!);
    // ベースラインは行き止まりの分だけ低いだけで、実際より高くはならない
    for (const key of ['all', 'inHours', 'outsideHours'] as const) {
      expect(summary.baselineReach[key].correct, key).toBeLessThanOrEqual(summary.reach[key].correct);
    }
    // 「AND では 0 件、優先順位つきでは N 件」の例（デモの流れ sc-01 を含む）
    expect(summary.andZeroExamples.map((e) => e.id)).toContain('sc-01');
    for (const e of summary.andZeroExamples) expect(e.mustTotal).toBeGreaterThan(0);
  });
});

describe('台本が DESIGN.md 7.1 の3 と 10.1 の流れを網羅している', () => {
  const turnsOf = (): HarnessTurn[] => runs.flatMap((r) => r.turns);
  const joined = (t: HarnessTurn): string => t.texts.join('\n');
  const steps = () => SCENARIO_CASES.flatMap((s) => s.steps);
  const ops = (): SlotOp[] => steps().flatMap((step) => step.extraction?.ops ?? []);

  it('到達の種類: 内見・引き継ぎ・到達しない会話（1〜2本）がある', () => {
    const count = (reach: string) => SCENARIO_CASES.filter((s) => s.expectedReach === reach).length;
    expect(count('viewing')).toBeGreaterThanOrEqual(8);
    expect(count('handoff')).toBeGreaterThanOrEqual(2);
    expect(count('none')).toBeGreaterThanOrEqual(1);
    expect(count('none')).toBeLessThanOrEqual(2);
  });

  it('緩和: 0件で提案 → 受け入れ・2件以下で提案・緩められる条件を聞く・提案を断る', () => {
    const turns = turnsOf();
    expect(turns.some((t) => t.mustTotal === 0 && joined(t).includes('件増えます'))).toBe(true);
    expect(turns.some((t) => t.cardIds.length > 0 && joined(t).includes('件増えます'))).toBe(true);
    expect(turns.some((t) => joined(t).includes('どの条件なら緩められそうですか？'))).toBe(true);
    expect(steps().some((s) => s.input.kind === 'tap' && s.input.label === '条件を変える')).toBe(true);
    expect(steps().some((s) => s.input.kind === 'tap' && s.input.label === 'このままにする')).toBe(true);
  });

  it('20件超で外せない条件を聞き、ボタンで答える', () => {
    expect(turnsOf().some((t) => joined(t).includes('この中で外せない条件はどれですか？'))).toBe(true);
    expect(steps().some((s) => s.input.kind === 'tap' && s.input.label === 'オートロック')).toBe(true);
  });

  it('条件の変更: 心変わり（やっぱり必須）・優先度を下げる・条件を外す・エリアの追加', () => {
    const all = ops();
    expect(all.some((o) => o.op === 'set' && o.key === 'floorMin' && o.priority === 'must')).toBe(true);
    expect(all.some((o) => o.op === 'setTagPriority' && o.priority === 'nice')).toBe(true);
    expect(all.some((o) => o.op === 'removeTag')).toBe(true);
    expect(all.some((o) => o.op === 'unset')).toBe(true);
    expect(all.some((o) => o.op === 'set' && o.key === 'area' && o.value.stations.length >= 2)).toBe(true);
  });

  it('もっと見る（ボタンと自由文）・複数物件の参照と比較・提示物件への質問（答えられる／引き継ぐ）', () => {
    expect(steps().some((s) => s.input.kind === 'tap' && s.input.label === 'もっと見る')).toBe(true);
    expect(steps().some((s) => s.extraction?.intent === 'showMore')).toBe(true);
    expect(steps().some((s) => (s.extraction?.targetPositions.length ?? 0) >= 2)).toBe(true);
    const turns = turnsOf();
    expect(turns.some((t) => t.answers.length > 0 && t.handoffAdded.length === 0)).toBe(true);
    expect(turns.some((t) => t.answers.length > 0 && t.handoffAdded.length > 0)).toBe(true);
  });

  it('内見: 候補日をボタンで選んで「この日時で送る」・2日選んで自動で送る・自由文で日時・定休日を言って聞き直される', () => {
    expect(steps().some((s) => s.input.kind === 'tap' && s.input.label === 'この日時で送る')).toBe(true);
    expect(steps().some((s) => s.input.kind === 'tapIndex')).toBe(true);
    expect(steps().some((s) => s.input.kind === 'card' && s.input.button === 'viewing')).toBe(true);
    expect(steps().some((s) => s.input.kind === 'card' && s.input.button === 'detail')).toBe(true);
    const byText = runs.flatMap((r) =>
      r.scenario.steps.flatMap((step, i) =>
        step.extraction?.intent === 'viewingRequest' && step.extraction.viewingTimes.length >= 2 ? [r.turns[i]] : [],
      ),
    );
    expect(byText.some((t) => t.viewingCreated.length > 0)).toBe(true);
    expect(turnsOf().some((t) => joined(t).includes('以降の営業日でお選びください'))).toBe(true);
  });

  it('有人切替: 禁止トピック・「担当者と話したい」・条件の変更と同時の引き継ぎ', () => {
    expect(steps().some((s) => s.extraction?.forbiddenTopic === 'initialCostTotal')).toBe(true);
    expect(steps().some((s) => s.extraction?.intent === 'handoff' && s.extraction.forbiddenTopic === null)).toBe(true);
    expect(steps().some((s) => s.extraction?.intent === 'conditions' && s.extraction.forbiddenTopic === 'vacancy' && s.extraction.ops.length > 0)).toBe(true);
  });

  it('時間帯: 定休日に始まる会話と、営業時間内に始まる会話がある', () => {
    expect(SCENARIO_CASES.some((s) => toJst(new Date(s.start)).weekday === 3)).toBe(true);
    expect(SCENARIO_CASES.some((s) => !startedOutsideHours(s.start))).toBe(true);
  });
});
