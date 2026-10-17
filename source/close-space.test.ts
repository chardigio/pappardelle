import test from 'ava';
import type {PappardelleConfig} from './config.ts';
import type {TrackerIssue} from './providers/types.ts';
import {
	resolveDeinitCommands,
	runCloseHooks,
	shouldAttach,
} from './close-space.ts';

const config: PappardelleConfig = {
	version: 1,
	pre_workspace_deinit: [{name: 'global', run: 'echo global'}],
	profiles: {
		hive: {
			display_name: 'King Bee',
			keywords: ['bee'],
			tracker_projects: ['The Hive'],
			pre_workspace_deinit: [{name: 'hive', run: 'echo hive'}],
		},
		jams: {
			display_name: 'Stardust Jams',
			keywords: ['music'],
			pre_workspace_deinit: [{name: 'jams', run: 'echo jams'}],
		},
	},
};

function issue(fields: Partial<TrackerIssue>): TrackerIssue {
	return {
		identifier: 'STA-1',
		title: '',
		state: {name: 'Todo', type: 'unstarted', color: '#fff'},
		...fields,
	};
}

const names = (commands: Array<{name: string}>) =>
	commands.map(command => command.name);

test('a project match picks its profile over a title keyword match', t => {
	const commands = resolveDeinitCommands(
		config,
		issue({title: 'music player', project: {name: 'The Hive'}}),
	);
	t.deepEqual(names(commands), ['global', 'hive']);
});

test('the title picks the profile when no project matches', t => {
	const commands = resolveDeinitCommands(
		config,
		issue({title: 'music player', project: {name: 'Elsewhere'}}),
	);
	t.deepEqual(names(commands), ['global', 'jams']);
});

test('without an issue only the global hooks run', t => {
	t.deepEqual(names(resolveDeinitCommands(config, null)), ['global']);
});

test('runCloseHooks passes the space key and repo context to the hooks', async t => {
	const calls: unknown[] = [];
	const result = await runCloseHooks(
		{name: 'STA-1', worktreePath: '/wt/STA-1', trackerIssue: null},
		{
			loadConfig: () => config,
			async runDeinit(commands, worktreePath, context) {
				calls.push({commands: names(commands), worktreePath, context});
				return {success: false, failedCommand: 'global'};
			},
			context: () => ({
				repoRoot: '/repo',
				mainRepoRoot: '/repo',
				repoName: 'r',
			}),
		},
	);
	t.deepEqual(result, {success: false, failedCommand: 'global'});
	t.deepEqual(calls, [
		{
			commands: ['global'],
			worktreePath: '/wt/STA-1',
			context: {
				issueKey: 'STA-1',
				repoRoot: '/repo',
				mainRepoRoot: '/repo',
				repoName: 'r',
			},
		},
	]);
});

test('a config that fails to load does not block the close', async t => {
	const result = await runCloseHooks(
		{name: 'STA-1', worktreePath: '/wt/STA-1', trackerIssue: null},
		{
			loadConfig() {
				throw new Error('bad yaml');
			},
			async runDeinit() {
				t.fail('no hooks to run');
				return {success: true};
			},
			context: () => ({}),
		},
	);
	t.deepEqual(result, {success: true});
});

test('a row the registry no longer lists is not attached', t => {
	t.false(shouldAttach({name: 'STA-1'}, ['STA-2']));
});

test('registered, main, and pending rows attach, as does an unreadable registry', t => {
	t.true(shouldAttach({name: 'STA-1'}, ['STA-1']));
	t.true(shouldAttach({name: 'main', isMainWorktree: true}, []));
	t.true(shouldAttach({name: 'STA-3', isPending: true}, []));
	t.true(shouldAttach({name: 'STA-1'}, null));
});
