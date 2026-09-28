import test from 'ava';
import {tearDownSpace} from './space-utils.ts';
import {innerKillSession, killSpaceSessions, innerTmuxArgs} from './tmux.ts';

test('kill targets exact inner sessions without probing first', async t => {
	const calls: string[][] = [];
	t.true(
		await innerKillSession('claude-repo-A', async args => {
			calls.push(args);
			return '';
		}),
	);
	t.deepEqual(calls, [innerTmuxArgs(['kill-session', '-t', '=claude-repo-A'])]);
});

for (const stderr of [
	"can't find session: claude-repo-A",
	'no server running on /tmp/test-socket',
	'error connecting to /tmp/test-socket (No such file or directory)',
]) {
	test(`already absent sessions close successfully: ${stderr}`, async t => {
		t.true(
			await innerKillSession('claude-repo-A', async () => {
				throw Object.assign(new Error(stderr), {code: 1, stderr});
			}),
		);
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
	test(`real kill failures are reported: ${error.message}`, async t => {
		t.false(
			await innerKillSession('claude-repo-A', async () => {
				throw error;
			}),
		);
	});
}

test('a failed session kill does not schedule simulator cleanup', async t => {
	const calls: string[][] = [];
	const result = await tearDownSpace('A', {
		async killSpaceSessions(key) {
			return killSpaceSessions(key, {
				repoName: 'fixture',
				async run(args) {
					calls.push(args);
					if (args.includes('=companion-fixture-A'))
						throw new Error('kill failed');
					return '';
				},
			});
		},
		removeSpace() {
			t.fail('failed kill must remain registered');
		},
		onKillFailure() {},
		async cleanup() {
			t.fail('workspace is still open');
			return true;
		},
	});
	t.false(result);
	t.is(calls.length, 1);
	t.true(calls[0]!.includes('=companion-fixture-A'));
});

test('successful session close returns while simulator cleanup is still pending', async t => {
	let finish = (_success: boolean) => {};
	const cleaning = new Promise<boolean>(resolve => {
		finish = resolve;
	});
	let started = false;
	t.true(
		await tearDownSpace('A', {
			async killSpaceSessions() {
				return true;
			},
			async removeSpace() {
				await Promise.resolve();
			},
			onKillFailure() {
				t.fail('kill should succeed');
			},
			async cleanup() {
				started = true;
				return cleaning;
			},
		}),
	);
	t.true(started);
	finish(false);
	await cleaning;
});

test('simulator cleanup rejection is nonfatal to session close', async t => {
	t.true(
		await tearDownSpace('A', {
			async killSpaceSessions() {
				return true;
			},
			removeSpace() {},
			onKillFailure() {
				t.fail('kill should succeed');
			},
			async cleanup() {
				throw new Error('xcrun failed');
			},
		}),
	);
});
