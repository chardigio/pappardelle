#!/bin/bash

# Test: `pappardelle schedule` on a real systemd user manager.
#
# A one-shot wake-up a few seconds out fires `pappardelle schedule fire`, which
# types its message into an agent session on an isolated tmux server; a
# cancelled one leaves no unit behind. Skipped without a systemd user bus.
#
# The tmux server lives under its own TMUX_TMPDIR with $TMUX unset, and is
# killed through its socket path only. The repo name is unique per run, so its
# job files and units can't collide with real ones.
#
# Usage: ./test-schedule-systemd.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$(cd "$SCRIPT_DIR/.." && pwd)"
PASS=0
FAIL=0

if [[ -z "${XDG_RUNTIME_DIR:-}" ]] || ! command -v systemd-run >/dev/null || ! command -v bun >/dev/null ||
    ! systemctl --user show-environment >/dev/null 2>&1; then
    echo "SKIP: test-schedule-systemd (needs a systemd user manager and bun)"
    exit 0
fi

ROOT="$(mktemp -d /tmp/pq-XXXXXX)"
REPO_NAME="pappardelle-qa-$(basename "$ROOT" | cut -d- -f2 | tr '[:upper:]' '[:lower:]')"
REPO="$ROOT/$REPO_NAME"
export TMUX_TMPDIR="$ROOT/t"
mkdir -p "$REPO" "$TMUX_TMPDIR"
SOCKET=""

T() { env -u TMUX -u TMUX_PANE tmux -L pappardelle_inner "$@"; }

cleanup() {
    for unit in $(systemctl --user list-units --all --plain --no-legend "pappardelle-$REPO_NAME-*" | awk '{print $1}'); do
        systemctl --user stop "$unit" 2>/dev/null
    done
    systemctl --user reset-failed "pappardelle-$REPO_NAME-*" 2>/dev/null
    if [[ -n "$SOCKET" && "$SOCKET" == "$TMUX_TMPDIR"/* ]]; then
        env -u TMUX -u TMUX_PANE tmux -S "$SOCKET" kill-server 2>/dev/null
    fi
    rm -rf "$ROOT" "$HOME/.pappardelle/repos/$REPO_NAME"
}
trap cleanup EXIT

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }

git init -q "$REPO"
printf 'version: 1\nteam_prefix: QA\nissue_tracker:\n  provider: jira\n  base_url: https://example.invalid\nprofiles:\n  test:\n    display_name: Test\n' > "$REPO/.pappardelle.yml"
git -C "$REPO" -c user.email=a@b -c user.name=a commit -q --allow-empty -m init

T -f /dev/null new-session -d -s "agent-$REPO_NAME-QA-1" -x 120 -y 20 cat
SOCKET="$(T display-message -p '#{socket_path}')"
if [[ "$SOCKET" != "$TMUX_TMPDIR"/* ]]; then
    echo "tmux is not isolated: $SOCKET"
    exit 1
fi

# This may itself run inside a space, whose PAPPARDELLE_* would point the
# timer at that space's repo.
SQLITE_STATE="${PAPPARDELLE_SQLITE_STATE:-}"
for name in $(compgen -e | grep '^PAPPARDELLE_'); do unset "$name"; done
# The run keeps its state mode. This test runs under the real $HOME, so the
# database and the status daemon's socket are its own, and the timer it starts
# is handed all three.
export PAPPARDELLE_STATE_DB="$ROOT/state.db"
export PAPPARDELLE_STATUS_SOCKET="$ROOT/status-1.sock"
if [[ -n "$SQLITE_STATE" ]]; then
    export PAPPARDELLE_SQLITE_STATE="$SQLITE_STATE"
fi

# The jobs the test's database holds for this repo.
stored_jobs() {
    bun -e '
        import {Database} from "bun:sqlite";
        const db = new Database(process.argv[1], {readonly: true});
        console.log(db.query("SELECT COUNT(*) AS jobs FROM schedules WHERE repo = ?").get(process.argv[2]).jobs);
    ' "$PAPPARDELLE_STATE_DB" "$REPO_NAME"
}

pappardelle() {
    (cd "$REPO" && env -u TMUX -u TMUX_PANE bun "$PROJECT/source/cli.tsx" "$@")
}

echo "schedule --at"
at="$(date -d '+5 seconds' --iso-8601=seconds)"
if pappardelle schedule QA-1 --at "$at" --message hello-from-a-timer >/dev/null; then
    pass "scheduled"
else
    fail "schedule exited $?"
fi
units="$(systemctl --user list-timers --all --plain --no-legend "pappardelle-$REPO_NAME-*" | wc -l)"
if [[ "$units" -eq 1 ]]; then pass "one timer loaded"; else fail "expected one timer, found $units"; fi
if [[ "$SQLITE_STATE" == 1 ]]; then
    jobs="$(stored_jobs)"
    if [[ "$jobs" -eq 1 ]]; then pass "the job is a row in the test's database"; else fail "expected one stored job, found $jobs"; fi
fi

seen=""
for _ in $(seq 1 40); do
    if T capture-pane -p -t "=agent-$REPO_NAME-QA-1:" | grep -q hello-from-a-timer; then
        seen=yes
        break
    fi
    sleep 1
done
if [[ -n "$seen" ]]; then pass "the timer typed the message into the session"; else fail "the message never arrived"; fi
sleep 2
left="$(pappardelle schedules)"
if [[ "$left" == "No scheduled wake-ups" ]]; then pass "the fired job removed itself"; else fail "jobs left: $left"; fi
if [[ "$SQLITE_STATE" == 1 ]]; then
    jobs="$(stored_jobs)"
    if [[ "$jobs" -eq 0 ]]; then pass "the timer's process removed the row"; else fail "$jobs stored jobs left"; fi
fi
if grep -q '"caller":"timer:' "$HOME/.pappardelle/repos/$REPO_NAME/supervise.jsonl"; then
    pass "the send is logged as the timer's"
else
    fail "no timer entry in the log"
fi

echo "unschedule"
id="$(pappardelle schedule QA-1 --at "$(date -d '+10 minutes' --iso-8601=seconds)" --message later | awk '{print $2}')"
if pappardelle unschedule "$id" >/dev/null; then pass "unscheduled $id"; else fail "unschedule failed"; fi
units="$(systemctl --user list-timers --all --plain --no-legend "pappardelle-$REPO_NAME-*" | wc -l)"
if [[ "$units" -eq 0 ]]; then pass "no timer left"; else fail "$units timers left"; fi

echo
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
