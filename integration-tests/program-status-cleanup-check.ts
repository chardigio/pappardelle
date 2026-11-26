import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {
	defaultCloseCommandDeps,
	runCloseCommand,
	runCloseTeardown,
} from '../source/close-command.ts';
import {getRepoName} from '../source/config.ts';
import {
	programStatusPath,
	statusSocket,
	statusTmuxArgs,
} from '../source/program-status-monitor.ts';
import {newSpaceIdentity, sessionNamesFor} from '../source/space-identity.ts';
import {listOpenSpaces} from '../source/space-registry.ts';
import {createStateDaos} from '../source/state-daos.ts';
import {cleanupOrphanedInnerSessions, initTmuxState} from '../source/tmux.ts';
import {StatusHarness, untilSeen} from './program-status-harness.ts';

const harness = new StatusHarness();
const originalDirectory = process.cwd();
const originalPath = process.env['PATH'];
try {
	execFileSync('git', ['init', '--quiet', harness.root]);
	process.chdir(harness.root);
	const daos = createStateDaos({
		repo: getRepoName(),
		stateDir: path.join(harness.root, 'state'),
	});
	initTmuxState(daos);
	const bin = path.join(harness.root, 'bin');
	mkdirSync(bin);
	const xcrun = "#!/bin/sh\nprintf '%s\\n' '{\"devices\":{}}'\n";
	execFileSync('shellcheck', ['-s', 'sh', '-'], {input: xcrun});
	writeFileSync(path.join(bin, 'xcrun'), xcrun, {mode: 0o755});
	process.env['PATH'] = `${bin}:${originalPath ?? ''}`;
	const repo = getRepoName();
	const sentinelLeases = [
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
	].map(file => `${file}.lease`);
	for (const file of sentinelLeases) {
		mkdirSync(path.dirname(file), {recursive: true});
		writeFileSync(file, '');
	}
	/** Whether the status daemon holds the pane's snapshot. */
	const published = async (key: string) =>
		(await harness.heldSnapshots(repo, key)) > 0;
	// No space is open, and none of these sessions is main's.
	const nothing = {names: new Set<string>(), keys: new Set<string>()};
	for (const mode of ['normal', 'detached', 'orphan'] as const) {
		const key = `qa-cleanup-${mode}`;
		const session = sessionNamesFor(key, repo).agent;
		// As idow records it: close finds the space's sessions by these names.
		await daos.spaceIdentities.record(
			newSpaceIdentity({
				repo,
				key,
				worktreePath: harness.root,
				socket: statusSocket(),
			}),
		);
		// Every creator sets the space on its sessions, which is how the reaper
		// knows whose status an orphan leaves behind.
		await harness.tmux([
			'new-session',
			'-d',
			'-s',
			session,
			'-c',
			harness.root,
			'-e',
			`PAPPARDELLE_SPACE=${key}`,
			'/bin/bash',
		]);
		const pane = await daos.programStatus.attach(key, session);
		assert.ok(pane);
		await harness.fixture(session);
		await untilSeen(
			async () => daos.programStatus.read(key, pane),
			value => value?.info.status === 'idle',
			`${mode} recorded idle report`,
		);
		const lease = `${programStatusPath(harness.statusDir(repo), key, pane.generation)}.lease`;
		assert.ok(await published(key));
		if (mode === 'orphan') {
			assert.equal(
				cleanupOrphanedInnerSessions(nothing, repo, undefined, []),
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
					return {kind: 'ran' as const};
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
		// Revocation is synchronous, and the daemon forgets the snapshot after.
		assert.ok(!existsSync(lease), `${mode} revokes the lease`);
		await untilSeen(
			async () => harness.heldSnapshots(repo, key),
			held => held === 0,
			`${mode} close forgets the snapshot`,
		);
		console.log(`PASS ${mode} close removes snapshot and lease`);
	}
	for (const file of sentinelLeases) assert.ok(existsSync(file));
	console.log('PASS cleanup preserves sibling workspace and repository leases');
	const key = 'qa-cleanup-failed';
	const sessions = sessionNamesFor(key, repo);
	await daos.spaceIdentities.record(
		newSpaceIdentity({
			repo,
			key,
			worktreePath: harness.root,
			socket: statusSocket(),
		}),
	);
	for (const session of [sessions.agent, sessions.companion])
		await harness.tmux([
			'new-session',
			'-d',
			'-s',
			session,
			'-e',
			`PAPPARDELLE_SPACE=${key}`,
			'/bin/bash',
		]);
	const pane = await daos.programStatus.attach(key, sessions.agent);
	assert.ok(pane);
	await harness.fixture(sessions.agent);
	await untilSeen(
		async () => daos.programStatus.read(key, pane),
		value => value?.info.status === 'idle',
		'failed close recorded idle report',
	);
	const lease = `${programStatusPath(harness.statusDir(repo), key, pane.generation)}.lease`;
	assert.equal(
		cleanupOrphanedInnerSessions(
			nothing,
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
	assert.ok(await published(key));
	assert.ok(existsSync(lease));
	assert.equal(cleanupOrphanedInnerSessions(nothing, repo, undefined, []), 1);
	assert.ok(!existsSync(lease));
	await untilSeen(
		async () => harness.heldSnapshots(repo, key),
		held => held === 0,
		'retried orphan cleanup removes its snapshot',
	);
	console.log(
		'PASS partial orphan teardown preserves snapshots until retry succeeds',
	);
} finally {
	process.chdir(originalDirectory);
	process.env['PATH'] = originalPath;
	await harness.cleanup();
}
