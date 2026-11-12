import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {
	defaultCloseCommandDeps,
	runCloseCommand,
	runCloseTeardown,
} from '../source/close-command.ts';
import {getRepoName} from '../source/config.ts';
import {
	programStatusPath,
	statusTmuxArgs,
} from '../source/program-status-monitor.ts';
import {listOpenSpaces} from '../source/space-registry.ts';
import {createStateDaos} from '../source/state-daos.ts';
import {
	cleanupOrphanedInnerSessions,
	getSessionNames,
	initTmuxState,
} from '../source/tmux.ts';
import {StatusHarness, until} from './program-status-harness.ts';

const harness = new StatusHarness();
const originalDirectory = process.cwd();
const originalPath = process.env['PATH'];
try {
	execFileSync('git', ['init', '--quiet', harness.root]);
	process.chdir(harness.root);
	const daos = createStateDaos({
		repo: getRepoName(),
		stateDir: path.join(harness.root, 'state'),
		sqlite: process.env['PAPPARDELLE_SQLITE_STATE'] === '1',
	});
	initTmuxState(daos);
	const bin = path.join(harness.root, 'bin');
	mkdirSync(bin);
	const xcrun = "#!/bin/sh\nprintf '%s\\n' '{\"devices\":{}}'\n";
	execFileSync('shellcheck', ['-s', 'sh', '-'], {input: xcrun});
	writeFileSync(path.join(bin, 'xcrun'), xcrun, {mode: 0o755});
	process.env['PATH'] = `${bin}:${originalPath ?? ''}`;
	const repo = getRepoName();
	const sentinelFiles = [
		programStatusPath(
			harness.statusDir(repo),
			'qa-cleanup-normal-sibling',
			'a'.repeat(32),
		),
		programStatusPath(
			harness.statusDir(`${repo}-other`),
			'qa-cleanup-normal',
			'b'.repeat(32),
		),
	];
	for (const file of sentinelFiles) {
		mkdirSync(path.dirname(file), {recursive: true});
		writeFileSync(file, 'other workspace message');
		writeFileSync(`${file}.lease`, '');
	}
	/**
	 * Whether the pane's snapshot is where its monitor publishes it: its file,
	 * or with the flag on the status daemon.
	 */
	const published = async (key: string, target: string) =>
		harness.sqlite
			? (await harness.heldSnapshots(repo, key)) > 0
			: existsSync(target);
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
		const pane = await daos.programStatus.attach(key, session);
		assert.ok(pane);
		await harness.fixture(session);
		await until(
			async () => daos.programStatus.read(key, pane),
			value => value?.info.status === 'idle',
			`${mode} recorded idle report`,
		);
		const target = programStatusPath(
			harness.statusDir(repo),
			key,
			pane.generation,
		);
		if (harness.sqlite) assert.ok(await published(key, target));
		else assert.ok(readFileSync(target, 'utf8').includes('fixture'));
		if (mode === 'orphan') {
			assert.equal(
				cleanupOrphanedInnerSessions(new Set(), repo, undefined, []),
				1,
			);
		} else {
			await daos.registry.add(key);
			const deps = {
				...defaultCloseCommandDeps(daos),
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
			assert.ok(!listOpenSpaces(daos.registry).includes(key));
		}
		// Revocation is synchronous. An already-running publisher can rename its
		// snapshot afterwards, then remove it when its final lease check fails.
		assert.ok(!existsSync(`${target}.lease`), `${mode} revokes the lease`);
		await until(
			() => existsSync(target),
			retained => !retained,
			`${mode} in-flight publisher removes its snapshot`,
		);
		// The publisher's rename and its removal are two steps, so its file can
		// appear for a moment after it was first seen gone.
		await delay(300);
		const retained =
			existsSync(target) ||
			existsSync(`${target}.lease`) ||
			(await harness.heldSnapshots(repo, key)) > 0;
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
	const pane = await daos.programStatus.attach(key, sessions.agent);
	assert.ok(pane);
	await harness.fixture(sessions.agent);
	await until(
		async () => daos.programStatus.read(key, pane),
		value => value?.info.status === 'idle',
		'failed close recorded idle report',
	);
	const target = programStatusPath(
		harness.statusDir(repo),
		key,
		pane.generation,
	);
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
	assert.ok(await published(key, target));
	assert.ok(existsSync(`${target}.lease`));
	assert.equal(cleanupOrphanedInnerSessions(new Set(), repo, undefined, []), 1);
	assert.ok(!existsSync(`${target}.lease`));
	await until(
		async () =>
			existsSync(target) || (await harness.heldSnapshots(repo, key)) > 0,
		retained => !retained,
		'retried orphan cleanup removes its snapshot',
	);
	// What is left under the harness's root is checked when it is cleaned up.
	for (const file of sentinelFiles) rmSync(file);
	console.log(
		'PASS partial orphan teardown preserves snapshots until retry succeeds',
	);
} finally {
	process.chdir(originalDirectory);
	process.env['PATH'] = originalPath;
	await harness.cleanup();
}
