'use client';

import { useRef, useState } from 'react';
import { saveCalendarAction } from '../actions';
import type { BusinessHoursRow } from '@/domain/types';
import { WEEKDAY_DISPLAY_ORDER, WEEKDAY_NAME } from '../_lib/labels';
import { FormMessage } from './FormMessage';
import { cardClass, hintClass, inputClass, SubmitButton } from './ui';
import { useServerForm } from './useServerForm';

interface DayState {
  closed: boolean;
  open: string;
  close: string;
}

interface Props {
  /** 7 曜日分（0=日 … 6=土） */
  hours: BusinessHoursRow[];
  /** 休業日 'YYYY-MM-DD' */
  holidays: string[];
  /** 担当者だけが変更できる。閲覧用は <fieldset disabled> で見るだけ */
  canEdit: boolean;
}

/**
 * 営業時間（曜日ごとの休み・開店・閉店）と休業日（日付の追加・削除）。送るフォームの名前は actions.ts の saveCalendarAction のとおり。
 * 保存に失敗しても入力が消えないよう、すべて制御コンポーネントにする。
 * 休みの曜日の時刻は編集できなくする（readOnly）が、保存済みの時刻を消さないよう送信には含める。
 */
export function CalendarForm({ hours, holidays, canEdit }: Props) {
  const [days, setDays] = useState<Record<number, DayState>>(() =>
    Object.fromEntries(hours.map((h) => [h.weekday, { closed: h.isClosed, open: h.open, close: h.close }])),
  );
  const nextKey = useRef(holidays.length);
  const [dates, setDates] = useState(() => holidays.map((value, key) => ({ key, value })));
  const [state, formAction, pending] = useServerForm(saveCalendarAction);

  const update = (weekday: number, patch: Partial<DayState>) =>
    setDays((current) => ({ ...current, [weekday]: { ...current[weekday], ...patch } }));

  return (
    <form action={formAction} className="space-y-6">
      <fieldset disabled={!canEdit} className="space-y-6">
        <section aria-labelledby="hours-heading" className={cardClass}>
          <h2 id="hours-heading" className="mb-1 text-base font-semibold">
            曜日ごとの営業時間
          </h2>
          <p className={`${hintClass} mb-4`}>休みの曜日は「定休日」にチェックを入れます。時刻は 24 時間表記です。</p>
          <ul className="divide-y divide-line">
            {WEEKDAY_DISPLAY_ORDER.map((weekday) => {
              const day = days[weekday];
              if (!day) return null;
              const name = `${WEEKDAY_NAME[weekday]}曜日`;
              return (
                <li key={weekday} className="grid grid-cols-[4.5rem_1fr] items-center gap-x-3 gap-y-2 py-3 sm:grid-cols-[5rem_8rem_1fr]">
                  <span className="text-sm font-semibold">{name}</span>
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name={`closed-${weekday}`}
                      checked={day.closed}
                      onChange={(e) => update(weekday, { closed: e.target.checked })}
                      className="size-4"
                    />
                    定休日
                  </label>
                  <div className="col-span-2 flex items-center gap-2 sm:col-span-1">
                    <input
                      type="time"
                      name={`open-${weekday}`}
                      aria-label={`${name}の開店時刻`}
                      value={day.open}
                      onChange={(e) => update(weekday, { open: e.target.value })}
                      readOnly={day.closed}
                      required={!day.closed}
                      className={`${inputClass} sm:max-w-36`}
                    />
                    <span aria-hidden="true">〜</span>
                    <input
                      type="time"
                      name={`close-${weekday}`}
                      aria-label={`${name}の閉店時刻`}
                      value={day.close}
                      onChange={(e) => update(weekday, { close: e.target.value })}
                      readOnly={day.closed}
                      required={!day.closed}
                      className={`${inputClass} sm:max-w-36`}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <section aria-labelledby="holidays-heading" className={cardClass}>
          <h2 id="holidays-heading" className="mb-1 text-base font-semibold">
            休業日（祝日・臨時休業）
          </h2>
          <p className={`${hintClass} mb-4`}>曜日の設定とは別に、日付を指定して休みにします。内見の候補日と時間外の案内から除かれます。</p>
          {dates.length === 0 && <p className="mb-3 text-sm text-muted">休業日は登録されていません。</p>}
          <ul className="space-y-2">
            {dates.map((item) => (
              <li key={item.key} className="flex items-center gap-2">
                <input
                  type="date"
                  name="holiday"
                  aria-label="休業日"
                  value={item.value}
                  onChange={(e) => setDates((current) => current.map((d) => (d.key === item.key ? { ...d, value: e.target.value } : d)))}
                  className={`${inputClass} sm:max-w-56`}
                />
                <button
                  type="button"
                  onClick={() => setDates((current) => current.filter((d) => d.key !== item.key))}
                  className="min-h-11 rounded-md border border-line-strong px-4 text-sm font-semibold disabled:opacity-60"
                >
                  削除
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => {
              const key = nextKey.current++;
              setDates((current) => [...current, { key, value: '' }]);
            }}
            className="mt-3 min-h-11 rounded-md border border-line-strong px-4 text-sm font-semibold disabled:opacity-60"
          >
            休業日を追加
          </button>
        </section>
      </fieldset>

      {canEdit ? (
        <div className="space-y-3">
          <SubmitButton pending={pending}>保存する</SubmitButton>
          <FormMessage state={state} />
        </div>
      ) : (
        <p className={hintClass}>閲覧用のアカウントでは変更できません。</p>
      )}
    </form>
  );
}
