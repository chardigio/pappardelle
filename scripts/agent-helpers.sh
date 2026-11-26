#!/usr/bin/env bash
# Shared shell helpers for agent command detection.

# Match unwrappedCommandWord / isAgyCommand in source/config-launch-flags.ts:
# strip leading VAR=VAL assignments and `env` wrappers so profiles such as
# `env FOO=1 agy` are recognized alongside bare `agy`.
is_agy_command() {
    local -a tokens
    local i=0 in_env=0 token base
    read -ra tokens <<< "$1"
    while ((i < ${#tokens[@]})); do
        token="${tokens[$i]}"
        if [[ "$token" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
            i=$((i + 1))
            continue
        fi
        if ((in_env)) && [[ "$token" == -* ]]; then
            case "$token" in
                -u|--unset|-C|--chdir|-S|--split-string) i=$((i + 2)) ;;
                *) i=$((i + 1)) ;;
            esac
            continue
        fi
        base="$(basename "$token")"
        if [[ "$base" == "env" ]]; then
            in_env=1
            i=$((i + 1))
            continue
        fi
        [[ "$base" == "agy" ]]
        return
    done
    return 1
}
