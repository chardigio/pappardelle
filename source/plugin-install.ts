import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';

// Claude Code and agy load the plugin in place from the checkout, so skill and
// hook edits are live after /reload-plugins (Claude Code) or in new agy
// sessions. Claude Code serves a GitHub marketplace from a cache that only
// refreshes on a version bump; `marketplace add` under the same name repoints
// it. Codex copies even a local plugin into its cache, and `plugin add`
// refreshes that copy.

const PLUGIN_ID = 'pappardelle@pappardelle-marketplace';

// Before the hooks shipped in the plugin, install.sh copied them to
// ~/.pappardelle/hooks and users merged commands running them into
// ~/.claude/settings.json. Left in place, every hook would fire twice. The
// scripts themselves stay: sessions open during an update keep running the old
// commands until they reload.
const LEGACY_HOOK_DIR = '.pappardelle/hooks/';

// Codex's session hook was merged into ~/.codex/hooks.json, first from
// ~/.pappardelle/hooks and later from the checkout. The plugin registers it
// now, so any copy left there records every session twice.
const CODEX_SESSION_HOOK = 'record-agent-session.py';

export type RunResult = {
	status: number | null;
	error?: Error;
};

export type PluginInstallDeps = {
	run: (command: string, args: string[]) => RunResult;
	repoDir: string;
	settingsPath: string;
	codexHooksPath: string;
	agyConfigDir: string;
	readFile: (file: string) => string | undefined;
	writeFile: (file: string, content: string) => void;
	/** Whether anything, a dangling symlink included, is at the path. */
	exists: (file: string) => boolean;
	/** The symlink's target, or undefined when the path is not a symlink. */
	readLink: (file: string) => string | undefined;
	/** Points `file` at `target`, replacing a symlink already there. */
	link: (target: string, file: string) => void;
	print: (line: string) => void;
	isLinkedWorktree: () => boolean;
};

type Outcome = 'installed' | 'skipped' | 'failed';

export function installPlugin(deps: PluginInstallDeps): number {
	const outcomes = new Set([
		installForClaude(deps),
		installForCodex(deps),
		installForAgy(deps),
	]);
	// Closing a workspace removes its worktree, and with it the plugin Claude
	// Code and agy load in place.
	if (deps.isLinkedWorktree() && outcomes.has('installed')) {
		deps.print(
			'This is a git worktree: run install.sh from your main checkout before removing it, or Claude Code and agy lose the plugin.',
		);
	}

	return outcomes.has('failed') ? 1 : 0;
}

function runSteps(
	deps: PluginInstallDeps,
	command: string,
	agent: string,
	steps: string[][],
): Outcome {
	for (const args of steps) {
		const result = deps.run(command, args);
		if (result.status === 0) continue;
		if (
			(result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
		) {
			deps.print(`${agent} (${command}) is not on PATH; skipped its plugin.`);
			return 'skipped';
		}

		deps.print(
			`${command} ${args.join(' ')} failed${result.error ? `: ${result.error.message}` : ''}`,
		);
		return 'failed';
	}

	return 'installed';
}

function installForClaude(deps: PluginInstallDeps): Outcome {
	// `marketplace add` rewrites settings.json too, so the backup is taken
	// before it runs to keep the file exactly as the user left it.
	const original = deps.readFile(deps.settingsPath);
	const outcome = runSteps(deps, 'claude', 'Claude Code', [
		['plugin', 'marketplace', 'add', deps.repoDir],
		['plugin', 'install', PLUGIN_ID, '--scope', 'user'],
	]);
	if (outcome !== 'installed') return outcome;
	if (original !== undefined) {
		removeHooks(deps, deps.settingsPath, original, hook =>
			hook.includes(LEGACY_HOOK_DIR),
		);
	}

	deps.print(
		`Installed the Pappardelle plugin for Claude Code from ${deps.repoDir}. Run /reload-plugins in open sessions to load it.`,
	);
	return 'installed';
}

function installForCodex(deps: PluginInstallDeps): Outcome {
	const outcome = runSteps(deps, 'codex', 'Codex', [
		['plugin', 'marketplace', 'add', deps.repoDir],
		['plugin', 'add', PLUGIN_ID],
	]);
	if (outcome !== 'installed') return outcome;
	const original = deps.readFile(deps.codexHooksPath);
	if (original !== undefined) {
		removeHooks(deps, deps.codexHooksPath, original, hook =>
			hook.includes(CODEX_SESSION_HOOK),
		);
	}

	deps.print(
		'Installed the Pappardelle plugin for Codex. Codex asks to trust its session hook on the next launch; until you do, codex spaces launch fresh instead of resuming.',
	);
	return 'installed';
}

function installForAgy(deps: PluginInstallDeps): Outcome {
	if (!deps.exists(deps.agyConfigDir)) {
		deps.print(
			`agy is not set up (no ${deps.agyConfigDir}); skipped its plugin. Run pappardelle plugin install again after first using agy.`,
		);
		return 'skipped';
	}

	const target = path.join(deps.repoDir, 'plugins', 'pappardelle');
	const link = path.join(deps.agyConfigDir, 'plugins', 'pappardelle');
	if (deps.readLink(link) === undefined && deps.exists(link)) {
		deps.print(
			`${link} is a copy installed by agy; run agy plugin uninstall pappardelle, then pappardelle plugin install again.`,
		);
		return 'failed';
	}

	if (deps.readLink(link) !== target) deps.link(target, link);
	deps.print(
		`Linked the Pappardelle plugin into agy at ${link}. New agy sessions load it.`,
	);
	return 'installed';
}

type HookGroup = {hooks?: Array<{command?: unknown}>};
type HookSettings = {hooks?: Record<string, HookGroup[]>};

type HookFilter = (command: string) => boolean;

function removeHooks(
	deps: PluginInstallDeps,
	file: string,
	original: string,
	isOld: HookFilter,
): void {
	const current = deps.readFile(file) ?? original;
	let settings: HookSettings;
	try {
		settings = JSON.parse(current) as HookSettings;
	} catch {
		deps.print(
			`Could not parse ${file}; remove any old Pappardelle hooks from it by hand.`,
		);
		return;
	}

	if (!stripHooks(settings, isOld)) return;
	deps.writeFile(`${file}.pappardelle.bak`, original);
	deps.writeFile(file, JSON.stringify(settings, null, 2) + '\n');
	deps.print(
		`Removed the old Pappardelle hooks from ${file} (backup: ${file}.pappardelle.bak).`,
	);
}

function stripHooks(settings: HookSettings, isOld: HookFilter): boolean {
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

			const remaining = groupHooks.filter(
				hook => !(typeof hook.command === 'string' && isOld(hook.command)),
			);
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
	const codexDir = process.env['CODEX_HOME'] ?? path.join(homedir(), '.codex');
	return {
		repoDir: pappardelleDir,
		settingsPath: path.join(claudeDir, 'settings.json'),
		codexHooksPath: path.join(codexDir, 'hooks.json'),
		agyConfigDir: path.join(homedir(), '.gemini', 'config'),
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
		exists(file) {
			try {
				fs.lstatSync(file);
				return true;
			} catch {
				return false;
			}
		},
		readLink(file) {
			try {
				return fs.readlinkSync(file);
			} catch {
				return undefined;
			}
		},
		link(target, file) {
			fs.mkdirSync(path.dirname(file), {recursive: true});
			fs.rmSync(file, {force: true});
			fs.symlinkSync(target, file);
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
	};
}
