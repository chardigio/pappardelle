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
//
// Codex trusts a plugin's hooks by a hash of the whole plugin, so any skill
// edit would silently stop the session hook until the user re-trusted it, and
// codex spaces would launch fresh instead of resuming. Its manifest therefore
// declares no hooks (left out, Codex would load Claude Code's), and the
// session hook goes in ~/.codex/hooks.json, which Codex trusts per command.

const MARKETPLACE = 'pappardelle-marketplace';
const PLUGIN_ID = `pappardelle@${MARKETPLACE}`;

// Before the hooks shipped in the plugin, install.sh copied them to
// ~/.pappardelle/hooks and users merged commands running them into
// ~/.claude/settings.json. Left in place, every hook would fire twice. The
// scripts themselves stay: sessions open during an update keep running the old
// commands until they reload.
const LEGACY_HOOK_DIR = '.pappardelle/hooks/';

// Older installs pointed Codex's session hook at ~/.pappardelle/hooks or at
// another checkout; any copy left beside this checkout's records every
// session twice.
const CODEX_SESSION_HOOK = 'record-agent-session.py';
const CODEX_SESSION_EVENTS: Array<[event: string, matcher?: string]> = [
	['SessionStart', 'startup|resume|clear'],
	['UserPromptSubmit'],
];

export type RunResult = {
	status: number | null;
	error?: Error;
};

export type PluginInstallDeps = {
	/** `quiet` hides the command's output from the user. */
	run: (command: string, args: string[], quiet?: boolean) => RunResult;
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

const isMissingCli = (result: RunResult) =>
	(result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

function skipMissing(
	deps: PluginInstallDeps,
	agent: string,
	command: string,
): Outcome {
	deps.print(`${agent} (${command}) is not on PATH; skipped its plugin.`);
	return 'skipped';
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
		if (isMissingCli(result)) return skipMissing(deps, agent, command);

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
	// Codex refuses to add a marketplace under a name it already has from
	// another source, such as the GitHub one or another checkout. Removing it
	// keeps the plugin enabled and its hooks trusted. It fails when there is
	// nothing to remove, which is fine, so its error would only alarm the user.
	const removed = deps.run(
		'codex',
		['plugin', 'marketplace', 'remove', MARKETPLACE],
		true,
	);
	if (isMissingCli(removed)) return skipMissing(deps, 'Codex', 'codex');
	const outcome = runSteps(deps, 'codex', 'Codex', [
		['plugin', 'marketplace', 'add', deps.repoDir],
		['plugin', 'add', PLUGIN_ID],
	]);
	if (outcome !== 'installed') return outcome;
	deps.print('Installed the Pappardelle plugin for Codex.');
	installCodexSessionHook(deps);
	return 'installed';
}

function installCodexSessionHook(deps: PluginInstallDeps): void {
	const file = deps.codexHooksPath;
	const script = path.join(
		deps.repoDir,
		'plugins',
		'pappardelle',
		'hooks',
		CODEX_SESSION_HOOK,
	);
	const command = `python3 "${script}"`;
	const original = deps.readFile(file);
	let settings: HookSettings;
	try {
		settings = JSON.parse(original ?? '{}') as HookSettings;
	} catch {
		deps.print(
			`Could not parse ${file}; add ${command} to its SessionStart and UserPromptSubmit hooks by hand.`,
		);
		return;
	}

	const removed = stripHooks(
		settings,
		hook => hook.includes(CODEX_SESSION_HOOK) && hook !== command,
	);
	const hooks = settings.hooks ?? {};
	let added = false;
	for (const [event, matcher] of CODEX_SESSION_EVENTS) {
		const groups = hooks[event] ?? [];
		if (groups.some(group => group.hooks?.some(h => h.command === command))) {
			continue;
		}

		hooks[event] = [
			...groups,
			{...(matcher ? {matcher} : {}), hooks: [{type: 'command', command}]},
		];
		added = true;
	}

	if (!removed && !added) return;
	settings.hooks = hooks;
	if (original !== undefined) {
		deps.writeFile(`${file}.pappardelle.bak`, original);
	}

	deps.writeFile(file, JSON.stringify(settings, null, 2) + '\n');
	deps.print(
		`Pointed the Codex session hook in ${file} at this checkout${original === undefined ? '' : ` (backup: ${file}.pappardelle.bak)`}.`,
	);
	if (added) {
		deps.print(
			'Codex asks to trust the session hook on its next launch; until you do, codex spaces launch fresh instead of resuming.',
		);
	}

	// Codex keys hook trust by each hook's position in the file, so removing
	// an old entry makes it treat the hooks after it as changed.
	const others = Object.values(hooks)
		.flat()
		.some(group =>
			group.hooks?.some(
				h => typeof h.command === 'string' && !h.command.includes(script),
			),
		);
	if (removed && others) {
		deps.print(
			`Codex will also ask you to review your other hooks in ${file} again, since removing the old entries moved them.`,
		);
	}
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

type HookGroup = {
	matcher?: string;
	hooks?: Array<{type?: string; command?: unknown}>;
};
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
		run(command, args, quiet) {
			const result = spawnSync(command, args, {
				stdio: quiet ? 'ignore' : 'inherit',
			});
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
