import {test, expect} from 'bun:test';
import {trackerIssue} from '../test/helpers/space-fixtures.ts';
import {teardown} from '../test/helpers/teardown.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readConfig, type PappardelleConfig} from './config.ts';
import {
	defaultCloseHooksDeps,
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

const names = (commands: Array<{name: string}>) =>
	commands.map(command => command.name);

test('a project match picks its profile over a title keyword match', () => {
	const commands = resolveDeinitCommands(
		config,
		trackerIssue({title: 'music player', project: {name: 'The Hive'}}),
	);
	expect(names(commands)).toStrictEqual(['global', 'hive']);
});

test('the title picks the profile when no project matches', () => {
	const commands = resolveDeinitCommands(
		config,
		trackerIssue({title: 'music player', project: {name: 'Elsewhere'}}),
	);
	expect(names(commands)).toStrictEqual(['global', 'jams']);
});

test('without an issue only the global hooks run', () => {
	expect(names(resolveDeinitCommands(config, null))).toStrictEqual(['global']);
});

test('runCloseHooks passes the space key and repo context to the hooks', async () => {
	const calls: unknown[] = [];
	const result = await runCloseHooks(
		{name: 'STA-1', worktreePath: '/wt/STA-1', trackerIssue: null},
		{
			readConfig: () => ({kind: 'valid', config}),
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
	expect(result).toStrictEqual({kind: 'failed', failedCommand: 'global'});
	expect(calls).toStrictEqual([
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

test('an invalid config skips the deinit commands and says why', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pappardelle-close-'));
	teardown(() => {
		fs.rmSync(dir, {recursive: true, force: true});
	});
	const marker = path.join(dir, 'deinit-ran');
	fs.writeFileSync(
		path.join(dir, '.pappardelle.yml'),
		`version: 1
profiles: {}
pre_workspace_deinit:
  - name: mark
    run: touch ${marker}
agent_profiles:
  opus:
    command: claude
    model: 7
`,
	);
	const result = await runCloseHooks(
		{name: 'STA-1', worktreePath: dir, trackerIssue: null},
		{
			...defaultCloseHooksDeps,
			readConfig: () =>
				readConfig({homeConfigDir: path.join(dir, 'home'), projectDir: dir}),
		},
	);
	expect(result.kind).toBe('config-invalid');
	expect(
		result.kind === 'config-invalid' &&
			result.errors.some(error => error.includes('agent_profiles.opus.model')),
	).toBe(true);
	expect(fs.existsSync(marker)).toBe(false);
});

test('a row the registry no longer lists is not attached', () => {
	expect(shouldAttach({name: 'STA-1'}, ['STA-2'])).toBe(false);
});

test('registered, main, and pending rows attach, as does an unreadable registry', () => {
	expect(shouldAttach({name: 'STA-1'}, ['STA-1'])).toBe(true);
	expect(shouldAttach({name: 'main', isMainWorktree: true}, [])).toBe(true);
	expect(shouldAttach({name: 'STA-3', isPending: true}, [])).toBe(true);
	expect(shouldAttach({name: 'STA-1'}, null)).toBe(true);
});
