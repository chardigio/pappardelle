import {spawnSync} from 'node:child_process';
import path from 'node:path';
import test from 'ava';

test('output larger than a pipe buffer arrives whole before the exit', t => {
	const module = path.join(import.meta.dirname, 'exit-after-flush.ts');
	const script = `import {exitAfterFlush} from ${JSON.stringify(module)};
process.stdout.write('x'.repeat(300_000));
await exitAfterFlush(3);`;
	// Piped stdout is asynchronous on macOS, which is where the cut-off shows.
	const result = spawnSync(process.execPath, ['-e', script], {
		encoding: 'utf8',
		maxBuffer: 10_000_000,
	});
	t.is(result.status, 3, `stderr: ${result.stderr}`);
	t.is(result.stdout.length, 300_000);
});

test('a slow reader still gets all of it', t => {
	const module = path.join(import.meta.dirname, 'exit-after-flush.ts');
	const script = `import {exitAfterFlush} from ${JSON.stringify(module)};
process.stdout.write('x'.repeat(300_000));
await exitAfterFlush(3);`;
	const result = spawnSync(
		'sh',
		['-c', `"$0" -e "$1" | (sleep 0.3; wc -c)`, process.execPath, script],
		{encoding: 'utf8'},
	);
	t.is(result.stdout.trim(), '300000', `stderr: ${result.stderr}`);
});
