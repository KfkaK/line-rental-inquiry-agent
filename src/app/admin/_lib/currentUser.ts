import { cache } from 'react';
import { getAdminUser } from '@/server/admin/session';

/**
 * ログイン中の利用者（未ログインは null）。ヘッダーと帯が同じリクエストで読むので、1リクエストにつき1回だけ確かめる。
 * cookie を読むので、呼ぶコンポーネントは <Suspense> の内側に置くこと。
 */
export const currentUser = cache(getAdminUser);
