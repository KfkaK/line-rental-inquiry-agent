/**
 * 管理画面のプレビュー（ADMIN_PREVIEW=1・開発環境だけ）かどうか。認証を飛ばす口なので判定はここ1か所に置く。
 * proxy からも読むので、重い依存（LINE SDK・インメモリ DB）を持たないファイルに分けている。詳しくは ./preview.ts
 */
import { optionalEnv } from '@/lib/env';

export function isAdminPreview(): boolean {
  // 本番ビルド（Vercel・next start）では環境変数があっても必ず無効
  return process.env.NODE_ENV !== 'production' && optionalEnv('ADMIN_PREVIEW') === '1';
}
