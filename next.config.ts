import type { NextConfig } from "next";

/**
 * 全パスに付けるセキュリティヘッダー（セキュリティ点検 A7）。
 * - 管理画面を他のサイトの iframe に入れさせない（クリックジャックで「確定する」を押させる手口を防ぐ）。
 *   `frame-ancestors` が本命で、古いブラウザ向けに X-Frame-Options も付ける
 * - CSP は `frame-ancestors` だけ。script-src などを絞る本格的な CSP は nonce が要り、`/`・`/privacy`・`/terms` の静的な描画が
 *   動的になる（`src/app/layout.tsx` の `<style dangerouslySetInnerHTML>` にも響く）ので入れない
 * - HSTS は `*.vercel.app` では Vercel が付ける。カスタムドメインにするときに自前で足す（点検 4.2）
 */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // X-Powered-By: Next.js を出さない（使っているフレームワークを知らせない）
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
