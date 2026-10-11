import { hintClass } from './ui';

/**
 * ログイン画面に出す、公開デモの閲覧用アカウント（role = viewer）の案内。
 * 読み取り専用で、見られるのは架空のデモ会話だけ（RLS が門。不変条件 14）なので、資格情報を公開してよい。
 * 毎朝の Cron が、このアカウントのパスワードを環境変数の値に戻す（src/server/demoSeed.ts の resetDemoViewerPassword）。
 *
 * フォームへの自動入力はしない。値はクリック（タップ）で全選択できる表示にして、コピーしやすくするだけ。
 * 色は globals.css の `@theme inline`（= src/constants/theme.ts のトークン）経由のクラスだけ。太字は 600 まで。
 * 表示してよいかの判断（DEMO_MODE=1 と環境変数の有無）は呼ぶ側（login/page.tsx の `publicDemoViewer()`）で済ませる。
 */
export function DemoViewerNotice({ email, password }: { email: string; password: string }) {
  return (
    <section aria-labelledby="demo-viewer-heading" className="rounded-lg border border-line bg-sunken p-4 sm:p-5">
      <h2 id="demo-viewer-heading" className="text-base font-semibold">
        公開デモの閲覧用アカウント
      </h2>
      <p className={`${hintClass} mt-1`}>読み取り専用です。見られるのは架空のデモ会話だけです。</p>
      <dl className="mt-4 space-y-3">
        <Credential label="メールアドレス" value={email} />
        <Credential label="パスワード" value={password} />
      </dl>
    </section>
  );
}

function Credential({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-sm font-semibold">{label}</dt>
      <dd className="mt-1">
        <code className="block select-all break-all rounded-md border border-line bg-surface px-3 py-2 font-mono text-sm leading-relaxed text-fg">{value}</code>
      </dd>
    </div>
  );
}
