import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'ava';
import {
	programStatusDir,
	programStatusPath,
	removeProgramSnapshots,
} from './program-status-monitor.ts';

const old = 'a'.repeat(32);
const current = 'b'.repeat(32);

test('a new generation prunes only its own key’s earlier generations', t => {
	const root = mkdtempSync(path.join(tmpdir(), 'program-status-'));
	const previous = process.env['PAPPARDELLE_PROGRAM_STATUS_DIR'];
	process.env['PAPPARDELLE_PROGRAM_STATUS_DIR'] = root;
	t.teardown(() => {
		if (previous === undefined)
			delete process.env['PAPPARDELLE_PROGRAM_STATUS_DIR'];
		else process.env['PAPPARDELLE_PROGRAM_STATUS_DIR'] = previous;
		rmSync(root, {recursive: true, force: true});
	});
	mkdirSync(programStatusDir('repo'), {recursive: true});
	for (const file of [
		programStatusPath('repo', 'STA-1', old),
		`${programStatusPath('repo', 'STA-1', old)}.lease`,
		programStatusPath('repo', 'STA-1', current),
		`${programStatusPath('repo', 'STA-1', current)}.lease`,
		programStatusPath('repo', 'STA-2', old),
	])
		writeFileSync(file, '');

	removeProgramSnapshots('repo', 'STA-1', current);

	t.deepEqual(readdirSync(programStatusDir('repo')).sort(), [
		path.basename(programStatusPath('repo', 'STA-1', current)),
		`${path.basename(programStatusPath('repo', 'STA-1', current))}.lease`,
		path.basename(programStatusPath('repo', 'STA-2', old)),
	]);
});
