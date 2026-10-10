/**
 * 管理画面のログインと権限（Data Access Layer）。ページと Server Action は DB をここ経由でだけ読み書きする。
 *
 * - DB はログインした利用者のセッションのクライアント（publishable key ＋ JWT）で読み書きし、RLS を本物の門にする
 *   （service role は RLS を迂回するので管理画面では使わない。引き継ぎ書 6章③）
 * - 役割は JWT の app_metadata.role（'staff' 担当者 / 'viewer' 閲覧用）。RLS も同じ値を見る（supabase/migrations/20261011000000_admin_roles.sql）
 * - 画面の出し分け（閲覧用ではボタンを出さない）は見た目だけ。書き込みは Server Action が `getStaffDeps()` で役割を確かめ直し、RLS がもう一度止める
 * - Cache Components 有効下では cookies を読むコンポーネントは <Suspense> の内側に置くこと
 */
import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { cache } from 'react';
import { createSupabaseRepositories, type Repositories } from '@/lib/db';
import { requireEnv } from '@/lib/env';
import { createLineMessenger } from '@/lib/line/messenger';
import { getPreviewDeps, isAdminPreview } from './preview';
import type { StaffDeps } from './service';

export const ADMIN_ROLES = ['staff', 'viewer'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export interface AdminUser {
  email: string | null;
  /** 役割が付いていないアカウントは null（何も読めない） */
  role: AdminRole | null;
  /** ローカルのプレビュー（ADMIN_PREVIEW=1）。ログインしていない */
  preview: boolean;
}

function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && (ADMIN_ROLES as readonly string[]).includes(value);
}

/** ログイン中の利用者のセッションのクライアント。リクエストごとに作る（使い回さない） */
export async function createSessionClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  return createServerClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_PUBLISHABLE_KEY'), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Server Component からは cookie を書けない。トークンの更新は proxy（src/proxy.ts）が行う
        }
      },
    },
  });
}

interface AdminSession {
  user: AdminUser;
  /** プレビューでは null */
  client: SupabaseClient | null;
}

/**
 * ログイン中の利用者。未ログインなら null。JWT の署名を検証して読む（cookie の中身をそのまま信じない）。
 * ヘッダー・帯・ページが同じリクエストで読むので、描画中は1リクエスト1回にまとめる（cache）
 */
const getAdminSession = cache(async (): Promise<AdminSession | null> => {
  // 管理画面はリクエストごとに描く（プレビューでは cookie を読まないので、ここで明示する）。呼んだ後は new Date() を使ってよい
  await connection();
  if (isAdminPreview()) return { user: { email: 'preview@example.test', role: 'staff', preview: true }, client: null };
  const client = await createSessionClient();
  const { data, error } = await client.auth.getClaims();
  if (error || !data?.claims) return null;
  const role: unknown = data.claims.app_metadata?.role;
  return { user: { email: data.claims.email ?? null, role: isAdminRole(role) ? role : null, preview: false }, client };
});

export async function getAdminUser(): Promise<AdminUser | null> {
  return (await getAdminSession())?.user ?? null;
}

/**
 * ページ用。未ログインはログイン画面へ、役割の無いアカウントは理由つきでログイン画面へ送る。
 * 返す `repos` はその利用者の権限（RLS）で読む
 */
export async function requireAdmin(): Promise<{ user: AdminUser & { role: AdminRole }; repos: Repositories }> {
  const session = await getAdminSession();
  if (!session) redirect('/admin/login');
  const { user, client } = session;
  if (!user.role) redirect('/admin/login?reason=norole');
  const repos = client ? createSupabaseRepositories(client) : getPreviewDeps().repos;
  return { user: { ...user, role: user.role }, repos };
}

/**
 * Server Action 用。担当者（staff）だけに書き込みの部品を渡す。閲覧用・未ログインは画面に出す文を返す。
 * Server Action は誰でも直接呼べるので、ページの出し分けに頼らずここで必ず確かめる
 */
export async function getStaffDeps(): Promise<StaffDeps | { error: string }> {
  const session = await getAdminSession();
  if (!session) return { error: 'ログインが切れました。ログインし直してください。' };
  if (session.user.role !== 'staff') return { error: '閲覧用のアカウントでは変更できません。' };
  if (!session.client) return getPreviewDeps();
  return {
    repos: createSupabaseRepositories(session.client),
    messenger: createLineMessenger(),
    clock: () => new Date(),
  };
}
