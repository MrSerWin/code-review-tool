#!/bin/sh
set -eu

if [ -z "${GH_TOKEN:-}" ]; then
  echo "code-review sandbox: GH_TOKEN required" >&2
  exit 64
fi

if [ -z "${GITHUB_ORG:-}" ]; then
  echo "code-review sandbox: GITHUB_ORG required" >&2
  exit 64
fi

: "${HOME:=/home/reviewer}"

# Refuse any remote that is not https://github.com/$GITHUB_ORG/...
for arg in "$@"; do
  case "$arg" in
    *://*)
      case "$arg" in
        "https://github.com/$GITHUB_ORG/"*) ;;
        *)
          echo "code-review sandbox: refusing remote outside github.com/$GITHUB_ORG: $arg" >&2
          exit 65
          ;;
      esac
      ;;
    *@*:*)
      echo "code-review sandbox: refusing scp-style remote: $arg" >&2
      exit 65
      ;;
    *github.com*)
      case "$arg" in
        "github.com/$GITHUB_ORG/"*) ;;
        *)
          echo "code-review sandbox: refusing host reference: $arg" >&2
          exit 65
          ;;
      esac
      ;;
  esac
done

export GIT_TERMINAL_PROMPT=0
export GIT_CONFIG_GLOBAL="$HOME/.gitconfig"

cat > "$GIT_CONFIG_GLOBAL" <<GITCFG
[user]
	name = code-review-bot
	email = review-bot@local.invalid
[safe]
	directory = *
[credential "https://github.com"]
	helper = "!f(){ echo username=x-access-token; echo password=\$GH_TOKEN; };f"
[advice]
	detachedHead = false
GITCFG

exec "$@"
