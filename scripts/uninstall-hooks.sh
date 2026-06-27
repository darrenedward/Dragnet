#!/bin/sh
# dragnet uninstall-hooks
# Removes the pre-push hook from .git/hooks/ of the current repo.

set -e

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$REPO_ROOT" ]; then
  echo "Not inside a git repository."
  exit 1
fi

HOOK_DST="$REPO_ROOT/.git/hooks/pre-push"

if [ -f "$HOOK_DST" ]; then
  rm "$HOOK_DST"
  echo "✓ Dragnet pre-push hook removed from $HOOK_DST"
else
  echo "No Dragnet pre-push hook found at $HOOK_DST"
fi
