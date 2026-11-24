# shellcheck shell=sh
# The test tmux guard (docs/glossary.md). Sourced by the tmux wrapper that
# tmux-guard-env.sh writes, which sets guard_real_tmux, guard_live_dirs (a file
# listing each live tmux directory a run has found) and guard_shared_log first. Some tests run tmux with a PATH holding nothing but
# tmux, so this uses shell builtins only, and it never cds in its own shell
# because tmux resolves relative -S paths and start directories from the cwd.

if [ -z "${guard_real_tmux:-}" ] || ! [ -s "${guard_live_dirs:-}" ]; then
	printf '%s\n' "tmux guard: the wrapper did not say which tmux to run or which directories to keep tests out of; rerun test/helpers/tmux-guard-env.sh" >&2
	exit 1
fi

guard_refuse() {
	guard_socket=$1
	shift
	guard_msg="refusing to run tmux against the live tmux directory ($guard_socket): tmux $*"
	printf '%s\n' "$guard_msg" >&2
	# Teardowns often discard tmux's exit status, so the test run reads this
	# log to fail on a refusal.
	printf '%s\n' "$guard_msg" >>"${PAPPARDELLE_TEST_TMUX_REFUSALS:-$guard_shared_log}"
	exit 1
}

# pwd -P keeps a leading //, which tmux resolves as /.
guard_resolve_dir() {
	guard_resolved=$(CDPATH='' cd -P -- "$1" 2>/dev/null && pwd -P) || return 1
	case $guard_resolved in
	//*) printf '%s\n' "/${guard_resolved#//}" ;;
	*) printf '%s\n' "$guard_resolved" ;;
	esac
}

# The last -S and the last -L win, any -S beats -L, and parsing stops at the
# command, as in tmux's own getopt over "2c:CDdf:lL:NqS:T:uUvV".
guard_S=''
guard_L=''
guard_want=''
for guard_arg in "$@"; do
	if [ -n "$guard_want" ]; then
		if [ "$guard_want" = S ]; then guard_S=$guard_arg; elif [ "$guard_want" = L ]; then guard_L=$guard_arg; fi
		guard_want=''
		continue
	fi
	case $guard_arg in
	--) break ;;
	-?*) ;;
	*) break ;;
	esac
	guard_rest=${guard_arg#-}
	while [ -n "$guard_rest" ]; do
		guard_opt=${guard_rest%"${guard_rest#?}"}
		guard_rest=${guard_rest#?}
		case $guard_opt in
		c | f | L | S | T)
			if [ -z "$guard_rest" ]; then
				guard_want=$guard_opt
			elif [ "$guard_opt" = S ]; then
				guard_S=$guard_rest
			elif [ "$guard_opt" = L ]; then
				guard_L=$guard_rest
			fi
			guard_rest=''
			;;
		esac
	done
done

# tmux falls back to /tmp when TMUX_TMPDIR is unset or can't be resolved.
guard_base=$(guard_resolve_dir "${TMUX_TMPDIR:-/tmp}") || guard_base=$(guard_resolve_dir /tmp)
guard_socket=''
if [ -n "$guard_S" ]; then
	guard_socket=$guard_S
elif [ -z "$guard_L" ]; then
	case ${TMUX:-,} in
	,*) guard_L=default ;;
	*) guard_socket=${TMUX%%,*} ;;
	esac
fi
if [ -n "$guard_socket" ]; then
	case $guard_socket in
	*/*) guard_dir=${guard_socket%/*} ;;
	*) guard_dir=. ;;
	esac
	guard_dir=$(guard_resolve_dir "${guard_dir:-/}")
fi

while IFS= read -r guard_live; do
	[ -n "$guard_live" ] || continue
	if [ -n "$guard_socket" ]; then
		[ "$guard_dir" != "$guard_live" ] || guard_refuse "$guard_socket" "$@"
		continue
	fi
	guard_named_dir=$guard_base/tmux-${guard_live##*/tmux-}
	case $guard_L in
	# tmux joins the name onto the directory as given, so a / in it can lead
	# somewhere else. tmux creates that directory first, so one that doesn't
	# exist yet can't be followed here and is refused too.
	*/*)
		guard_named=$guard_named_dir/$guard_L
		guard_named_parent=$(guard_resolve_dir "${guard_named%/*}") || guard_refuse "$guard_named" "$@"
		[ "$guard_named_parent" != "$guard_live" ] || guard_refuse "$guard_named" "$@"
		;;
	*) [ "$guard_named_dir" != "$guard_live" ] || guard_refuse "$guard_live/$guard_L" "$@" ;;
	esac
done <"$guard_live_dirs"

exec "$guard_real_tmux" "$@"
