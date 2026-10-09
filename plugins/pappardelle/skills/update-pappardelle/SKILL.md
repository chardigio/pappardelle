---
name: update-pappardelle
description: Update Pappardelle to the latest version by re-running the install script.
disable-model-invocation: true
---

# /update-pappardelle — Update to Latest Version

Re-runs the Pappardelle install script to pull the latest version, rebuild, and update hooks.

Pappardelle now checks GitHub Releases on startup (cached once per 24h) and shows a banner in the TUI when a newer version is available — pressing `U` in the workspace list runs the same install script this skill runs. Use this skill when the user explicitly asks (e.g. they want to force a check after dismissing the banner, or they're not running the TUI right now).

## Steps

1. Tell the user you're updating Pappardelle to the latest version.

2. Run the update command. `--no-restart-tuis` keeps it from restarting running TUIs, since this session may be running inside one:

```bash
pappardelle update --no-restart-tuis
```

If `pappardelle` is not on PATH, or its shim errors before the update starts (e.g. a missing or too-old node), run the install script directly instead:

```bash
curl -fsSL https://raw.githubusercontent.com/chardigio/pappardelle/main/install.sh | bash
```

3. If the update fails, read its output (`pappardelle update` also keeps it in `~/.pappardelle/logs/update.log`) and help the user troubleshoot:
   - Missing prerequisites → suggest `brew install <tool>`
   - Permission errors → suggest checking `~/.local/bin` ownership
   - Network errors → suggest checking internet connectivity

4. After success, tell the user:
   - Pappardelle has been updated
   - If the command named running TUIs, they're still on the old build. `pappardelle restart`, run in each repo, restarts that repo's TUI on the new build

Note: the installer also re-pins the `pappardelle` shim to the node binary currently on PATH, so re-running it is the fix when the shim complains about a missing or too-old node (e.g. after `nvm uninstall`).
