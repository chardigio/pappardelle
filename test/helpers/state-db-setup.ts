// Loaded into every test process (package.json, ava.require).
//
// A test run chooses its state mode with PAPPARDELLE_SQLITE_STATE. Without
// this, a run would follow the developer's own home config, and with the flag
// on there it would write to their real database.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setDefaultStateDbPathForTests} from '../../source/state-db.ts';

if (process.env['PAPPARDELLE_SQLITE_STATE'] === '1') {
	// Not an environment variable: a CLI that a test starts under a throwaway
	// HOME has to keep its database there, apart from every other test's.
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-test-state-'));
	setDefaultStateDbPathForTests(path.join(directory, 'state.db'));
	process.on('exit', () => {
		fs.rmSync(directory, {recursive: true, force: true});
	});
} else {
	process.env['PAPPARDELLE_SQLITE_STATE'] = '0';
}
