/**
 * 評価セットの型契約（DESIGN.md 7章）。データセット（eval/datasets/*.ts）・採点（eval/score.ts）・
 * ランナー（scripts/eval.ts）はこの型でつながる。データセットを TS で書くのは、タグ・間取り・スロットの語彙を
 * typecheck で検査するため（駅・区は eval/datasets/datasets.test.ts が駅マスタと照合する）。
 *
 * いまあるのは条件抽出（単発発話）の種だけ。攻撃的質問・シナリオは Week 4 で足す（引き継ぎ書6章）。
 */
import type { ForbiddenTopic, Intent, SlotOp, Slots } from '@/domain/types';

/**
 * 評価の既定の現在時刻: 2026-10-15（木）21:30 JST（営業時間外）。
 * 抽出の出力例の「今日」（2026-10-07）と別の日にして、モデルが例の日付を写しても当たらないようにする。
 * 早見: 明日=10-16(金) / 土曜=10-17 / 日曜=10-18 / 来週月曜=10-19 / 水曜=10-21（定休日）/ 来月=2026-11
 */
export const EVAL_NOW = '2026-10-15T21:30:00+09:00';

export const EXTRACTION_CATEGORIES = [
  /** 単純な条件の提示 */
  'basic',
  /** 表記ゆれ（かな・略称・全角・漢数字・口語・誤字） */
  'variant',
  /** 複合条件（1発話に3つ以上） */
  'compound',
  /** 条件の変更・追加・削除（現在のスロットあり） */
  'change',
  /** 優先度の手がかり・優先順位の質問への答え */
  'priority',
  /** 提示物件への参照（質問・比較） */
  'reference',
  /** 内見の希望と日時 */
  'viewing',
  /** 禁止トピック（単独・条件の変更と同時） */
  'forbidden',
  /** もっと見る・あいさつ・雑談・担当者と話したい・指示の乗っ取り */
  'other',
] as const;
export type ExtractionCategory = (typeof EXTRACTION_CATEGORIES)[number];

export interface ExtractionCase {
  /** 'ex-001' から連番 */
  id: string;
  category: ExtractionCategory;
  /** 優先度の手がかり（「絶対」「できれば」「なくてもいい」など）を含む。優先度判定の正確さの母数 */
  priorityCue: boolean;
  utterance: string;
  /** 発話の前のスロット。省略時は空 */
  slots?: Slots;
  /** 提示済みの物件 ID（data/properties.csv の公開物件。表示番号 1 から順）。省略時は空 */
  shownIds?: string[];
  /** 評価の現在時刻（ISO 8601）。省略時は EVAL_NOW */
  now?: string;
  expected: {
    intent: Intent;
    /** 解釈が割れうるときに正解として認める別の意図 */
    alsoAcceptIntents?: Intent[];
    /**
     * 正解の差分。`applySlotOps(slots, ops)` を正解のスロットとして比べるので、差分の書き方の違い
     * （set で優先度ごと置き換える／setPriority で優先度だけ変える）は問わない。
     * priority を省略した op は本番と同じく既定値（rules.DEFAULT_PRIORITY）か元の優先度になる
     */
    ops: SlotOp[];
    /** 省略時は [] */
    targetPositions?: number[];
    /** JST の 'YYYY-MM-DDTHH:mm' か 'YYYY-MM-DD'。省略時は [] */
    viewingTimes?: string[];
    /** 省略時は null */
    forbiddenTopic?: ForbiddenTopic | null;
  };
  /** 正解の根拠（解釈が割れうるとき） */
  note?: string;
}

/** 1回の呼び出しの計測値 */
export interface CallMeasure {
  latencyMs: number;
  costUsd: number;
}

/** 正解数・母数・割合（母数 0 なら rate は null） */
export interface Ratio {
  correct: number;
  total: number;
  rate: number | null;
}
