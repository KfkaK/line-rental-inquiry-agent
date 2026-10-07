import { describe, expect, it } from 'vitest';
import { makeProperty } from '@/domain/fixtures';
import { attachTags, numericTags } from './importProperties';

const row = (overrides: Parameters<typeof makeProperty>[0] = {}) => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { tags, ...rest } = makeProperty(overrides);
  return rest;
};

describe('attachTags', () => {
  it('敷金・礼金 0 か月は数値列からタグにする', () => {
    expect(numericTags({ depositMonths: 0, keyMoneyMonths: 1 })).toEqual(['敷金なし']);
    expect(numericTags({ depositMonths: 1, keyMoneyMonths: 0 })).toEqual(['礼金なし']);
  });

  it('備考のタグと数値列のタグを合わせ、TAGS の並びにそろえる', () => {
    const [p] = attachTags([row({ id: 'X1', depositMonths: 0 })], new Map([['X1', ['静か', 'ペット可'] as const]]));
    expect(p.tags).toEqual(['ペット可', '静か', '敷金なし']);
  });

  it('備考側の「敷金なし」は数値列で決め直す（食い違ったら数値が正）', () => {
    const [p] = attachTags([row({ id: 'X2', depositMonths: 1, keyMoneyMonths: 1 })], new Map([['X2', ['敷金なし'] as const]]));
    expect(p.tags).toEqual([]);
  });

  it('noteTags に無い行は備考のタグなし', () => {
    const [p] = attachTags([row({ id: 'X3', depositMonths: 1, keyMoneyMonths: 1 })], new Map());
    expect(p.tags).toEqual([]);
  });
});
