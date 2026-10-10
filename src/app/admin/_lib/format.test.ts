import { describe, expect, it } from 'vitest';
import { AI_RESUME_AFTER_MS } from '@/domain/rules';
import { candidateTimePart, displayNameOf, formatCandidates, formatCostUsd, formatJstDateTime, formatLatency } from './format';
import { aiResumeAt } from './resume';

describe('formatJstDateTime', () => {
  it('UTC の ISO を JST の「10月6日(火) 19:00」にする', () => {
    expect(formatJstDateTime('2026-10-06T10:00:00.000Z')).toBe('10月6日(火) 19:00');
  });

  it('UTC の夜は JST では翌日になる', () => {
    expect(formatJstDateTime('2026-10-06T15:30:00.000Z')).toBe('10月7日(水) 00:30');
  });
});

describe('formatCandidates / candidateTimePart', () => {
  it('候補日時を「、」でつなぎ、時刻が無ければ日付だけにする', () => {
    expect(formatCandidates(['2026-10-10T14:00', '2026-10-12'])).toBe('10月10日(土) 14:00、10月12日(月)');
  });

  it('候補の時刻部分を取り出す（日付だけなら空）', () => {
    expect(candidateTimePart('2026-10-10T14:00')).toBe('14:00');
    expect(candidateTimePart('2026-10-12')).toBe('');
  });
});

describe('formatLatency / formatCostUsd', () => {
  it('応答時間は秒、費用は USD で小数4桁', () => {
    expect(formatLatency(1234)).toBe('1.2秒');
    expect(formatLatency(800)).toBe('0.8秒');
    expect(formatCostUsd(0.00123)).toBe('$0.0012');
    expect(formatCostUsd(0)).toBe('$0');
  });
});

describe('displayNameOf', () => {
  it('表示名が無い・空白だけなら「（表示名なし）」', () => {
    expect(displayNameOf('田中')).toBe('田中');
    expect(displayNameOf(null)).toBe('（表示名なし）');
    expect(displayNameOf('  ')).toBe('（表示名なし）');
  });
});

describe('aiResumeAt', () => {
  it('最終の担当者返信から 24 時間後に自動で再開する', () => {
    const last = '2026-10-09T03:00:00.000Z';
    expect(aiResumeAt(last)).toBe(new Date(Date.parse(last) + AI_RESUME_AFTER_MS).toISOString());
    expect(aiResumeAt(last)).toBe('2026-10-10T03:00:00.000Z');
  });

  it('担当者の返信が無い停止は自動では再開しない', () => {
    expect(aiResumeAt(null)).toBeNull();
    expect(aiResumeAt('not a date')).toBeNull();
  });
});
