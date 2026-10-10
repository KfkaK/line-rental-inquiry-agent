import { describe, expect, it } from 'vitest';
import { fromJst } from '@/domain/businessHours';
import { createMemoryRepositories } from '@/lib/db';
import { loadMorningList } from './morningList';
import { buildPreviewSeed, loadPreviewProperties } from './previewSeed';

const properties = loadPreviewProperties();

// 営業中・営業終了直後・深夜・休業日（水曜）・週末の朝など、どの時刻に開いても両方の区分に案件が出る
const NOWS: [string, Date][] = [
  ['木曜 11:00', fromJst('2026-10-08', '11:00')],
  ['月曜 08:30', fromJst('2026-10-05', '08:30')],
  ['火曜 19:05', fromJst('2026-10-06', '19:05')],
  ['水曜（休業日）14:00', fromJst('2026-10-07', '14:00')],
  ['土曜 02:00', fromJst('2026-10-10', '02:00')],
  ['日曜 23:40', fromJst('2026-10-11', '23:40')],
];

describe.each(NOWS)('プレビューのデモデータ（%s に開いた）', (_label, now) => {
  const seed = buildPreviewSeed(now, properties);
  const repos = createMemoryRepositories(seed, { clock: () => now });

  it('朝の引き継ぎ一覧の両方の区分に案件が出る', async () => {
    const list = await loadMorningList(repos, now);
    const label = (item: (typeof list.overnight)[number]): string =>
      item.kind === 'viewing' ? `viewing:${item.viewing.id}:${item.viewing.status}` : `handoff:${item.conversation.id}`;
    expect(list.overnight.map(label)).toEqual([
      'viewing:vr-demo-yamada:pending',
      'handoff:conv-demo-suzuki',
      'viewing:vr-demo-takahashi:confirmed',
    ]);
    expect(list.earlier.map(label)).toEqual(['viewing:vr-demo-ito:in_progress']);
  });

  it('「AIが聞き取れなかったこと」が未対応の仮受付と引き継ぎの行に載る（対応済みのメモは載らない）', async () => {
    const list = await loadMorningList(repos, now);
    const yamada = list.overnight[0];
    expect(yamada.openNotes.map((n) => n.topic)).toEqual(['vacancy']);
    expect(list.overnight[1].openNotes.map((n) => n.topic)).toEqual(['safety']);
    expect(list.earlier[0].openNotes.map((n) => n.topic)).toEqual(['initialCostTotal']);
    const all = [...list.overnight, ...list.earlier];
    expect(all.some((item) => item.kind === 'handoff' && item.conversation.id === 'conv-demo-watanabe')).toBe(false);
  });

  it('会話は 6 件。すべてデモ（isDemo）で、LINE ユーザー ID は demo-…。表示名なしの会話が 1 件ある', async () => {
    expect(seed.conversations).toHaveLength(6);
    for (const conversation of seed.conversations ?? []) {
      expect(conversation.isDemo).toBe(true);
      expect(conversation.lineUserId).toMatch(/^demo-/);
    }
    const recent = await repos.conversations.listRecent();
    expect(recent).toHaveLength(6);
    expect(recent.filter((c) => c.displayName === null)).toHaveLength(1);
    expect(recent.every((c) => !('lineUserId' in c))).toBe(true);
  });

  it('担当者が手動返信した会話は AI 停止中で、最終の担当者返信がある。差し替えの回答が 1 件だけある', async () => {
    const watanabe = await repos.conversations.getSummary('conv-demo-watanabe');
    expect(watanabe?.aiPaused).toBe(true);
    expect(watanabe?.lastStaffReplyAt).not.toBeNull();
    expect(watanabe?.handoffResolvedCount).toBe(1);
    const log = await repos.messages.listByConversation('conv-demo-watanabe');
    expect(log.some((m) => m.role === 'staff')).toBe(true);
    expect(seed.messages?.filter((m) => m.verification === 'replaced')).toHaveLength(1);
  });

  it('メッセージは時系列で、AI の行は意図・応答時間・費用を持つ。物件カードの ID は実在する', async () => {
    const ids = new Set(properties.map((p) => p.id));
    for (const conversation of seed.conversations ?? []) {
      const log = await repos.messages.listByConversation(conversation.id);
      const times = log.map((m) => Date.parse(m.createdAt));
      expect(times).toEqual([...times].sort((a, b) => a - b));
      expect(Date.parse(log[log.length - 1].createdAt)).toBeLessThanOrEqual(now.getTime());
      for (const m of log.filter((x) => x.role === 'ai')) {
        expect(m.latencyMs).not.toBeNull();
        for (const [, list] of m.text.matchAll(/\[物件カード \d+〜\d+番目: ([^\]]+)\]/g)) {
          for (const id of list.split(', ')) expect(ids.has(id), id).toBe(true);
        }
      }
    }
  });

  it('物件カードは条件に合う検索結果（0 件で全物件に置き換えていない）', () => {
    const presented = (seed.messages ?? []).filter((m) => m.role === 'ai' && m.text.includes('[物件カード'));
    expect(presented).toHaveLength(5);
    for (const m of presented) {
      const total = Number(/条件に合う物件が(\d+)件/.exec(m.text)?.[1]);
      expect(total).toBeGreaterThan(0);
      expect(total).toBeLessThan(properties.length);
    }
  });

  it('ID は固定（同じ時刻で作ると同じ内容）', () => {
    expect(buildPreviewSeed(now, properties)).toEqual(seed);
  });
});
