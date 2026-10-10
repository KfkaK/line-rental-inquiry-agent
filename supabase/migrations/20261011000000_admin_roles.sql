-- 管理画面（Week 3・意思決定ログ9・12）。
--
-- 方針
--   * 管理画面の読み書きは、ログインした利用者のセッションのクライアント（publishable key ＋ JWT）で行い、RLS を本物の門にする。
--     service role（RLS をバイパス）は Webhook とスクリプトだけが使う。
--   * 役割は Supabase Auth の app_metadata.role で持つ。app_metadata は service role でしか書けないので、利用者が自分では変えられない。
--       staff  : 担当者。これまでどおり画面で要る select / insert / update ができる
--       viewer : 公開デモの閲覧用アカウント。読み取りだけで、会話はデモ会話（is_demo）に限る
--     役割の無いログインユーザーは何も読めない（付け忘れで、配った閲覧用の資格情報に担当者の権限が付かないよう、既定は拒否）。
--     担当者・閲覧用のユーザーは scripts/admin-user.ts で作る（README・引き継ぎ書 9章）。
--   * 列の追加は 1 行 1 列の `alter table ... add column` で書く（src/lib/db/mappers.test.ts が読んで列名を検査する）。

-- ---------- 列の追加 ----------

-- 閲覧用アカウントに見せるデモ会話（種まきしたもの。確定・返信しても LINE には送らない）
alter table public.conversations add column is_demo boolean not null default false;
-- 担当者が対応済みにした引き継ぎメモの数（handoff_notes の先頭からこの数まで）。メモは追記だけなので、見た件数を書けば後から届いたメモは未対応で残る
alter table public.conversations add column handoff_resolved_count integer not null default 0 check (handoff_resolved_count >= 0);
-- 未対応の引き継ぎメモの数（朝の引き継ぎ一覧で「未対応のメモがある会話」を引くため。PostgREST は列どうしを比べられないので生成列にする）
alter table public.conversations add column handoff_open_count integer generated always as (greatest(jsonb_array_length(handoff_notes) - handoff_resolved_count, 0)) stored;

create index conversations_handoff_open_idx on public.conversations (updated_at desc) where handoff_open_count > 0;
create index viewing_requests_conversation_created_idx on public.viewing_requests (conversation_id, created_at);

-- ---------- 役割 ----------

-- ログイン中の利用者の役割（'staff' / 'viewer'。無ければ空文字）。RLS のポリシーから呼ぶ
create or replace function public.app_role()
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '');
$$;

revoke all on function public.app_role() from public, anon;
grant execute on function public.app_role() to authenticated, service_role;

-- ---------- 担当者（staff）のポリシーを役割で絞る ----------
-- `(select public.app_role())` と包むと、行ごとでなくクエリに 1 回だけ評価される

alter policy staff_select on public.properties using ((select public.app_role()) = 'staff');
alter policy staff_insert on public.properties with check ((select public.app_role()) = 'staff');
alter policy staff_update on public.properties using ((select public.app_role()) = 'staff') with check ((select public.app_role()) = 'staff');

alter policy staff_select on public.line_users using ((select public.app_role()) = 'staff');

alter policy staff_select on public.conversations using ((select public.app_role()) = 'staff');
alter policy staff_update on public.conversations using ((select public.app_role()) = 'staff') with check ((select public.app_role()) = 'staff');

alter policy staff_select on public.messages using ((select public.app_role()) = 'staff');
alter policy staff_insert on public.messages with check ((select public.app_role()) = 'staff');

alter policy staff_select on public.viewing_requests using ((select public.app_role()) = 'staff');
alter policy staff_update on public.viewing_requests using ((select public.app_role()) = 'staff') with check ((select public.app_role()) = 'staff');

alter policy staff_select on public.business_hours using ((select public.app_role()) = 'staff');
alter policy staff_insert on public.business_hours with check ((select public.app_role()) = 'staff');
alter policy staff_update on public.business_hours using ((select public.app_role()) = 'staff') with check ((select public.app_role()) = 'staff');

alter policy staff_select on public.holidays using ((select public.app_role()) = 'staff');
alter policy staff_insert on public.holidays with check ((select public.app_role()) = 'staff');
alter policy staff_update on public.holidays using ((select public.app_role()) = 'staff') with check ((select public.app_role()) = 'staff');
alter policy staff_delete on public.holidays using ((select public.app_role()) = 'staff');

-- ---------- 閲覧用（viewer）: 読み取りだけ・会話はデモに限る ----------
-- insert / update / delete のポリシーは作らない（RLS は許可の和なので、viewer の書き込みはどれにも当たらず拒否される）

create policy viewer_select on public.properties for select to authenticated
  using ((select public.app_role()) = 'viewer');

create policy viewer_select on public.business_hours for select to authenticated
  using ((select public.app_role()) = 'viewer');

create policy viewer_select on public.holidays for select to authenticated
  using ((select public.app_role()) = 'viewer');

create policy viewer_select on public.conversations for select to authenticated
  using ((select public.app_role()) = 'viewer' and is_demo);

-- 下の 3 つの exists は conversations の RLS（viewer はデモ会話だけ見える）を通って評価される
create policy viewer_select on public.line_users for select to authenticated
  using (
    (select public.app_role()) = 'viewer'
    and exists (select 1 from public.conversations c where c.line_user_id = line_users.line_user_id and c.is_demo)
  );

create policy viewer_select on public.messages for select to authenticated
  using (
    (select public.app_role()) = 'viewer'
    and exists (select 1 from public.conversations c where c.id = messages.conversation_id and c.is_demo)
  );

create policy viewer_select on public.viewing_requests for select to authenticated
  using (
    (select public.app_role()) = 'viewer'
    and exists (select 1 from public.conversations c where c.id = viewing_requests.conversation_id and c.is_demo)
  );
