import { SCALAR_SLOT_KEYS, TAGS, type ConditionRef, type ScalarSlotKey, type Tag } from '@/domain/types';

/**
 * postback の data の組み立てと解析。形式は URLSearchParams（例: `a=detail&id=P001`）。
 *
 * - 組み立ては自分のコードが呼ぶので、不正な入力（空の ID・300 文字超）は例外にする（バグを早く見つけるため）。
 * - 解析の入力はユーザー経由（偽造できる）なので、不正な data は**例外にせず null** を返す。
 *   呼び出し側は null を「無視」または定型文で扱う。
 */

/** LINE の postback data の上限（文字数） */
export const POSTBACK_DATA_MAX_LENGTH = 300;
const PROPERTY_ID_MAX_LENGTH = 100;

export type PostbackData =
  | { action: 'detail'; propertyId: string }
  | { action: 'viewing'; propertyId: string }
  | { action: 'more' }
  /** 内見の候補日（JST の 'YYYY-MM-DD'） */
  | { action: 'viewingDay'; date: string }
  /** 内見の候補日時をこのまま送る */
  | { action: 'bookingSubmit' }
  | { action: 'relax'; ref: ConditionRef; accept: boolean }
  | { action: 'priority'; ref: ConditionRef };

export type PostbackAction = PostbackData['action'];

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isValidPropertyId(id: string): boolean {
  return id.length > 0 && id.length <= PROPERTY_ID_MAX_LENGTH && !CONTROL_CHARS.test(id);
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isSlotKey(value: string): value is ScalarSlotKey {
  return (SCALAR_SLOT_KEYS as readonly string[]).includes(value);
}

function isTag(value: string): value is Tag {
  return (TAGS as readonly string[]).includes(value);
}

function setRef(params: URLSearchParams, ref: ConditionRef): void {
  if (ref.kind === 'slot') {
    params.set('k', 'slot');
    params.set('key', ref.key);
  } else {
    params.set('k', 'tag');
    params.set('tag', ref.tag);
  }
}

function getRef(params: URLSearchParams): ConditionRef | null {
  const kind = params.get('k');
  if (kind === 'slot') {
    const key = params.get('key');
    return key !== null && isSlotKey(key) ? { kind: 'slot', key } : null;
  }
  if (kind === 'tag') {
    const tag = params.get('tag');
    return tag !== null && isTag(tag) ? { kind: 'tag', tag } : null;
  }
  return null;
}

/** postback の data 文字列を作る。300 文字を超える・物件 ID が不正なときは例外 */
export function buildPostbackData(data: PostbackData): string {
  const params = new URLSearchParams();
  params.set('a', data.action);
  switch (data.action) {
    case 'detail':
    case 'viewing':
      if (!isValidPropertyId(data.propertyId)) {
        throw new Error(`postback の物件 ID が不正です（空・長すぎ・制御文字）: ${JSON.stringify(data.propertyId)}`);
      }
      params.set('id', data.propertyId);
      break;
    case 'more':
    case 'bookingSubmit':
      break;
    case 'viewingDay':
      if (!DATE_PATTERN.test(data.date)) throw new Error(`postback の日付が不正です: ${JSON.stringify(data.date)}`);
      params.set('d', data.date);
      break;
    case 'relax':
      setRef(params, data.ref);
      params.set('accept', data.accept ? '1' : '0');
      break;
    case 'priority':
      setRef(params, data.ref);
      break;
  }
  const result = params.toString();
  if (result.length > POSTBACK_DATA_MAX_LENGTH) {
    throw new Error(`postback data が ${POSTBACK_DATA_MAX_LENGTH} 文字を超えています（${result.length} 文字）`);
  }
  return result;
}

/** postback の data を解析する。不正・未知・偽造された値は null */
export function parsePostbackData(raw: unknown): PostbackData | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > POSTBACK_DATA_MAX_LENGTH) return null;
  const params = new URLSearchParams(raw);

  switch (params.get('a')) {
    case 'detail':
    case 'viewing': {
      const id = params.get('id');
      if (id === null || !isValidPropertyId(id)) return null;
      return { action: params.get('a') as 'detail' | 'viewing', propertyId: id };
    }
    case 'more':
      return { action: 'more' };
    case 'bookingSubmit':
      return { action: 'bookingSubmit' };
    case 'viewingDay': {
      const date = params.get('d');
      return date !== null && DATE_PATTERN.test(date) ? { action: 'viewingDay', date } : null;
    }
    case 'relax': {
      const ref = getRef(params);
      const accept = params.get('accept');
      if (ref === null || (accept !== '1' && accept !== '0')) return null;
      return { action: 'relax', ref, accept: accept === '1' };
    }
    case 'priority': {
      const ref = getRef(params);
      return ref === null ? null : { action: 'priority', ref };
    }
    default:
      return null;
  }
}
