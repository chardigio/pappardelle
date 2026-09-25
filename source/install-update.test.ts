import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'ava';
import {updateShellScript} from './update-check.ts';

// A coworker who presses `U` on Node 18 or 20 used to see Pappardelle quit with
// no message: the installer stopped at its Node check, and the TUI killed its
// tmux session (and the error text) right after. These tests pin the three
// parts of the fix: the installer finds or installs a Node that meets the
// floor, it never deletes a working install before the new one builds, and
// the `U` wrapper keeps failures visible.

const root = path.join(import.meta.dirname, '..');
const installSh = path.join(root, 'install.sh');

let counter = 0;
function temporaryDir(): string {
	const dir = path.join(
		os.tmpdir(),
		`install-update-test-${process.pid}-${Date.now()}-${counter++}`,
	);
	fs.mkdirSync(dir, {recursive: true});
	return dir;
}

// Only these tools are on PATH, so a real node on the test machine (or the CI
// runner) can never satisfy find_node by accident.
const TOOLS = [
	'bash',
	'curl',
	'tar',
	'gzip',
	'shasum',
	'sha256sum',
	'perl',
	'uname',
	'sort',
	'grep',
	'head',
	'cut',
	'mktemp',
	'rm',
	'mkdir',
	'ln',
	'mv',
	'find',
	'dirname',
	'cat',
	'git',
	'tee',
	'env',
];

function toolsDir(): string {
	const dir = temporaryDir();
	for (const tool of TOOLS) {
		const found = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], {
			encoding: 'utf8',
		}).stdout.trim();
		if (found) fs.symlinkSync(found, path.join(dir, tool));
	}
	return dir;
}

// Answers the two questions install.sh asks a node (`-p` with execPath or the
// major version, and `--version`) without running JavaScript.
function fakeNodeScript(version: string): string {
	return `#!/bin/bash
case "$1" in
	-p)
		if [[ "$2" == *execPath* ]]; then echo "$0"; else echo "${version.split('.')[0]!}"; fi
		;;
	--version) echo "v${version}" ;;
esac
`;
}

function writeFakeNode(dir: string, version: string): string {
	fs.mkdirSync(dir, {recursive: true});
	const nodePath = path.join(dir, 'node');
	fs.writeFileSync(nodePath, fakeNodeScript(version), {mode: 0o755});
	return nodePath;
}

function runInstallFunction(
	call: string,
	env: Record<string, string>,
): {status: number | null; stdout: string; stderr: string} {
	const result = spawnSync(
		'/bin/bash',
		['-c', `source "${installSh}"; ${call}`],
		{
			encoding: 'utf8',
			env: {
				PAPPARDELLE_INSTALL_SOURCE_ONLY: '1',
				PATH: env['PATH'] ?? toolsDir(),
				...env,
			},
		},
	);
	return {
		status: result.status,
		stdout: String(result.stdout),
		stderr: String(result.stderr),
	};
}

function platformSuffix(): string {
	const osName = process.platform === 'darwin' ? 'darwin' : 'linux';
	const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
	return `${osName}-${arch}`;
}

// A local stand-in for https://nodejs.org/dist/latest-v22.x, served over
// file:// so the test never touches the network.
function fakeNodeDist(options: {corruptChecksum?: boolean} = {}): string {
	const dist = temporaryDir();
	const name = `node-v22.99.0-${platformSuffix()}`;
	const build = temporaryDir();
	writeFakeNode(path.join(build, name, 'bin'), '22.99.0');
	const tarball = `${name}.tar.gz`;
	spawnSync('tar', ['-czf', path.join(dist, tarball), '-C', build, name]);
	const hash = options.corruptChecksum
		? '0'.repeat(64)
		: crypto
				.createHash('sha256')
				.update(fs.readFileSync(path.join(dist, tarball)))
				.digest('hex');
	fs.writeFileSync(
		path.join(dist, 'SHASUMS256.txt'),
		`${'1'.repeat(64)}  node-v22.99.0-aix-ppc64.tar.gz\n${hash}  ${tarball}\n`,
	);
	return `file://${dist}`;
}

// ============================================================================
// find_node
// ============================================================================

test('find_node prefers the node the TUI passes over a stale PATH node', t => {
	const home = temporaryDir();
	const tools = toolsDir();
	writeFakeNode(tools, '18.20.0');
	const tuiNode = writeFakeNode(path.join(temporaryDir(), 'bin'), '22.5.0');

	const result = runInstallFunction('find_node', {
		HOME: home,
		PATH: tools,
		PAPPARDELLE_NODE: tuiNode,
	});

	t.is(result.status, 0, `stderr: ${result.stderr}`);
	t.is(result.stdout.trim(), tuiNode);
});

test('find_node skips a stale PATH node and picks the newest nvm node that meets the floor', t => {
	const home = temporaryDir();
	const tools = toolsDir();
	writeFakeNode(tools, '20.11.0');
	const nvm = path.join(home, '.nvm', 'versions', 'node');
	writeFakeNode(path.join(nvm, 'v18.20.0', 'bin'), '18.20.0');
	writeFakeNode(path.join(nvm, 'v22.3.0', 'bin'), '22.3.0');
	const newest = writeFakeNode(path.join(nvm, 'v22.12.0', 'bin'), '22.12.0');

	const result = runInstallFunction('find_node', {HOME: home, PATH: tools});

	t.is(result.status, 0, `stderr: ${result.stderr}`);
	t.is(result.stdout.trim(), newest);
});

test('find_node fails when no node meets the floor', t => {
	const home = temporaryDir();
	const tools = toolsDir();
	writeFakeNode(tools, '18.20.0');

	const result = runInstallFunction('find_node', {HOME: home, PATH: tools});

	t.not(result.status, 0);
	t.is(result.stdout.trim(), '');
});

// ============================================================================
// install_private_node
// ============================================================================

test('install_private_node installs a verified node that find_node then uses', t => {
	const home = temporaryDir();
	const tools = toolsDir();
	writeFakeNode(tools, '18.20.0');
	const env = {
		HOME: home,
		PATH: tools,
		PAPPARDELLE_NODE_DIST_URL: fakeNodeDist(),
	};

	const installed = runInstallFunction('install_private_node', env);
	t.is(installed.status, 0, `stderr: ${installed.stderr}`);
	const privateNode = path.join(
		home,
		'.pappardelle',
		'node',
		'current',
		'bin',
		'node',
	);
	t.is(installed.stdout.trim(), privateNode);
	t.true(installed.stderr.includes('your own Node is not changed'));

	const found = runInstallFunction('find_node', env);
	t.is(found.status, 0, `stderr: ${found.stderr}`);
	t.true(found.stdout.trim().endsWith('/bin/node'));
	t.true(found.stdout.trim().startsWith(path.join(home, '.pappardelle')));
});

test('install_private_node refuses a checksum mismatch and keeps an earlier private node', t => {
	const home = temporaryDir();
	const tools = toolsDir();
	const good = runInstallFunction('install_private_node', {
		HOME: home,
		PATH: tools,
		PAPPARDELLE_NODE_DIST_URL: fakeNodeDist(),
	});
	t.is(good.status, 0, `stderr: ${good.stderr}`);
	const current = path.join(home, '.pappardelle', 'node', 'current');
	const before = fs.readlinkSync(current);

	const bad = runInstallFunction('install_private_node', {
		HOME: home,
		PATH: tools,
		PAPPARDELLE_NODE_DIST_URL: fakeNodeDist({corruptChecksum: true}),
	});

	t.not(bad.status, 0);
	t.true(bad.stderr.includes('Checksum mismatch'));
	t.is(fs.readlinkSync(current), before);
});

// ============================================================================
// install_repo_atomically
// ============================================================================

// A git repo whose `npm run build` runs build.sh, with a fake npm on PATH so
// the test needs no registry.
function sourceRepo(buildScript: string): string {
	const repo = temporaryDir();
	fs.writeFileSync(path.join(repo, 'build.sh'), buildScript);
	const git = (...args: string[]) =>
		spawnSync('git', args, {cwd: repo, encoding: 'utf8'});
	git('init', '-q');
	git('add', '.');
	git(
		'-c',
		'user.name=t',
		'-c',
		'user.email=t@example.com',
		'commit',
		'-q',
		'-m',
		'init',
	);
	return repo;
}

function toolsWithFakeNpm(): string {
	const tools = toolsDir();
	fs.writeFileSync(
		path.join(tools, 'npm'),
		'#!/bin/bash\nif [[ "$1" == run ]]; then bash build.sh; fi\n',
		{mode: 0o755},
	);
	return tools;
}

function existingInstall(home: string): string {
	const repoDir = path.join(home, '.pappardelle', 'repo');
	fs.mkdirSync(path.join(repoDir, 'dist'), {recursive: true});
	fs.writeFileSync(path.join(repoDir, 'dist', 'cli.js'), 'old build');
	return repoDir;
}

test('a failed build leaves the current install in place', t => {
	const home = temporaryDir();
	const repoDir = existingInstall(home);

	const result = runInstallFunction('install_repo_atomically', {
		HOME: home,
		PATH: toolsWithFakeNpm(),
		PAPPARDELLE_REPO_URL: sourceRepo('exit 1\n'),
	});

	t.not(result.status, 0);
	t.is(
		fs.readFileSync(path.join(repoDir, 'dist', 'cli.js'), 'utf8'),
		'old build',
	);
	const leftovers = fs
		.readdirSync(path.join(home, '.pappardelle'))
		.filter(name => name.startsWith('repo.staging'));
	t.deepEqual(leftovers, []);
});

test('a clone failure leaves the current install in place', t => {
	const home = temporaryDir();
	const repoDir = existingInstall(home);

	const result = runInstallFunction('install_repo_atomically', {
		HOME: home,
		PATH: toolsWithFakeNpm(),
		PAPPARDELLE_REPO_URL: path.join(temporaryDir(), 'missing'),
	});

	t.not(result.status, 0);
	t.is(
		fs.readFileSync(path.join(repoDir, 'dist', 'cli.js'), 'utf8'),
		'old build',
	);
});

test('a successful build replaces the install and keeps the old one as a rollback', t => {
	const home = temporaryDir();
	const repoDir = existingInstall(home);

	const result = runInstallFunction('install_repo_atomically', {
		HOME: home,
		PATH: toolsWithFakeNpm(),
		PAPPARDELLE_REPO_URL: sourceRepo(
			'mkdir -p dist && echo new build > dist/cli.js\n',
		),
	});

	t.is(result.status, 0, `stderr: ${result.stderr}`);
	t.is(
		fs.readFileSync(path.join(repoDir, 'dist', 'cli.js'), 'utf8').trim(),
		'new build',
	);
	t.is(
		fs.readFileSync(path.join(`${repoDir}.previous`, 'dist', 'cli.js'), 'utf8'),
		'old build',
	);
});

// ============================================================================
// updateShellScript (the `U` wrapper)
// ============================================================================

function runUpdateScript(installCommand: string) {
	const home = temporaryDir();
	const result = spawnSync(
		'/bin/bash',
		['-c', updateShellScript(installCommand)],
		{encoding: 'utf8', env: {...process.env, HOME: home}, stdio: 'pipe'},
	);
	const log = path.join(home, '.pappardelle', 'logs', 'update.log');
	return {result, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''};
}

test('a failed update keeps its exit status, explains it, and writes a log', t => {
	const {result, log} = runUpdateScript('echo installer ran; exit 3');

	t.is(result.status, 3);
	t.true(result.stdout.includes('The Pappardelle update failed (exit 3)'));
	t.true(result.stdout.includes('Press any key to close'));
	t.true(log.includes('installer ran'));
});

test('a successful update exits 0 without a failure message', t => {
	const {result, log} = runUpdateScript('echo all good');

	t.is(result.status, 0);
	t.false(result.stdout.includes('failed'));
	t.true(log.includes('all good'));
});

test('the default update script runs the published installer', t => {
	t.true(
		updateShellScript().includes(
			'https://raw.githubusercontent.com/chardigio/pappardelle/main/install.sh',
		),
	);
});
