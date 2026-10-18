import {spawnSync} from 'node:child_process';
import path from 'node:path';
import test from 'ava';

const hook = path.resolve(
	import.meta.dirname,
	'../plugins/pappardelle/hooks/session-start.sh',
);

function run(env: NodeJS.ProcessEnv) {
	const base = {...process.env};
	delete base['PAPPARDELLE_SPACE'];
	return spawnSync('bash', [hook], {
		cwd: import.meta.dirname,
		env: {...base, ...env},
		encoding: 'utf8',
	});
}

test('inside a space the hook names the space and the skill to load', t => {
	const result = run({PAPPARDELLE_SPACE: 'STA-42'});
	t.is(result.status, 0);
	t.regex(result.stdout, /Pappardelle space STA-42 \(repo [^)]+\)/);
	t.regex(result.stdout, /Load the pappardelle-agent skill now/);
});

test('outside a space the hook prints nothing', t => {
	for (const env of [{}, {PAPPARDELLE_SPACE: '  '}]) {
		const result = run(env);
		t.is(result.status, 0);
		t.is(result.stdout, '');
	}
});
