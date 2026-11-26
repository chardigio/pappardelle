#!/usr/bin/env bash
# Prints the environment for a test run that keeps its tmux off the user's own
# servers, as lines to eval: the test tmux guard first on
# PATH, a private TMUX_TMPDIR and no TMUX. Prints nothing without tmux, since
# the tmux tests then skip themselves.
#
# With --finish <refusal log> [--fail-on-leaks] [dir...], at the end of a run:
# stops every tmux server still running in the run's private TMUX_TMPDIR or
# under one of the extra dirs and names it, prints the refusals the log holds
# and those the shared log gained since setup, removes the private directory,
# and fails if there were refusals, or with --fail-on-leaks, servers. The extra
# dirs are left in place.
set -euo pipefail
# cd prints the directory it found through CDPATH, which would end up in the
# paths below.
CDPATH=''

private_prefix=/tmp/pt-

if [[ ${1:-} == --finish ]]; then
	refusals=${2:-}
	[[ -n $refusals ]] || exit 0
	private=${refusals%/*}
	# Everything under this directory is stopped and removed, so it has to be
	# one this script made. macOS reaches /tmp through /private/tmp.
	parent=${private%/*}
	if [[ ($parent != "${private_prefix%/*}" && $parent != /private"${private_prefix%/*}") || ${private##*/} != "${private_prefix##*/}"* ]]; then
		echo "tmux-guard-env.sh --finish: $refusals is not in a private TMUX_TMPDIR this script creates (${private_prefix}*)" >&2
		exit 1
	fi
	shift 2
	fail_on_leaks=''
	if [[ ${1:-} == --fail-on-leaks ]]; then
		fail_on_leaks=1
		shift
	fi
	# The extra dirs can be anything a caller names, /tmp included, so only the
	# guard may stop what is under them: the real tmux would reach the live
	# tmux directory.
	if [[ -z ${PAPPARDELLE_TEST_TMUX_GUARD:-} || ! $(type -P tmux) -ef $PAPPARDELLE_TEST_TMUX_GUARD/bin/tmux ]]; then
		echo "tmux-guard-env.sh --finish: the tmux on PATH ($(type -P tmux)) is not the test tmux guard (${PAPPARDELLE_TEST_TMUX_GUARD:-unset}/bin/tmux); put the run's PATH back" >&2
		exit 1
	fi
	status=0
	# Removing the private directory would leave such a server running with no
	# socket to reach it by.
	while IFS= read -r socket; do
		pids=$(tmux -S "$socket" list-panes -a -F '#{pane_pid}' 2>/dev/null) || continue
		# A pane shell that never got the terminal ignores the SIGHUP from
		# kill-server and keeps running as an orphan; one that exits leaves its
		# children to init, where they can no longer be found by parent.
		children=''
		for pid in $pids; do
			children="$children $(pgrep -P "$pid" 2>/dev/null || true)"
		done
		tmux -S "$socket" kill-server 2>/dev/null || true
		for pid in $pids $children; do
			kill -9 "$pid" 2>/dev/null || true
		done
		echo "Stopped a tmux server left running on $socket"
		[[ -z $fail_on_leaks ]] || status=1
	done < <(find "$private" "$@" -type s 2>/dev/null)
	# The guard writes here when a process lost the run's refusal log, as a
	# systemd timer's does. Other runs write here too, and each of their
	# refusals would also have reached the user's tmux.
	shared=''
	if [[ -n ${PAPPARDELLE_TEST_TMUX_GUARD:-} && -n ${PAPPARDELLE_TEST_TMUX_SHARED_START:-} ]]; then
		shared=$(tail -c "+$((PAPPARDELLE_TEST_TMUX_SHARED_START + 1))" -- "$PAPPARDELLE_TEST_TMUX_GUARD/refusals.log" 2>/dev/null || true)
	fi
	if [[ -s $refusals || -n $shared ]]; then
		echo "The test tmux guard refused tmux calls against the live tmux directory. Give each test its own TMUX_TMPDIR or a -S socket:"
		[[ ! -s $refusals ]] || cat -- "$refusals"
		[[ -z $shared ]] || printf '%s\n' "$shared"
		status=1
	fi
	rm -rf -- "$private"
	exit "$status"
fi

guard_home=/tmp/pappardelle-test-tmux-$(id -u)
wrapper=$guard_home/bin/tmux

real_tmux=''
while IFS= read -r candidate; do
	if [[ ! $candidate -ef $wrapper ]]; then
		real_tmux=$candidate
		break
	fi
done < <(type -ap tmux)
[[ -n $real_tmux ]] || exit 0

quote() {
	printf "'%s'" "${1//\'/\'\\\'\'}"
}

# A run started under another run (a test that runs a test script) keeps the
# outer run's wrapper, whose live tmux directory is the user's, not the outer
# run's private one. Such a run has the wrapper somewhere on PATH or one of
# those private directories as its TMUX_TMPDIR.
base=$(cd -P -- "${TMUX_TMPDIR:-/tmp}" 2>/dev/null && pwd -P) || base=$(cd -P /tmp && pwd -P)
# pwd -P keeps a leading //, which tmux resolves as /.
case $base in //*) base=/${base#//} ;; esac
nested=''
while IFS= read -r candidate; do
	[[ ! $candidate -ef $wrapper ]] || nested=1
done < <(type -ap tmux)
[[ $base != "$private_prefix"* && $base != /private"$private_prefix"* ]] || nested=1
if [[ -n $nested && ! -x $wrapper ]]; then
	echo "TMUX_TMPDIR=${TMUX_TMPDIR:-} is a test run's private directory, but there is no tmux guard at $wrapper to keep this run in it; unset TMUX_TMPDIR" >&2
	exit 1
fi
if [[ -z $nested ]]; then
	mkdir -m 700 "$guard_home" 2>/dev/null || true
	# Anyone can create a directory in /tmp, and this one holds code tests run.
	if [[ -L $guard_home || ! -O $guard_home ]]; then
		echo "$guard_home is a symlink or belongs to another user; remove it" >&2
		exit 1
	fi
	mkdir -p "$guard_home/bin"
	# Only ever added to: a run set up with the wrong TMUX_TMPDIR then makes
	# the guard refuse too much, which fails loudly, rather than stop guarding
	# the directory an earlier run found.
	live=$base/tmux-$(id -u)
	grep -qxF -- "$live" "$guard_home/live-dirs" 2>/dev/null || echo "$live" >>"$guard_home/live-dirs"
	# Never removed, and kept apart from the checkout: a server or daemon a
	# test started can outlive the run and its worktree and still call tmux.
	next=$(mktemp "$guard_home/.guard.XXXXXX")
	cp -- "$(dirname -- "${BASH_SOURCE[0]}")/tmux-guard.sh" "$next"
	mv -f -- "$next" "$guard_home/tmux-guard.sh"
	next=$(mktemp "$guard_home/bin/.tmux.XXXXXX")
	{
		echo '#!/bin/sh'
		echo "guard_real_tmux=$(quote "$real_tmux")"
		echo "guard_live_dirs=$(quote "$guard_home/live-dirs")"
		echo "guard_shared_log=$(quote "$guard_home/refusals.log")"
		echo ". $(quote "$guard_home/tmux-guard.sh")"
	} >"$next"
	chmod 755 "$next"
	mv -f "$next" "$wrapper"
fi

private=$(mktemp -d "${private_prefix}XXXXXX")
echo "export PATH=$(quote "$guard_home/bin:$PATH")"
echo "export TMUX_TMPDIR=$(quote "$private")"
echo "export PAPPARDELLE_TEST_TMUX_GUARD=$(quote "$guard_home")"
echo "export PAPPARDELLE_TEST_TMUX_REFUSALS=$(quote "$private/refusals.log")"
shared_start=0
[[ ! -f $guard_home/refusals.log ]] || shared_start=$(wc -c <"$guard_home/refusals.log" | tr -d ' ')
echo "export PAPPARDELLE_TEST_TMUX_SHARED_START=$(quote "$shared_start")"
echo 'unset TMUX TMUX_PANE'
