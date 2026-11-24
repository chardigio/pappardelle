// Loaded into every test process (ava.config.js, require).
//
// A test run chooses its state mode with PAPPARDELLE_SQLITE_STATE, not the
// home config. With the flag on, each test process also gets a database of its
// own: the workers share one throwaway HOME (ava.config.js).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setDefaultStateDbPathForTests} from '../../source/state-db.ts';

if (process.env['PAPPARDELLE_SQLITE_STATE'] === '1') {
	// Not an environment variable: a CLI that a test starts under a throwaway
	// HOME has to keep its database there, apart from every other test's. The
	// status daemon's socket is beside the database, so this moves it too.
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-test-state-'));
	setDefaultStateDbPathForTests(path.join(directory, 'state.db'));
	process.on('exit', () => {
		fs.rmSync(directory, {recursive: true, force: true});
	});
} else {
	process.env['PAPPARDELLE_SQLITE_STATE'] = '0';
}
