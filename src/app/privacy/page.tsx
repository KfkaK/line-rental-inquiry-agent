import type { Metadata } from 'next';
import { PRIVACY } from '../_legal/content';
import { LegalPage } from '../_legal/LegalPage';

export const metadata: Metadata = {
  title: `${PRIVACY.title} | お部屋探しAI（デモ）`,
  description: 'お部屋探しAI（デモ）が保存する情報と、その使いみち、利用する外部サービス、保存期間。',
};

export default function PrivacyPage() {
  return <LegalPage document={PRIVACY} />;
}
