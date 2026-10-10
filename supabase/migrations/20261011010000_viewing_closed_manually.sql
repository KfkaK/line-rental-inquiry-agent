-- 内見の仮受付に4つ目の終わり「手動で対応済み」（closed_manually）を足す（意思決定ログ15）。
--
-- 確定（confirmed）は営業時間内の時刻だけで、システムが利用者に確定の文を送る（意思決定ログ14）。
-- 営業時間外の内見などを担当者が手動返信で利用者と取り決めたときは、LINE に何も送らずに記録だけをこの状態で閉じる。
-- 確定日時（confirmed_time）は持たず、取り決めた日時と経緯は staff_note に書く（必須。アプリが検証する）。
-- 値の一覧は src/domain/types.ts の VIEWING_STATUSES と揃える（src/lib/db/mappers.test.ts が検査する）。

alter table public.viewing_requests drop constraint viewing_requests_status_check;
alter table public.viewing_requests add constraint viewing_requests_status_check check (status in ('pending', 'in_progress', 'confirmed', 'rejected', 'closed_manually'));
