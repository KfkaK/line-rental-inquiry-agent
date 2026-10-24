import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

describe('next.config: セキュリティヘッダー', () => {
  it('全パスに、iframe への埋め込み禁止・nosniff・Referrer-Policy・Permissions-Policy を付ける', async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    expect(rules).toHaveLength(1);
    expect(rules[0].source).toBe('/:path*');
    expect(Object.fromEntries(rules[0].headers.map((h) => [h.key, h.value]))).toEqual({
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
  });

  it('CSP は frame-ancestors だけ（script-src などを足すと nonce が要り、静的なページが動的になる）', async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const csp = rules[0].headers.find((h) => h.key === 'Content-Security-Policy')?.value ?? '';
    expect(csp).not.toMatch(/script-src|default-src|style-src/);
  });

  it('X-Powered-By を出さない', () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
