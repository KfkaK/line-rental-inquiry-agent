-- 会話ログの90日削除で、引き継ぎメモ（conversations.handoff_notes）に写した発話の原文も消す（意思決定ログ19）。
--
-- これまでの purge_old_messages は messages だけを消し、AI が答えずに担当者へ回した質問の原文（handoff_notes[].text）は
-- 会話が続く限り残っていた（DESIGN.md 5章・8章の「会話ログは90日で削除」を一部しか満たさない）。
-- メモの要素は消さずに text だけを空にする。要素を消すと handoff_resolved_count（先頭から何件が対応済みか）と
-- 生成列 handoff_open_count がずれるため。話題（topic）・対象物件（propertyIds）・時刻（at）は個人情報でないので残す。
-- 管理画面は空の text を「保存期間を過ぎたため削除」と出す（src/app/admin/_lib/notes.ts）。
-- purge_old_messages の引数と戻り値（削除したメッセージの件数）は変えないので、アプリ（src/server/demoSeed.ts）の変更は要らない。

-- 引き継ぎメモの配列のうち、時刻（at）が cutoff より前のメモの発話（text）を空にして返す（データは読まない）。
-- 要素の数と順番は変えない。at が ISO 8601 の形でないメモはそのまま残す（キャストの失敗で削除全体を止めないため）
create or replace function public.expire_handoff_note_texts(notes jsonb, cutoff timestamptz)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      case
        when coalesce(e.note ->> 'text', '') <> ''
          and (case when e.note ->> 'at' ~ '^\d{4}-\d{2}-\d{2}T' then (e.note ->> 'at')::timestamptz < cutoff else false end)
        then jsonb_set(e.note, '{text}', '""'::jsonb)
        else e.note
      end
      order by e.ord
    ),
    '[]'::jsonb
  )
  from jsonb_array_elements(notes) with ordinality as e(note, ord);
$$;

-- 保存期間の削除は利用者や担当者の動作ではないので、会話の updated_at（管理画面の「最終動作」と一覧の並び）を進めない。
-- purge_old_messages がトランザクションの中だけ app.purging を on にする
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(current_setting('app.purging', true), '') = 'on' then
    return new;
  end if;
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.purge_old_messages(retention_days integer default 90)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  cutoff timestamptz;
  deleted_count integer;
begin
  if retention_days is null or retention_days < 1 then
    raise exception 'retention_days must be 1 or more';
  end if;
  cutoff := now() - make_interval(days => retention_days);

  delete from public.messages
  where created_at < cutoff;
  get diagnostics deleted_count = row_count;

  perform set_config('app.purging', 'on', true);
  update public.conversations
  set handoff_notes = public.expire_handoff_note_texts(handoff_notes, cutoff)
  where handoff_notes <> public.expire_handoff_note_texts(handoff_notes, cutoff);
  perform set_config('app.purging', 'off', true);

  return deleted_count;
end;
$$;

-- create or replace は既存の権限を引き継ぐ（purge_old_messages は service_role だけ）。新しい関数も service_role だけに絞る
revoke all on function public.expire_handoff_note_texts(jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.expire_handoff_note_texts(jsonb, timestamptz) to service_role;
