import test from 'ava';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseConfigLayer} from './config.ts';

// The bug this covers: with `backend: herdr-app` in the home layer and an
// INVALID repo config, activeBackend() caught the validation error, lost the
// backend, and started a tmux layout the user never asked for. Reading the
// key without validation is what keeps the configured intent.
//
// The full path needs a real git checkout, so this pins the piece that was
// missing: a config that fails validation still parses far enough to name its
// backend.
test('a config that fails validation still yields its backend key', t => {
	// No `profiles:` — this is exactly what made ship-it's config invalid.
	const parsed = parseConfigLayer(
		'.pappardelle.yml',
		'version: 1\nbackend: herdr-app\n',
	);
	t.is(parsed?.['backend'], 'herdr-app');
});

test('the home layer alone carries the backend a repo inherits', t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pappardelle-backend-'));
	try {
		const file = path.join(dir, '.pappardelle.yml');
		fs.writeFileSync(file, 'version: 1\nbackend: herdr-app\nprofiles: {}\n');
		const parsed = parseConfigLayer(file, fs.readFileSync(file, 'utf8'));
		t.is(parsed?.['backend'], 'herdr-app');
	} finally {
		fs.rmSync(dir, {recursive: true, force: true});
	}
});

test('a layer without a backend leaves the choice to the next layer', t => {
	t.is(
		parseConfigLayer('.pappardelle.yml', 'version: 1\n')?.['backend'],
		undefined,
	);
});
