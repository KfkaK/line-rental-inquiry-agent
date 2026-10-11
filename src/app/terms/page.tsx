import type { Metadata } from 'next';
import { TERMS } from '../_legal/content';
import { LegalPage } from '../_legal/LegalPage';

export const metadata: Metadata = {
  title: `${TERMS.title} | お部屋探しAI（デモ）`,
  description: 'お部屋探しAI（デモ）の使い方。物件は架空のデータで、回答は参考情報です。',
};

export default function TermsPage() {
  return <LegalPage document={TERMS} />;
}
