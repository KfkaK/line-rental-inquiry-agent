/**
 * AI がユーザーへ返す定型文（純関数）。言い回しを変えるときはここだけを直す。
 * 根拠の要る内容（物件の項目）は Property の値をそのまま差し込み、推測で補わない（不変条件3）。
 */
import { formatJstDay } from './businessHours';
import { formatDate, formatManYen, formatYen } from './labels';
import { DEFAULT_WALK_PREFERENCE_MIN } from './rules';
import { monthlyCost } from './search';
import type { ConditionSummary } from './slots';
import type { ForbiddenTopic, Priority, Property, ScalarSlotKey } from './types';

export const DISCLAIMER = '回答は参考情報です。契約条件は担当者からの案内が優先されます。';

// ---------- 公開デモ（DEMO_MODE=1） ----------
// 公開デモでは担当者からの連絡が実際には行われないので、「担当者からご連絡します」の約束を守れない。
// 約束の文（内見は確定しない・担当者が確認する）はそのまま残し、実際の連絡が無いことを後ろに足す。

/** 友だち追加のあいさつに足す一文 */
export const DEMO_GREETING_NOTE = 'これはデモです。物件は架空のデータで、担当者からの連絡はありません。';
/** 「担当者からご連絡します」の後ろに足す一文 */
export const DEMO_NO_CONTACT_NOTE = '（デモのため、実際の連絡はありません）';

export function greeting(outsideHours: boolean, demo = false): string {
  const lines = [
    '友だち追加ありがとうございます。',
    'このアカウントでは AI が一次対応し、担当者が内容を確認します。',
  ];
  if (demo) lines.push(DEMO_GREETING_NOTE);
  // 営業時間外の案内は outsideHoursNote() と同じ一文（handleEvent が会話ログでこの一文を探して、最初の発話に重ねない）
  if (outsideHours) lines.push(outsideHoursNote());
  lines.push('', 'ご希望のエリア（駅名）とご予算を教えてください。');
  return lines.join('\n');
}

export function outsideHoursNote(): string {
  return 'ただいま営業時間外ですが、物件探しはお手伝いできます。';
}

const ASK: Record<ScalarSlotKey, string> = {
  area: 'ご希望のエリアを教えてください（例: 渋谷、中目黒、吉祥寺。複数でも大丈夫です）。',
  rentMax: 'ご予算（管理費込みの月額）はどのくらいですか？',
  layouts: 'ご希望の間取りはありますか？',
  walkMax: '駅からの徒歩は何分までがよいですか？',
  floorMin: '何階以上がよいですか？',
  moveIn: '入居はいつ頃をお考えですか？',
};

export function askFor(key: ScalarSlotKey): string {
  return ASK[key];
}

/** 優先度の呼び名（会話の文・管理画面で使う） */
export const PRIORITY_LABEL: Record<Priority, string> = { must: '外せない', want: 'できれば', nice: 'あれば' };

/** 「外せない: 渋谷エリア・予算9万円以内 / できれば: 徒歩10分以内 / あれば: オートロック」 */
export function conditionsSummary(conditions: readonly ConditionSummary[]): string {
  const parts: string[] = [];
  for (const p of ['must', 'want', 'nice'] as const) {
    const labels = conditions.filter((c) => c.priority === p).map((c) => c.label);
    if (labels.length > 0) parts.push(`${PRIORITY_LABEL[p]}: ${labels.join('・')}`);
  }
  return parts.join(' / ');
}

export interface SearchIntroNotes {
  /** 上位（1ページ目）が直前に見せた1ページ目と同じ。条件を変えても反応が無いように見えないよう一言添える（意思決定ログ24） */
  sameAsBefore?: boolean;
  /** 徒歩の条件が無いので、徒歩の目安（DEFAULT_WALK_PREFERENCE_MIN）で並べた。並びの理由を見せる */
  walkGuide?: boolean;
}

export function searchIntro(total: number, shown: number, summary: string, notes: SearchIntroNotes = {}): string {
  const lines = [`条件に合う物件が${total}件あります。合っている順に${shown}件お見せします。`];
  if (notes.sameAsBefore) {
    lines.push(total > shown ? `上位${shown}件は前回と同じです。続きは「もっと見る」からご覧ください。` : '前回と同じ物件です。');
  }
  lines.push(`（${summary}）`);
  if (notes.walkGuide) lines.push(`駅からの徒歩は${DEFAULT_WALK_PREFERENCE_MIN}分以内を目安に並べています。`);
  return lines.join('\n');
}

export function noResults(summary: string): string {
  return `いまの条件では合う物件が見つかりませんでした。\n（${summary}）`;
}

export function relaxationProposal(label: string, gained: number): string {
  return `${label}と${gained}件増えます。条件を変えますか？`;
}

export function askMustConditions(total: number): string {
  return `候補が${total}件あります。この中で外せない条件はどれですか？`;
}

export function askWhichToRelax(): string {
  return 'どの条件なら緩められそうですか？下から選ぶと、その条件を「できれば」にして探し直します。';
}

/** 0件で、緩める提案も聞き返しもできないとき（行き止まりにしない） */
export function howToChangeConditions(): string {
  return '条件を変えて送ってください（例:「予算10万まで」「駅から15分でもいい」「オートロックはなくてもいい」）。';
}

export function noMoreResults(): string {
  return 'お見せできる候補は以上です。条件を変えて探すこともできます。';
}

export function keepConditions(): string {
  return '承知しました。条件はそのままにします。ほかに気になる点があればお知らせください。';
}

export function offTopic(): string {
  return 'このアカウントでは賃貸物件探しのお手伝いをしています。ご希望のエリアやご予算、気になる物件についてお知らせください。';
}

export function propertyUnavailable(): string {
  return 'この物件は現在ご案内できません。担当者が確認します。';
}

export function askWhichProperty(): string {
  return 'どの物件についてでしょうか？カードの番号（例:「2番目」）で教えてください。';
}

/** 物件の詳細（DB の項目だけで作る） */
export function propertyDetail(p: Property, position: number | null): string {
  const access = p.access.map((a) => `${a.station}駅 徒歩${a.walkMin}分`).join(' / ');
  const lines = [
    `${position ? `${position}. ` : ''}${p.name}`,
    `家賃 ${formatYen(p.rent)}（管理費 ${formatYen(p.managementFee)}・月額 ${formatManYen(monthlyCost(p))}円）`,
    `敷金 ${p.depositMonths}か月 / 礼金 ${p.keyMoneyMonths}か月`,
    `${p.layout}・${p.areaSqm}㎡・${p.floor}階・${p.builtYear}年築`,
    access,
    `所在地: ${p.address}`,
    `入居: ${p.availableFrom ? `${formatDate(p.availableFrom)}から` : '即入居可'}`,
  ];
  if (p.tags.length > 0) lines.push(`設備・特徴: ${p.tags.join('、')}`);
  lines.push('', '空室状況と初期費用の確定額は担当者が確認します。', DISCLAIMER);
  return lines.join('\n');
}

/** 禁止トピックの呼び名（引き継ぎ文・管理画面・担当者通知で使う） */
export const TOPIC_LABEL: Record<ForbiddenTopic, string> = {
  vacancy: '空室状況',
  initialCostTotal: '初期費用の確定額',
  safety: '周辺の治安',
  noise: '騒音',
  screening: '入居審査',
  neighbors: '近隣の様子',
};

/** 担当者への引き継ぎ。営業時間外なら連絡日を具体的に示す（DESIGN.md 2.1「引き継ぎ」） */
export function handoff(topic: ForbiddenTopic | null, outsideHours: boolean, contactDay: string, demo = false): string {
  const what = topic ? `${TOPIC_LABEL[topic]}については` : 'このご質問は';
  const when = outsideHours
    ? `ただいま営業時間外のため、${formatJstDay(contactDay)}に担当者からご連絡します。`
    : '営業時間内に担当者からご連絡します。';
  return `${what}担当者が確認します。${when}${demo ? DEMO_NO_CONTACT_NOTE : ''}\nそのあいだも物件探しはお手伝いできます。`;
}

/** `exampleDay` は最初の候補日（YYYY-MM-DD）。例を固定の日付にすると過去の日付になるので、候補日から作る */
export function askViewingTimes(propertyName: string, collected: readonly string[], exampleDay: string | undefined): string {
  if (collected.length === 0) {
    const example = exampleDay ? `（例: ${formatJstDay(exampleDay)} 14時）` : '';
    return `「${propertyName}」の内見ですね。ご希望の日時を2〜3つ教えてください${example}。下の候補日から選ぶこともできます。`;
  }
  return `いま ${collected.map(formatViewingTime).join('、')} をお預かりしています。ほかの候補があれば教えてください。このままでよければ「この日時で送る」を押してください。`;
}

export function invalidViewingTimes(firstDay: string, lastDay: string): string {
  return `内見は${formatJstDay(firstDay)}以降の営業日でお選びください（${formatJstDay(lastDay)}まで）。`;
}

/** 同じ物件の仮受付が担当者の対応待ちのまま（新しくは受け付けない） */
export function viewingAlreadyRequested(propertyName: string): string {
  return `「${propertyName}」の内見のご希望は受け付け済みです。担当者からのご連絡をお待ちください。`;
}

/** 未対応の仮受付が会話ごとの上限に達した */
export function viewingLimitReached(): string {
  return '内見のご希望はすでにいくつか受け付けています。担当者からのご連絡の後に、あらためてお知らせください。';
}

/** '2026-10-10T14:00' → '10月10日(土) 14:00'、'2026-10-10' → '10月10日(土)' */
export function formatViewingTime(value: string): string {
  const [date, time] = value.split('T');
  return time ? `${formatJstDay(date)} ${time}` : formatJstDay(date);
}

export function viewingAccepted(
  propertyName: string,
  times: readonly string[],
  outsideHours: boolean,
  contactDay: string,
  demo = false,
): string {
  const list = times.map((t, i) => `${'①②③'[i] ?? `${i + 1}.`} ${formatViewingTime(t)}`).join('\n');
  const when = outsideHours
    ? `ただいま営業時間外のため、${formatJstDay(contactDay)}に担当者から確定のご連絡をします。`
    : '担当者から確定のご連絡をします。';
  // 「まだ予約は確定していません」はデモでも外さない（AI は内見を確定しない。不変条件 4）
  return `「${propertyName}」の内見のご希望を受け付けました。\n${list}\n\nまだ予約は確定していません。${when}${demo ? DEMO_NO_CONTACT_NOTE : ''}`;
}

// ---------- 担当者が管理画面から送る文（AI ではなく担当者からの連絡だと分かるように頭に付ける） ----------

const FROM_STAFF = '【担当者より】';

/** 内見の確定（DESIGN.md 2.2「内見の確定・却下」）。`time` は 'YYYY-MM-DDTHH:mm' */
export function viewingConfirmed(propertyName: string, time: string, note: string): string {
  const lines = [`${FROM_STAFF}「${propertyName}」の内見日時が確定しました。`, `日時: ${formatViewingTime(time)}`];
  if (note) lines.push('', note);
  lines.push('', '当日の待ち合わせ場所などは、あらためてこのトークでご連絡します。');
  return lines.join('\n');
}

/** 内見の却下。理由は担当者が書く */
export function viewingRejected(propertyName: string, reason: string): string {
  return [
    `${FROM_STAFF}「${propertyName}」の内見は、ご希望の日時でのご案内が難しくなりました。`,
    '',
    reason,
    '',
    'ほかの日時や物件のご希望があれば、このトークでお知らせください。',
  ].join('\n');
}

export function textOnly(): string {
  return '恐れ入りますが、ご希望は文字でお送りください。';
}

export function rateLimited(): string {
  return 'ただいま混み合っています。少し時間をおいてからもう一度お送りください。';
}

/** 利用者ごとの1日の上限（DAILY_TURNS_PER_USER）に達した */
export function dailyLimitReached(): string {
  return '本日はたくさんのご質問をありがとうございます。AI の対応は本日はここまでとさせてください。明日あらためてお送りください。';
}

export function tooLong(maxChars: number): string {
  return `恐れ入りますが、${maxChars}字以内で短くしてお送りください。`;
}
