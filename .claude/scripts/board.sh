#!/usr/bin/env bash
# Move an issue's card on the GitHub Project board (adds the issue if missing).
#
#   bash .claude/scripts/board.sh <issue-number> "<Status>"
#   bash .claude/scripts/board.sh check        # list the board's status options
#
# Config: .claude/github-project.env   Needs: gh with the "project" scope.
set -euo pipefail

CLAUDE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
source "$CLAUDE_DIR/github-project.env"

: "${GH_OWNER:?Set GH_OWNER in .claude/github-project.env}"
: "${GH_PROJECT_NUMBER:?Set GH_PROJECT_NUMBER in .claude/github-project.env}"
STATUS_FIELD="${GH_STATUS_FIELD:-Status}"

die() { echo "board.sh: $*" >&2; exit 1; }

fields() {
  gh project field-list "$GH_PROJECT_NUMBER" --owner "$GH_OWNER" --format json --jq "$1"
}

field_id="$(fields ".fields[] | select(.name == \"$STATUS_FIELD\") | .id")"
[ -n "$field_id" ] || die "field '$STATUS_FIELD' not found on project $GH_PROJECT_NUMBER"

if [ "${1:-}" = "check" ]; then
  echo "Status options on project $GH_PROJECT_NUMBER ($STATUS_FIELD):"
  fields ".fields[] | select(.name == \"$STATUS_FIELD\") | .options[].name" | sed 's/^/  - /'
  exit 0
fi

issue="${1:-}"; status="${2:-}"
[[ "$issue" =~ ^[0-9]+$ ]] || die "usage: board.sh <issue-number> \"<Status>\" | check"
[ -n "$status" ] || die "missing status name"

option_id="$(fields ".fields[] | select(.name == \"$STATUS_FIELD\") | .options[] | select(.name == \"$status\") | .id")"
[ -n "$option_id" ] || die "status '$status' is not a column on the board (run: board.sh check)"

project_id="$(gh project view "$GH_PROJECT_NUMBER" --owner "$GH_OWNER" --format json --jq '.id')"
issue_url="$(gh issue view "$issue" --json url --jq '.url')"

item_id="$(gh project item-list "$GH_PROJECT_NUMBER" --owner "$GH_OWNER" --limit 1000 --format json \
  --jq ".items[] | select(.content.url == \"$issue_url\") | .id" | head -n 1)"

if [ -z "$item_id" ]; then
  item_id="$(gh project item-add "$GH_PROJECT_NUMBER" --owner "$GH_OWNER" --url "$issue_url" --format json --jq '.id')"
  echo "Added #$issue to project $GH_PROJECT_NUMBER"
fi

gh project item-edit --id "$item_id" --project-id "$project_id" \
  --field-id "$field_id" --single-select-option-id "$option_id" > /dev/null

echo "#$issue -> $status"
