/**
 * 共有の型契約。DB・LLM・LINE・管理画面はこの型を介してつながる。
 * 変えるときは DESIGN.md の 3.2・5章と、呼び出し側すべてを合わせて直す。
 */

// ---------- 語彙（閉じた集合。LLM の出力もここに無い値は捨てる） ----------

export const LAYOUTS = ['1R', '1K', '1DK', '1LDK', '2K', '2DK', '2LDK'] as const;
export type Layout = (typeof LAYOUTS)[number];

/**
 * こだわり条件のタグ。物件の `tags` は CSV 取込時に備考から抽出する（敷金なし・礼金なしは数値列から決める）。
 * 「2階以上」は数値条件 `floor_min`、「駅近」は `walk_max` で扱うのでタグにしない。
 */
export const TAGS = [
  'ペット可',
  'バストイレ別',
  'オートロック',
  '独立洗面台',
  '室内洗濯機置場',
  '宅配ボックス',
  'エアコン',
  'フローリング',
  '角部屋',
  '南向き',
  '日当たり良好',
  '静か',
  '駐輪場',
  '2人入居可',
  '楽器相談可',
  '敷金なし',
  '礼金なし',
] as const;
export type Tag = (typeof TAGS)[number];

export const PRIORITIES = ['must', 'want', 'nice'] as const;
/** must: 外せない（WHERE で絞る） / want: できれば（重み2） / nice: あれば嬉しい（重み1） */
export type Priority = (typeof PRIORITIES)[number];

// ---------- 物件 ----------

export interface Access {
  /** 駅名（「駅」は付けない。例: '渋谷'） */
  station: string;
  walkMin: number;
}

export interface Property {
  id: string;
  name: string;
  address: string;
  /** 区・市（例: '渋谷区'） */
  ward: string;
  /** 最寄り駅。1〜3件。先頭が最寄り */
  access: Access[];
  /** 家賃（円） */
  rent: number;
  /** 管理費・共益費（円） */
  managementFee: number;
  depositMonths: number;
  keyMoneyMonths: number;
  layout: Layout;
  areaSqm: number;
  floor: number;
  builtYear: number;
  tags: Tag[];
  /** 備考（自由文）。回答の根拠には使わない（タグ化した結果だけを使う） */
  note: string;
  /** 入居可能日 'YYYY-MM-DD'。null は即入居可 */
  availableFrom: string | null;
  status: 'public' | 'private';
}

// ---------- 条件スロット ----------

export interface Slot<T> {
  value: T;
  priority: Priority;
}

export interface AreaValue {
  /** 駅名（「駅」なし）。いずれかの駅に `access` があれば一致 */
  stations: string[];
  /** 区・市名（例: '目黒区'）。`ward` が一致すれば一致 */
  wards: string[];
}

/** 値が1つのスロット。`tags` だけはタグごとに優先度を持つので別扱い */
export interface ScalarSlotValues {
  area: AreaValue;
  /** 予算上限（円）。家賃＋管理費と比べる（rules.BUDGET_INCLUDES_MANAGEMENT_FEE） */
  rentMax: number;
  layouts: Layout[];
  /** 駅徒歩の上限（分） */
  walkMax: number;
  floorMin: number;
  /** 入居時期 'YYYY-MM'（JST）。この月の末日までに入居できれば一致 */
  moveIn: string;
}
export type ScalarSlotKey = keyof ScalarSlotValues;
export const SCALAR_SLOT_KEYS: readonly ScalarSlotKey[] = [
  'area',
  'rentMax',
  'layouts',
  'walkMax',
  'floorMin',
  'moveIn',
];

export type Slots = { [K in ScalarSlotKey]?: Slot<ScalarSlotValues[K]> } & {
  tags: Slot<Tag>[];
};

/** スロットの差分。LLM の条件抽出はこの配列を返し、`applySlotOps` で現在のスロットに当てる */
export type SlotOp =
  | {
      [K in ScalarSlotKey]: {
        op: 'set';
        key: K;
        value: ScalarSlotValues[K];
        /** 省略時: 既存スロットなら元の優先度を保つ。新規なら rules.DEFAULT_PRIORITY */
        priority?: Priority;
      };
    }[ScalarSlotKey]
  | { op: 'unset'; key: ScalarSlotKey }
  | { op: 'setPriority'; key: ScalarSlotKey; priority: Priority }
  | { op: 'addTag'; tag: Tag; priority?: Priority }
  | { op: 'removeTag'; tag: Tag }
  | { op: 'setTagPriority'; tag: Tag; priority: Priority };

/** 条件1つを指す参照（優先度の変更・緩和提案・一致の内訳で使う） */
export type ConditionRef = { kind: 'slot'; key: ScalarSlotKey } | { kind: 'tag'; tag: Tag };

// ---------- 検索結果 ----------

export interface ConditionResult {
  ref: ConditionRef;
  priority: Priority;
  /** 条件の短い文言（例: '徒歩10分以内'・'オートロック'） */
  label: string;
  /** 0〜1。数値条件は段階評価で部分点がある */
  credit: number;
  /** credit が 1 未満のときの不足の説明（例: 'オートロックなし'・'徒歩12分'）。満たしていれば null */
  shortfall: string | null;
}

export interface ScoredProperty {
  property: Property;
  /** want/nice（徒歩の条件が無いときは徒歩の目安も nice として）の加重一致率 0〜1。どれも無ければ 1 */
  score: number;
  /** must を含む全条件の評価（must は絞り込み済みなので常に credit 1） */
  conditions: ConditionResult[];
  /** credit が 1 の条件の label */
  matched: string[];
  /** credit が 1 未満の条件の shortfall（部分点を含む）。そのまま表示できる（例: 'オートロックなし'・'徒歩12分'） */
  unmatched: string[];
  /** 表示に使う駅（エリア条件の駅を優先し、無ければ最寄り） */
  displayAccess: Access;
}

export interface SearchResult {
  /** must をすべて満たした件数 */
  total: number;
  /** must をすべて満たした全件。スコア降順 → 月額（家賃＋管理費）昇順 → 物件 ID 昇順 */
  items: ScoredProperty[];
}

/**
 * 候補が少ないときの緩和提案（DESIGN.md 4.2）。
 * downgrade: must を1つ want に下げる（「オートロックを『できれば』にすると7件増えます」）
 * widen: 従来型のフォールバック（予算＋5,000円 → 徒歩＋5分 → 隣の駅を含める）
 */
export interface RelaxationSuggestion {
  kind: 'downgrade' | 'widen';
  ref: ConditionRef;
  /** 提案の文言（例: 'オートロックを「できれば」にする'・'予算を9.5万円まで広げる'） */
  label: string;
  /** 受け入れたときにスロットへ当てる差分 */
  ops: SlotOp[];
  /** 適用後の件数 − いまの件数（1 以上） */
  gained: number;
  totalAfter: number;
}

// ---------- 会話 ----------

export const CONVERSATION_STATES = ['hearing', 'presenting', 'qa', 'booking', 'handed_off'] as const;
export type ConversationState = (typeof CONVERSATION_STATES)[number];

export const INTENTS = [
  /** 条件の提示・変更（優先度の変更を含む） */
  'conditions',
  /** 「もっと見せて」 */
  'showMore',
  /** 提示物件への質問・比較 */
  'propertyQuestion',
  /** 内見希望（日時の提示を含む） */
  'viewingRequest',
  /** 範囲外・雑談・あいさつ */
  'offTopic',
  /** 担当者への引き継ぎが必要（禁止トピック・人と話したい） */
  'handoff',
] as const;
export type Intent = (typeof INTENTS)[number];

/** AI が答えずに必ず担当者へ渡す話題（DESIGN.md 3.5） */
export const FORBIDDEN_TOPICS = ['vacancy', 'initialCostTotal', 'safety', 'noise', 'screening', 'neighbors'] as const;
export type ForbiddenTopic = (typeof FORBIDDEN_TOPICS)[number];

/** 内見の聞き取り途中の状態。候補日時が揃ったら viewing_requests を作って null に戻す */
export interface BookingDraft {
  propertyId: string;
  /** JST の 'YYYY-MM-DDTHH:mm'（時刻が無ければ 'YYYY-MM-DD'） */
  candidateTimes: string[];
}

/** AI が答えずに担当者へ回した質問のメモ。朝の引き継ぎ一覧の「AIが聞き取れなかったこと」に使う */
export interface HandoffNote {
  /** ユーザーの発話（原文） */
  text: string;
  topic: ForbiddenTopic | null;
  /** 質問の対象物件（「1番目の物件、空いてますか？」を朝の一覧で読めるように）。無ければ空 */
  propertyIds: string[];
  /** 回した時刻（ISO 8601） */
  at: string;
}

/**
 * 内見の仮受付の状態。管理画面の 未対応 / 対応中 / 確定 / 却下 / 手動で対応済み。遷移は src/domain/staff.ts。
 * closed_manually は営業時間外の内見などを担当者が手動返信で取り決めたときに、利用者に何も送らずに記録だけを閉じる終わり（意思決定ログ15）
 */
export const VIEWING_STATUSES = ['pending', 'in_progress', 'confirmed', 'rejected', 'closed_manually'] as const;
export type ViewingStatus = (typeof VIEWING_STATUSES)[number];

/** 意図分類＋条件抽出（毎ターン・安いモデル）の出力 */
export interface ExtractionResult {
  intent: Intent;
  ops: SlotOp[];
  /** 提示済みリストの何番目への言及か（1始まり）。「2番目」「さっきの安い方」を LLM が解決する */
  targetPositions: number[];
  /** 内見の候補日時（JST の 'YYYY-MM-DDTHH:mm'。時刻が無ければ 'YYYY-MM-DD'） */
  viewingTimes: string[];
  forbiddenTopic: ForbiddenTopic | null;
  /**
   * 住みたい場所として、駅マスタ・区の一覧に無い地名（「船橋で」）を挙げた。その地名は ops に出ない。
   * 会話エンジンは前の条件で黙って探さず、対応エリアを案内する。省略は false
   */
  outOfArea?: boolean;
}

// ---------- 営業時間 ----------

export interface BusinessHoursRow {
  /** 0=日 … 6=土 */
  weekday: number;
  /** 'HH:MM'（JST） */
  open: string;
  close: string;
  isClosed: boolean;
}

export interface BusinessCalendar {
  hours: BusinessHoursRow[];
  /** 休業日 'YYYY-MM-DD'（JST）。祝日と臨時休業 */
  holidays: string[];
}
