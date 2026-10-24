import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminCookieOptions } from './cookieOptions';

const createServerClient = vi.hoisted(() => vi.fn());

vi.mock('@supabase/ssr', () => ({ createServerClient }));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));

afterEach(() => {
  vi.unstubAllEnvs();
  createServerClient.mockReset();
});

describe('adminCookieOptions', () => {
  it('JS から読めない・SameSite=Lax。Secure は本番だけ（next dev の http://localhost で cookie が付かなくならないように）', () => {
    expect(adminCookieOptions('production')).toEqual({ httpOnly: true, secure: true, sameSite: 'lax' });
    expect(adminCookieOptions('development')).toEqual({ httpOnly: true, secure: false, sameSite: 'lax' });
    expect(adminCookieOptions('test')).toEqual({ httpOnly: true, secure: false, sameSite: 'lax' });
    expect(adminCookieOptions(undefined)).toEqual({ httpOnly: true, secure: false, sameSite: 'lax' });
  });

  it('名前と有効期間は決めない（@supabase/ssr の既定の cookie 名のまま。maxAge は @supabase/ssr が 400 日で上書きする）', () => {
    const options = adminCookieOptions('production');
    expect(options.name).toBeUndefined();
    expect(options.maxAge).toBeUndefined();
  });
});

describe('createServerClient に渡す cookie の属性は、session.ts と proxy.ts で同じ', () => {
  function stubSupabaseEnv(): void {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.test');
    vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    vi.stubEnv('ADMIN_PREVIEW', '');
  }

  it('session.ts の createSessionClient', async () => {
    stubSupabaseEnv();
    createServerClient.mockReturnValue({});
    const { createSessionClient } = await import('./session');
    await createSessionClient();
    expect(createServerClient).toHaveBeenCalledTimes(1);
    expect(createServerClient.mock.calls[0][2].cookieOptions).toEqual(adminCookieOptions());
  });

  it('proxy.ts の proxy', async () => {
    stubSupabaseEnv();
    createServerClient.mockReturnValue({ auth: { getClaims: async () => ({ data: { claims: { sub: 'u' } } }) } });
    const { proxy } = await import('../../proxy');
    await proxy(new NextRequest('https://app.example.com/admin'));
    expect(createServerClient).toHaveBeenCalledTimes(1);
    expect(createServerClient.mock.calls[0][2].cookieOptions).toEqual(adminCookieOptions());
  });
});
