/**
 * 製品（発注を受けたデプロイ）のプライバシーポリシー・利用規約で、発注者が埋める欄（セキュリティ点検 4.1・意思決定ログ41）。
 *
 * 公開デモの文面（content.ts）は運営者の情報を書かないので、ここの値はまだどこにも表示しない。製品用に文面を書き直すときに使う。
 * 埋め忘れたまま製品の本番に出さないよう、`npm run build` の前に scripts/check-legal.ts が `productLegalProblems` で確かめ、
 * 問題があればビルドを落とす。
 *
 * このファイルは scripts から tsx で直接読むので、`@/` の別名で import しない。
 */

/** 発注者が埋める欄の印。この文字列が残っている欄は「未記入」と見なす */
export const TO_FILL = '【発注者が記入】';

export interface OperatorInfo {
  /** 事業者の名称（商号） */
  businessName: string;
  /** 住所 */
  address: string;
  /** 代表者の氏名（法人のとき） */
  representative: string;
  /** 個人情報の取扱いと苦情の窓口（部署・電話・メールなど） */
  contactWindow: string;
  /** 開示・訂正・利用停止などの請求の手続き */
  disclosureProcedure: string;
  /** LINE の表示名・LINE ユーザー ID・希望条件・内見の候補日時の保存期間（例: 最後のメッセージから1年） */
  profileRetention: string;
}

export const OPERATOR: OperatorInfo = {
  businessName: TO_FILL,
  address: TO_FILL,
  representative: TO_FILL,
  contactWindow: TO_FILL,
  disclosureProcedure: TO_FILL,
  profileRetention: TO_FILL,
};

/**
 * 文面の版。content.ts はいま公開デモの文面（架空データ・担当者からの連絡なし）なので 'demo'。
 * 製品用に書き直したら 'product' にする（デモの文面のまま製品の本番に出さないため）。
 */
export const LEGAL_EDITION: 'demo' | 'product' = 'demo';

/** 空か、印が残っている欄の名前 */
export function unfilledFields(info: OperatorInfo): (keyof OperatorInfo)[] {
  return (Object.keys(info) as (keyof OperatorInfo)[]).filter((key) => {
    const value = info[key].trim();
    return value === '' || value.includes(TO_FILL);
  });
}

export interface BuildEnv {
  /** Vercel が入れる環境の名前（production / preview / development）。Vercel の外では無い */
  VERCEL_ENV?: string;
  DEMO_MODE?: string;
}

/**
 * 製品の本番ビルドで直すべきこと（無ければ空）。
 * 製品の本番 = Vercel の Production で、DEMO_MODE が 1 でないもの。公開デモの本番（DEMO_MODE=1）・Preview・CI・手元のビルドは確かめない。
 */
export function productLegalProblems(
  env: BuildEnv,
  info: OperatorInfo = OPERATOR,
  edition: 'demo' | 'product' = LEGAL_EDITION,
): string[] {
  if (env.VERCEL_ENV !== 'production' || env.DEMO_MODE === '1') return [];
  const problems: string[] = [];
  if (edition !== 'product') {
    problems.push('プライバシーポリシーと利用規約が公開デモの文面のままです（src/app/_legal/content.ts を製品用に書き直し、operator.ts の LEGAL_EDITION を product にする）');
  }
  for (const key of unfilledFields(info)) {
    problems.push(`発注者が埋める欄 ${key} が未記入です（src/app/_legal/operator.ts）`);
  }
  return problems;
}
