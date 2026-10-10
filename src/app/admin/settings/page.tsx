import type { Metadata } from 'next';
import { Suspense } from 'react';
import { defaultCalendar } from '@/domain/businessHours';
import { requireAdmin } from '@/server/admin/session';
import { CalendarForm } from '../_components/CalendarForm';

export const metadata: Metadata = { title: '営業時間' };

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">営業時間</h1>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          曜日ごとの営業時間と休業日を設定します。AI の時間外の案内（「翌営業日にご連絡します」）と、内見の候補日の提示に使います。日本時間で扱います。
        </p>
      </div>
      <Suspense fallback={<p className="text-sm text-muted">読み込み中…</p>}>
        <SettingsContent />
      </Suspense>
    </div>
  );
}

async function SettingsContent() {
  const { user, repos } = await requireAdmin();
  const calendar = await repos.businessCalendar.get();
  // 7 曜日そろっていない場合（DB に行が無いなど）は既定値で埋める
  const hours = defaultCalendar().hours.map((fallback) => calendar.hours.find((h) => h.weekday === fallback.weekday) ?? fallback);
  return <CalendarForm hours={hours} holidays={calendar.holidays} canEdit={user.role === 'staff'} />;
}
