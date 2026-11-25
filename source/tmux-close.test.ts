import {test, expect, beforeAll, afterAll} from 'bun:test';
import {unreachable} from '../test/helpers/unreachable.ts';
import {tearDownSpace} from './space-utils.ts';
import {innerKillSession, killSpaceSessions, innerTmuxArgs} from './tmux.ts';
import {testTmuxState} from '../test/helpers/state.ts';

// tmux.ts names a space's sessions from the stores. Without the database they
// are the names idow gives a space, which is all this file needs.
const stateTeardowns: Array<() => unknown> = [];
beforeAll(() => {
	testTmuxState({
		cleanup: fn => stateTeardowns.push(fn),
		repo: 'fixture',
		sqlite: false,
	});
});
afterAll(async () => {
	for (const step of stateTeardowns.reverse()) await step();
});

test('kill targets exact inner sessions without probing first', async () => {
	const calls: string[][] = [];
	expect(
		await innerKillSession('claude-repo-A', async args => {
			calls.push(args);
			return '';
		}),
	).toBe(true);
	expect(calls).toStrictEqual([
		innerTmuxArgs(['kill-session', '-t', '=claude-repo-A:']),
	]);
});

for (const stderr of [
	"can't find session: claude-repo-A",
	'no server running on /tmp/test-socket',
	'error connecting to /tmp/test-socket (No such file or directory)',
	'server exited unexpectedly',
	'no current target',
]) {
	test(`already absent sessions close successfully: ${stderr}`, async () => {
		expect(
			await innerKillSession('claude-repo-A', async () => {
				throw Object.assign(new Error(stderr), {code: 1, stderr});
			}),
		).toBe(true);
	});
}

for (const error of [
	Object.assign(new Error('missing tmux'), {code: 'ENOENT'}),
	Object.assign(new Error('permission denied'), {
		code: 1,
		stderr: 'error connecting to /tmp/socket (Permission denied)',
	}),
	Object.assign(new Error('timed out'), {
		code: 1,
		stderr: "can't find session: A",
		killed: true,
		signal: 'SIGTERM',
	}),
]) {
	test(`real kill failures are reported: ${error.message}`, async () => {
		expect(
			await innerKillSession('claude-repo-A', async () => {
				throw error;
			}),
		).toBe(false);
	});
}

test('a failed session kill does not schedule simulator cleanup', async () => {
	const calls: string[][] = [];
	const result = await tearDownSpace('A', {
		async markClosing() {},
		async reopen() {},
		async killSpaceSessions(key) {
			return killSpaceSessions(key, {
				async run(args) {
					calls.push(args);
					if (args.includes('=companion-fixture-A:'))
						throw new Error('kill failed');
					return '';
				},
			});
		},
		removeSpace() {
			unreachable('failed kill must remain registered');
		},
		onKillFailure() {},
		async cleanup() {
			unreachable('workspace is still open');
			return true;
		},
	});
	expect(result.outcome).toBe('kill-failed');
	// The companion's splits are listed first, then the companion is killed.
	expect(calls.length).toBe(2);
	expect(calls[0]!.includes('list-sessions')).toBe(true);
	expect(calls[1]!.includes('=companion-fixture-A:')).toBe(true);
});

test('successful session close returns while simulator cleanup is still pending', async () => {
	let finish = (_success: boolean) => {};
	const cleaning = new Promise<boolean>(resolve => {
		finish = resolve;
	});
	let started = false;
	const result = await tearDownSpace('A', {
		async markClosing() {},
		async reopen() {},
		async killSpaceSessions() {
			return true;
		},
		async removeSpace() {
			await Promise.resolve();
		},
		onKillFailure() {
			unreachable('kill should succeed');
		},
		async cleanup() {
			started = true;
			return cleaning;
		},
	});
	expect(result.outcome).toBe('closed');
	expect(started).toBe(true);
	finish(false);
	await cleaning;
});

test('simulator cleanup rejection is nonfatal to session close', async () => {
	const result = await tearDownSpace('A', {
		async markClosing() {},
		async reopen() {},
		async killSpaceSessions() {
			return true;
		},
		removeSpace() {},
		onKillFailure() {
			unreachable('kill should succeed');
		},
		async cleanup() {
			throw new Error('xcrun failed');
		},
	});
	expect(result.outcome).toBe('closed');
});
