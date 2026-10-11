import { describe, expect, it } from 'vitest';
import { DEMO_GREETING_NOTE, DEMO_NO_CONTACT_NOTE, greeting, handoff, viewingAccepted } from './messages';

describe('定型文（公開デモ）', () => {
  it('デモの文言は決めた言い回しのまま', () => {
    expect(DEMO_GREETING_NOTE).toBe('これはデモです。物件は架空のデータで、担当者からの連絡はありません。');
    expect(DEMO_NO_CONTACT_NOTE).toBe('（デモのため、実際の連絡はありません）');
  });

  it('あいさつ: 既定はデモの一文なし。デモでは AI の一次対応の明示のあと・営業時間外の案内の前に入る', () => {
    expect(greeting(true)).not.toContain('デモ');
    expect(greeting(false, false)).not.toContain('デモ');
    const lines = greeting(true, true).split('\n');
    expect(lines[0]).toBe('友だち追加ありがとうございます。');
    expect(lines[1]).toContain('AI が一次対応');
    expect(lines[2]).toBe(DEMO_GREETING_NOTE);
    expect(lines[3]).toContain('営業時間外');
    expect(lines.at(-1)).toContain('エリア');
    // 営業時間内ならデモの一文のあとに空行
    expect(greeting(false, true).split('\n')[2]).toBe(DEMO_GREETING_NOTE);
    expect(greeting(false, true)).not.toContain('営業時間外');
  });

  it('引き継ぎ文: 既定は従来どおり。デモでは「ご連絡します」の直後に足し、あとの一文はそのまま', () => {
    expect(handoff('vacancy', true, '2026-10-08')).toBe(
      '空室状況については担当者が確認します。ただいま営業時間外のため、10月8日(木)に担当者からご連絡します。\nそのあいだも物件探しはお手伝いできます。',
    );
    expect(handoff('vacancy', true, '2026-10-08', true)).toBe(
      `空室状況については担当者が確認します。ただいま営業時間外のため、10月8日(木)に担当者からご連絡します。${DEMO_NO_CONTACT_NOTE}\nそのあいだも物件探しはお手伝いできます。`,
    );
    expect(handoff(null, false, '2026-10-08', true)).toBe(
      `このご質問は担当者が確認します。営業時間内に担当者からご連絡します。${DEMO_NO_CONTACT_NOTE}\nそのあいだも物件探しはお手伝いできます。`,
    );
  });

  it('内見の仮受付: デモでも「まだ予約は確定していません」を保ち、確定のご連絡の直後に足す', () => {
    const times = ['2026-10-08T14:00', '2026-10-09T11:00'];
    const normal = viewingAccepted('テスト荘', times, true, '2026-10-08');
    const demo = viewingAccepted('テスト荘', times, true, '2026-10-08', true);
    expect(normal).not.toContain('デモ');
    expect(demo).toBe(`${normal}${DEMO_NO_CONTACT_NOTE}`);
    expect(demo).toContain('まだ予約は確定していません。ただいま営業時間外のため、10月8日(木)に担当者から確定のご連絡をします。');
    expect(viewingAccepted('テスト荘', times, false, '2026-10-08', true).endsWith(`担当者から確定のご連絡をします。${DEMO_NO_CONTACT_NOTE}`)).toBe(true);
  });
});
