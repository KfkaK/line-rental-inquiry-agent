#!/usr/bin/env bash
# 公開用のミラー（意思決定ログ18）。非公開の開発用リポジトリの main を、作者・コミッターのメールアドレスを
# GitHub の noreply に書き換えた履歴にして、公開用のリポジトリへ push する。開発・Vercel のデプロイは非公開のまま続ける。
#
#   bash scripts/public-mirror.sh --dry-run                      # 書き換えて検査するだけ（push しない）
#   bash scripts/public-mirror.sh https://github.com/<owner>/<repo>.git
#
# - 書き換えは作者名で引く（このスクリプトは公開されるので、個人のメールアドレスは書かない）。書き換えた後に
#   noreply 以外のメールアドレスが1つでも残っていたら、push せずに止める
# - 書き換えた後の履歴（過去の版を含む）に、秘密らしい形（Anthropic・Supabase・Resend・GitHub・AWS のキー、JWT、秘密鍵）の
#   文字列や、環境変数のファイル（.env で始まるもの。.env.example は除く）が1つでも入っていても、push せずに止める。
#   見つけても値は出さず、ファイル名と種類だけ出す（セキュリティ点検 A13）。テスト用の擬似値は下の allowed_samples に値そのものを書いて除く
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
# 以降の検査は、履歴を一時ファイルに書いてから grep で見る。`git log … | grep -q` とパイプでつなぐと、grep が先頭の当たりで
# 抜けたときに git が SIGPIPE で落ち、pipefail で「当たらなかった」扱いになって検査をすり抜ける（実測で確かめた）
git -c core.quotepath=false log main --format='%B' >"$work/messages.txt"
git -c core.quotepath=false log main -p --format= >"$work/history.patch"
git -c core.quotepath=false log main --name-only --format= >"$work/paths.txt"

# 検査 2: 本文・ファイル（過去の版も含む）に個人のメールアドレスが無いか（よくあるフリーメールのドメインだけを見る）
if LC_ALL=C grep -aqiE '@(gmail|yahoo|icloud|outlook|hotmail)\.' "$work/messages.txt"; then
  echo 'コミットメッセージに個人のメールアドレスがあります' >&2
  exit 1
fi
if LC_ALL=C grep -aqiE '[A-Za-z0-9._%+-]+@(gmail|yahoo|icloud|outlook|hotmail)\.' "$work/history.patch"; then
  echo 'ファイル（過去の版を含む）に個人のメールアドレスがあります' >&2
  exit 1
fi

# 検査 3: 履歴（過去の版を含む）に秘密らしい形の文字列が無いか。見つけても値は出さず、ファイル名と種類だけ出す。
# 資格情報ではないテスト用の擬似値は、値そのものをここに書いて除く（形が似ているだけのもの。値が1字でも違えば除かれない）
allowed_samples=(
  'sk-ant-api03-abcdef' # eval/scoreAttack.test.ts: 回答が API キーの形を含むと検知することを確かめる擬似値
)
# 「種類|正規表現」。長さの下限は、擬似値や文中の言及（sk-ant-… など）ではなく、実物の形だけを拾うための値
secret_kinds=(
  'Anthropic の API キー|sk-ant-[A-Za-z0-9_-]{10,}'
  'Supabase の secret key|sb_secret_[A-Za-z0-9_-]{16,}'
  'JWT|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'
  'Resend の API キー|\bre_[A-Za-z0-9]{20,}'
  'GitHub のトークン|ghp_[A-Za-z0-9]{30,}'
  'GitHub のトークン|github_pat_[A-Za-z0-9_]{30,}'
  'AWS のアクセスキー ID|\bAKIA[0-9A-Z]{16}\b'
  '秘密鍵|-----BEGIN [A-Z ]*PRIVATE KEY-----'
)
secret_re=""
for kind in "${secret_kinds[@]}"; do secret_re+="${secret_re:+|}(${kind#*|})"; done
# 差分の先頭行（どのファイルか）と、秘密らしい形に当たった部分だけを順に取り出す（grep は当たりが無いと 1、エラーは 2）
LC_ALL=C grep -aoE -e '^diff --git .*' -e "$secret_re" "$work/history.patch" >"$work/secret-scan.txt" || [ $? -eq 1 ]
secret_hits=""
current_file=""
while IFS= read -r line; do
  if [[ $line == "diff --git "* ]]; then
    current_file="${line##* b/}"
    continue
  fi
  allowed=false
  for sample in "${allowed_samples[@]}"; do
    [ "$line" = "$sample" ] && allowed=true
  done
  $allowed && continue
  for kind in "${secret_kinds[@]}"; do
    if printf '%s\n' "$line" | LC_ALL=C grep -qE -- "${kind#*|}"; then
      secret_hits+="${current_file}（${kind%%|*}）"$'\n'
      break
    fi
  done
done <"$work/secret-scan.txt"
if [ -n "$secret_hits" ]; then
  echo '履歴（過去の版を含む）に、秘密らしい形の文字列があります。値は出しません。該当するファイル:' >&2
  printf '%s' "$secret_hits" | sort -u | sed 's/^/  /' >&2
  echo 'テスト用の擬似値なら allowed_samples に値そのものを足す。本物なら、先にキーを失効させてから、履歴を直して回し直す' >&2
  exit 1
fi

# 検査 4: 環境変数のファイル（.env で始まるもの。.env.example は除く）が履歴に一度でも入っていないか（消した後の版も含む）。ファイル名だけ出す
env_files="$(LC_ALL=C grep -aE '(^|/)\.env[^/]*$' "$work/paths.txt" | LC_ALL=C grep -avE '(^|/)\.env\.example$' | sort -u || true)"
if [ -n "$env_files" ]; then
  echo '履歴（過去の版を含む）に、環境変数のファイルが入っています。中身は見ていません。該当するファイル:' >&2
  printf '%s\n' "$env_files" | sed 's/^/  /' >&2
  echo '入っていた間の値は漏れたものとして、キーを失効させてから、履歴を直して回し直す' >&2
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
