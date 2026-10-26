#!/usr/bin/env bash
# Manage git visibility of src/ui while it is a frontend symlink.
#   skip   — hide linked frontend content from git status (skip-worktree + exclude symlink)
#   unskip — allow committing the real src/ui directory again
#   install-hooks — install pre-commit that blocks commits while src/ui is a symlink
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

cmd="${1:-}"
EXCLUDE_MARK="src/ui"
EXCLUDE_COMMENT="# axi: ignore src/ui while it is a frontend symlink"

ui_files() {
	git ls-files -z -- src/ui 2>/dev/null || true
}

exclude_path() {
	git rev-parse --git-path info/exclude
}

add_exclude() {
	local exclude
	exclude="$(exclude_path)"
	mkdir -p "$(dirname "$exclude")"
	touch "$exclude"
	if grep -qxF "$EXCLUDE_MARK" "$exclude" 2>/dev/null; then
		return 0
	fi
	printf '\n%s\n%s\n' "$EXCLUDE_COMMENT" "$EXCLUDE_MARK" >>"$exclude"
}

remove_exclude() {
	local exclude tmp
	exclude="$(exclude_path)"
	[ -f "$exclude" ] || return 0
	tmp="$(mktemp)"
	# Drop our mark line and the immediately preceding axi comment (if present).
	awk -v mark="$EXCLUDE_MARK" -v comment="$EXCLUDE_COMMENT" '
		$0 == comment { next }
		$0 == mark { next }
		{ print }
	' "$exclude" >"$tmp"
	mv "$tmp" "$exclude"
}

case "$cmd" in
	skip)
		files=()
		while IFS= read -r -d '' f; do
			files+=("$f")
		done < <(ui_files)
		if [ "${#files[@]}" -gt 0 ]; then
			git update-index --skip-worktree -- "${files[@]}"
		fi
		add_exclude
		;;
	unskip)
		files=()
		while IFS= read -r -d '' f; do
			files+=("$f")
		done < <(ui_files)
		if [ "${#files[@]}" -gt 0 ]; then
			git update-index --no-skip-worktree -- "${files[@]}"
		fi
		remove_exclude
		;;
	install-hooks)
		if ! git rev-parse --git-dir >/dev/null 2>&1; then
			echo "ui-git-state: not a git checkout — skip hook install"
			exit 0
		fi
		hooks_dir="$(git rev-parse --git-path hooks)"
		mkdir -p "$hooks_dir"
		cp "$ROOT/scripts/githooks/pre-commit" "$hooks_dir/pre-commit"
		chmod +x "$hooks_dir/pre-commit"
		echo "ui-git-state: installed pre-commit hook → $hooks_dir/pre-commit"
		;;
	*)
		echo "usage: $0 skip|unskip|install-hooks" >&2
		exit 2
		;;
esac
