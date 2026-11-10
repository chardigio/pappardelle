"""Shared helpers for acli (Atlassian CLI) integration in Pappardelle hooks."""

import subprocess


def acli_succeeded(result: subprocess.CompletedProcess) -> bool:
    """Check if an acli command actually succeeded.

    acli sometimes returns exit code 0 even on failure (e.g. comment create
    with invalid ADF). Check stdout/stderr for known failure indicators.

    Uses "Error:" and "Failure:" (with colon) to avoid false negatives when
    legitimate output contains the word "Error" as a substring (e.g., an issue
    titled "Error-Handling-Improvements").
    """
    output = (result.stdout or "") + (result.stderr or "")
    failure_indicators = ["Failure:", "Error:", "InvalidPayloadException"]
    if any(indicator in output for indicator in failure_indicators):
        return False
    return result.returncode == 0
