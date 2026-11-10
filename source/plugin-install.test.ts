import test from 'ava';
import {
	installPlugin,
	type PluginInstallDeps,
	type RunResult,
} from './plugin-install.ts';

const REPO = '/home/me/.pappardelle/repo';
const SETTINGS = '/home/me/.claude/settings.json';
const CODEX_HOOKS = '/home/me/.codex/hooks.json';
const AGY = '/home/me/.gemini/config';
const AGY_LINK = `${AGY}/plugins/pappardelle`;
const PLUGIN_DIR = `${REPO}/plugins/pappardelle`;
const enoent = (command: string): RunResult => ({
	status: null,
	error: Object.assign(new Error(`spawn ${command} ENOENT`), {code: 'ENOENT'}),
});

const legacy = (script: string) => ({
	type: 'command',
	command: `python3 ~/.pappardelle/hooks/${script}`,
});
const mine = {type: 'command', command: 'bd prime'};

function fakeDeps(
	options: {
		settings?: string;
		codexHooks?: string;
		agy?: boolean;
		respond?: (command: string, args: string[]) => RunResult | undefined;
		worktree?: boolean;
	} = {},
) {
	const calls: string[] = [];
	const files = new Map<string, string>();
	const links = new Map<string, string>();
	const dirs = new Set<string>(options.agy ? [AGY] : []);
	if (options.settings !== undefined) files.set(SETTINGS, options.settings);
	if (options.codexHooks !== undefined) {
		files.set(CODEX_HOOKS, options.codexHooks);
	}

	const printed: string[] = [];
	const deps: PluginInstallDeps = {
		repoDir: REPO,
		settingsPath: SETTINGS,
		codexHooksPath: CODEX_HOOKS,
		agyConfigDir: AGY,
		run(command, args, quiet) {
			calls.push([command, ...args, ...(quiet ? ['(quiet)'] : [])].join(' '));
			return options.respond?.(command, args) ?? {status: 0};
		},
		readFile: file => files.get(file),
		writeFile(file, content) {
			files.set(file, content);
		},
		exists: file => files.has(file) || links.has(file) || dirs.has(file),
		readLink: file => links.get(file),
		link(target, file) {
			links.set(file, target);
		},
		print(line) {
			printed.push(line);
		},
		isLinkedWorktree: () => options.worktree ?? false,
	};
	return {deps, calls, files, links, dirs, printed};
}

test('points the Claude Code and Codex marketplaces at the checkout, then installs the plugin', t => {
	const {deps, calls} = fakeDeps();
	t.is(installPlugin(deps), 0);
	t.deepEqual(calls, [
		`claude plugin marketplace add ${REPO}`,
		'claude plugin install pappardelle@pappardelle-marketplace --scope user',
		'codex plugin marketplace remove pappardelle-marketplace (quiet)',
		`codex plugin marketplace add ${REPO}`,
		'codex plugin add pappardelle@pappardelle-marketplace',
	]);
});

test('skips an agent whose CLI is missing, leaving its old hooks running', t => {
	const settings = JSON.stringify({hooks: {Stop: [{hooks: [legacy('x.py')]}]}});
	const {deps, calls, files, printed} = fakeDeps({
		settings,
		respond: command => (command === 'claude' ? enoent(command) : undefined),
	});
	t.is(installPlugin(deps), 0);
	t.true(printed[0]!.includes('not on PATH'));
	t.is(files.get(SETTINGS), settings);
	t.true(
		calls.includes('codex plugin add pappardelle@pappardelle-marketplace'),
	);
});

test("a failed marketplace add skips that agent's install and hook cleanup but not the others", t => {
	const {deps, calls, files} = fakeDeps({
		settings: JSON.stringify({hooks: {Stop: [{hooks: [legacy('x.py')]}]}}),
		respond: (command, args) =>
			command === 'claude' && args[1] === 'marketplace'
				? {status: 1}
				: undefined,
	});
	t.is(installPlugin(deps), 1);
	t.false(calls.some(call => call.startsWith('claude plugin install')));
	t.false(files.has(`${SETTINGS}.pappardelle.bak`));
	t.true(
		calls.includes('codex plugin add pappardelle@pappardelle-marketplace'),
	);
});

test('a Codex marketplace that is not there to remove does not stop the install', t => {
	const {deps, calls} = fakeDeps({
		respond: (command, args) =>
			command === 'codex' && args[2] === 'remove' ? {status: 1} : undefined,
	});
	t.is(installPlugin(deps), 0);
	t.true(
		calls.includes('codex plugin add pappardelle@pappardelle-marketplace'),
	);
});

const sessionHook = (script: string) => ({
	type: 'command',
	command: `python3 ${script}`,
});
const CODEX_COMMAND = `python3 "${PLUGIN_DIR}/hooks/record-agent-session.py"`;
const codexSessionHooks = {
	SessionStart: [
		{
			matcher: 'startup|resume|clear',
			hooks: [{type: 'command', command: CODEX_COMMAND}],
		},
	],
	UserPromptSubmit: [{hooks: [{type: 'command', command: CODEX_COMMAND}]}],
};

test('adds the Codex session hook to hooks.json, pointing at the checkout', t => {
	const {deps, files, printed} = fakeDeps();
	t.is(installPlugin(deps), 0);
	t.deepEqual(JSON.parse(files.get(CODEX_HOOKS)!), {hooks: codexSessionHooks});
	t.false(files.has(`${CODEX_HOOKS}.pappardelle.bak`));
	t.true(printed.some(line => line.includes('trust the session hook')));
});

test("replaces session hooks from older installs, keeping the user's hooks and a backup", t => {
	const original = JSON.stringify({
		hooks: {
			SessionStart: [
				{
					matcher: 'startup|resume|clear',
					hooks: [sessionHook('~/.pappardelle/hooks/record-agent-session.py')],
				},
				{hooks: [mine]},
			],
			UserPromptSubmit: [
				{
					hooks: [sessionHook('"/old/checkout/hooks/record-agent-session.py"')],
				},
			],
		},
	});
	const {deps, files, printed} = fakeDeps({codexHooks: original});
	t.is(installPlugin(deps), 0);
	t.deepEqual(JSON.parse(files.get(CODEX_HOOKS)!), {
		hooks: {
			SessionStart: [{hooks: [mine]}, ...codexSessionHooks.SessionStart],
			UserPromptSubmit: codexSessionHooks.UserPromptSubmit,
		},
	});
	t.is(files.get(`${CODEX_HOOKS}.pappardelle.bak`), original);
	t.true(printed.some(line => line.includes('review your other hooks')));
});

test('leaves a Codex hooks.json that already has the session hook untouched, so its trust holds', t => {
	const original = JSON.stringify({
		hooks: {...codexSessionHooks, Stop: [{hooks: [mine]}]},
	});
	const {deps, files, printed} = fakeDeps({codexHooks: original});
	t.is(installPlugin(deps), 0);
	t.is(files.get(CODEX_HOOKS), original);
	t.false(printed.some(line => line.includes('trust')));
});

test('leaves an unparseable Codex hooks.json alone and says what to add', t => {
	const {deps, files, printed} = fakeDeps({codexHooks: '{'});
	t.is(installPlugin(deps), 0);
	t.is(files.get(CODEX_HOOKS), '{');
	t.true(printed.some(line => line.includes(CODEX_COMMAND)));
});

test('links the plugin into agy in place', t => {
	const {deps, links} = fakeDeps({agy: true});
	t.is(installPlugin(deps), 0);
	t.is(links.get(AGY_LINK), PLUGIN_DIR);
});

test('repoints an agy link left by another checkout', t => {
	const {deps, links} = fakeDeps({agy: true});
	links.set(AGY_LINK, '/old/checkout/plugins/pappardelle');
	t.is(installPlugin(deps), 0);
	t.is(links.get(AGY_LINK), PLUGIN_DIR);
});

test('warns when agy has the plugin disabled', t => {
	const {deps, files, printed} = fakeDeps({agy: true});
	files.set(
		`${AGY}/config.json`,
		JSON.stringify({plugins: {pappardelle: {enabled: false}}}),
	);
	t.is(installPlugin(deps), 0);
	t.true(printed.some(line => line.includes('agy plugin enable pappardelle')));
});

test('skips agy until it has been set up', t => {
	const {deps, links, printed} = fakeDeps();
	t.is(installPlugin(deps), 0);
	t.is(links.size, 0);
	t.true(printed.some(line => line.includes('agy is not set up')));
});

test('leaves a copy agy installed itself and fails with how to replace it', t => {
	const {deps, links, dirs, printed} = fakeDeps({agy: true});
	dirs.add(AGY_LINK);
	t.is(installPlugin(deps), 1);
	t.false(links.has(AGY_LINK));
	t.true(printed.some(line => line.includes('agy plugin uninstall')));
});

test('removes only the old Pappardelle hooks from settings, keeping a backup', t => {
	const original = JSON.stringify({
		model: 'opus',
		hooks: {
			PreCompact: [
				{matcher: 'auto', hooks: [legacy('update-status.py')]},
				{matcher: 'manual', hooks: [legacy('update-status.py'), mine]},
			],
			Stop: [{hooks: [legacy('update-status.py')]}],
			SessionStart: [{hooks: [mine]}],
		},
	});
	const {deps, files} = fakeDeps({settings: original});
	t.is(installPlugin(deps), 0);
	t.deepEqual(JSON.parse(files.get(SETTINGS)!), {
		model: 'opus',
		hooks: {
			PreCompact: [{matcher: 'manual', hooks: [mine]}],
			SessionStart: [{hooks: [mine]}],
		},
	});
	t.is(files.get(`${SETTINGS}.pappardelle.bak`), original);
});

test('backs up settings as they were before claude rewrote them', t => {
	const original = JSON.stringify({hooks: {Stop: [{hooks: [legacy('x.py')]}]}});
	const {deps, files} = fakeDeps({settings: original});
	const {run} = deps;
	deps.run = (command, args) => {
		if (args[1] === 'marketplace') {
			const settings = JSON.parse(files.get(SETTINGS)!) as object;
			files.set(
				SETTINGS,
				JSON.stringify({...settings, extraKnownMarketplaces: {}}),
			);
		}

		return run(command, args);
	};

	t.is(installPlugin(deps), 0);
	t.is(files.get(`${SETTINGS}.pappardelle.bak`), original);
	t.deepEqual(JSON.parse(files.get(SETTINGS)!), {extraKnownMarketplaces: {}});
});

test('drops the hooks key when only Pappardelle hooks were configured', t => {
	const {deps, files} = fakeDeps({
		settings: JSON.stringify({
			model: 'opus',
			hooks: {Stop: [{hooks: [legacy('update-status.py')]}]},
		}),
	});
	installPlugin(deps);
	t.deepEqual(JSON.parse(files.get(SETTINGS)!), {model: 'opus'});
});

test('leaves settings without old hooks untouched', t => {
	const settings = JSON.stringify({hooks: {SessionStart: [{hooks: [mine]}]}});
	const {deps, files} = fakeDeps({settings});
	t.is(installPlugin(deps), 0);
	t.is(files.get(SETTINGS), settings);
	t.false(files.has(`${SETTINGS}.pappardelle.bak`));
});

test('keeps hook groups it does not recognise', t => {
	const {deps, files} = fakeDeps({
		settings: JSON.stringify({
			hooks: {Stop: [null, {hooks: [legacy('update-status.py')]}]},
		}),
	});
	t.is(installPlugin(deps), 0);
	t.deepEqual(JSON.parse(files.get(SETTINGS)!), {hooks: {Stop: [null]}});
});

test('leaves unparseable settings alone and still succeeds', t => {
	const {deps, files, printed} = fakeDeps({settings: '{not json'});
	t.is(installPlugin(deps), 0);
	t.is(files.get(SETTINGS), '{not json');
	t.true(printed.some(line => line.includes('by hand')));
});

test('warns that removing the worktree it installed from drops the plugin', t => {
	const fromWorktree = fakeDeps({worktree: true});
	installPlugin(fromWorktree.deps);
	t.true(fromWorktree.printed.some(line => line.includes('git worktree')));

	const fromMain = fakeDeps();
	installPlugin(fromMain.deps);
	t.false(fromMain.printed.some(line => line.includes('git worktree')));
});
