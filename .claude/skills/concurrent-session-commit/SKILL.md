---
name: concurrent-session-commit
description: 同じ作業ツリーで複数の Claude セッションが並行して動いているときに、自分の変更だけをコミットする手順（引き継ぎ書など全員が編集する文書・ソースの衝突・index に対する検証）。git status に自分が触っていない変更がある、「changed on disk since you last read it」が出た、意思決定ログの番号が衝突しそう、というときに使う。
---

# 並行セッション下で自分の変更だけをコミットする

LifeOwner では同じ作業ツリーで2〜3セッションが同時に走り、`docs/引き継ぎ書.md` を全員が編集した（2026-09 に常態化）。`git add` で丸ごとステージすると、他セッションの未完成の追記（存在しないファイルへの参照など）を自分のコミットに巻き込む。意思決定ログの番号衝突（47/48/49、50/52）も頻発した。

## コミット前に確かめる

- `git status` と `git log -3` で、他セッションの未コミット変更と、直前に増えたコミット（番号を先取りしている）を見る
- 意思決定ログの番号は「既存の最大＋1」を付け直してから書く（クラウドなら `git fetch` して origin と自分のブランチの最大）
- 他セッションの新規ファイル（untracked）と、相手が足した README の1行などは触らない。相手が自分のコミットで載せる

## 共有の文書から自分の変更だけを index に置く

1. 作業ツリーの文書から他セッションの追記行（内容で識別）を取り除いた一時ファイルを、node スクリプトで scratchpad に作る（スクリプトは Write ツールで書く）
2. `git hash-object -w --path=docs/引き継ぎ書.md <tmp>` → 出た blob を `git update-index --cacheinfo 100644,<blob>,docs/引き継ぎ書.md`
3. `git diff --cached` が自分の差分だけ、`git diff` が相手の追記だけになっていることを確かめてからコミット

**やらないこと**: `git diff -U0` のハンクを選別して `git apply --cached --unidiff-zero` する方法。行の移動（削除＋挿入）を含むと1行ずれて空行や表の行順が崩れる（2回やり直した）。純粋な追加ハンクだけなら使えるが、上の方法のほうが安全。

## ソースファイルまで衝突したとき

ファイル変更通知（「changed on disk since you last read it」）が衝突の合図。相手が自分の編集の上にさらに改変している場合:

- `git show HEAD:<file>` に、自分の Edit の old/new 文字列を `indexOf` で当て直す node スクリプト（一意に一致することを assert）で「HEAD ＋ 自分の変更」を再構成する
- 同じく `hash-object -w` → `update-index` で index に置く

## index に対して検証する（作業ツリーではなく）

作業ツリーには相手の変更が混ざっているので、コミットする中身そのものを検証する:

1. `git checkout-index -a --prefix=<scratch>/` で index を書き出す
2. gitignore されていて必要なファイル（例: `expo-env.d.ts`）をコピーする
3. Windows では `cmd //c mklink //J <scratch>\node_modules <repo>\node_modules` でジャンクションを張り、`npx jest` と `npx tsc --noEmit` を回す
4. 後片付けは**先に `cmd //c rmdir <scratch>\node_modules` でジャンクションを外してから** `rm -rf`（rm がジャンクション先の本物の node_modules を消しに行かないように）
