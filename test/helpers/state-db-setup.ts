// Loaded into every test process (package.json, ava.require).
//
// A test run chooses its state mode with PAPPARDELLE_SQLITE_STATE. Without
// this, a run would follow the developer's own home config, and with the flag
// on there it would write to their real database.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.env['PAPPARDELLE_SQLITE_STATE'] !== '1') {
	process.env['PAPPARDELLE_SQLITE_STATE'] = '0';
} else if (!process.env['PAPPARDELLE_STATE_DB']) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-test-state-'));
	process.env['PAPPARDELLE_STATE_DB'] = path.join(directory, 'state.db');
	process.on('exit', () => {
		fs.rmSync(directory, {recursive: true, force: true});
	});
}
