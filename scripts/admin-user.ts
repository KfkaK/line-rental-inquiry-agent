/**
 * 管理画面のアカウントを作る・役割を付け替える（service role の Admin API。意思決定ログ12）。
 * 役割は app_metadata.role（staff 担当者 / viewer 閲覧用）。RLS はこの値で読み書きを決め、役割の無いアカウントは何も読めない。
 * Sign-ups は無効なので、アカウントはここで作る。
 *
 * 使い方（環境変数は .env.local から読む。SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が要る）:
 *   npm run admin:user -- --email=staff@example.com --role=staff     # 無ければ作り（パスワードを1回だけ表示）、あれば役割を付け替える
 *   npm run admin:user -- --email=viewer@example.com --role=viewer
 *   npm run admin:user -- --email=staff@example.com --reset-password # パスワードを作り直して表示する
 *   npm run admin:user -- --email=staff@example.com --role=none      # 役割を外す（何も読めなくなる）
 *   npm run admin:user -- --list                                     # アカウントと役割の一覧
 *
 * パスワードは画面にだけ出す（ファイルやログに残さない）。閲覧用のパスワードは公開デモの README に載せる前提で作り直してよい。
 */
import { randomBytes } from 'node:crypto';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { createServiceClient } from '@/lib/db';

const ROLES = ['staff', 'viewer', 'none'] as const;
type RoleArg = (typeof ROLES)[number];

interface Args {
  email: string | null;
  role: RoleArg | null;
  resetPassword: boolean;
  list: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { email: null, role: null, resetPassword: false, list: false };
  for (const arg of argv) {
    if (arg === '--list') args.list = true;
    else if (arg === '--reset-password') args.resetPassword = true;
    else if (arg.startsWith('--email=')) args.email = arg.slice('--email='.length).trim().toLowerCase();
    else if (arg.startsWith('--role=')) {
      const value = arg.slice('--role='.length);
      if (!(ROLES as readonly string[]).includes(value)) throw new Error(`--role は ${ROLES.join(' / ')} のどれか: ${value}`);
      args.role = value as RoleArg;
    } else throw new Error(`未知のオプション: ${arg}`);
  }
  if (!args.list && !args.email) throw new Error('--email=... か --list を指定してください');
  if (!args.list && !args.role && !args.resetPassword) throw new Error('--role=... か --reset-password を指定してください');
  return args;
}

/** 記号を含まない 24 文字（URL・シェルに貼っても崩れない） */
function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

async function listAllUsers(client: SupabaseClient): Promise<User[]> {
  const users: User[] = [];
  for (let page = 1; ; page++) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`アカウントの一覧を取れません: ${error.message}`);
    users.push(...data.users);
    if (data.users.length < 1000) return users;
  }
}

function roleOf(user: User): string {
  const role: unknown = user.app_metadata?.role;
  return typeof role === 'string' ? role : '（なし）';
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    // .env.local が無ければ、環境変数がすでに設定されている前提で続ける
  }
  const args = parseArgs(process.argv.slice(2));
  const client = createServiceClient();
  const users = await listAllUsers(client);

  if (args.list) {
    if (users.length === 0) console.log('アカウントはありません');
    for (const user of users) console.log(`${user.email ?? '（メールなし）'}  役割: ${roleOf(user)}`);
    return;
  }

  const email = args.email!;
  const existing = users.find((u) => u.email?.toLowerCase() === email);
  const appRole = args.role === 'none' ? null : args.role;

  if (!existing) {
    if (!appRole) throw new Error(`${email} のアカウントはありません（作るときは --role=staff か --role=viewer）`);
    const password = generatePassword();
    const { error } = await client.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { role: appRole },
    });
    if (error) throw new Error(`アカウントを作れません: ${error.message}`);
    console.log(`作りました: ${email}（役割: ${appRole}）`);
    console.log(`パスワード（この画面にだけ出します。控えてください）: ${password}`);
    return;
  }

  const attributes: { app_metadata?: Record<string, unknown>; password?: string } = {};
  if (args.role) attributes.app_metadata = { ...existing.app_metadata, role: appRole };
  const password = args.resetPassword ? generatePassword() : null;
  if (password) attributes.password = password;
  const { error } = await client.auth.admin.updateUserById(existing.id, attributes);
  if (error) throw new Error(`アカウントを更新できません: ${error.message}`);
  if (args.role) console.log(`役割を変えました: ${email}（${roleOf(existing)} → ${appRole ?? '（なし）'}）。ログイン中なら、ログインし直すと効きます`);
  if (password) console.log(`新しいパスワード（この画面にだけ出します。控えてください）: ${password}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
