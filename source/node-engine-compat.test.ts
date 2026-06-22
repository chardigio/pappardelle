import fs from 'node:fs';
import path from 'node:path';
import test from 'ava';
import semver from 'semver';

// Regression test for STA-1543: a `/update-pappardelle` bump pulled in
// string-width@8, whose engines.node is ">=20" because it relies on the regex
// `v` (unicodeSets) flag introduced in V8 11.6 / Node 20. npm does not enforce
// `engines` at install time, so the incompatible package installed cleanly on
// the Node 18 work MacBook — which both install.sh and our own engines.node
// advertise as supported — and then crashed at *import* time with
// "SyntaxError: Invalid regular expression flags".
//
// This pins the contract the crash violated: every direct runtime dependency
// must support the minimum Node major we promise. CI runs on Node 22, so a
// plain `import('string-width')` would NOT reproduce the failure — instead we
// assert each installed dependency's declared engines.node still overlaps our
// floor major. Bumping any runtime dep past the floor (e.g. back to
// string-width@8 while engines.node stays ">=18") turns this red.

type PackageJson = {
	version?: string;
	engines?: {node?: string};
	dependencies?: Record<string, string>;
};

const root = path.join(import.meta.dirname, '..');

function readPkg(relativePath: string): PackageJson {
	return JSON.parse(
		fs.readFileSync(path.join(root, relativePath), 'utf8'),
	) as PackageJson;
}

const rootPkg = readPkg('package.json');
const declaredNode = rootPkg.engines?.node;

test('package.json declares a Node engines floor', t => {
	t.truthy(
		declaredNode,
		'engines.node must be set so the supported floor is explicit',
	);
});

// The lowest Node major we promise, expressed as a range — e.g. ">=18" → "18.x".
// We check overlap against the whole 18.x line (not the bare 18.0.0 floor) so a
// dep needing, say, ">=18.17" still counts as Node-18-compatible, matching what
// install.sh actually enforces (major version only).
const floorMajor = declaredNode
	? semver.minVersion(declaredNode)?.major
	: undefined;
const floorRange = floorMajor === undefined ? undefined : `${floorMajor}.x`;

for (const dep of Object.keys(rootPkg.dependencies ?? {})) {
	test(`direct dependency ${dep} supports Node ${floorRange ?? '?'}`, t => {
		if (floorRange === undefined) {
			t.fail('could not derive a Node floor from engines.node');
			return;
		}

		let installed: PackageJson;
		try {
			installed = readPkg(`node_modules/${dep}/package.json`);
		} catch {
			t.fail(`${dep} is declared but not installed — run npm ci`);
			return;
		}

		const depNode = installed.engines?.node;
		if (!depNode) {
			t.pass(); // No engines constraint → compatible with any Node.
			return;
		}

		const message = `${dep}@${installed.version ?? '?'} requires Node "${depNode}", which excludes Node ${floorRange}. Pin a release compatible with the engines.node floor, or raise engines.node + install.sh + the README badge together.`;
		t.true(semver.intersects(depNode, floorRange, {loose: true}), message);
	});
}
