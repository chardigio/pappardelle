import fs from 'node:fs';
import path from 'node:path';
import {test, expect} from 'bun:test';
import semver from 'semver';

const root = path.join(import.meta.dirname, '..');
const pkg = JSON.parse(
	fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
);
const floor = semver.minVersion(pkg.engines.bun)!.version;
test('Bun runtime floor agrees across package, installer and documentation', () => {
	expect(pkg.engines.node).toBe(undefined);
	expect(
		fs
			.readFileSync(path.join(root, 'install.sh'), 'utf8')
			.includes(`MIN_BUN_VERSION=${floor}`),
	).toBe(true);
	expect(
		fs
			.readFileSync(path.join(root, 'README.md'), 'utf8')
			.includes(`bun-%3E%3D${floor}-`),
	).toBe(true);
	expect(
		fs
			.readFileSync(path.join(root, 'source/cli.tsx'), 'utf8')
			.startsWith('#!/usr/bin/env bun'),
	).toBe(true);
});
// Packages that only export subpaths are imported by the one Pappardelle uses.
const entryPoints: Record<string, string> = {
	'@modelcontextprotocol/sdk': '@modelcontextprotocol/sdk/server/mcp.js',
};
for (const dep of Object.keys(pkg.dependencies)) {
	test(`runtime dependency ${dep} loads under Bun`, async () => {
		expect(await import(entryPoints[dep] ?? dep)).toBeTruthy();
	});
}
