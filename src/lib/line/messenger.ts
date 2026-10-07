import { messagingApi } from '@line/bot-sdk';
import { requireEnv } from '@/lib/env';

/**
 * LINE への送信口。外部サービスはこのインターフェースの背後に置き、テストは偽物（createFakeMessenger）で回す。
 *
 * 1回の reply / push は最大 5 メッセージ（LINE の上限）。超えたときの扱い:
 * - push: 5 通ずつに**分割して順に送る**（順序は保たれる。クイックリプライは元の最後のメッセージに付いたまま最後の組に入る）
 * - reply: replyToken は1回しか使えないので分割できない。**先頭 5 通だけ送り、6 通目以降は切り捨てる**（console.warn に件数を出す）。
 *   呼び出し側は 5 通以内に収めること（切り捨てたメッセージのクイックリプライも失われる）
 * - 空配列は何も送らない（LINE は空の messages を 400 で拒否するため）
 */

export type LineMessage = messagingApi.Message;

export interface LineProfile {
  displayName: string;
  pictureUrl?: string;
}

export interface LineMessenger {
  reply(replyToken: string, messages: LineMessage[]): Promise<void>;
  push(to: string, messages: LineMessage[]): Promise<void>;
  /** 入力中アニメーション（1:1 トークのみ）。5〜60 秒の 5 の倍数に丸める。失敗しても例外にしない（見た目だけの機能） */
  showLoading(userId: string, seconds: number): Promise<void>;
  /** 取得できなければ null（ブロック済み・退会など）。呼び出し側は表示名なしで続行する */
  getProfile(userId: string): Promise<LineProfile | null>;
}

/** 1回の reply / push に載せられる最大メッセージ数 */
export const MAX_MESSAGES_PER_CALL = 5;

const LOADING_MIN_SECONDS = 5;
const LOADING_MAX_SECONDS = 60;

/** reply 用: 先頭 5 通だけ残し、切り捨てた件数を返す */
export function truncateForReply(messages: LineMessage[]): { sent: LineMessage[]; dropped: number } {
  const sent = messages.slice(0, MAX_MESSAGES_PER_CALL);
  return { sent, dropped: messages.length - sent.length };
}

/** push 用: 5 通ずつに分割する（空配列なら空） */
export function chunkForPush(messages: LineMessage[]): LineMessage[][] {
  const chunks: LineMessage[][] = [];
  for (let i = 0; i < messages.length; i += MAX_MESSAGES_PER_CALL) {
    chunks.push(messages.slice(i, i + MAX_MESSAGES_PER_CALL));
  }
  return chunks;
}

/** 入力中アニメーションの秒数を LINE の仕様（5〜60 の 5 の倍数）に丸める */
export function clampLoadingSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return LOADING_MIN_SECONDS;
  const rounded = Math.round(seconds / 5) * 5;
  return Math.min(LOADING_MAX_SECONDS, Math.max(LOADING_MIN_SECONDS, rounded));
}

/** 使う API だけ。テストでは偽物のクライアントを渡す */
export type LineApiClient = Pick<
  messagingApi.MessagingApiClient,
  'replyMessage' | 'pushMessage' | 'showLoadingAnimation' | 'getProfile'
>;

/** 実装。トークンは呼ばれた時点で読む（モジュール読み込み時には読まない） */
export function createLineMessenger(client?: LineApiClient): LineMessenger {
  const api: LineApiClient =
    client ?? new messagingApi.MessagingApiClient({ channelAccessToken: requireEnv('LINE_CHANNEL_ACCESS_TOKEN') });

  return {
    async reply(replyToken, messages) {
      const { sent, dropped } = truncateForReply(messages);
      if (dropped > 0) {
        console.warn(`[line] reply は ${MAX_MESSAGES_PER_CALL} 通までのため ${dropped} 通を切り捨てました`);
      }
      if (sent.length === 0) return;
      await api.replyMessage({ replyToken, messages: sent });
    },

    async push(to, messages) {
      for (const chunk of chunkForPush(messages)) {
        await api.pushMessage({ to, messages: chunk });
      }
    },

    async showLoading(userId, seconds) {
      try {
        await api.showLoadingAnimation({ chatId: userId, loadingSeconds: clampLoadingSeconds(seconds) });
      } catch (error) {
        console.warn('[line] showLoadingAnimation に失敗しました（無視して続行）', errorSummary(error));
      }
    },

    async getProfile(userId) {
      try {
        const profile = await api.getProfile(userId);
        return { displayName: profile.displayName, pictureUrl: profile.pictureUrl };
      } catch (error) {
        console.warn('[line] getProfile に失敗しました（表示名なしで続行）', errorSummary(error));
        return null;
      }
    },
  };
}

/** ログに出すのはエラーの種類と短い説明だけ（ユーザー情報を含めない） */
function errorSummary(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

// ---------- テスト用の偽物 ----------

export interface FakeMessenger extends LineMessenger {
  /** 実際に送られる内容（5 通を超えた分は切り捨て済み）。`dropped` は切り捨てた件数 */
  readonly replies: { replyToken: string; messages: LineMessage[]; dropped: number }[];
  /** 5 通ずつに分割した後の1回ごとの送信 */
  readonly pushes: { to: string; messages: LineMessage[] }[];
  readonly loadings: { userId: string; seconds: number }[];
  /** 設定すると reply がこのエラーで失敗する（replyToken 失効 → push に切り替える経路のテスト用）。null で解除 */
  failReplyWith: Error | null;
  /** 設定すると push がこのエラーで失敗する。null で解除 */
  failPushWith: Error | null;
  setProfile(userId: string, profile: LineProfile | null): void;
}

export function createFakeMessenger(options: { profiles?: Record<string, LineProfile> } = {}): FakeMessenger {
  const profiles = new Map<string, LineProfile | null>(Object.entries(options.profiles ?? {}));
  const fake: FakeMessenger = {
    replies: [],
    pushes: [],
    loadings: [],
    failReplyWith: null,
    failPushWith: null,

    async reply(replyToken, messages) {
      if (fake.failReplyWith) throw fake.failReplyWith;
      const { sent, dropped } = truncateForReply(messages);
      if (sent.length === 0) return;
      fake.replies.push({ replyToken, messages: sent, dropped });
    },

    async push(to, messages) {
      if (fake.failPushWith) throw fake.failPushWith;
      for (const chunk of chunkForPush(messages)) {
        fake.pushes.push({ to, messages: chunk });
      }
    },

    async showLoading(userId, seconds) {
      fake.loadings.push({ userId, seconds: clampLoadingSeconds(seconds) });
    },

    async getProfile(userId) {
      return profiles.get(userId) ?? null;
    },

    setProfile(userId, profile) {
      profiles.set(userId, profile);
    },
  };
  return fake;
}
