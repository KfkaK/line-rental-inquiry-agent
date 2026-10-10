/**
 * 管理画面の表示名（純関数・定数）。内見の状態の名前は domain/staff.ts の `VIEWING_STATUS_LABEL`、
 * 禁止トピックと優先度の名前は domain/messages.ts にある。
 */
import type { MessageRole } from '@/lib/db';
import type { ConversationState, Intent } from '@/domain/types';
import type { AdminRole } from '@/server/admin/session';

export const CONVERSATION_STATE_LABEL: Record<ConversationState, string> = {
  hearing: 'ヒアリング中',
  presenting: '物件を提示済み',
  qa: '質問対応中',
  booking: '内見の聞き取り中',
  handed_off: '担当者へ引き継ぎ',
};

export const INTENT_LABEL: Record<Intent, string> = {
  conditions: '条件の提示・変更',
  showMore: 'もっと見る',
  propertyQuestion: '物件への質問',
  viewingRequest: '内見の希望',
  offTopic: '範囲外・雑談',
  handoff: '担当者への引き継ぎ',
};

export const MESSAGE_ROLE_LABEL: Record<MessageRole, string> = {
  user: '利用者',
  ai: 'AI',
  staff: '担当者',
};

export const ADMIN_ROLE_LABEL: Record<AdminRole, string> = {
  staff: '担当者',
  viewer: '閲覧用',
};

/** 営業時間の画面で並べる曜日（月曜始まり）。0=日 … 6=土 */
export const WEEKDAY_DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
export const WEEKDAY_NAME = ['日', '月', '火', '水', '木', '金', '土'] as const;
