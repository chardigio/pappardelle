#!/bin/sh
# A program that resumes the way the spec's resume-wrap does: it reports
# itself to its terminal, records what it was started with, and waits.
#
#   program-resume-fixture.sh <out-dir> <name> [args...]
#
# Writes <out-dir>/<name>.argv (NUL-separated), .cwd and .token, then reports
# the command that starts it again with the same arguments.
out=$1
name=$2
printf '%s\0' "$@" > "$out/$name.argv.tmp" && mv "$out/$name.argv.tmp" "$out/$name.argv"
pwd > "$out/$name.cwd"
printf '%s' "${OSC7577_TOKEN:-}" > "$out/$name.token"
if [ -n "${OSC7577_TOKEN:-}" ]; then
  args=$(for a in "$0" "$@"; do printf '%s' "$a" | base64 | tr -d '\n'; echo; done | paste -sd, -)
  cwd=$(pwd | tr -d '\n' | base64 | tr -d '\n')
  body=$(printf 'pid=%s:time=%s:argv=%s:cwd=%s' "$$" "$(date +%s)" "$args" "$cwd")
  mac=$(printf '%s:%s' "$body" "$OSC7577_TOKEN" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-64)
  # shellcheck disable=SC1003 # ST is ESC and a backslash
  printf '\033]7577;%s:mac=%s\033\\' "$body" "$mac"
fi
unset OSC7577_TOKEN
printf '%s\n' "$$" > "$out/$name.pid"
exec sleep 600
