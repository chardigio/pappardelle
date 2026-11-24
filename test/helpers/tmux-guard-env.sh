#!/usr/bin/env bash
# Prints the environment for a test run that keeps its tmux off the user's own
# servers, as lines to eval: the test tmux guard (docs/glossary.md) first on
# PATH, a private TMUX_TMPDIR and no TMUX. Prints nothing without tmux, since
# the tmux tests then skip themselves.
set -euo pipefail
# cd prints the directory it found through CDPATH, which would end up in the
# paths below.
CDPATH=''

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
[[ $base != /tmp/pt-* && $base != /private/tmp/pt-* ]] || nested=1
if [[ -n $nested && ! -x $wrapper ]]; then
	echo "TMUX_TMPDIR=$TMUX_TMPDIR is a test run's private directory, but there is no tmux guard at $wrapper to keep this run in it; unset TMUX_TMPDIR" >&2
	exit 1
fi
if [[ -z $nested ]]; then
	guard=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/tmux-guard.sh
	mkdir -m 700 "$guard_home" 2>/dev/null || true
	# Anyone can create a directory in /tmp, and this one holds code tests run.
	if [[ ! -O $guard_home ]]; then
		echo "$guard_home belongs to another user; remove it" >&2
		exit 1
	fi
	mkdir -p "$guard_home/bin"
	# Only ever added to: a run set up with the wrong TMUX_TMPDIR then makes
	# the guard refuse too much, which fails loudly, rather than stop guarding
	# the directory an earlier run found.
	live=$base/tmux-$(id -u)
	grep -qxF -- "$live" "$guard_home/live-dirs" 2>/dev/null || echo "$live" >>"$guard_home/live-dirs"
	# Never removed: a server or daemon a test started can outlive the run and
	# still call tmux.
	next=$(mktemp "$guard_home/bin/.tmux.XXXXXX")
	{
		echo '#!/bin/sh'
		echo "guard_real_tmux=$(quote "$real_tmux")"
		echo "guard_live_dirs=$(quote "$guard_home/live-dirs")"
		echo "guard_shared_log=$(quote "$guard_home/refusals.log")"
		echo ". $(quote "$guard")"
	} >"$next"
	chmod 755 "$next"
	mv -f "$next" "$wrapper"
fi

private=$(mktemp -d /tmp/pt-XXXXXX)
echo "export PATH=$(quote "$guard_home/bin:$PATH")"
echo "export TMUX_TMPDIR=$(quote "$private")"
echo "export PAPPARDELLE_TEST_TMUX_REFUSALS=$(quote "$private/refusals.log")"
echo 'unset TMUX TMUX_PANE'
