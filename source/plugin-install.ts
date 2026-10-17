import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';

// A marketplace added from a local directory loads its plugins in place, so
// pointing it at the checkout makes skill and hook edits live after
// /reload-plugins. Added from GitHub instead, Claude Code serves a cached copy
// that only refreshes on a version bump. `marketplace add` under the same
// name repoints an existing marketplace, which moves GitHub installs over.

const PLUGIN_ID = 'pappardelle@pappardelle-marketplace';

// Before the hooks shipped in the plugin, install.sh copied them here and
// users merged hooks/settings.json.example into ~/.claude/settings.json.
// Left in place, every hook would fire twice.
const LEGACY_HOOK_COMMAND = '.pappardelle/hooks/';

export type RunResult = {
	status: number | null;
	error?: Error;
};

export type PluginInstallDeps = {
	run: (command: string, args: string[]) => RunResult;
	repoDir: string;
	settingsPath: string;
	legacyHooksDir: string;
	readFile: (file: string) => string | undefined;
	writeFile: (file: string, content: string) => void;
	removeDir: (dir: string) => void;
	print: (line: string) => void;
};

export function installPlugin(deps: PluginInstallDeps): number {
	const steps = [
		['plugin', 'marketplace', 'add', deps.repoDir],
		['plugin', 'install', PLUGIN_ID, '--scope', 'user'],
	];
	for (const args of steps) {
		const result = deps.run('claude', args);
		if (result.status === 0) continue;
		deps.print(
			(result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
				? 'Claude Code (claude) is not on PATH, so the Pappardelle plugin was not installed.'
				: `claude ${args.join(' ')} failed${result.error ? `: ${result.error.message}` : ''}`,
		);
		return 1;
	}

	removeLegacyHooks(deps);
	deps.print(
		`Installed the Pappardelle plugin from ${deps.repoDir}. Run /reload-plugins in open Claude Code sessions to load it.`,
	);
	return 0;
}

type HookGroup = {hooks?: Array<{command?: unknown}>};

function removeLegacyHooks(deps: PluginInstallDeps): void {
	const original = deps.readFile(deps.settingsPath);
	if (original !== undefined) {
		let settings: {hooks?: Record<string, HookGroup[]>};
		try {
			settings = JSON.parse(original) as typeof settings;
		} catch {
			deps.print(
				`Could not parse ${deps.settingsPath}; remove any hooks that run ~/.pappardelle/hooks/ by hand.`,
			);
			return;
		}

		if (settings.hooks && withoutLegacyHooks(settings)) {
			deps.writeFile(`${deps.settingsPath}.bak`, original);
			deps.writeFile(
				deps.settingsPath,
				JSON.stringify(settings, null, 2) + '\n',
			);
			deps.print(
				`Removed the old Pappardelle hooks from ${deps.settingsPath} (backup: ${deps.settingsPath}.bak).`,
			);
		}
	}

	deps.removeDir(deps.legacyHooksDir);
}

const isLegacyHook = (hook: {command?: unknown}) =>
	typeof hook.command === 'string' &&
	hook.command.includes(LEGACY_HOOK_COMMAND);

function withoutLegacyHooks(settings: {
	hooks?: Record<string, HookGroup[]>;
}): boolean {
	let changed = false;
	const hooks: Record<string, HookGroup[]> = {};
	for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
		if (!Array.isArray(groups)) {
			hooks[event] = groups;
			continue;
		}

		const kept: HookGroup[] = [];
		for (const group of groups) {
			const remaining = Array.isArray(group.hooks)
				? group.hooks.filter(hook => !isLegacyHook(hook))
				: undefined;
			if (!remaining || remaining.length === group.hooks!.length) {
				kept.push(group);
				continue;
			}

			changed = true;
			if (remaining.length > 0) kept.push({...group, hooks: remaining});
		}

		if (kept.length > 0) hooks[event] = kept;
	}

	if (!changed) return false;
	if (Object.keys(hooks).length > 0) settings.hooks = hooks;
	else delete settings.hooks;
	return true;
}

export function defaultPluginInstallDeps(
	pappardelleDir: string,
): PluginInstallDeps {
	const claudeDir =
		process.env['CLAUDE_CONFIG_DIR'] ?? path.join(homedir(), '.claude');
	return {
		repoDir: pappardelleDir,
		settingsPath: path.join(claudeDir, 'settings.json'),
		legacyHooksDir: path.join(homedir(), '.pappardelle', 'hooks'),
		run(command, args) {
			const result = spawnSync(command, args, {stdio: 'inherit'});
			return {status: result.status, error: result.error};
		},
		readFile(file) {
			try {
				return fs.readFileSync(file, 'utf8');
			} catch {
				return undefined;
			}
		},
		writeFile(file, content) {
			fs.writeFileSync(file, content);
		},
		removeDir(dir) {
			fs.rmSync(dir, {recursive: true, force: true});
		},
		print(line) {
			console.log(line);
		},
	};
}
