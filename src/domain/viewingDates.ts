/**
 * 内見の候補日時の曜日の読み違いを直す（純関数。意思決定ログ33）。
 *
 * 抽出（LLM）にはプロンプトで日付の早見表（曜日つき）を渡しているが、それでも「明日の15時と火曜の11時」の「火曜」を
 * 水曜の日付にすることがある（2026-10-24 の評価 sc-12。水曜は定休日なので候補が1つしか残らず、仮受付に進まない）。
 * プロンプトを直すと他の発話が崩れうる（意思決定ログ31）ので、抽出の後で、発話の言い回しと食い違う日付だけをコードで直す。
 *
 * 方針は「疑わしいものだけ直す」:
 * - 発話の日付の言い回し（今日・明日・明後日・N月N日・N日・「（来週の）火曜」・週末）を拾う
 * - LLM の候補日のうち、どの言い回しでも説明できない日付（曜日も日付も合わない）を「食い違い」とする
 * - 食い違いの候補と、どの候補にも使われていない曜日の言い回しを、出てきた順に組にして、曜日から計算した日付に置き換える（時刻は残す）
 * - 組にならないもの（言い回しが無い・余る）はそのまま
 * 現在時刻は引数で受け取る（不変条件5）。
 */
import { addDays, toJst, weekdayOf } from './businessHours';
import { normalizeText } from './normalize';

const WEEKDAY_CHARS = '日月火水木金土';

type DateMention =
  | { kind: 'date'; date: string }
  | { kind: 'day'; day: number }
  | { kind: 'weekday'; weekday: number; week: 'this' | 'next' | 'after' | null; index: number };

/** 発話の日付の言い回しを、出てきた順に拾う */
function findDateMentions(text: string, today: string): DateMention[] {
  const found: { index: number; mention: DateMention }[] = [];
  const [year] = today.split('-').map(Number);
  const relative: ReadonlyArray<[RegExp, number]> = [
    [/明後日|あさって/g, 2],
    [/明日|あした/g, 1],
    [/今日|本日/g, 0],
  ];
  let rest = text;
  for (const [re, offset] of relative) {
    rest = rest.replace(re, (m, index: number) => {
      found.push({ index, mention: { kind: 'date', date: addDays(today, offset) } });
      return '｜'.repeat(m.length);
    });
  }
  rest = rest.replace(/(\d{1,2})月(\d{1,2})日/g, (m, mo: string, d: string, index: number) => {
    let date = `${year}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    if (date < today) date = `${year + 1}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    found.push({ index, mention: { kind: 'date', date } });
    return '｜'.repeat(m.length);
  });
  rest = rest.replace(/(\d{1,2})日(?!間|後|前|以内)/g, (m, d: string, index: number) => {
    found.push({ index, mention: { kind: 'day', day: Number(d) } });
    return '｜'.repeat(m.length);
  });
  rest = rest.replace(/(今週|来週|再来週)?(?:の)?(?:週末|土日)/g, (m, week: string | undefined, index: number) => {
    const w = week === '今週' ? 'this' : week === '来週' ? 'next' : week === '再来週' ? 'after' : null;
    found.push({ index, mention: { kind: 'weekday', weekday: 6, week: w, index } });
    found.push({ index: index + 0.5, mention: { kind: 'weekday', weekday: 0, week: w, index: index + 0.5 } });
    return '｜'.repeat(m.length);
  });
  for (const m of rest.matchAll(/(今週|来週|再来週)?(?:の)?([日月火水木金土])曜/g)) {
    const w = m[1] === '今週' ? 'this' : m[1] === '来週' ? 'next' : m[1] === '再来週' ? 'after' : null;
    found.push({ index: m.index, mention: { kind: 'weekday', weekday: WEEKDAY_CHARS.indexOf(m[2]), week: w, index: m.index } });
  }
  return found.sort((a, b) => a.index - b.index).map((f) => f.mention);
}

/** 曜日の言い回しの日付。週は月曜はじまり。週の指定が無ければ、明日以降で最初のその曜日 */
function dateOfWeekday(mention: Extract<DateMention, { kind: 'weekday' }>, today: string): string {
  if (mention.week === null) {
    for (let i = 1; i <= 7; i++) {
      const date = addDays(today, i);
      if (weekdayOf(date) === mention.weekday) return date;
    }
  }
  const mondayOffset = (weekdayOf(today) + 6) % 7;
  const thisMonday = addDays(today, -mondayOffset);
  const weeks = mention.week === 'this' ? 0 : mention.week === 'next' ? 1 : 2;
  return addDays(thisMonday, weeks * 7 + ((mention.weekday + 6) % 7));
}

function explains(mention: DateMention, date: string): boolean {
  if (mention.kind === 'date') return mention.date === date;
  if (mention.kind === 'day') return Number(date.slice(8, 10)) === mention.day;
  return weekdayOf(date) === mention.weekday;
}

/**
 * 内見の候補日時（'YYYY-MM-DD' か 'YYYY-MM-DDTHH:mm'）のうち、発話の言い回しと食い違う日付を、
 * 使われていない曜日の言い回しから計算した日付に置き換える
 */
export function alignViewingWeekdays(viewingTimes: readonly string[], utterance: string, now: Date): string[] {
  if (viewingTimes.length === 0) return [...viewingTimes];
  const today = toJst(now).date;
  const mentions = findDateMentions(normalizeText(utterance), today);
  if (!mentions.some((m) => m.kind === 'weekday')) return [...viewingTimes];

  const dates = viewingTimes.map((t) => t.slice(0, 10));
  const unexplained = dates.map((d, i) => (mentions.some((m) => explains(m, d)) ? -1 : i)).filter((i) => i !== -1);
  const unusedWeekdays = mentions.filter(
    (m): m is Extract<DateMention, { kind: 'weekday' }> => m.kind === 'weekday' && !dates.some((d) => weekdayOf(d) === m.weekday),
  );
  const out = [...viewingTimes];
  unexplained.forEach((i, k) => {
    const mention = unusedWeekdays[k];
    if (!mention) return;
    out[i] = dateOfWeekday(mention, today) + viewingTimes[i].slice(10);
  });
  return out;
}

/** 抽出の結果に {@link alignViewingWeekdays} をかける */
export function withAlignedViewingWeekdays<R extends { viewingTimes: string[] }>(result: R, utterance: string, now: Date): R {
  const viewingTimes = alignViewingWeekdays(result.viewingTimes, utterance, now);
  return viewingTimes.every((t, i) => t === result.viewingTimes[i]) ? result : { ...result, viewingTimes };
}
