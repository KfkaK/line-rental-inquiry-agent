/**
 * ローカル開発専用のプレビュー（`.env.local` に ADMIN_PREVIEW=1）。ログインせずに、インメモリのデモデータで管理画面を開く。
 * LINE には送らない（偽の送信口）。データは開発サーバーのプロセスの中だけにあり、再起動で初期化される。
 *
 * 本番ビルド（NODE_ENV=production。Vercel も `next start` も）では環境変数があっても必ず無効。
 * 認証を飛ばす口なので、判定は ./previewFlag.ts の `isAdminPreview()` 1か所に置き、ページ・Server Action・proxy はそれだけを見る。
 */
import { createMemoryRepositories } from '@/lib/db';
import { createFakeMessenger } from '@/lib/line/messenger';
import { isAdminPreview } from './previewFlag';
import { buildPreviewSeed } from './previewSeed';
import type { StaffDeps } from './service';

export { isAdminPreview };

// 開発サーバーはリクエストごとにモジュールを読み直すことがあるので、globalThis に1つだけ持つ
const store = globalThis as typeof globalThis & { __adminPreviewDeps?: StaffDeps };

export function getPreviewDeps(): StaffDeps {
  if (!isAdminPreview()) throw new Error('管理画面のプレビューは開発環境で ADMIN_PREVIEW=1 のときだけ使えます');
  store.__adminPreviewDeps ??= {
    repos: createMemoryRepositories(buildPreviewSeed(new Date())),
    messenger: createFakeMessenger(),
    clock: () => new Date(),
  };
  return store.__adminPreviewDeps;
}
