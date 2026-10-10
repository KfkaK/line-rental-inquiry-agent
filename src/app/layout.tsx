import type { Metadata } from "next";
import { themeCss } from "@/constants/themeCss";
import "./globals.css";

export const metadata: Metadata = {
  title: "お部屋探しAI（デモ）",
  description: "賃貸仲介向けの LINE 一次対応エージェントのデモ。物件は架空のデータです。",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja" className="h-full antialiased">
      <head>
        {/* 色のトークン（src/constants/theme.ts）を CSS 変数にする。クラスへの割り当ては globals.css */}
        <style dangerouslySetInnerHTML={{ __html: themeCss() }} />
      </head>
      <body className="min-h-full flex flex-col bg-background text-fg">{children}</body>
    </html>
  );
}
