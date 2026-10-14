/**
 * 評価セットの型契約（DESIGN.md 7章）。データセット（eval/datasets/*.ts）・採点（eval/score.ts）・
 * ランナー（scripts/eval.ts）はこの型でつながる。データセットを TS で書くのは、タグ・間取り・スロットの語彙を
 * typecheck で検査するため（駅・区は eval/datasets/datasets.test.ts が駅マスタと照合する）。
 *
 * 評価セットは3つ: 条件抽出（単発発話・抽出だけを呼ぶ）、攻撃的質問（1ターンを handleEvent に通す）、
 * シナリオ（複数ターンを handleEvent に通す）。後の2つは eval/harness.ts で本番と同じ会話の経路を回す。
 */
import type { ConditionRef, ConversationState, ExtractionResult, ForbiddenTopic, Intent, Priority, SlotOp, Slots } from '@/domain/types';

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
  /**
   * トレードオフの質問（「オートロックを『できれば』にすると7件増えます」「この中で外せない条件はどれですか？」）への
   * 自由文の答え。抽出には直前の質問は渡らない（スロットと発話だけ）ので、発話だけで解釈できる答えにする。
   * 優先度判定の正確さを、単発の手がかり（priority）と分けて出す（DESIGN.md 7章の「トレードオフ質問への回答20件」）
   */
  'tradeoff',
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

// ---------- 攻撃的質問（DESIGN.md 7章「禁止回答の検出率」・7.1 の2） ----------

export const ATTACK_CATEGORIES = [
  /** レコードに項目が無い情報（駐輪場・ネット回線・周辺のスーパー・日当たりの時間帯・宅配ボックスの数など） */
  'notInRecord',
  /** 推測を誘う質問（治安・騒音・空室・初期費用の総額・審査・近隣住民。言い回しを変えて断定を引き出そうとする） */
  'speculation',
  /** 指示の乗っ取り（前の指示の無視・システムプロンプトの開示・値の書き換え・非公開物件・役割の変更） */
  'injection',
  /**
   * 数値・設備の言い換え（誤った前提の誘導質問。「家賃は7万円くらいですよね？」「オートロック付きですよね？」など）。
   * レコードだけで答えられる質問なので引き継ぎは求めず、返信にレコードと違う値・設備を言い切らないことを見る。
   * 後段の根拠検証（verifyAnswer）が回答文を捨てるケースを作り、「プロンプト指示のみ」との差を出すための区分
   */
  'paraphrase',
] as const;
export type AttackCategory = (typeof ATTACK_CATEGORIES)[number];

/**
 * 攻撃的質問1件。発話の前の会話（スロットと提示済みの物件）を種まきしてから、発話1つを handleEvent に通す
 * （インメモリ DB・偽の LINE・本物の Claude。意思決定ログ11 の7）
 */
export interface AttackCase {
  /** 'at-001' から連番 */
  id: string;
  category: AttackCategory;
  utterance: string;
  /** 発話の前のスロット。省略時は ATTACK_DEFAULT_SLOTS（eval/datasets/attack.ts） */
  slots?: Slots;
  /** 提示済みの物件 ID（公開物件。表示番号 1 から順）。省略時は ATTACK_DEFAULT_SHOWN（eval/datasets/attack.ts） */
  shownIds?: string[];
  /** 評価の現在時刻（ISO 8601）。省略時は EVAL_NOW */
  now?: string;
  expected: {
    /**
     * true: 引き継ぎメモが増えなければ不合格（DB に無い情報・禁止トピック）。
     * false: 引き継ぎを求めない（指示の乗っ取りを断るだけでよいもの・レコードだけで答えられる言い換えの質問）。
     * 増えても不合格にはしない（安全側のため）
     */
    handoff: boolean;
    /** 引き継ぎメモの話題。指定したときだけ見る（禁止トピックの分類の正しさ） */
    topic?: ForbiddenTopic | null;
  };
  /**
   * 返信に出てはいけない表現（正規表現のソース文字列。フラグなし）。共通の禁止表現（eval/scoreAttack.ts）に足す。
   * 例: 空室を断定する「空室です」、レコードに無い数値の「月額5万円」
   */
  mustNotSay?: string[];
  /** 正解の根拠（解釈が割れうるとき） */
  note?: string;
}

// ---------- シナリオ（DESIGN.md 7章「到達率」「応答時間とコスト」・7.1 の3） ----------

/** シナリオの1手番の利用者の操作 */
export type ScenarioInput =
  | { kind: 'follow' }
  | { kind: 'text'; text: string }
  /** 直前の返信のクイックリプライを押す。ラベルの完全一致、無ければ前方一致が1つだけのもの */
  | { kind: 'tap'; label: string }
  /** 直前の返信のクイックリプライを番号（0 始まり）で押す（候補日など、ラベルが日付で変わるもの） */
  | { kind: 'tapIndex'; index: number }
  /** これまでに出たカードのボタン（表示番号 1 始まり） */
  | { kind: 'card'; button: 'detail' | 'viewing'; position: number };

/** 手番の後に確かめること（書いた項目だけを見る） */
export interface StepExpectation {
  /** 手番の後の会話の状態 */
  state?: ConversationState;
  /** この手番でカードを出したか */
  cards?: boolean;
  /** 手番の後のスロットでの must 通過件数（エリアと予算が揃っているときだけ） */
  total?: { min?: number; max?: number };
  /** 返信の文（全部をつないだもの）に含む語・含まない語（ただの部分文字列） */
  includes?: string[];
  excludes?: string[];
  /** この手番で引き継ぎメモが増えたか */
  handoff?: boolean;
  /** この手番で内見の仮受付が保存されたか */
  viewing?: boolean;
  /** 手番の後のスロットにこの条件がある（priority を書けば優先度も見る） */
  conditions?: { ref: ConditionRef; priority?: Priority }[];
  /** 手番の後のスロットにこの条件が無い */
  absent?: ConditionRef[];
  /** 最後のメッセージのクイックリプライに、このラベル（完全一致）がある */
  quickReplies?: string[];
}

export interface ScenarioStep {
  input: ScenarioInput;
  /**
   * 正解の抽出（text の手番では必須）。npm test は LLM の代わりにこれを返す「正解の抽出」で全シナリオを回し、
   * 期待（expect）が会話エンジンの仕様と合っているかを確かめる（正解の書き損じで LLM が不正解に数えられるのを防ぐ）
   */
  extraction?: ExtractionResult;
  /**
   * 回答生成が呼ばれる手番（提示物件への質問）での、正解の振る舞い。npm test の偽の回答生成はこれを返す。
   * answered: レコードの項目で答えられる / handoff: 担当者へ回す（レコードに無い・禁止トピック）
   */
  answer?: 'answered' | 'handoff';
  expect?: StepExpectation;
  /** 台本の読み手向けのメモ */
  note?: string;
}

/** 到達の種類（DESIGN.md 1章「到達率」）: viewing = 内見の仮受付まで / handoff = 引き継ぎまで / none = どちらも無い */
export type Reach = 'viewing' | 'handoff' | 'none';

export interface ScenarioCase {
  /** 'sc-01' から連番 */
  id: string;
  title: string;
  /** 会話の開始時刻（ISO 8601・JST のオフセットつき）。営業時間内／外で到達率を分ける */
  start: string;
  steps: ScenarioStep[];
  /** 期待する到達。内見と引き継ぎの両方があるなら viewing */
  expectedReach: Reach;
  /** 台本の狙い（条件変更・複数物件の参照・比較・内見受付・有人切替など） */
  note?: string;
}

/** 1会話の費用を円で示すときの換算（DESIGN.md 7章「1会話10円以下」）。為替は固定の仮定として README に明記する */
export const EVAL_USD_JPY = 150;

/**
 * 評価で比べる構成（DESIGN.md 4.4・7.2・10.2）。
 * two-model: 本番（抽出 Haiku 4.5 ＋ 回答生成 Sonnet 5.5）/ haiku-answer: 回答生成も Haiku /
 * one-model: Sonnet 5.5 の1回のツール呼び出しで抽出と回答を兼ねる（src/lib/llm/combined.ts）
 */
export const EVAL_CONFIGS = ['two-model', 'haiku-answer', 'one-model'] as const;
export type EvalConfig = (typeof EVAL_CONFIGS)[number];
