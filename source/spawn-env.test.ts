import {test, expect} from 'bun:test';
import {buildSessionEnvArgs, buildSpawnEnv} from './spawn-env.ts';
import {MAIN_WORKTREE_KEY} from './space-utils.ts';

test('buildSpawnEnv includes PAPPARDELLE_PROJECT_ROOT', () => {
	const env = buildSpawnEnv('/tmp/fake-project', {registerSpace: false});
	expect(env['PAPPARDELLE_PROJECT_ROOT']).toBe('/tmp/fake-project');
});

test('buildSpawnEnv preserves existing env vars', () => {
	const env = buildSpawnEnv('/tmp/fake-project', {registerSpace: false});
	// Should still have PATH from process.env
	expect(env['PATH']).toBeTruthy();
});

test('buildSpawnEnv does not mutate process.env', () => {
	const before = process.env['PAPPARDELLE_PROJECT_ROOT'];
	buildSpawnEnv('/tmp/fake-project', {registerSpace: false});
	expect(process.env['PAPPARDELLE_PROJECT_ROOT']).toBe(before);
});

test('buildSpawnEnv passes the main repo root when given one', () => {
	const env = buildSpawnEnv('/tmp/fake-project', {
		mainRepoRoot: '/tmp/fake-main',
		registerSpace: false,
	});
	expect(env['PAPPARDELLE_MAIN_REPO_ROOT']).toBe('/tmp/fake-main');
});

test('buildSpawnEnv omits the main repo root when there is none', () => {
	const before = process.env['PAPPARDELLE_MAIN_REPO_ROOT'];
	delete process.env['PAPPARDELLE_MAIN_REPO_ROOT'];
	try {
		expect(
			'PAPPARDELLE_MAIN_REPO_ROOT' in
				buildSpawnEnv('/tmp/fake-project', {registerSpace: false}),
		).toBe(false);
	} finally {
		if (before !== undefined)
			process.env['PAPPARDELLE_MAIN_REPO_ROOT'] = before;
	}
});

// idow starts the binary to record the space only when it is told to. A
// registry that keeps no lifecycle has nothing to record.
test('buildSpawnEnv tells idow to record the space only for a registry that records spaces being set up', () => {
	const before = process.env['PAPPARDELLE_REGISTER_SPACE'];
	// What a Pappardelle started from inside another one's session inherits.
	process.env['PAPPARDELLE_REGISTER_SPACE'] = '1';
	try {
		expect(
			buildSpawnEnv('/tmp/fake-project', {registerSpace: true})[
				'PAPPARDELLE_REGISTER_SPACE'
			],
		).toBe('1');
		expect(
			buildSpawnEnv('/tmp/fake-project', {registerSpace: false})[
				'PAPPARDELLE_REGISTER_SPACE'
			],
		).toBe(undefined);
	} finally {
		if (before === undefined) delete process.env['PAPPARDELLE_REGISTER_SPACE'];
		else process.env['PAPPARDELLE_REGISTER_SPACE'] = before;
	}
});

test('buildSessionEnvArgs names the space and its repo for an issue space', () => {
	expect(buildSessionEnvArgs('STA-42', 'repo')).toStrictEqual([
		'-e',
		'PAPPARDELLE_REPO=repo',
		'-e',
		'PAPPARDELLE_SPACE=STA-42',
	]);
});

test('buildSessionEnvArgs adds the main repo root when given one', () => {
	expect(buildSessionEnvArgs('STA-42', 'repo', '/tmp/fake-main')).toStrictEqual(
		[
			'-e',
			'PAPPARDELLE_REPO=repo',
			'-e',
			'PAPPARDELLE_SPACE=STA-42',
			'-e',
			'PAPPARDELLE_MAIN_REPO_ROOT=/tmp/fake-main',
		],
	);
});

test('buildSessionEnvArgs does not name the main space', () => {
	// The main checkout can change branch while its session lives on, so a
	// fixed space name would go stale. The hook's cwd logic follows the branch.
	expect(
		buildSessionEnvArgs(MAIN_WORKTREE_KEY, 'repo', '/tmp/fake-main'),
	).toStrictEqual([
		'-e',
		'PAPPARDELLE_REPO=repo',
		'-e',
		'PAPPARDELLE_MAIN_REPO_ROOT=/tmp/fake-main',
	]);
	expect(buildSessionEnvArgs(MAIN_WORKTREE_KEY, 'repo')).toStrictEqual([
		'-e',
		'PAPPARDELLE_REPO=repo',
	]);
});
