#!/usr/bin/env bash
# 公開用のミラー（意思決定ログ18）。非公開の開発用リポジトリの main を、作者・コミッターのメールアドレスを
# GitHub の noreply に書き換えた履歴にして、公開用のリポジトリへ push する。開発・Vercel のデプロイは非公開のまま続ける。
#
#   bash scripts/public-mirror.sh --dry-run                      # 書き換えて検査するだけ（push しない）
#   bash scripts/public-mirror.sh https://github.com/<owner>/<repo>.git
#
# - 書き換えは作者名で引く（このスクリプトは公開されるので、個人のメールアドレスは書かない）。書き換えた後に
#   noreply 以外のメールアドレスが1つでも残っていたら、push せずに止める
# - 日時と中身は変えないので、同じ履歴からは毎回同じコミット ID になる。区切りで回し直すと、増えた分だけが push される
#   （force push はしない。公開側の履歴が食い違ったら push が拒否されて止まる）
# - 公開側では、docs の PR 番号のリンク（KfkaK/line-rental-agent#N）が非公開の開発用リポジトリを指す（README に明記する）
# - この PC では push が git-credential-manager の画面待ちで固まることがある。そのときは引き継ぎ書8章のとおり
#   gh の認証を使う。git の設定を環境変数で渡せる（fetch と push の両方に効く）:
#   GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0= \
#     GIT_CONFIG_KEY_1=credential.helper GIT_CONFIG_VALUE_1='!"/c/Program Files/GitHub CLI/gh.exe" auth git-credential' bash scripts/public-mirror.sh ...
# - 写すのは GitHub の origin/main（PR でマージ済みのもの）。手元の main が古い・main に push していないコミットがある、は関係しない
set -euo pipefail

usage() {
  echo '使い方: bash scripts/public-mirror.sh --dry-run | <公開用リポジトリの URL>' >&2
  exit 1
}
[ $# -eq 1 ] || usage
target="$1"
dry_run=false
[ "$target" = "--dry-run" ] && dry_run=true

src="$(git rev-parse --show-toplevel)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git -C "$src" fetch --quiet origin main
git init --quiet "$work/mirror"
cd "$work/mirror"
git fetch --quiet "$src" refs/remotes/origin/main
git checkout --quiet -B main FETCH_HEAD

# 作者名 → GitHub の noreply（ID は `gh api users/<login> --jq .id`）。GitHub 上のマージのコミッター（GitHub <noreply@github.com>）はそのまま
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --env-filter '
noreply() {
  case "$1" in
    rokota1129-commits) echo "305899087+rokota1129-commits@users.noreply.github.com" ;;
    KfkaK) echo "266705633+KfkaK@users.noreply.github.com" ;;
    *) echo "" ;;
  esac
}
a="$(noreply "$GIT_AUTHOR_NAME")"
if [ -n "$a" ]; then export GIT_AUTHOR_EMAIL="$a"; fi
c="$(noreply "$GIT_COMMITTER_NAME")"
if [ -n "$c" ]; then export GIT_COMMITTER_EMAIL="$c"; fi
' -- main >/dev/null

# 検査 1: 作者・コミッターのメールアドレスが noreply だけか
leftover="$(git log main --format='%ae%n%ce' | sort -u | grep -vE '^[0-9]+\+[A-Za-z0-9-]+@users\.noreply\.github\.com$|^noreply@github\.com$' || true)"
if [ -n "$leftover" ]; then
  echo "noreply 以外のメールアドレスが残っています（作者名の表に足してください）: $(echo "$leftover" | wc -l) 件" >&2
  exit 1
fi
# 検査 2: 本文・ファイル（過去の版も含む）に個人のメールアドレスが無いか（よくあるフリーメールのドメインだけを見る）
if git log main --format='%B' | grep -qiE '@(gmail|yahoo|icloud|outlook|hotmail)\.'; then
  echo 'コミットメッセージに個人のメールアドレスがあります' >&2
  exit 1
fi
if git log main -p --format= | grep -qiE '[A-Za-z0-9._%+-]+@(gmail|yahoo|icloud|outlook|hotmail)\.'; then
  echo 'ファイル（過去の版を含む）に個人のメールアドレスがあります' >&2
  exit 1
fi

count="$(git rev-list --count main)"
echo "書き換えて検査しました: コミット ${count} 件・先頭 $(git rev-parse --short main)"
echo "作者・コミッター: $(git log main --format='%an <%ae>' | sort -u | tr '\n' ' ')"

if $dry_run; then
  echo '--dry-run のため push しません'
  exit 0
fi
git push "$target" main:main
echo "push しました: $target"
