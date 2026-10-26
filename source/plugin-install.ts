import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {readAllSessionStates} from './claude-status.ts';
import {reloadClaudeSessions, type ReloadResult} from './plugin-reload.ts';
import {defaultInnerTmuxRunner} from './tmux.ts';
import {plural} from './tui-sessions.ts';

// A marketplace added from a local directory loads its plugins in place, so
// pointing it at the checkout makes skill and hook edits live after
// /reload-plugins. Added from GitHub instead, Claude Code serves a cached copy
// that only refreshes on a version bump. `marketplace add` under the same
// name repoints an existing marketplace, which moves GitHub installs over.

const PLUGIN_ID = 'pappardelle@pappardelle-marketplace';

// Before the hooks shipped in the plugin, install.sh copied them to
// ~/.pappardelle/hooks and users merged commands running them into
// ~/.claude/settings.json. Left in place, every hook would fire twice. The
// scripts themselves stay: sessions open during an update keep running the old
// commands until they reload.
const LEGACY_HOOK_DIR = '~/.pappardelle/hooks/';
const LEGACY_HOOK_COMMAND = '.pappardelle/hooks/';

export type RunResult = {
	status: number | null;
	error?: Error;
};

export type PluginInstallDeps = {
	run: (command: string, args: string[]) => RunResult;
	repoDir: string;
	settingsPath: string;
	readFile: (file: string) => string | undefined;
	writeFile: (file: string, content: string) => void;
	print: (line: string) => void;
	isLinkedWorktree: () => boolean;
	reloadSessions: () => ReloadResult;
};

export function installPlugin(deps: PluginInstallDeps): number {
	// `marketplace add` rewrites settings.json too, so the backup is taken
	// before it runs to keep the file exactly as the user left it.
	const original = deps.readFile(deps.settingsPath);
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

	if (original !== undefined) removeLegacyHooks(deps, original);
	deps.print(`Installed the Pappardelle plugin from ${deps.repoDir}.`);
	// Closing a workspace removes its worktree, and with it the plugin every
	// Claude session loads.
	if (deps.isLinkedWorktree()) {
		deps.print(
			'This is a git worktree: run install.sh from your main checkout before removing it, or Claude Code loses the plugin.',
		);
	}

	const {reloaded, skipped} = deps.reloadSessions();
	if (reloaded.length > 0) {
		deps.print(
			`Sent /reload-plugins to ${reloaded.length} Pappardelle Claude ${plural(reloaded.length, 'session')} (${reloaded.join(', ')}).`,
		);
	}

	if (skipped.length > 0) {
		deps.print(
			`Run /reload-plugins by hand in ${skipped.join(', ')}: ${skipped.length === 1 ? 'it was' : 'they were'} waiting on a question or permission prompt, or had no status.`,
		);
	}

	deps.print('Other open Claude Code sessions load it after /reload-plugins.');
	return 0;
}

type HookGroup = {hooks?: Array<{command?: unknown}>};
type ClaudeSettings = {hooks?: Record<string, HookGroup[]>};

function removeLegacyHooks(deps: PluginInstallDeps, original: string): void {
	const current = deps.readFile(deps.settingsPath) ?? original;
	let settings: ClaudeSettings;
	try {
		settings = JSON.parse(current) as ClaudeSettings;
	} catch {
		deps.print(
			`Could not parse ${deps.settingsPath}; remove any hooks that run ${LEGACY_HOOK_DIR} by hand.`,
		);
		return;
	}

	if (!stripLegacyHooks(settings)) return;
	deps.writeFile(`${deps.settingsPath}.bak`, original);
	deps.writeFile(deps.settingsPath, JSON.stringify(settings, null, 2) + '\n');
	deps.print(
		`Removed the old Pappardelle hooks from ${deps.settingsPath} (backup: ${deps.settingsPath}.bak).`,
	);
}

const isLegacyHook = (hook: {command?: unknown}) =>
	typeof hook.command === 'string' &&
	hook.command.includes(LEGACY_HOOK_COMMAND);

function stripLegacyHooks(settings: ClaudeSettings): boolean {
	let changed = false;
	const hooks: Record<string, HookGroup[]> = {};
	for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
		if (!Array.isArray(groups)) {
			hooks[event] = groups;
			continue;
		}

		const kept: HookGroup[] = [];
		for (const group of groups) {
			const groupHooks = group?.hooks;
			if (!Array.isArray(groupHooks)) {
				kept.push(group);
				continue;
			}

			const remaining = groupHooks.filter(hook => !isLegacyHook(hook));
			if (remaining.length === groupHooks.length) {
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
		print(line) {
			console.log(line);
		},
		isLinkedWorktree() {
			const result = spawnSync(
				'git',
				['-C', pappardelleDir, 'rev-parse', '--git-dir', '--git-common-dir'],
				{encoding: 'utf8'},
			);
			if (result.status !== 0) return false;
			const [gitDir, commonDir] = result.stdout
				.trim()
				.split('\n')
				.map(dir => path.resolve(pappardelleDir, dir));
			return gitDir !== commonDir;
		},
		reloadSessions: () =>
			reloadClaudeSessions({
				innerTmux: defaultInnerTmuxRunner,
				readStatuses: readAllSessionStates,
			}),
	};
}
