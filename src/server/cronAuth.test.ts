import { describe, expect, it } from 'vitest';
import { isCronAuthorized } from './cronAuth';

const SECRET = 'cron-secret-0123456789abcdef';

describe('isCronAuthorized', () => {
  it('Bearer ＋ CRON_SECRET が一致すれば true', () => {
    expect(isCronAuthorized(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it('ヘッダーが無い・空なら false', () => {
    expect(isCronAuthorized(null, SECRET)).toBe(false);
    expect(isCronAuthorized('', SECRET)).toBe(false);
  });

  it('秘密が違う・前後に余分がある・長さが違うなら false', () => {
    expect(isCronAuthorized('Bearer wrong-secret', SECRET)).toBe(false);
    expect(isCronAuthorized(`Bearer ${SECRET} `, SECRET)).toBe(false);
    expect(isCronAuthorized(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(isCronAuthorized(`Bearer ${SECRET.slice(0, -1)}`, SECRET)).toBe(false);
    expect(isCronAuthorized('Bearer ', SECRET)).toBe(false);
  });

  it('Bearer 以外の形式（秘密そのもの・Basic・小文字）は false', () => {
    expect(isCronAuthorized(SECRET, SECRET)).toBe(false);
    expect(isCronAuthorized(`Basic ${SECRET}`, SECRET)).toBe(false);
    expect(isCronAuthorized(`bearer ${SECRET}`, SECRET)).toBe(false);
  });

  it('秘密が空なら、どんなヘッダーも false（空の秘密を通さない）', () => {
    expect(isCronAuthorized('Bearer ', '')).toBe(false);
    expect(isCronAuthorized('Bearer anything', '')).toBe(false);
    expect(isCronAuthorized(null, '')).toBe(false);
  });
});
