import test from 'ava';
import {
	installPlugin,
	type PluginInstallDeps,
	type RunResult,
} from './plugin-install.ts';

const REPO = '/home/me/.pappardelle/repo';
const SETTINGS = '/home/me/.claude/settings.json';

const legacy = (script: string) => ({
	type: 'command',
	command: `python3 ~/.pappardelle/hooks/${script}`,
});
const mine = {type: 'command', command: 'bd prime'};

function fakeDeps(
	options: {settings?: string; respond?: (args: string[]) => RunResult} = {},
) {
	const calls: string[] = [];
	const files = new Map<string, string>();
	if (options.settings !== undefined) files.set(SETTINGS, options.settings);
	const printed: string[] = [];
	const deps: PluginInstallDeps = {
		repoDir: REPO,
		settingsPath: SETTINGS,
		run(command, args) {
			calls.push([command, ...args].join(' '));
			return options.respond?.(args) ?? {status: 0};
		},
		readFile: file => files.get(file),
		writeFile(file, content) {
			files.set(file, content);
		},
		print(line) {
			printed.push(line);
		},
	};
	return {deps, calls, files, printed};
}

test('points the marketplace at the checkout, then installs the plugin for the user', t => {
	const {deps, calls} = fakeDeps();
	t.is(installPlugin(deps), 0);
	t.deepEqual(calls, [
		`claude plugin marketplace add ${REPO}`,
		'claude plugin install pappardelle@pappardelle-marketplace --scope user',
	]);
});

test('without the claude CLI it fails with a hint and leaves the old hooks running', t => {
	const settings = JSON.stringify({hooks: {Stop: [{hooks: [legacy('x.py')]}]}});
	const {deps, files, printed} = fakeDeps({
		settings,
		respond: () => ({
			status: null,
			error: Object.assign(new Error('spawn claude ENOENT'), {code: 'ENOENT'}),
		}),
	});
	t.is(installPlugin(deps), 1);
	t.true(printed[0]!.includes('not on PATH'));
	t.is(files.get(SETTINGS), settings);
});

test('a failed marketplace add skips the install and the hook cleanup', t => {
	const {deps, calls, files} = fakeDeps({
		settings: JSON.stringify({hooks: {Stop: [{hooks: [legacy('x.py')]}]}}),
		respond: args => (args[1] === 'marketplace' ? {status: 1} : undefined),
	});
	t.is(installPlugin(deps), 1);
	t.is(calls.length, 1);
	t.false(files.has(`${SETTINGS}.bak`));
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
	t.is(files.get(`${SETTINGS}.bak`), original);
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
	t.false(files.has(`${SETTINGS}.bak`));
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
