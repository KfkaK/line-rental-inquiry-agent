-- 初期スキーマ（DESIGN.md 5章）。Postgres 15 / Supabase。
--
-- 方針
--   * サーバー（Next.js の Webhook・管理画面の Server Action）は service role で読み書きする（RLS をバイパス）。
--   * 管理画面にログインした担当者（authenticated）には、画面で要る select / insert / update だけを許す。anon には何も許さない。
--     全員が担当者の前提なので、Supabase の Authentication で Sign-ups を無効にし、担当者は招待で作ること。
--   * 物件の must 条件の絞り込みは SQL でなくアプリの純関数（src/domain）で行う。検索用の複雑なインデックスや RPC は持たない。
--   * 列の定義は 1 行 1 列で書く（src/lib/db/mappers.test.ts がこのファイルを読んで、マッパーの列名との食い違いを検査する）。
--   * enum 相当の check の値は src/domain/types.ts と揃える（同じテストが検査する）。

-- ---------- 共通 ----------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------- properties（物件マスタ。CSV から取込） ----------

create table public.properties (
  id text primary key,
  name text not null,
  address text not null,
  ward text not null,
  -- 最寄り駅 1〜3 件。先頭が最寄り。例: [{ "station": "渋谷", "walk_min": 7 }]
  access jsonb not null,
  rent integer not null check (rent > 0),
  management_fee integer not null default 0 check (management_fee >= 0),
  deposit_months numeric(4, 1) not null default 0 check (deposit_months >= 0),
  key_money_months numeric(4, 1) not null default 0 check (key_money_months >= 0),
  layout text not null check (layout in ('1R', '1K', '1DK', '1LDK', '2K', '2DK', '2LDK')),
  area_sqm numeric(6, 2) not null check (area_sqm > 0),
  floor integer not null,
  built_year integer not null,
  tags text[] not null default '{}',
  note text not null default '',
  -- null は即入居可
  available_from date,
  status text not null default 'public' check (status in ('public', 'private')),
  updated_at timestamptz not null default now(),
  constraint properties_access_check check (jsonb_typeof(access) = 'array' and jsonb_array_length(access) between 1 and 3)
);

create trigger properties_set_updated_at
  before update on public.properties
  for each row execute function public.set_updated_at();

-- ---------- line_users ----------

create table public.line_users (
  id uuid primary key default gen_random_uuid(),
  line_user_id text not null unique,
  display_name text,
  created_at timestamptz not null default now()
);

-- ---------- conversations（1 LINE ユーザー 1 会話） ----------

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  line_user_id text not null unique references public.line_users (line_user_id) on delete cascade,
  state text not null default 'hearing' check (state in ('hearing', 'presenting', 'qa', 'booking', 'handed_off')),
  -- src/domain/types.ts の Slots をそのまま（camelCase）保存する
  slots jsonb not null default '{"tags": []}'::jsonb,
  -- 提示済みの物件 ID（表示順）。「2番目」などの参照解決に使う
  shown_property_ids text[] not null default '{}',
  -- 「もっと見る」の位置（検索結果の何件目まで見せたか）
  shown_offset integer not null default 0 check (shown_offset >= 0),
  -- 直近の検索の must 通過件数。null は未検索
  last_search_total integer check (last_search_total >= 0),
  -- 優先順位を聞いた回数（1 会話 1 回まで。rules.ASK_PRIORITY_MAX_PER_CONVERSATION）
  priority_asked_count integer not null default 0 check (priority_asked_count >= 0),
  ai_paused boolean not null default false,
  paused_at timestamptz,
  -- 最終の担当者返信。24 時間で AI を再開する判定に使う
  last_staff_reply_at timestamptz,
  -- 内見の聞き取り途中の状態 { "propertyId": "...", "candidateTimes": ["..."] }。揃ったら viewing_requests を作って null に戻す
  booking jsonb,
  -- AI が答えずに担当者へ回した質問のメモ [{ "text": "...", "topic": "vacancy" | null, "at": "ISO 日時" }]。朝の引き継ぎ一覧の「AIが聞き取れなかったこと」に使う
  handoff_notes jsonb not null default '[]'::jsonb check (jsonb_typeof(handoff_notes) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index conversations_updated_at_idx on public.conversations (updated_at desc);

create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();

-- ---------- messages（会話ログと計測値。90 日で削除） ----------

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  role text not null check (role in ('user', 'ai', 'staff')),
  text text not null,
  intent text,
  -- 条件の差分（SlotOp[]）。管理画面の会話ログで「検索に使った条件」を見せる
  slot_diff jsonb,
  tool_calls jsonb,
  -- 根拠検証の結果。ok: そのまま / replaced: 定型の引き継ぎ文に差し替えた
  verification text check (verification in ('ok', 'replaced')),
  latency_ms integer check (latency_ms >= 0),
  cost_usd numeric(12, 6) not null default 0 check (cost_usd >= 0),
  created_at timestamptz not null default now()
);

create index messages_conversation_created_idx on public.messages (conversation_id, created_at);
create index messages_created_at_idx on public.messages (created_at);

-- メッセージが増えたら会話の updated_at を進める（管理画面の会話一覧を「最終動作の新しい順」にするため）
create or replace function public.touch_conversation_on_message()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.conversations set updated_at = now() where id = new.conversation_id;
  return new;
end;
$$;

create trigger messages_touch_conversation
  after insert on public.messages
  for each row execute function public.touch_conversation_on_message();

-- ---------- viewing_requests（内見の仮受付。確定・却下は担当者） ----------

create table public.viewing_requests (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  property_id text not null references public.properties (id),
  -- JST の 'YYYY-MM-DDTHH:mm'（時刻が無ければ 'YYYY-MM-DD'）。ExtractionResult.viewingTimes と同じ形式
  candidate_times text[] not null default '{}',
  -- 管理画面の 未対応 / 対応中 / 確定 / 却下
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'confirmed', 'rejected')),
  -- 確定した日時。candidate_times と同じ形式
  confirmed_time text,
  staff_note text,
  received_outside_hours boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index viewing_requests_created_at_idx on public.viewing_requests (created_at);
create index viewing_requests_status_created_idx on public.viewing_requests (status, created_at);

create trigger viewing_requests_set_updated_at
  before update on public.viewing_requests
  for each row execute function public.set_updated_at();

-- ---------- business_hours / holidays（営業時間設定） ----------

create table public.business_hours (
  -- 0=日 … 6=土
  weekday smallint primary key check (weekday between 0 and 6),
  open_time time not null,
  close_time time not null,
  is_closed boolean not null default false,
  constraint business_hours_open_before_close check (is_closed or open_time < close_time)
);

-- 既定値（rules.DEFAULT_OPEN / DEFAULT_CLOSE / DEFAULT_CLOSED_WEEKDAYS と揃える）。平日・土日とも 10:00-19:00、水曜定休
insert into public.business_hours (weekday, open_time, close_time, is_closed) values
  (0, '10:00', '19:00', false),
  (1, '10:00', '19:00', false),
  (2, '10:00', '19:00', false),
  (3, '10:00', '19:00', true),
  (4, '10:00', '19:00', false),
  (5, '10:00', '19:00', false),
  (6, '10:00', '19:00', false)
on conflict (weekday) do nothing;

create table public.holidays (
  -- 祝日と臨時休業（JST の日付）
  date date primary key,
  name text
);

-- ---------- webhook_events（再送による二重処理の防止） ----------

create table public.webhook_events (
  webhook_event_id text primary key,
  received_at timestamptz not null default now()
);

-- ---------- 関数 ----------

-- 指定時刻以降の API 費用の合計（1 日の費用上限の判定用。PostgREST の 1000 行上限に掛からないよう SQL で集計する）
create or replace function public.sum_message_cost_since(p_since timestamptz)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(cost_usd), 0) from public.messages where created_at >= p_since;
$$;

-- 会話ログの削除（個人情報は 90 日で消す。rules.MESSAGE_RETENTION_DAYS と揃える）。削除した件数を返す。
-- スケジュール（pg_cron や Vercel Cron）は別途設定する。
create or replace function public.purge_old_messages(retention_days integer default 90)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  deleted_count integer;
begin
  if retention_days is null or retention_days < 1 then
    raise exception 'retention_days must be 1 or more';
  end if;
  delete from public.messages
  where created_at < now() - make_interval(days => retention_days);
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.sum_message_cost_since(timestamptz) from public, anon, authenticated;
revoke all on function public.purge_old_messages(integer) from public, anon, authenticated;
grant execute on function public.sum_message_cost_since(timestamptz) to service_role;
grant execute on function public.purge_old_messages(integer) to service_role;

-- ---------- 権限と RLS ----------

alter table public.properties enable row level security;
alter table public.line_users enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.viewing_requests enable row level security;
alter table public.business_hours enable row level security;
alter table public.holidays enable row level security;
alter table public.webhook_events enable row level security;

-- いったん anon / authenticated の既定の権限（Supabase が public の新しいテーブルに付ける）を外し、要るものだけ付け直す。
-- service role は RLS をバイパスするが、テーブルの権限は要るので明示する。
revoke all on all tables in schema public from anon, authenticated;
grant all on all tables in schema public to service_role;

-- 担当者（authenticated）。delete は付けない（holidays だけ祝日の取り消しに要る）。webhook_events には何も付けない。
grant select, insert, update on public.properties to authenticated;
grant select on public.line_users to authenticated;
grant select, update on public.conversations to authenticated;
grant select, insert on public.messages to authenticated;
grant select, update on public.viewing_requests to authenticated;
grant select, insert, update on public.business_hours to authenticated;
grant select, insert, update, delete on public.holidays to authenticated;

create policy staff_select on public.properties for select to authenticated using (true);
create policy staff_insert on public.properties for insert to authenticated with check (true);
create policy staff_update on public.properties for update to authenticated using (true) with check (true);

create policy staff_select on public.line_users for select to authenticated using (true);

create policy staff_select on public.conversations for select to authenticated using (true);
create policy staff_update on public.conversations for update to authenticated using (true) with check (true);

create policy staff_select on public.messages for select to authenticated using (true);
create policy staff_insert on public.messages for insert to authenticated with check (true);

create policy staff_select on public.viewing_requests for select to authenticated using (true);
create policy staff_update on public.viewing_requests for update to authenticated using (true) with check (true);

create policy staff_select on public.business_hours for select to authenticated using (true);
create policy staff_insert on public.business_hours for insert to authenticated with check (true);
create policy staff_update on public.business_hours for update to authenticated using (true) with check (true);

create policy staff_select on public.holidays for select to authenticated using (true);
create policy staff_insert on public.holidays for insert to authenticated with check (true);
create policy staff_update on public.holidays for update to authenticated using (true) with check (true);
create policy staff_delete on public.holidays for delete to authenticated using (true);
