#!/usr/bin/env bash
# Runs a test suite that runs outside scripts/unit-tests.ts (integration-tests,
# pytest, scripts/test-*.sh) under the test tmux guard: the guard first on
# PATH, a private TMUX_TMPDIR and no TMUX. Fails when the guard refused a tmux
# call, even one the suite swallowed, and when a suite that passed left a tmux
# server running in the private TMUX_TMPDIR.
#
# Usage: test/helpers/tmux-guard-run.sh command [args...]
set -euo pipefail
CDPATH=''

if (($# == 0)); then
	echo "usage: $0 command [args...]" >&2
	exit 2
fi
helpers=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

guard_env=$(env -u TMUX -u TMUX_PANE "$helpers/tmux-guard-env.sh")
# Without tmux the guard sets nothing up and the tmux tests skip themselves.
if [[ -z $guard_env ]]; then
	exec "$@"
fi

status=0
# shellcheck disable=SC2329 # invoked by the EXIT trap
finish() {
	# A suite that failed stops before its own cleanup, so what it left says
	# nothing about it.
	local fail_on_leaks=''
	((status)) || fail_on_leaks=--fail-on-leaks
	if ! "$helpers/tmux-guard-env.sh" --finish "$PAPPARDELLE_TEST_TMUX_REFUSALS" ${fail_on_leaks:+"$fail_on_leaks"} >&2 && ((status == 0)); then
		status=1
	fi
	exit "$status"
}
eval "$guard_env"
trap finish EXIT
# bash skips the EXIT trap when a signal kills it.
trap 'status=130; exit' INT
trap 'status=143; exit' TERM

"$@" || status=$?
