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
