import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 px-4 py-16">
      <p className="text-sm text-muted">デモ</p>
      <h1 className="text-2xl font-semibold leading-relaxed">お部屋探しAI</h1>
      <p className="leading-relaxed">
        賃貸仲介向けの LINE 一次対応エージェントのデモです。条件のヒアリングから物件の提示、内見の仮受付までを AI が受け持ち、
        空室状況や初期費用の確定額など AI が答えない内容と、内見の確定は担当者に引き継ぎます。
      </p>
      <p className="leading-relaxed text-muted">掲載している物件はすべて架空のデータです。</p>
      <div>
        <Link
          href="/admin"
          className="inline-flex min-h-11 items-center rounded-md bg-accent px-5 text-sm font-semibold text-on-accent"
        >
          管理画面を開く
        </Link>
      </div>
    </main>
  );
}
