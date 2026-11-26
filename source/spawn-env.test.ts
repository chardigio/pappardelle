import {test, expect} from 'bun:test';
import {buildSessionEnvArgs, buildSpawnEnv} from './spawn-env.ts';
import {MAIN_WORKTREE_KEY} from './space-utils.ts';

test('buildSpawnEnv includes PAPPARDELLE_PROJECT_ROOT', () => {
	const env = buildSpawnEnv('/tmp/fake-project');
	expect(env['PAPPARDELLE_PROJECT_ROOT']).toBe('/tmp/fake-project');
});

test('buildSpawnEnv preserves existing env vars', () => {
	const env = buildSpawnEnv('/tmp/fake-project');
	// Should still have PATH from process.env
	expect(env['PATH']).toBeTruthy();
});

test('buildSpawnEnv does not mutate process.env', () => {
	const before = process.env['PAPPARDELLE_PROJECT_ROOT'];
	buildSpawnEnv('/tmp/fake-project');
	expect(process.env['PAPPARDELLE_PROJECT_ROOT']).toBe(before);
});

test('buildSpawnEnv passes the main repo root when given one', () => {
	const env = buildSpawnEnv('/tmp/fake-project', {
		mainRepoRoot: '/tmp/fake-main',
	});
	expect(env['PAPPARDELLE_MAIN_REPO_ROOT']).toBe('/tmp/fake-main');
});

test('buildSpawnEnv omits the main repo root when there is none', () => {
	const before = process.env['PAPPARDELLE_MAIN_REPO_ROOT'];
	delete process.env['PAPPARDELLE_MAIN_REPO_ROOT'];
	try {
		expect(
			'PAPPARDELLE_MAIN_REPO_ROOT' in buildSpawnEnv('/tmp/fake-project'),
		).toBe(false);
	} finally {
		if (before !== undefined)
			process.env['PAPPARDELLE_MAIN_REPO_ROOT'] = before;
	}
});

// idow records the space before it starts any session only when it is told
// a Pappardelle that lists spaces started it.
test('buildSpawnEnv tells idow to record the space', () => {
	const before = process.env['PAPPARDELLE_REGISTER_SPACE'];
	delete process.env['PAPPARDELLE_REGISTER_SPACE'];
	try {
		expect(
			buildSpawnEnv('/tmp/fake-project')['PAPPARDELLE_REGISTER_SPACE'],
		).toBe('1');
	} finally {
		if (before !== undefined)
			process.env['PAPPARDELLE_REGISTER_SPACE'] = before;
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
	// The hook finds main from its stored worktree.
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
