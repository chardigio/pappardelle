import test from 'ava';
import {buildSpawnEnv} from './spawn-env.ts';

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
