/**
 * AI がユーザーへ返す定型文（純関数）。言い回しを変えるときはここだけを直す。
 * 根拠の要る内容（物件の項目）は Property の値をそのまま差し込み、推測で補わない（不変条件3）。
 */
import { formatJstDay } from './businessHours';
import { formatDate, formatManYen, formatYen } from './labels';
import { monthlyCost } from './search';
import type { ConditionSummary } from './slots';
import type { ForbiddenTopic, Priority, Property, ScalarSlotKey } from './types';

export const DISCLAIMER = '回答は参考情報です。契約条件は担当者からの案内が優先されます。';

export function greeting(outsideHours: boolean): string {
  const lines = [
    '友だち追加ありがとうございます。',
    'このアカウントでは AI が一次対応し、担当者が内容を確認します。',
  ];
  if (outsideHours) lines.push('ただいま営業時間外ですが、物件探しはお手伝いできます。');
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

const PRIORITY_LABEL: Record<Priority, string> = { must: '外せない', want: 'できれば', nice: 'あれば' };

/** 「外せない: 渋谷エリア・予算9万円以内 / できれば: 徒歩10分以内 / あれば: オートロック」 */
export function conditionsSummary(conditions: readonly ConditionSummary[]): string {
  const parts: string[] = [];
  for (const p of ['must', 'want', 'nice'] as const) {
    const labels = conditions.filter((c) => c.priority === p).map((c) => c.label);
    if (labels.length > 0) parts.push(`${PRIORITY_LABEL[p]}: ${labels.join('・')}`);
  }
  return parts.join(' / ');
}

export function searchIntro(total: number, shown: number, summary: string): string {
  return `条件に合う物件が${total}件あります。合っている順に${shown}件お見せします。\n（${summary}）`;
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
  return 'どの条件なら緩められそうですか？';
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

const TOPIC_LABEL: Record<ForbiddenTopic, string> = {
  vacancy: '空室状況',
  initialCostTotal: '初期費用の確定額',
  safety: '周辺の治安',
  noise: '騒音',
  screening: '入居審査',
  neighbors: '近隣の様子',
};

/** 担当者への引き継ぎ。営業時間外なら連絡日を具体的に示す（DESIGN.md 2.1「引き継ぎ」） */
export function handoff(topic: ForbiddenTopic | null, outsideHours: boolean, contactDay: string): string {
  const what = topic ? `${TOPIC_LABEL[topic]}については` : 'このご質問は';
  const when = outsideHours
    ? `ただいま営業時間外のため、${formatJstDay(contactDay)}に担当者からご連絡します。`
    : '営業時間内に担当者からご連絡します。';
  return `${what}担当者が確認します。${when}\nそのあいだも物件探しはお手伝いできます。`;
}

export function askViewingTimes(propertyName: string, collected: readonly string[]): string {
  if (collected.length === 0) {
    return `「${propertyName}」の内見ですね。ご希望の日時を2〜3つ教えてください（例: 10月10日 14時）。下の候補日から選ぶこともできます。`;
  }
  return `いま ${collected.map(formatViewingTime).join('、')} をお預かりしています。ほかの候補があれば教えてください。このままでよければ「この日時で送る」を押してください。`;
}

export function invalidViewingTimes(firstDay: string): string {
  return `内見は${formatJstDay(firstDay)}以降の営業日でお選びください。`;
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
): string {
  const list = times.map((t, i) => `${'①②③'[i] ?? `${i + 1}.`} ${formatViewingTime(t)}`).join('\n');
  const when = outsideHours
    ? `ただいま営業時間外のため、${formatJstDay(contactDay)}に担当者から確定のご連絡をします。`
    : '担当者から確定のご連絡をします。';
  return `「${propertyName}」の内見のご希望を受け付けました。\n${list}\n\nまだ予約は確定していません。${when}`;
}

export function textOnly(): string {
  return '恐れ入りますが、ご希望は文字でお送りください。';
}

export function rateLimited(): string {
  return 'ただいま混み合っています。少し時間をおいてからもう一度お送りください。';
}
