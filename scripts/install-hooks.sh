#!/bin/sh
# dragnet install-hooks
# Installs the pre-push hook into .git/hooks/ of the current repo.

set -e

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$REPO_ROOT" ]; then
  echo "Not inside a git repository."
  exit 1
fi

HOOK_SRC="$(dirname "$0")/hooks/pre-push"
HOOK_DST="$REPO_ROOT/.git/hooks/pre-push"

if [ ! -f "$HOOK_SRC" ]; then
  echo "Error: hook source not found at $HOOK_SRC"
  exit 1
fi

cp "$HOOK_SRC" "$HOOK_DST"
chmod +x "$HOOK_DST"
echo "✓ Dragnet pre-push hook installed at $HOOK_DST"
echo "  Pushes to non-default branches will now be reviewed by Dragnet."
echo "  Bypass with: git push --no-verify"
