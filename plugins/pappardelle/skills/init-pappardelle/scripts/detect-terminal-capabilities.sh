#!/usr/bin/env bash
# Probe the outermost terminal for the capabilities Step 4.ii offers to pass
# through, and print them as a single space-separated key=value line.
#
# $TERM inside tmux is what tmux advertises to inner apps, and in a Pappardelle
# pane this server's client is itself a nested tmux, so #{client_termname} here
# is another tmux TERM. Walk out via each client's own $TMUX until the termname
# belongs to a real terminal.
set -uo pipefail

outer="$TERM"
if [ -n "${TMUX:-}" ]; then
  sock=${TMUX%%,*}
  hops=0
  while [ "$hops" -lt 5 ]; do
    name=$(tmux -S "$sock" display -p '#{client_termname}' 2>/dev/null) || break
    [ -n "$name" ] || break
    outer="$name"
    case "$outer" in
      screen* | tmux*) ;;
      *) break ;;
    esac
    cpid=$(tmux -S "$sock" display -p '#{client_pid}' 2>/dev/null) || break
    up=$(ps eww -p "$cpid" 2>/dev/null | tr ' ' '\n' | sed -n 's/^TMUX=//p' | head -1)
    [ -n "$up" ] || break
    sock=${up%%,*}
    hops=$((hops + 1))
  done
fi

sync_ok=no
if infocmp -x "$outer" 2>/dev/null | grep -q 'Sync='; then
  sync_ok=yes
else
  # Some terminfo entries shipped by the OS lag the terminal's real support
  case "$outer" in
    *ghostty* | *kitty* | *wezterm* | foot* | *alacritty* | contour* | rio*) sync_ok=yes ;;
  esac
fi

rgb_ok=no
if infocmp -x "$outer" 2>/dev/null | grep -qE '\b(Tc|RGB)\b'; then
  rgb_ok=yes
elif [ "${COLORTERM:-}" = truecolor ] || [ "${COLORTERM:-}" = 24bit ]; then
  rgb_ok=yes
fi

ver=$(tmux -V | sed 's/[^0-9.]//g')
[ "$(printf '%s\n3.2\n' "$ver" | sort -V | head -1)" = "3.2" ] && tmux_ok=yes || tmux_ok=no
infocmp tmux-256color > /dev/null 2>&1 && ti_ok=yes || ti_ok=no
infocmp -x "$outer" 2>/dev/null | grep -q 'Smulx=' && usstyle_ok=yes || usstyle_ok=no

printf 'TERM=%s tmux_ok=%s(%s) sync_ok=%s rgb_ok=%s ti_ok=%s usstyle_ok=%s\n' \
  "$outer" "$tmux_ok" "$ver" "$sync_ok" "$rgb_ok" "$ti_ok" "$usstyle_ok"
