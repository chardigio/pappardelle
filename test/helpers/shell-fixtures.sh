# shellcheck shell=bash
# Temp directories, config layers, polling and the tmux guard for the
# scripts/test-*.sh that need them. Sourced, so it sets no shell options.
# macOS runs these scripts with its /bin/bash 3.2.

SHELL_FIXTURES_HELPERS=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
SHELL_FIXTURES_ROOT=''

# test_tmpdir VAR: sets VAR to a new empty directory, removed with every other
# one when the script exits. Call it as a statement: in a command substitution
# the exit trap would be installed in the subshell and lost.
test_tmpdir() {
	if [[ -z "$SHELL_FIXTURES_ROOT" ]]; then
		SHELL_FIXTURES_ROOT=$(mktemp -d)
		trap 'rm -rf "$SHELL_FIXTURES_ROOT"' EXIT
		# bash skips the EXIT trap when a signal kills it.
		trap 'exit 130' INT
		trap 'exit 143' TERM
	fi
	local dir
	dir=$(mktemp -d "$SHELL_FIXTURES_ROOT/XXXXXX")
	printf -v "$1" '%s' "$dir"
}

# write_config_layers <project yaml> [local yaml] [home yaml]: writes the three
# config layers into a new TMPDIR_ROOT and sets CONFIG_LAYER_ARGS to the
# --config, --local-config and --home-config arguments the resolvers take. An
# empty local or home yaml leaves that layer missing.
write_config_layers() {
	test_tmpdir TMPDIR_ROOT
	mkdir -p "$TMPDIR_ROOT/home"
	CONFIG_LAYER_ARGS=(
		--config "$TMPDIR_ROOT/.pappardelle.yml"
		--local-config "$TMPDIR_ROOT/.pappardelle.local.yml"
		--home-config "$TMPDIR_ROOT/home/.pappardelle.yml"
	)
	printf '%s\n' "$1" >"${CONFIG_LAYER_ARGS[1]}"
	if [[ -n "${2:-}" ]]; then
		printf '%s\n' "$2" >"${CONFIG_LAYER_ARGS[3]}"
	fi
	if [[ -n "${3:-}" ]]; then
		printf '%s\n' "$3" >"${CONFIG_LAYER_ARGS[5]}"
	fi
}

# wait_until cmd...: runs cmd every 0.1 s until it succeeds, for up to 15 s.
# A command typed into a tmux pane runs in an interactive shell that sources
# the user's rc files first, so a fixed sleep is flaky under load.
wait_until() {
	local _
	for _ in $(seq 1 150); do
		"$@" && return 0
		sleep 0.1
	done
	return 1
}

# run_under_tmux_guard "$0" "$@": runs the script again under
# test/helpers/tmux-guard-run.sh, unless it already runs under the guard or
# there is no tmux.
run_under_tmux_guard() {
	if [[ -z "${PAPPARDELLE_TEST_TMUX_REFUSALS:-}" ]] && command -v tmux >/dev/null 2>&1; then
		exec "$SHELL_FIXTURES_HELPERS/tmux-guard-run.sh" "$@"
	fi
}
