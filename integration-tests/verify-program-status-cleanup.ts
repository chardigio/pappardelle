import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {
	defaultCloseCommandDeps,
	runCloseCommand,
	runCloseTeardown,
} from '../source/close-command.ts';
import {getRepoName} from '../source/config.ts';
import {
	attachStatusMonitor,
	programStatusPath,
	readProgramSnapshot,
	statusTmuxArgs,
} from '../source/program-status-monitor.ts';
import {
	addSpace,
	getRegisteredSpaces,
	setRegistryPath,
} from '../source/space-registry.ts';
import {cleanupOrphanedInnerSessions, getSessionNames} from '../source/tmux.ts';
import {StatusHarness, until} from './program-status-harness.ts';

const harness = new StatusHarness();
const originalDirectory = process.cwd();
const originalPath = process.env['PATH'];
try {
	execFileSync('git', ['init', '--quiet', harness.root]);
	process.chdir(harness.root);
	setRegistryPath(path.join(harness.root, 'open-spaces.json'));
	const bin = path.join(harness.root, 'bin');
	mkdirSync(bin);
	const xcrun = "#!/bin/sh\nprintf '%s\\n' '{\"devices\":{}}'\n";
	execFileSync('shellcheck', ['-s', 'sh', '-'], {input: xcrun});
	writeFileSync(path.join(bin, 'xcrun'), xcrun, {mode: 0o755});
	process.env['PATH'] = `${bin}:${originalPath ?? ''}`;
	const repo = getRepoName();
	const sentinelFiles = [
		programStatusPath(repo, 'qa-cleanup-normal-sibling', 'a'.repeat(32)),
		programStatusPath(`${repo}-other`, 'qa-cleanup-normal', 'b'.repeat(32)),
	];
	for (const file of sentinelFiles) {
		mkdirSync(path.dirname(file), {recursive: true});
		writeFileSync(file, 'other workspace message');
		writeFileSync(`${file}.lease`, '');
	}
	const findings: string[] = [];
	for (const mode of ['normal', 'detached', 'orphan'] as const) {
		const key = `qa-cleanup-${mode}`;
		const session = getSessionNames(key, repo).agent;
		await harness.tmux([
			'new-session',
			'-d',
			'-s',
			session,
			'-c',
			harness.root,
			'/bin/bash',
		]);
		const pane = await attachStatusMonitor(repo, key, session);
		assert.ok(pane);
		await harness.fixture(session);
		await until(
			() => readProgramSnapshot(repo, key, pane),
			value => value?.info.status === 'idle',
			`${mode} recorded idle report`,
		);
		const target = programStatusPath(repo, key, pane.generation);
		assert.ok(readFileSync(target, 'utf8').includes('fixture'));
		if (mode === 'orphan') {
			assert.equal(
				cleanupOrphanedInnerSessions(new Set(), repo, undefined, []),
				1,
			);
		} else {
			await addSpace(key);
			const deps = {
				...defaultCloseCommandDeps(),
				async getIssue() {
					return null;
				},
				async runHooks() {
					return {success: true};
				},
				worktreePath: () => harness.root,
				currentInnerSession: () => null,
			};
			assert.equal(
				mode === 'normal'
					? await runCloseCommand({key, yes: true}, deps)
					: await runCloseTeardown(key, deps),
				0,
			);
			assert.ok(!getRegisteredSpaces().includes(key));
		}
		const retained = existsSync(target) || existsSync(`${target}.lease`);
		if (retained) findings.push(mode);
		console.log(
			`${retained ? 'FAIL' : 'PASS'} ${mode} close removes snapshot and lease`,
		);
	}
	assert.deepEqual(findings, []);
	for (const file of sentinelFiles) {
		assert.equal(readFileSync(file, 'utf8'), 'other workspace message');
		assert.ok(existsSync(`${file}.lease`));
	}
	console.log(
		'PASS cleanup preserves sibling workspace and repository snapshots',
	);
	const key = 'qa-cleanup-failed';
	const sessions = getSessionNames(key, repo);
	for (const session of [sessions.agent, sessions.companion])
		await harness.tmux(['new-session', '-d', '-s', session, '/bin/bash']);
	const pane = await attachStatusMonitor(repo, key, sessions.agent);
	assert.ok(pane);
	await harness.fixture(sessions.agent);
	await until(
		() => readProgramSnapshot(repo, key, pane),
		value => value?.info.status === 'idle',
		'failed close recorded idle report',
	);
	const target = programStatusPath(repo, key, pane.generation);
	assert.equal(
		cleanupOrphanedInnerSessions(
			new Set(),
			repo,
			args => {
				if (
					args[0] === 'kill-session' &&
					args.includes(`=${sessions.companion}:`)
				)
					return {status: 1, stdout: '', stderr: 'injected kill failure'};
				const result = spawnSync('tmux', statusTmuxArgs([...args]), {
					encoding: 'utf8',
				});
				return {
					status: result.status,
					stdout: result.stdout,
					stderr: result.stderr,
					error: result.error,
				};
			},
			[],
		),
		1,
	);
	assert.ok(existsSync(target));
	assert.ok(existsSync(`${target}.lease`));
	assert.equal(cleanupOrphanedInnerSessions(new Set(), repo, undefined, []), 1);
	assert.ok(!existsSync(target));
	assert.ok(!existsSync(`${target}.lease`));
	console.log(
		'PASS partial orphan teardown preserves snapshots until retry succeeds',
	);
} finally {
	process.chdir(originalDirectory);
	process.env['PATH'] = originalPath;
	await harness.cleanup();
}
