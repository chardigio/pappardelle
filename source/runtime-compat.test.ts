import fs from 'node:fs';
import path from 'node:path';
import test from 'ava';
import semver from 'semver';

const root = path.join(import.meta.dirname, '..');
const pkg = JSON.parse(
	fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
);
const floor = semver.minVersion(pkg.engines.bun)!.version;
test('Bun runtime floor agrees across package, installer and documentation', t => {
	t.is(pkg.engines.node, undefined);
	t.true(
		fs
			.readFileSync(path.join(root, 'install.sh'), 'utf8')
			.includes(`MIN_BUN_VERSION=${floor}`),
	);
	t.true(
		fs
			.readFileSync(path.join(root, 'README.md'), 'utf8')
			.includes(`bun-%3E%3D${floor}-`),
	);
	t.true(
		fs
			.readFileSync(path.join(root, 'source/cli.tsx'), 'utf8')
			.startsWith('#!/usr/bin/env bun'),
	);
});
// Packages that only export subpaths are imported by the one Pappardelle uses.
const entryPoints: Record<string, string> = {
	'@modelcontextprotocol/sdk': '@modelcontextprotocol/sdk/server/mcp.js',
};
for (const dep of Object.keys(pkg.dependencies)) {
	test(`runtime dependency ${dep} loads under Bun`, async t => {
		t.truthy(await import(entryPoints[dep] ?? dep));
	});
}
