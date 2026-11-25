#!/usr/bin/env bash
# Agy takes no per-space system-prompt launch flag like claude or codex, and it
# reads .agents/rules/ from the directory where it starts. Writing the rule in
# the worktree isolates per-space identity and messaging rules to this space
# rather than sharing one global rule across every agy session on the machine.
# Other agents get their rules from agentRulesFlags() in source/companion-rules.ts
# or from the MCP server instructions.
#
# Usage: install-agent-rules.sh <agent command> <worktree> [--space KEY] [--repo NAME] [--role sous-chef|worker]

set -euo pipefail

is_agy_command() {
    local -a tokens
    local i=0 token base
    read -ra tokens <<< "$1"
    while ((i < ${#tokens[@]})); do
        token="${tokens[$i]}"
        if [[ "$token" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
            i=$((i + 1))
            continue
        fi
        base="$(basename "$token")"
        if [[ "$base" == "env" ]]; then
            i=$((i + 1))
            while ((i < ${#tokens[@]})); do
                token="${tokens[$i]}"
                case "$token" in
                    -u|--unset|-C|--chdir|-S|--split-string)
                        i=$((i + 2))
                        ;;
                    -*)
                        i=$((i + 1))
                        ;;
                    *)
                        if [[ "$token" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
                            i=$((i + 1))
                        else
                            break
                        fi
                        ;;
                esac
            done
            continue
        fi
        [[ "$base" == "agy" ]]
        return
    done
    return 1
}

[[ $# -ge 1 ]] || {
    echo "Usage: install-agent-rules.sh <agent command> <worktree> [--space KEY] [--repo NAME] [--role sous-chef|worker]" >&2
    exit 2
}

is_agy_command "$1" || exit 0

[[ $# -ge 2 ]] || {
    echo "install-agent-rules.sh: missing <worktree> argument" >&2
    exit 2
}

worktree="$2"
shift 2

space=""
repo=""
role="worker"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --space|--repo|--role)
            [[ $# -ge 2 ]] || {
                echo "install-agent-rules.sh: $1 requires a value" >&2
                exit 2
            }
            case "$1" in
                --space) space="$2" ;;
                --repo) repo="$2" ;;
                --role)
                    if [[ "$2" != "sous-chef" && "$2" != "worker" ]]; then
                        echo "install-agent-rules.sh: invalid --role: $2" >&2
                        exit 2
                    fi
                    role="$2"
                    ;;
            esac
            shift 2
            ;;
        *)
            echo "install-agent-rules.sh: unknown option: $1" >&2
            exit 2
            ;;
    esac
done

rules_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
rule=".agents/rules/pappardelle.md"
repo_note=""
if [[ -n "$repo" ]]; then
    repo_note=" (repo $repo)"
fi

mkdir -p "$worktree/.agents/rules"
{
    # agy silently discards a rule without a trigger.
    printf -- '---\ntrigger: always_on\n---\n\n'
    if [[ "$role" == "sous-chef" ]]; then
        printf 'You are in Pappardelle space %s%s, running in sous-chef mode as the coordinator for the repo'\''s spaces. ' "${space:-main}" "$repo_note"
        cat << 'EOF'
Use the pappardelle MCP tools rather than tmux. Since the main checkout has no PAPPARDELLE_SPACE env var, pass `space: "main"` (or the target space key) to companion tools. The pappardelle-agent skill covers updating and restarting Pappardelle.

Sous-chef routine: keep the other spaces moving with `spaces_list` for the board, `space_watch` with `until: ["blocked", "idle"]` in a loop to catch spaces waiting on a person or stopped, `space_state` and `space_question_tabs` to read what a space asks, `space_answer` to answer, `space_holds` and `space_hold_resolve` (only on the user's word), and `space_open` to open or reopen spaces. Message other spaces using `spaces_list` and `space_send` with the target space key — never use `SendMessage`. If `SOUS-CHEF.md` exists in the repo root, read it before anything else and follow it where it differs from this routine. Never do task-level work yourself: investigate and plan with the user, then file an issue and open a space for it with `space_open`.

EOF
    elif [[ "$space" == "main" ]]; then
        printf 'You are in Pappardelle space main%s, the main checkout. ' "$repo_note"
        cat << 'EOF'
Use the pappardelle MCP tools rather than tmux, and pass `space: "main"` to companion tools since the main checkout has no PAPPARDELLE_SPACE env var. The pappardelle-agent skill covers updating and restarting Pappardelle.

To reach another space, list spaces with `spaces_list` and send a prompt with `space_send` using the target space key — never use `SendMessage`.

EOF
    elif [[ -n "$space" ]]; then
        printf 'You are in Pappardelle space %s%s. ' "$space" "$repo_note"
        cat << 'EOF'
Pappardelle gives each issue a git worktree, an agent session and a companion pane next to it, and the user watches both. Use the pappardelle MCP tools rather than tmux; they target your own space unless you pass `space`. The pappardelle-agent skill covers updating and restarting Pappardelle.

To reach another space or the sous-chef in the main checkout (space key `main`), list spaces with `spaces_list` and send a prompt with `space_send` — never use `SendMessage`.

EOF
    else
        printf 'You are in a Pappardelle-managed repo%s. ' "$repo_note"
        cat << 'EOF'
Use the pappardelle MCP tools rather than tmux. To reach another space or the sous-chef in the main checkout (space key `main`), list spaces with `spaces_list` and send a prompt with `space_send` — never use `SendMessage`.

EOF
    fi
    cat "$rules_dir/companion-rules.txt"
} > "$worktree/$rule"

exclude="$(git -C "$worktree" rev-parse --path-format=absolute --git-path info/exclude)"
if ! grep -qxF "$rule" "$exclude" 2>/dev/null; then
    mkdir -p "$(dirname "$exclude")"
    printf '%s\n' "$rule" >> "$exclude"
fi
