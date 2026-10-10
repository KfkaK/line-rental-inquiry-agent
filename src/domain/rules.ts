/**
 * 業務ルールの定数。マジックナンバーはここにだけ置く。値を変えたら DESIGN.md の該当箇所も直す。
 */
import type { Priority, ScalarSlotKey } from './types';

// ---------- 優先度とスコア（DESIGN.md 3.2.1・4.2） ----------

/** スコア加点の重み。must は絞り込みなので重みを持たない */
export const PRIORITY_WEIGHT: Record<Exclude<Priority, 'must'>, number> = {
  want: 2,
  nice: 1,
};

/** 明示が無いときの優先度。初回はエリアと予算を must、それ以外は want */
export const DEFAULT_PRIORITY: Record<ScalarSlotKey, Priority> & { tag: Priority } = {
  area: 'must',
  rentMax: 'must',
  layouts: 'want',
  walkMax: 'want',
  floorMin: 'want',
  moveIn: 'want',
  tag: 'want',
};

/**
 * 数値条件の段階評価。上限（予算・徒歩）を超えた量が許容幅以内なら PARTIAL_CREDIT、超えたら 0。
 * 例: 徒歩10分 want に対し 12分 → 0.6
 */
export const PARTIAL_CREDIT = 0.6;
/** 徒歩: 上限＋この分数までは部分点 */
export const WALK_PARTIAL_TOLERANCE_MIN = 3;
/** 予算: 上限＋この円までは部分点 */
export const RENT_PARTIAL_TOLERANCE_YEN = 5000;
/** 階数: 下限−この階までは部分点（2階以上 want に対し 1階 → 部分点なし。0 で無効） */
export const FLOOR_PARTIAL_TOLERANCE = 0;

/** 予算と比べる金額に管理費を含める（「月々いくら」の感覚に合わせる） */
export const BUDGET_INCLUDES_MANAGEMENT_FEE = true;

// ---------- 条件の値域（LLM 出力の正規化。src/domain/normalize.ts） ----------

/** LLM が返した数値をこの範囲にクランプする */
export const CLAMP = {
  /** 家賃上限（円）。1万〜100万 */
  rentYen: { min: 10_000, max: 1_000_000 },
  /** 駅徒歩（分） */
  walkMin: { min: 1, max: 60 },
  /** 階 */
  floor: { min: 1, max: 50 },
} as const;

/** 家賃として渡された整数がこの値以下なら「万」単位の取り違えとみなす（例: 7 → 7万円） */
export const RENT_IN_MAN_UP_TO = 100;

// ---------- 提示（DESIGN.md 2.1・6.1） ----------

/** 1回に見せる件数（Flex カルーセル。LINE の上限は 12 バブル） */
export const PAGE_SIZE = 5;

/** 優先順位を聞く条件: 0件、またはこの件数を超えたとき。1会話で1回まで */
export const ASK_PRIORITY_WHEN_MORE_THAN = 20;
export const ASK_PRIORITY_MAX_PER_CONVERSATION = 1;

/** 候補がこの件数以下なら緩和を提案する */
export const SUGGEST_RELAXATION_AT_OR_BELOW = 2;

/** 従来型の緩和（フォールバック）の幅 */
export const FALLBACK_RELAX_RENT_YEN = 5000;
export const FALLBACK_RELAX_WALK_MIN = 5;

/** 「駅近」の解釈 */
export const NEAR_STATION_WALK_MIN = 10;

// ---------- 内見の仮受付（DESIGN.md 2.1） ----------

/** 聞き取る候補日時の数 */
export const VIEWING_CANDIDATES_MIN = 2;
export const VIEWING_CANDIDATES_MAX = 3;
/** 内見候補日として提示する営業日の数（翌営業日から） */
export const VIEWING_DAYS_TO_OFFER = 5;

// ---------- 有人対応への切替（DESIGN.md 3.4） ----------

/** 最終の担当者返信からこの時間が経つと AI の自動応答を再開する */
export const AI_RESUME_AFTER_MS = 24 * 60 * 60 * 1000;

// ---------- 営業時間（DESIGN.md 2.1。既定値。実際の値は business_hours テーブル） ----------

export const DEFAULT_OPEN = '10:00';
export const DEFAULT_CLOSE = '19:00';
/** 定休日（0=日 … 6=土）。既定は水曜 */
export const DEFAULT_CLOSED_WEEKDAYS = [3];
/** 日付と営業時間はすべて JST で解釈する（Vercel は UTC で動く） */
export const TIMEZONE_OFFSET_MINUTES = 9 * 60;

// ---------- 回答生成と根拠検証（DESIGN.md 4.3） ----------

/** 回答文の字数の上限（プロンプトでは 300 字以内と指示し、超えたら根拠検証で引き継ぎに倒す。LINE のテキストは 5,000 字まで） */
export const ANSWER_MAX_CHARS = 800;
/** 面積（㎡）の照合で同じ値とみなす差。レコードは小数1桁なので、表記の丸めだけを許す */
export const AREA_MATCH_TOLERANCE_SQM = 0.051;

// ---------- 乱用対策・費用（DESIGN.md 4.4） ----------

/** 1ユーザーあたりの発話数の上限（1分間） */
export const RATE_LIMIT_PER_MINUTE = 5;

// ---------- 個人情報（DESIGN.md 8章） ----------

/** 会話ログの保存日数 */
export const MESSAGE_RETENTION_DAYS = 90;
