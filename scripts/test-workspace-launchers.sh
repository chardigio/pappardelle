#!/bin/bash

# Test: the three workspace launchers emit identical command lines
#
# open-iterm-agent.sh, open-ghostty-agent.sh and open-default-terminal-agent.sh
# each assemble the same agent and companion pane command lines. The two
# AppleScript launchers build theirs inside osascript, out of reach of a shared
# bash helper, and the default-terminal launcher has no AppleScript at all, so
# the assembly exists three times. For identical inputs all three must emit
# identical bytes.
#
# The AppleScript pair assemble inside osascript, so --print-command runs the
# real thing rather than a bash-side reimplementation. osascript is macOS-only,
# so CI runs only the portable tests that precede it: prompt and worktree path
# quoting, and the viewer rebuild, which needs tmux.
#
# Usage: ./scripts/test-workspace-launchers.sh (it puts itself under
# test/helpers/tmux-guard-run.sh)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=SCRIPTDIR/../test/helpers/shell-asserts.sh
source "$SCRIPT_DIR/../test/helpers/shell-asserts.sh"
# shellcheck source=SCRIPTDIR/../test/helpers/shell-fixtures.sh
source "$SCRIPT_DIR/../test/helpers/shell-fixtures.sh"
run_under_tmux_guard "$0" "$@"

# idow exports the space's socket from `pappardelle space get`.
export PAPPARDELLE_TMUX_SOCKET=pappardelle_inner

# Runs anywhere: the default-terminal agent line, executed with tmux swapped
# for sh, hands agy the prompt as one literal word through both shell parses,
# behind -i with prompt_args and as a bare word without.
# shellcheck disable=SC2016 # the $ signs are the prompt's own text
PROMPT_RAW='/idow it'"'"'s "q" $HOME $(touch PWNED) `touch PWNED` \\n & x'
for prompt_args in "-i {prompt}" ""; do
    section "prompt survives both shell parses (prompt_args [$prompt_args])"
    test_tmpdir PROMPT_TMP
    mkdir -p "$PROMPT_TMP/bin"
    cat > "$PROMPT_TMP/bin/agy" <<SHIM
#!/bin/bash
printf '<%s>' "\$@" >> "$PROMPT_TMP/argv"
printf '\n' >> "$PROMPT_TMP/argv"
[[ "\$*" == *RESUME_FAIL* ]] && exit 1
exit 0
SHIM
    chmod +x "$PROMPT_TMP/bin/agy"
    PROMPT_TEXT=${PROMPT_RAW//PWNED/$PROMPT_TMP/pwned}
    PROMPT_LINE=$("$SCRIPT_DIR/open-default-terminal-agent.sh" --worktree "$PROMPT_TMP" --issue-key QA-1 \
        --repo-name testrepo --agent-session agent-testrepo-QA-1 --companion-session companion-testrepo-QA-1 \
        --companion-command "" --prompt "$PROMPT_TEXT" --agent-command agy \
        --agent-is-claude false --agent-launch-flags "--model m1" --agent-resume-args "--conversation RESUME_FAIL" \
        --agent-prompt-args "$prompt_args" --print-command | head -1)
    # shellcheck disable=SC2001 # a regex replace over one line
    RUNNABLE=$(sed -E "s#tmux -L [^ ]+ new-session -A -s '[^']*'( -e \"[^\"]*\")* #sh -c #" <<< "$PROMPT_LINE")
    PATH="$PROMPT_TMP/bin:$PATH" sh -c "$RUNNABLE" >/dev/null 2>&1 || true
    PROMPT_ARGV="${prompt_args:+<-i>}<$PROMPT_TEXT>"
    assert_eq "resume attempt" "<--model><m1><--conversation><RESUME_FAIL>$PROMPT_ARGV" "$(sed -n 1p "$PROMPT_TMP/argv")"
    assert_eq "fresh launch" "<--model><m1>$PROMPT_ARGV" "$(sed -n 2p "$PROMPT_TMP/argv")"
    assert_eq "nothing in the prompt ran" "no" "$([[ -e "$PROMPT_TMP/pwned" ]] && echo yes || echo no)"
done

# Runs anywhere: both default-terminal pane lines, executed with tmux swapped
# for a shim, cd into a worktree whose path holds quotes and a $(), title the
# pane with the key and name the sessions it is given, quotes and all, and
# claude gets the key as one --name word, without running any of the inputs.
section "worktree path, repo name and key survive the pane shell"
test_tmpdir PATH_TMP
mkdir -p "$PATH_TMP/bin"
PATH_WT="$PATH_TMP/o'brien \$(touch $PATH_TMP/pwned) it's \"wt\""
mkdir -p "$PATH_WT"
# shellcheck disable=SC2016 # the $ signs are the key's own text
PATH_KEY='QA-%s '"'"'x'"'"' $(touch pwned) "q"'
cat > "$PATH_TMP/bin/tmux" <<SHIM
#!/bin/bash
printf '%s\n' "\$PWD" >> "$PATH_TMP/pwd"
printf '%s\n' "\$6" >> "$PATH_TMP/session"
(( \$# > 6 )) && printf '%s' "\${@: -1}" > "$PATH_TMP/agent-command"
exit 0
SHIM
cat > "$PATH_TMP/bin/claude" <<SHIM
#!/bin/bash
printf '<%s>' "\$@" >> "$PATH_TMP/argv"
printf '\n' >> "$PATH_TMP/argv"
[[ "\$*" == *--continue* ]] && exit 1
exit 0
SHIM
chmod +x "$PATH_TMP/bin/tmux" "$PATH_TMP/bin/claude"
{ read -r AGENT_PANE_LINE; read -r COMPANION_PANE_LINE; } < <("$SCRIPT_DIR/open-default-terminal-agent.sh" \
    --worktree "$PATH_WT" --issue-key "$PATH_KEY" --repo-name "bob's dad's app" \
    --agent-session "agent-bob's dad's app-$PATH_KEY" --companion-session "companion-bob's dad's app-$PATH_KEY" \
    --companion-command "" --prompt "" --print-command)
PATH_TITLE=$(printf '\033]0;%s\007' "$PATH_KEY")
# Run from $PATH_TMP so anything that runs before the line's cd lands where the
# last check looks, not in the checkout.
assert_eq "agent pane is titled with the key" "$PATH_TITLE" \
    "$(cd "$PATH_TMP" && PATH="$PATH_TMP/bin:$PATH" bash -c "$AGENT_PANE_LINE" 2>&1)"
assert_eq "companion pane is titled with the key" "$PATH_TITLE" \
    "$(cd "$PATH_TMP" && PATH="$PATH_TMP/bin:$PATH" bash -c "$COMPANION_PANE_LINE" 2>&1)"
assert_eq "both panes start in the worktree" "$PATH_WT"$'\n'"$PATH_WT" "$(cat "$PATH_TMP/pwd" 2>/dev/null)"
assert_eq "sessions get the names they are given" \
    "agent-bob's dad's app-$PATH_KEY"$'\n'"companion-bob's dad's app-$PATH_KEY" \
    "$(cat "$PATH_TMP/session" 2>/dev/null)"
# tmux runs the session command through sh -c in the worktree.
(cd "$PATH_WT" && PATH="$PATH_TMP/bin:$PATH" sh -c "$(cat "$PATH_TMP/agent-command" 2>/dev/null)" >/dev/null 2>&1) || true
assert_eq "claude gets the key as one --name word" \
    "<--name><$PATH_KEY><--continue>"$'\n'"<--name><$PATH_KEY>" "$(cat "$PATH_TMP/argv" 2>/dev/null)"
assert_eq "nothing in the inputs ran" "no" \
    "$([[ -e "$PATH_TMP/pwned" || -e "$PATH_WT/pwned" ]] && echo yes || echo no)"

# The names come from the space's stored identity, so a launcher attaches to
# what it is given, even a name that agent-<repo>-<key> would never spell.
section "the default-terminal launcher attaches to the names it is given"
NAMED_LINES=$("$SCRIPT_DIR/open-default-terminal-agent.sh" --worktree /tmp/wt --issue-key QA-1 \
    --repo-name testrepo --agent-session hand.named_agent --companion-session hand-named_companion \
    --prompt "" --print-command)
assert_eq "agent pane" "1" "$(sed -n 1p <<< "$NAMED_LINES" | grep -c "new-session -A -s 'hand.named_agent'" || true)"
assert_eq "companion pane" "1" "$(sed -n 2p <<< "$NAMED_LINES" | grep -c "new-session -A -s 'hand-named_companion'" || true)"

# Runs anywhere with tmux: the generated .command, run against a private tmux
# server, rebuilds a viewer that lost a pane inside the same session. Killing
# the viewer and creating it again can empty the user's default server, and a
# new-session that reaches a server on its way out fails with it.
section "the default-terminal viewer is rebuilt in place"
test_tmpdir VIEW_TMP
REAL_TMUX=$(command -v tmux)
mkdir -p "$VIEW_TMP/bin" "$VIEW_TMP/home" "$VIEW_TMP/wt"
cat > "$VIEW_TMP/bin/tmux" <<SHIM
#!/bin/bash
# The panes' attach to the inner server is recorded and stood in for by a sleep.
if [[ "\$1" == -L ]]; then printf '%s\n' "\$*" >> "$VIEW_TMP/inner"; exec sleep 600; fi
# attach needs a terminal.
[[ "\$1" == attach ]] && exit 0
exec env -u TMUX -u TMUX_PANE "$REAL_TMUX" -f /dev/null -S "$TMUX_TMPDIR/view" "\$@"
SHIM
cat > "$VIEW_TMP/bin/open" <<'SHIM'
#!/bin/bash
exec bash "$1"
SHIM
chmod +x "$VIEW_TMP/bin/tmux" "$VIEW_TMP/bin/open"
vrun() { HOME="$VIEW_TMP/home" PATH="$VIEW_TMP/bin:$PATH" SHELL=/bin/sh PAPPARDELLE_TMUX_SOCKET=view_inner "$@"; }
vtmux() { vrun tmux "$@"; }
open_viewer() {
    vrun "$SCRIPT_DIR/open-default-terminal-agent.sh" --worktree "$VIEW_TMP/wt" --issue-key QA-1 \
        --repo-name testrepo --agent-session agent-testrepo-QA-1 --companion-session companion-testrepo-QA-1 \
        --companion-command "" --prompt "" >/dev/null 2>&1 || true
}
VIEWER="=pappardelle-view-testrepo-QA-1:"
vtmux new-session -d -s pappardelle-view-testrepo-QA-1 "sleep 600"
BEFORE=$(vtmux display-message -p -t "$VIEWER" '#{pid} #{session_id}')
open_viewer
assert_eq "the last session on the server is the same one afterwards" "$BEFORE" \
    "$(vtmux display-message -p -t "$VIEWER" '#{pid} #{session_id}' 2>/dev/null)"
assert_eq "it has the agent and companion panes" "2" "$(vtmux list-panes -t "$VIEWER" 2>/dev/null | wc -l | tr -d ' ')"
# shellcheck disable=SC2329  # invoked through wait_until
both_panes_attached() { [[ "$(grep -c '' "$VIEW_TMP/inner" 2>/dev/null)" == 2 ]]; }
wait_until both_panes_attached || true
assert_eq "both panes attach to the inner sessions" \
    "-L view_inner new-session -A -s agent-testrepo-QA-1"$'\n'"-L view_inner new-session -A -s companion-testrepo-QA-1" \
    "$(cut -d' ' -f1-6 "$VIEW_TMP/inner" 2>/dev/null | sort)"
assert_eq "the agent pane is the active one" "1" \
    "$(vtmux display-message -p -t "$VIEWER" '#{pane_start_command}' | grep -c 'agent-testrepo-QA-1' || true)"
vtmux kill-server 2>/dev/null || true
open_viewer
assert_eq "a missing viewer is created with both panes" "2" "$(vtmux list-panes -t "$VIEWER" 2>/dev/null | wc -l | tr -d ' ')"
vtmux kill-server 2>/dev/null || true

if ! command -v osascript >/dev/null 2>&1; then
    skip "launcher parity (no osascript — macOS only)"
    summarize
fi

# KEY and the session names are reassigned by the session-name tests below;
# every helper reads them live.
KEY="QA-1"
AGENT_NAME="agent-testrepo-QA-1"
COMPANION_NAME="companion-testrepo-QA-1"
base_args() {
    printf '%s\n' --worktree /tmp/wt --issue-key "$KEY" --repo-name testrepo \
        --agent-session "$AGENT_NAME" --companion-session "$COMPANION_NAME"
}

iterm() { local a; IFS=$'\n' read -r -d '' -a a < <(base_args; printf '\0'); "$SCRIPT_DIR/open-iterm-agent.sh" "${a[@]}" "$@" 2>/dev/null; }
ghostty() { local a; IFS=$'\n' read -r -d '' -a a < <(base_args; printf '\0'); "$SCRIPT_DIR/open-ghostty-agent.sh" "${a[@]}" "$@" 2>/dev/null; }
default_term() { local a; IFS=$'\n' read -r -d '' -a a < <(base_args; printf '\0'); "$SCRIPT_DIR/open-default-terminal-agent.sh" "${a[@]}" "$@" 2>/dev/null; }

# Single-word flag permutations, including non-claude agents and a claude
# wrapper. Model/effort flags are one multi-word value, so they're below.
FLAG_CASES=(
    ""
    "--skip-permissions"
    "--agent-command codex --agent-is-claude false --agent-args --yolo"
    "--agent-command codex --agent-is-claude false --agent-resume-args resume"
    "--agent-command agy --agent-is-claude false --agent-resume-args --conversation --agent-prompt-args --prompt-interactive={prompt}"
    "--agent-command claude-local --agent-is-claude true --skip-permissions"
)

section "launch flags are byte-identical"
for flags in "${FLAG_CASES[@]}"; do
    read -r -a flag_args <<< "$flags"
    assert_eq "flags [${flags:-none}]" \
        "$(iterm --prompt "" "${flag_args[@]}" --print-launch-flags)" \
        "$(ghostty --prompt "" "${flag_args[@]}" --print-launch-flags)"
    assert_eq "flags [${flags:-none}] (default)" \
        "$(iterm --prompt "" "${flag_args[@]}" --print-launch-flags)" \
        "$(default_term --prompt "" "${flag_args[@]}" --print-launch-flags)"
done

section "assembled command lines are byte-identical"
for flags in "${FLAG_CASES[@]}"; do
    read -r -a flag_args <<< "$flags"
    assert_eq "command [${flags:-none}]" \
        "$(iterm --prompt "/idow QA-1" "${flag_args[@]}" --print-command)" \
        "$(ghostty --prompt "/idow QA-1" "${flag_args[@]}" --print-command)"
    assert_eq "command [${flags:-none}] (default)" \
        "$(iterm --prompt "/idow QA-1" "${flag_args[@]}" --print-command)" \
        "$(default_term --prompt "/idow QA-1" "${flag_args[@]}" --print-command)"
done

# The agent profile's model/effort flags arrive as one multi-word value, so
# they can't ride the whitespace-split FLAG_CASES above.
section "agent profile launch flags are byte-identical"
LAUNCH_FLAG_CASES=(
    "codex|false|-m 'gpt-5.5 [1m]' -c model_reasoning_effort=high"
    "claude|true|--model opus --effort max"
    "claude|true|--model 'claude-opus-5[1m]'"
)
for launch_case in "${LAUNCH_FLAG_CASES[@]}"; do
    IFS='|' read -r lf_command lf_is_claude lf_flags <<< "$launch_case"
    lf_args=(--agent-command "$lf_command" --agent-is-claude "$lf_is_claude" \
        --agent-args "--yolo" --agent-resume-args "resume abc" --agent-launch-flags "$lf_flags")
    for mode in --print-launch-flags --print-command; do
        assert_eq "$lf_command $mode" \
            "$(iterm --prompt "/idow QA-1" "${lf_args[@]}" "$mode")" \
            "$(ghostty --prompt "/idow QA-1" "${lf_args[@]}" "$mode")"
        assert_eq "$lf_command $mode (default)" \
            "$(iterm --prompt "/idow QA-1" "${lf_args[@]}" "$mode")" \
            "$(default_term --prompt "/idow QA-1" "${lf_args[@]}" "$mode")"
    done
done

# The names are passed in, so a launcher that rebuilt one from the key would
# still pass every assertion above for QA-1 while attaching to a session
# nothing else uses.
section "the given session names are attached by every launcher"
for names in "bd-a1b2.1|agent-testrepo-bd-a1b2_1|companion-testrepo-bd-a1b2_1" \
    "my_svc-a1b2|hand.named_agent|hand-named_companion"; do
    IFS='|' read -r KEY AGENT_NAME COMPANION_NAME <<< "$names"
    assert_eq "key [$KEY] ghostty" \
        "$(iterm --prompt "" --print-command)" \
        "$(ghostty --prompt "" --print-command)"
    assert_eq "key [$KEY] default" \
        "$(iterm --prompt "" --print-command)" \
        "$(default_term --prompt "" --print-command)"
    assert_eq "key [$KEY] companion" "1" \
        "$(iterm --prompt "" --print-command | tail -1 | grep -c "new-session -A -s '$COMPANION_NAME'" || true)"
done
KEY="QA-1"
AGENT_NAME="agent-testrepo-QA-1"
COMPANION_NAME="companion-testrepo-QA-1"

# The prompt branch and the companion command are the other two inputs that
# change the assembled bytes.
assert_eq "empty prompt (resume mode)" \
    "$(iterm --prompt "" --print-command)" \
    "$(ghostty --prompt "" --print-command)"
assert_eq "empty prompt (resume mode) (default)" \
    "$(iterm --prompt "" --print-command)" \
    "$(default_term --prompt "" --print-command)"
for prompt_args in "" "-i {prompt}"; do
    assert_eq "quoted prompt, prompt_args [$prompt_args]" \
        "$(iterm --prompt "/fix it's \"QA-1\"" --agent-prompt-args "$prompt_args" --print-command)" \
        "$(ghostty --prompt "/fix it's \"QA-1\"" --agent-prompt-args "$prompt_args" --print-command)"
    assert_eq "quoted prompt, prompt_args [$prompt_args] (default)" \
        "$(iterm --prompt "/fix it's \"QA-1\"" --agent-prompt-args "$prompt_args" --print-command)" \
        "$(default_term --prompt "/fix it's \"QA-1\"" --agent-prompt-args "$prompt_args" --print-command)"
done
assert_eq "custom companion command" \
    "$(iterm --prompt "" --companion-command "lazygit" --print-command)" \
    "$(ghostty --prompt "" --companion-command "lazygit" --print-command)"
assert_eq "custom companion command (default)" \
    "$(iterm --prompt "" --companion-command "lazygit" --print-command)" \
    "$(default_term --prompt "" --companion-command "lazygit" --print-command)"
assert_eq "empty companion command (plain shell)" \
    "$(iterm --prompt "" --companion-command "" --print-command)" \
    "$(ghostty --prompt "" --companion-command "" --print-command)"
assert_eq "empty companion command (plain shell) (default)" \
    "$(iterm --prompt "" --companion-command "" --print-command)" \
    "$(default_term --prompt "" --companion-command "" --print-command)"
assert_eq "companion command containing a single quote" \
    "$(iterm --prompt "" --companion-command "DESTDIR='/tmp' make" --print-command)" \
    "$(ghostty --prompt "" --companion-command "DESTDIR='/tmp' make" --print-command)"
assert_eq "companion command containing a single quote (default)" \
    "$(iterm --prompt "" --companion-command "DESTDIR='/tmp' make" --print-command)" \
    "$(default_term --prompt "" --companion-command "DESTDIR='/tmp' make" --print-command)"

QUOTED_ARGS=(--worktree "/tmp/o'brien wt" --repo-name "bob's-app" --issue-key "QA-%s 'x'" --prompt "")
assert_eq "worktree path, repo name and key containing quotes" \
    "$(iterm "${QUOTED_ARGS[@]}" --print-command)" \
    "$(ghostty "${QUOTED_ARGS[@]}" --print-command)"
assert_eq "worktree path, repo name and key containing quotes (default)" \
    "$(iterm "${QUOTED_ARGS[@]}" --print-command)" \
    "$(default_term "${QUOTED_ARGS[@]}" --print-command)"

# --window-id only steers which Ghostty window receives the tab; it must not
# leak into the shell the panes run.
assert_eq "--window-id does not change the assembled bytes" \
    "$(ghostty --prompt "" --print-command)" \
    "$(ghostty --prompt "" --window-id tab-group-abc123 --print-command)"

section "companion pane does not replay into a live session"
# idow step 7 usually created the companion session already. new-session -A
# attaches to it instead of starting the companion command a second time, and
# nothing is typed into the pane, so a running gitui is left alone on reopen.
for launcher in iterm ghostty; do
    COMPANION_LINE=$("$launcher" --prompt "" --print-command | tail -1)
    assert_contains "$launcher: companion session is attached when it exists" \
        "new-session -A -s 'companion-testrepo-QA-1'" "$COMPANION_LINE"
    assert_eq "$launcher: nothing is typed into the companion pane" "0" \
        "$(grep -c 'send-keys' <<< "$COMPANION_LINE" || true)"

    # The generated line crosses into a real shell, so it has to parse there.
    if printf '%s\n' "$COMPANION_LINE" | bash -n /dev/stdin 2>/dev/null; then
        pass "$launcher: companion line is valid shell"
    else
        fail "$launcher: companion line is valid shell" "Expected a line bash -n accepts" "Actual: \"$COMPANION_LINE\""
    fi
done

section "idow captures the window after --open is parsed"
# idow resolves its config before it parses arguments, so a capture placed with
# the config sees an unset OPEN_WORKSPACE and silently never runs, disabling
# window targeting altogether.
IDOW="$SCRIPT_DIR/idow"
PARSE_LINE=$(grep -n '^OPEN_WORKSPACE=false$' "$IDOW" | head -1 | cut -d: -f1)
CAPTURE_LINE=$(grep -n '^GHOSTTY_WINDOW_ID=""$' "$IDOW" | head -1 | cut -d: -f1)
STEP1_LINE=$(grep -n '^# Step 1: Select profile' "$IDOW" | head -1 | cut -d: -f1)
if [[ -n "$PARSE_LINE" && -n "$CAPTURE_LINE" && -n "$STEP1_LINE" \
      && "$CAPTURE_LINE" -gt "$PARSE_LINE" && "$CAPTURE_LINE" -lt "$STEP1_LINE" ]]; then
    pass "capture sits between --open parsing and the first slow step"
else
    fail "capture sits between --open parsing and the first slow step" \
        "Expected: parse < capture < step 1" "Actual:   parse=$PARSE_LINE capture=$CAPTURE_LINE step1=$STEP1_LINE"
fi

summarize
