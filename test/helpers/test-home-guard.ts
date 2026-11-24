// Loaded first into every test process (ava.config.js, require), before any
// module under source/ fixes a path from homedir().
import os from 'node:os';

if (os.homedir() !== process.env['PAPPARDELLE_TEST_HOME']) {
	throw new Error(
		`Tests are running with HOME=${os.homedir()}, not the throwaway HOME ava.config.js sets up, so they would write to the real ~/.pappardelle. Run them with ava from the repository root.`,
	);
}
