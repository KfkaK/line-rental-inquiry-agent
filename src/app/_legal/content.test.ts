import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DISCLAIMER } from '@/domain/messages';
import { MESSAGE_RETENTION_DAYS, RATE_LIMIT_PER_MINUTE } from '@/domain/rules';
import { CONTACT_TEXT, LEGAL_UPDATED, PRIVACY, TERMS, type LegalDocument } from './content';
import { LegalPage } from './LegalPage';

function allText(doc: LegalDocument): string {
  return [doc.title, doc.lead, ...doc.sections.flatMap((s) => [s.heading, ...(s.paragraphs ?? []), ...(s.items ?? []), ...(s.closing ?? [])])].join('\n');
}

describe.each([
  ['プライバシーポリシー', PRIVACY],
  ['利用規約', TERMS],
])('%s', (_name, doc) => {
  const text = allText(doc);

  it('見出しは重複せず、どの節にも本文がある', () => {
    const headings = doc.sections.map((s) => s.heading);
    expect(new Set(headings).size).toBe(headings.length);
    for (const s of doc.sections) expect((s.paragraphs?.length ?? 0) + (s.items?.length ?? 0)).toBeGreaterThan(0);
  });

  it('架空データのデモであり、担当者からの連絡が無いことを書く', () => {
    expect(text).toContain('架空のデータ');
    expect(text).toContain('担当者からの連絡はありません');
  });

  it('お問い合わせは LINE のトークで「担当者と話したい」と送る方法を書く', () => {
    expect(CONTACT_TEXT).toBe('この LINE アカウントのトークで「担当者と話したい」と送ってください（管理者が確認します）。');
    expect(text).toContain(CONTACT_TEXT);
  });

  it('運営者の氏名・住所・メールアドレス・電話番号を書かない', () => {
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    expect(text).not.toMatch(/\d{2,4}-\d{2,4}-\d{3,4}/);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/運営者|事業者|代表者|所在地/);
  });

  it('文の前後に余分な空白が無い', () => {
    for (const s of doc.sections) for (const t of [...(s.paragraphs ?? []), ...(s.items ?? []), ...(s.closing ?? [])]) expect(t.trim()).toBe(t);
  });
});

describe('プライバシーポリシーの内容', () => {
  const text = allText(PRIVACY);

  it('保存するもの: 表示名・ユーザー ID・メッセージ・内見の候補日時。氏名・電話番号は聞かない', () => {
    for (const word of ['LINE の表示名', 'LINE ユーザー ID', 'メッセージ', '内見の仮受付の候補日時', '氏名・電話番号を聞くことはありません']) {
      expect(text).toContain(word);
    }
  });

  it('使う外部サービスを挙げる（LINE・Anthropic の Claude API・Supabase（東京）・Vercel・Resend）', () => {
    for (const word of ['LINE:', 'Anthropic の Claude API', 'Supabase（東京リージョン）', 'Vercel', 'Resend']) {
      expect(text).toContain(word);
    }
  });

  it('メールに表示名・LINE ユーザー ID を載せないことと、会話ログの保存期間は rules.ts と同じ', () => {
    expect(text).toContain('LINE の表示名と LINE ユーザー ID は載せません');
    expect(text).toContain(`会話ログ（メッセージ）は ${MESSAGE_RETENTION_DAYS} 日で削除します`);
    expect(text).toContain(`担当者へ回した質問の文面も、同じく ${MESSAGE_RETENTION_DAYS} 日で削除します`);
  });

  it('閲覧用アカウントは架空のデモ会話だけ、管理画面に LINE ユーザー ID を出さないことを書く', () => {
    expect(text).toContain('架空のデモ会話だけ');
    expect(text).toContain('LINE ユーザー ID は出しません');
  });

  it('閲覧用アカウントの資格情報を公開していて、誰でもログインして架空のデモ会話を見られることを書く（実際の利用者の会話は見えない）', () => {
    expect(text).toContain('資格情報は管理画面のログイン画面で公開していて、誰でもログインして架空のデモ会話を見られます');
    expect(text).toContain('実際の利用者の会話は見えません');
  });
});

describe('利用規約の内容', () => {
  const text = allText(TERMS);

  it('回答は参考情報（物件カードの免責と同じ文）。AI は内見を確定しない', () => {
    expect(text).toContain(DISCLAIMER);
    expect(text).toContain('AI は内見を確定しません');
  });

  it('レート制限の目安は rules.ts と同じ値', () => {
    expect(text).toContain(`1 分に ${RATE_LIMIT_PER_MINUTE} 回を超えたとき`);
  });

  it('AI が答えない内容（空室・初期費用の確定額・治安・騒音・審査）を担当者に引き継ぐと書く', () => {
    for (const word of ['空室状況', '初期費用の確定額', '治安', '騒音', '入居審査']) expect(text).toContain(word);
  });
});

describe('LegalPage', () => {
  it.each([PRIVACY, TERMS])('$title: 見出し・最終更新日・各節・関連ページへのリンクを描く', (doc) => {
    const html = renderToStaticMarkup(createElement(LegalPage, { document: doc }));
    expect(html).toContain(`<h1`);
    expect(html).toContain(doc.title);
    expect(html).toContain(LEGAL_UPDATED);
    for (const s of doc.sections) expect(html).toContain(s.heading);
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/terms"');
    // 太字は 600 まで・色はトークン経由（クラス名だけ）
    expect(html).not.toMatch(/font-(?:bold|extrabold|black)/);
    expect(html).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
  });
});
