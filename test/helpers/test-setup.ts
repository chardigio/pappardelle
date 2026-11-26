// Loaded into every test file (bunfig.toml, preload), after test-guard.ts.
//
// Each test file gets a database of its own: the files share one throwaway
// HOME (scripts/unit-tests.ts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterAll, beforeEach, expect} from 'bun:test';
import {
	closeStateDb,
	setDefaultStateDbPathForTests,
	stateDbPath,
} from '../../source/state-db.ts';

// Not an environment variable: a CLI that a test starts under a throwaway
// HOME has to keep its database there, apart from every other test's. The
// status daemon's socket is beside the database, so this moves it too.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-test-state-'));
setDefaultStateDbPathForTests(path.join(directory, 'state.db'));
// A preload's afterAll runs after the file's own, so nothing the file still
// closes is removed under it.
afterAll(() => {
	closeStateDb(stateDbPath(directory));
	fs.rmSync(directory, {recursive: true, force: true});
});

// Bun starts with SIGPIPE ignored, but removing the last SIGPIPE listener
// restores the default action, which kills the process. Every OpenTUI renderer
// adds one and removes it when destroyed, so a test file that renders would
// leave its worker to die on the next write to a closed pipe, such as
// logger.test.ts's FIFO with no reader. Holding a listener of our own keeps
// SIGPIPE caught for the whole worker.
process.on('SIGPIPE', () => {});

// A test that asserts nothing passes whatever the code does, as when its only
// expect sits in a branch that did not run.
beforeEach(() => {
	expect.hasAssertions();
});
