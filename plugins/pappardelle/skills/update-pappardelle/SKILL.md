---
name: update-pappardelle
description: Update Pappardelle to the latest version by re-running the install script.
disable-model-invocation: true
---

# /update-pappardelle — Update to Latest Version

Re-runs the Pappardelle install script to pull the latest version, rebuild, and update hooks.

## Steps

1. Tell the user you're updating Pappardelle to the latest version.

2. Run the install script:

```bash
curl -fsSL https://raw.githubusercontent.com/chardigio/pappardelle/main/install.sh | bash
```

3. If the install script fails, help the user troubleshoot:
   - Missing prerequisites → suggest `brew install <tool>`
   - Permission errors → suggest checking `~/.local/bin` ownership
   - Network errors → suggest checking internet connectivity

4. After success, tell the user:
   - Pappardelle has been updated
   - Any running Pappardelle TUI must be restarted to pick up the changes — press `q` to quit, then re-launch with `pappardelle`
