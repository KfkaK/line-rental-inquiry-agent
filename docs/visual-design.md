---
version: alpha
name: お部屋探しAI 管理画面
description: 賃貸仲介の担当者が朝に引き継ぎを片付ける管理画面と、公開ページ（トップ・規約）の見た目の決まり。いまの画面から書き起こしたもの。
colors:
  # 色の正本は src/constants/theme.ts。ここは写しで、scripts/check-design-tokens.js が値のずれを落とす
  primary: "#3E5C76"
  background: "#F4F5F7"
  background-element: "#FFFFFF"
  border: "#D8DCE2"
  text: "#1F2933"
  text-secondary: "#5B6670"
  accent: "#3E5C76"
  on-accent: "#FFFFFF"
  danger: "#9A3B32"
  background-muted: "#EBEEF1"
  border-strong: "#7E8995"
  accent-soft: "#E4EBF1"
  danger-soft: "#F6E8E6"
  dark-background: "#1B1D20"
  dark-background-element: "#25282C"
  dark-border: "#3A3F46"
  dark-text: "#ECE8E2"
  dark-text-secondary: "#B3ACA3"
  dark-accent: "#9DB8CE"
  dark-on-accent: "#1B1D20"
  dark-danger: "#E59A90"
  dark-background-muted: "#2E3237"
  dark-border-strong: "#7A838D"
  dark-accent-soft: "#2B3945"
  dark-danger-soft: "#3B2B29"
typography:
  headline-lg:
    fontFamily: Hiragino Sans, Noto Sans JP, Yu Gothic UI, system-ui, sans-serif
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.625
  headline-md:
    fontFamily: Hiragino Sans, Noto Sans JP, Yu Gothic UI, system-ui, sans-serif
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.4
  headline-sm:
    fontFamily: Hiragino Sans, Noto Sans JP, Yu Gothic UI, system-ui, sans-serif
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.5
  body-md:
    fontFamily: Hiragino Sans, Noto Sans JP, Yu Gothic UI, system-ui, sans-serif
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.7
  body-sm:
    fontFamily: Hiragino Sans, Noto Sans JP, Yu Gothic UI, system-ui, sans-serif
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.625
  label-md:
    fontFamily: Hiragino Sans, Noto Sans JP, Yu Gothic UI, system-ui, sans-serif
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.43
  label-sm:
    fontFamily: Hiragino Sans, Noto Sans JP, Yu Gothic UI, system-ui, sans-serif
    fontSize: 12px
    fontWeight: 600
    lineHeight: 1.5
rounded:
  sm: 4px
  md: 6px
  lg: 8px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 20px
  2xl: 24px
  3xl: 32px
  touch-target: 44px
  admin-max-width: 1024px
  public-max-width: 672px
  login-max-width: 448px
components:
  page:
    backgroundColor: "{colors.background}"
    textColor: "{colors.text}"
    typography: "{typography.body-md}"
  page-dark:
    backgroundColor: "{colors.dark-background}"
    textColor: "{colors.dark-text}"
  card:
    backgroundColor: "{colors.background-element}"
    textColor: "{colors.text}"
    borderColor: "{colors.border}"
    rounded: "{rounded.lg}"
    padding: "{spacing.lg}"
  card-dark:
    backgroundColor: "{colors.dark-background-element}"
    textColor: "{colors.dark-text}"
    borderColor: "{colors.dark-border}"
  card-hint:
    backgroundColor: "{colors.background-element}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.body-sm}"
  card-hint-dark:
    backgroundColor: "{colors.dark-background-element}"
    textColor: "{colors.dark-text-secondary}"
  notice-bar:
    backgroundColor: "{colors.background-muted}"
    textColor: "{colors.text}"
    typography: "{typography.body-sm}"
    padding: "{spacing.sm}"
  notice-bar-dark:
    backgroundColor: "{colors.dark-background-muted}"
    textColor: "{colors.dark-text}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-accent}"
    borderColor: "{colors.accent}"
    typography: "{typography.label-md}"
    rounded: "{rounded.md}"
    padding: "{spacing.xl}"
    height: "{spacing.touch-target}"
  button-primary-dark:
    backgroundColor: "{colors.dark-accent}"
    textColor: "{colors.dark-on-accent}"
    borderColor: "{colors.dark-accent}"
  button-secondary:
    backgroundColor: "{colors.background-element}"
    textColor: "{colors.text}"
    borderColor: "{colors.border-strong}"
    typography: "{typography.label-md}"
    rounded: "{rounded.md}"
    padding: "{spacing.xl}"
    height: "{spacing.touch-target}"
  button-secondary-dark:
    backgroundColor: "{colors.dark-background-element}"
    textColor: "{colors.dark-text}"
    borderColor: "{colors.dark-border-strong}"
  button-danger:
    backgroundColor: "{colors.background-element}"
    textColor: "{colors.danger}"
    borderColor: "{colors.danger}"
    typography: "{typography.label-md}"
    rounded: "{rounded.md}"
    padding: "{spacing.xl}"
    height: "{spacing.touch-target}"
  button-danger-dark:
    backgroundColor: "{colors.dark-background-element}"
    textColor: "{colors.dark-danger}"
    borderColor: "{colors.dark-danger}"
  input:
    backgroundColor: "{colors.background-element}"
    textColor: "{colors.text}"
    borderColor: "{colors.border-strong}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
  input-dark:
    backgroundColor: "{colors.dark-background-element}"
    textColor: "{colors.dark-text}"
    borderColor: "{colors.dark-border-strong}"
  input-readonly:
    backgroundColor: "{colors.background-muted}"
    textColor: "{colors.text-secondary}"
  input-readonly-dark:
    backgroundColor: "{colors.dark-background-muted}"
    textColor: "{colors.dark-text-secondary}"
  chip-solid:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm}"
  chip-solid-dark:
    backgroundColor: "{colors.dark-accent}"
    textColor: "{colors.dark-on-accent}"
  chip-soft:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm}"
  chip-soft-dark:
    backgroundColor: "{colors.dark-accent-soft}"
    textColor: "{colors.dark-accent}"
  chip-plain:
    backgroundColor: "{colors.background-muted}"
    textColor: "{colors.text}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm}"
  chip-plain-dark:
    backgroundColor: "{colors.dark-background-muted}"
    textColor: "{colors.dark-text}"
  chip-outline:
    backgroundColor: "{colors.background-element}"
    textColor: "{colors.text}"
    borderColor: "{colors.border-strong}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm}"
  chip-outline-dark:
    backgroundColor: "{colors.dark-background-element}"
    textColor: "{colors.dark-text}"
    borderColor: "{colors.dark-border-strong}"
  chip-danger:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm}"
  chip-danger-dark:
    backgroundColor: "{colors.dark-danger-soft}"
    textColor: "{colors.dark-danger}"
  nav-link:
    backgroundColor: "{colors.background-element}"
    textColor: "{colors.text}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
    height: "{spacing.touch-target}"
  nav-link-active:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
    typography: "{typography.label-md}"
  nav-link-active-dark:
    backgroundColor: "{colors.dark-accent-soft}"
    textColor: "{colors.dark-accent}"
  link:
    backgroundColor: "{colors.background}"
    textColor: "{colors.accent}"
    height: "{spacing.touch-target}"
  link-dark:
    backgroundColor: "{colors.dark-background}"
    textColor: "{colors.dark-accent}"
  label:
    textColor: "{colors.text}"
    typography: "{typography.label-md}"
  page-title:
    typography: "{typography.headline-md}"
  page-title-public:
    typography: "{typography.headline-lg}"
  section-title:
    typography: "{typography.headline-sm}"
---

# お部屋探しAI 管理画面の見た目の決まり

いまの画面（`src/app/admin/_components/ui.tsx`・`src/app/globals.css`・各ページ）から書き起こした決まり。新しい見た目はここで作らない。**色の値の正本は `src/constants/theme.ts`** で、ここの `colors` は写し（`npm run check:design-tokens` が値のずれを落とす）。文字と背景のコントラストの正本は `npm run check:contrast`。

画面のクラスは Tailwind の名前で書く（`bg-surface` など）。トークンとクラスの対応は `globals.css` の `@theme inline` にある。

## Overview

賃貸仲介の担当者が、朝いちばんに夜間の問い合わせを上から順に片付けるための道具。**落ち着いて、迷わず、長く見ても疲れない**ことを優先する。白ラベルの商品見本として見せるので、特定の会社の色やにぎやかな飾りは持たない。

- シンプルで落ち着いた低彩度。地は寒色寄りの薄いグレー、内容は白いカードに載せ、操作と現在地だけをスレートブルー1色で示す
- 情報は「状態の印 → 時刻 → 名前」の順に1行で読めることを大事にする（朝の引き継ぎ一覧）
- ライトとダークは OS の設定に従う（`prefers-color-scheme`）。どちらも同じ役割の色を持つ
- 公開ページ（`/`・`/privacy`・`/terms`）も同じトークンを使い、幅を狭くして読み物に寄せる

## Colors

役割で名前を付け、画面では役割の名前（Tailwind のクラス）だけを使う。ダークは同じ役割の名前の頭に `dark-` を付けて並べている（画面では CSS 変数が切り替わるので、クラスは同じ）。`primary` は design.md の書式が求める名前で、中身は `accent` と同じ。

| トークン | Tailwind のクラス | 役割 |
|---|---|---|
| background | `bg-background` | ページの地（寒色寄りのニュートラル） |
| background-element | `bg-surface` | カード・入力欄・ヘッダー・副ボタンの地（ライトは白） |
| background-muted | `bg-sunken` | 一段沈んだ地。お知らせの帯・読み取り専用の入力欄・ふつうの印 |
| border | `border-line` | カードとヘッダーの枠線 |
| border-strong | `border-line-strong` | 入力欄・副ボタン・枠だけの印の枠線、カードのホバー |
| text | `text-fg` | 本文 |
| text-secondary | `text-muted` | 説明・時刻・件数・空の表示 |
| accent / primary | `bg-accent`・`text-accent` | 主ボタン・リンク・いまいるページ・未対応の印・フォーカスの輪。**アクセントはこの1色だけ** |
| on-accent | `text-on-accent` | accent の地に載せる文字 |
| accent-soft | `bg-accent-soft` | いまいるページのナビ・「対応中」「AI停止中」の印の地 |
| danger | `text-danger`・`border-danger` | 却下などの取り消しにくい操作、エラーの文 |
| danger-soft | `bg-danger-soft` | 危ない印の地 |

## Typography

フォントはシステムのもの（Hiragino Sans → Noto Sans JP → Yu Gothic UI）。next/font の Geist は日本語に効かないので使わない。

- 太さは **400 と 600 の2つだけ**（`font-normal`・`font-semibold`）。`font-bold` は `themeCss.test.ts` が落とす
- 行間は広め。本文は 1.7（`body`）、説明の小さい字は `leading-relaxed`（1.625）
- 見出し: 管理画面のページ見出しは `text-xl font-semibold`（headline-md）、公開ページの見出しは `text-2xl font-semibold leading-relaxed`（headline-lg）、節の見出しは `text-base font-semibold`（headline-sm）。件数は見出しの横に `text-sm font-normal text-muted` で添える
- 入力欄は 16px（`text-base`）。スマホで入力時に拡大されないため
- 印（チップ）は `text-xs font-semibold`（label-sm）、ボタン・ラベルは `text-sm font-semibold`（label-md）

## Layout

- 管理画面は1段組み。ヘッダーと本文は `max-w-5xl`（1024px）の中央寄せ、左右の余白は `px-4`（16px）。本文の上下は `py-6 sm:py-8`
- 公開ページは `max-w-2xl`（672px）、ログイン画面は `max-w-md`（448px）
- 縦の間隔は4の倍数で、よく使うのは 8px（`space-y-2`）・12px（`space-y-3`。一覧の行の間）・24px（`space-y-6`。ページの塊の間）
- 押せるものは高さ 44px 以上（`min-h-11`）。ボタン・ナビ・規約のリンクすべて
- 一覧は表ではなく、カードの縦の並び（`ul.space-y-3`）。1行のカードの中で、印と名前は `flex flex-wrap gap-x-3 gap-y-1` で折り返す

## Elevation & Depth

影は使わない。奥行きは **地の色の段と枠線**で出す: ページの地（background）の上に白いカード（background-element ＋ border）、一段沈めたいものは background-muted。カードがリンクのときは、ホバーで枠線を border-strong に濃くするだけにする。

## Shapes

角丸は小さめで3段だけ。カード・空の表示は 8px（`rounded-lg`）、ボタン・入力欄・ナビは 6px（`rounded-md`）、印は 4px（`rounded`）。丸いピル形（`rounded-full`）は使わない。フォーカスは accent の 2px の輪（`outline-offset: 2px`。`globals.css`）。

## Components

部品は `src/app/admin/_components/ui.tsx` にある。新しい画面はまずここの部品とクラスを使い、足りないときだけ同じトークンで足す。

- **カード**（`cardClass`）: `rounded-lg border border-line bg-surface p-4 sm:p-5`。一覧の行・フォームの塊・空の表示（空の表示は `text-sm text-muted`）
- **ボタン**（`SubmitButton`）: `min-h-11 rounded-md px-5 text-sm font-semibold`。主は accent の塗り、副は surface ＋ border-strong の枠、危ないもの（却下など）は surface ＋ danger の枠と文字。送信中は無効にして「送信中…」と出す（`disabled:opacity-60`）。1つの塊に主ボタンは1つまで
- **入力欄**（`inputClass`）: `rounded-md border border-line-strong bg-surface px-3 py-2 text-base`。読み取り専用は sunken の地と muted の文字。ラベルは `labelClass`（`text-sm font-semibold`）、補足は `hintClass`（`text-sm text-muted leading-relaxed`）
- **印**（`Chip`）: `rounded px-2 py-0.5 text-xs font-semibold`。tone は solid（accent の塗り。**手がまだ要るもの＝未対応だけ**）・soft（対応中・AI停止中）・plain（時間外など中立）・outline（デモ・確定済み・引き継ぎ）・danger。内見の状態は `StatusBadge` が対応を決める
- **ナビ**（`NavLinks`）: `min-h-11 rounded-md px-3 text-sm`。いまいるページは accent-soft の地 ＋ accent の文字 ＋ 600 で、`aria-current="page"` を付ける
- **リンク**: 文中と規約のリンクは `text-accent underline underline-offset-4`。ボタンに見せるリンク（トップの「管理画面を開く」）は主ボタンと同じ見た目
- **お知らせの帯**（`Notices`）: ヘッダーの下に `border-b border-line bg-sunken` の帯で `text-sm`。`role="note"`

## Do's and Don'ts

- Do 色は役割のトークン（Tailwind のクラス `bg-surface`・`text-muted` など）経由でだけ使う。新しい色が要るときは `theme.ts` に light と dark の両方を足し、このファイルの `colors` も直して、`npm run check:contrast` で AA（本文 4.5:1）を実測する
- Do アクセントは accent の1色だけ。塗りの accent は「主ボタン」と「未対応の印」に絞り、1画面で塗りを増やしすぎない
- Do 太字は 600 まで。強調は太さか muted との対比で出し、色を足さない
- Do 押せるものは 44px 以上。いまいる場所は `aria-current` と見た目の両方で示す
- Do ライトとダークの両方で見て確かめる
- Don't `#xxxxxx` などの色の値を `src/app` に直書きしない（`themeCss.test.ts` が落とす）
- Don't 影・グラデーション・角の大きいピル形・アイコンの多用・アニメーションで飾らない
- Don't ゲーム風の飾り（バッジの数字を光らせる・達成の演出・絵文字の多用）を入れない
- Don't 状態を色だけで伝えない。印には必ず文字（「未対応」「AI停止中」など）を入れる
- Don't 表を新しく足す前に、カードの縦の並びで足りないかを考える（スマホで朝に読むため）
