import test from 'ava';
import {buildSessionEnvArgs, buildSpawnEnv} from './spawn-env.ts';
import {MAIN_WORKTREE_KEY} from './space-utils.ts';

test('buildSpawnEnv includes PAPPARDELLE_PROJECT_ROOT', t => {
	const env = buildSpawnEnv('/tmp/fake-project');
	t.is(env['PAPPARDELLE_PROJECT_ROOT'], '/tmp/fake-project');
});

test('buildSpawnEnv preserves existing env vars', t => {
	const env = buildSpawnEnv('/tmp/fake-project');
	// Should still have PATH from process.env
	t.truthy(env['PATH']);
});

test('buildSpawnEnv does not mutate process.env', t => {
	const before = process.env['PAPPARDELLE_PROJECT_ROOT'];
	buildSpawnEnv('/tmp/fake-project');
	t.is(process.env['PAPPARDELLE_PROJECT_ROOT'], before);
});

test('buildSpawnEnv passes the main repo root when given one', t => {
	const env = buildSpawnEnv('/tmp/fake-project', '/tmp/fake-main');
	t.is(env['PAPPARDELLE_MAIN_REPO_ROOT'], '/tmp/fake-main');
});

test.serial('buildSpawnEnv omits the main repo root when there is none', t => {
	const before = process.env['PAPPARDELLE_MAIN_REPO_ROOT'];
	delete process.env['PAPPARDELLE_MAIN_REPO_ROOT'];
	try {
		t.false('PAPPARDELLE_MAIN_REPO_ROOT' in buildSpawnEnv('/tmp/fake-project'));
	} finally {
		if (before !== undefined)
			process.env['PAPPARDELLE_MAIN_REPO_ROOT'] = before;
	}
});

test('buildSessionEnvArgs names the space for an issue space', t => {
	t.deepEqual(buildSessionEnvArgs('STA-42'), [
		'-e',
		'PAPPARDELLE_SPACE=STA-42',
	]);
});

test('buildSessionEnvArgs adds the main repo root when given one', t => {
	t.deepEqual(buildSessionEnvArgs('STA-42', '/tmp/fake-main'), [
		'-e',
		'PAPPARDELLE_SPACE=STA-42',
		'-e',
		'PAPPARDELLE_MAIN_REPO_ROOT=/tmp/fake-main',
	]);
});

test('buildSessionEnvArgs does not name the main space', t => {
	// The main checkout can change branch while its session lives on, so a
	// fixed space name would go stale. The hook's cwd logic follows the branch.
	t.deepEqual(buildSessionEnvArgs(MAIN_WORKTREE_KEY, '/tmp/fake-main'), [
		'-e',
		'PAPPARDELLE_MAIN_REPO_ROOT=/tmp/fake-main',
	]);
	t.deepEqual(buildSessionEnvArgs(MAIN_WORKTREE_KEY), []);
});
