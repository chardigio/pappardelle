import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'ava';
import {updateShellScript} from './update-check.ts';
import {tempDir, type Teardown} from '../test/helpers/temp-dir.ts';

const testDir = (t: Teardown) => tempDir(t, 'install-update-test-');

// A coworker who presses `U` on an unsupported runtime used to see Pappardelle quit with
// no message: the installer stopped at its Bun check, and the TUI killed its
// tmux session (and the error text) right after. These tests pin the three
// parts of the fix: the installer finds or installs a Bun that meets the
// floor, it never deletes a working install before the new one builds, and
// the `U` wrapper keeps failures visible.

const root = path.join(import.meta.dirname, '..');
const installSh = path.join(root, 'install.sh');

// Only these tools are on PATH, so a real bun on the test machine (or the CI
// runner) can never satisfy find_bun by accident.
const TOOLS = [
	'bash',
	'curl',
	'tar',
	'awk',
	'unzip',
	'zip',
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
	'cp',
	'chmod',
	'git',
	'tee',
	'env',
];

function toolsDir(t: Teardown): string {
	const dir = testDir(t);
	for (const tool of TOOLS) {
		const found = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], {
			encoding: 'utf8',
		}).stdout.trim();
		if (found) fs.symlinkSync(found, path.join(dir, tool));
	}
	return dir;
}

// Answers the two questions install.sh asks a bun (`-p` with execPath or the
// major version, and `--version`) without running JavaScript.
function fakeBunScript(version: string): string {
	return `#!/bin/bash
case "$*" in
	*-p*execPath*) echo "$0" ;;
	*-p*) echo "${version.split('.')[0]!}" ;;
	--version) echo "${version}" ;;
esac
`;
}

function writeFakeBun(dir: string, version: string): string {
	fs.mkdirSync(dir, {recursive: true});
	const bunPath = path.join(dir, 'bun');
	fs.writeFileSync(bunPath, fakeBunScript(version), {mode: 0o755});
	return bunPath;
}

function runInstallFunction(
	t: Teardown,
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
				PATH: env['PATH'] ?? toolsDir(t),
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
	const arch = process.arch === 'arm64' ? 'aarch64' : 'x64-baseline';
	return `${osName}-${arch}`;
}

// A local stand-in for the pinned official Bun release, served over
// file:// so the test never touches the network.
function fakeBunDist(
	t: Teardown,
	options: {corruptChecksum?: boolean} = {},
): string {
	const dist = testDir(t);
	const name = `bun-${platformSuffix()}`;
	const build = testDir(t);
	writeFakeBun(path.join(build, name), '1.4.4');
	const tarball = `${name}.zip`;
	spawnSync('zip', ['-qr', path.join(dist, tarball), name], {cwd: build});
	const hash = options.corruptChecksum
		? '0'.repeat(64)
		: crypto
				.createHash('sha256')
				.update(fs.readFileSync(path.join(dist, tarball)))
				.digest('hex');
	fs.writeFileSync(
		path.join(dist, 'SHASUMS256.txt'),
		`${'1'.repeat(64)}  bun-v1.4.4-aix-ppc64.tar.gz\n${hash}  ${tarball}\n`,
	);
	return `file://${dist}`;
}

// ============================================================================
// find_bun
// ============================================================================

test('find_bun prefers the bun the TUI passes over a stale PATH bun', t => {
	const home = testDir(t);
	const tools = toolsDir(t);
	writeFakeBun(tools, '1.3.0');
	const tuiBun = writeFakeBun(path.join(testDir(t), 'bin'), '1.4.4');

	const result = runInstallFunction(t, 'find_bun', {
		HOME: home,
		PATH: tools,
		PAPPARDELLE_BUN: tuiBun,
	});

	t.is(result.status, 0, `stderr: ${result.stderr}`);
	t.is(result.stdout.trim(), tuiBun);
});

test('find_bun finds the standard user install after a stale PATH runtime', t => {
	const home = testDir(t);
	const tools = toolsDir(t);
	writeFakeBun(tools, '1.3.0');
	const installed = writeFakeBun(path.join(home, '.bun', 'bin'), '1.4.4');
	const result = runInstallFunction(t, 'find_bun', {HOME: home, PATH: tools});
	t.is(result.status, 0, `stderr: ${result.stderr}`);
	t.is(result.stdout.trim(), installed);
});

test('find_bun ignores the bunfig.toml preload of the directory it runs from', t => {
	const workspace = testDir(t);
	fs.writeFileSync(
		path.join(workspace, 'bunfig.toml'),
		'preload = ["./preload.ts"]\n',
	);
	fs.writeFileSync(
		path.join(workspace, 'preload.ts'),
		'console.log("from the preload");\n',
	);

	const result = spawnSync(
		'/bin/bash',
		['-c', `source "${installSh}"; find_bun`],
		{
			cwd: workspace,
			encoding: 'utf8',
			env: {
				PAPPARDELLE_INSTALL_SOURCE_ONLY: '1',
				HOME: testDir(t),
				PATH: toolsDir(t),
				PAPPARDELLE_BUN: process.execPath,
			},
		},
	);

	t.is(result.status, 0, `stderr: ${result.stderr}`);
	t.is(result.stdout.trim(), fs.realpathSync(process.execPath));
});

test('find_bun fails when no bun meets the floor', t => {
	const home = testDir(t);
	const tools = toolsDir(t);
	writeFakeBun(tools, '1.3.0');

	const result = runInstallFunction(t, 'find_bun', {HOME: home, PATH: tools});

	t.not(result.status, 0);
	t.is(result.stdout.trim(), '');
});

// ============================================================================
// install_private_bun
// ============================================================================

test('install_private_bun installs a verified bun that find_bun then uses', t => {
	const home = testDir(t);
	const tools = toolsDir(t);
	writeFakeBun(tools, '1.3.0');
	const env = {
		HOME: home,
		PATH: tools,
		PAPPARDELLE_BUN_DIST_URL: fakeBunDist(t),
	};

	const installed = runInstallFunction(t, 'install_private_bun', env);
	t.is(installed.status, 0, `stderr: ${installed.stderr}`);
	const privateBun = path.join(home, '.pappardelle', 'bun', 'current', 'bun');
	t.is(installed.stdout.trim(), privateBun);
	t.true(installed.stderr.includes('your own Bun is not changed'));

	const found = runInstallFunction(t, 'find_bun', env);
	t.is(found.status, 0, `stderr: ${found.stderr}`);
	t.true(found.stdout.trim().endsWith('/bun'));
	t.true(found.stdout.trim().startsWith(path.join(home, '.pappardelle')));
});

test('install_private_bun refuses a checksum mismatch and keeps an earlier private bun', t => {
	const home = testDir(t);
	const tools = toolsDir(t);
	const good = runInstallFunction(t, 'install_private_bun', {
		HOME: home,
		PATH: tools,
		PAPPARDELLE_BUN_DIST_URL: fakeBunDist(t),
	});
	t.is(good.status, 0, `stderr: ${good.stderr}`);
	const current = path.join(home, '.pappardelle', 'bun', 'current');
	const before = fs.readlinkSync(current);

	const bad = runInstallFunction(t, 'install_private_bun', {
		HOME: home,
		PATH: tools,
		PAPPARDELLE_BUN_DIST_URL: fakeBunDist(t, {corruptChecksum: true}),
	});

	t.not(bad.status, 0);
	t.true(bad.stderr.includes('Checksum mismatch'));
	t.is(fs.readlinkSync(current), before);
});

test('install_private_bun removes the private bun it replaces', t => {
	const home = testDir(t);
	const env = {
		HOME: home,
		PATH: toolsDir(t),
		PAPPARDELLE_BUN_DIST_URL: fakeBunDist(t),
	};
	for (let run = 0; run < 2; run++) {
		const result = runInstallFunction(t, 'install_private_bun', env);
		t.is(result.status, 0, `stderr: ${result.stderr}`);
	}

	const bunDir = path.join(home, '.pappardelle', 'bun');
	const releases = fs
		.readdirSync(bunDir)
		.filter(entry => entry.startsWith('release.'));
	t.deepEqual(releases, [
		path.basename(fs.readlinkSync(path.join(bunDir, 'current'))),
	]);
});

test('install_private_bun names the archive URL when its download fails', t => {
	const dist = fakeBunDist(t);
	fs.rmSync(new URL(`${dist}/bun-${platformSuffix()}.zip`));
	const result = runInstallFunction(t, 'install_private_bun', {
		HOME: testDir(t),
		PATH: toolsDir(t),
		PAPPARDELLE_BUN_DIST_URL: dist,
	});

	t.not(result.status, 0);
	t.true(result.stderr.includes(`${dist}/bun-${platformSuffix()}.zip`));
});

// ============================================================================
// install_repo_atomically
// ============================================================================

// A git repo whose `bun run build` runs build.sh and `bun run typecheck`
// runs typecheck.sh, with a fake bun on PATH so the test needs no registry.
function sourceRepo(
	t: Teardown,
	buildScript: string,
	typecheckScript = 'exit 0\n',
): string {
	const repo = testDir(t);
	fs.writeFileSync(path.join(repo, 'build.sh'), buildScript);
	fs.writeFileSync(path.join(repo, 'typecheck.sh'), typecheckScript);
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

function toolsWithFakeBun(t: Teardown): string {
	const tools = toolsDir(t);
	fs.writeFileSync(
		path.join(tools, 'bun'),
		'#!/bin/bash\ncase "$1 $2" in\n\t"run typecheck") bash typecheck.sh ;;\n\t"run build") bash build.sh ;;\nesac\n',
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
	const home = testDir(t);
	const repoDir = existingInstall(home);

	const result = runInstallFunction(t, 'install_repo_atomically', {
		HOME: home,
		PATH: toolsWithFakeBun(t),
		PAPPARDELLE_REPO_URL: sourceRepo(t, 'exit 1\n'),
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

test('a clone that does not typecheck is never built and leaves the current install in place', t => {
	const home = testDir(t);
	const repoDir = existingInstall(home);

	const result = runInstallFunction(t, 'install_repo_atomically', {
		HOME: home,
		PATH: toolsWithFakeBun(t),
		PAPPARDELLE_REPO_URL: sourceRepo(
			t,
			'mkdir -p dist && echo new build > dist/cli.js\n',
			'exit 2\n',
		),
	});

	t.not(result.status, 0);
	t.is(
		fs.readFileSync(path.join(repoDir, 'dist', 'cli.js'), 'utf8'),
		'old build',
	);
});

test('a clone failure leaves the current install in place', t => {
	const home = testDir(t);
	const repoDir = existingInstall(home);

	const result = runInstallFunction(t, 'install_repo_atomically', {
		HOME: home,
		PATH: toolsWithFakeBun(t),
		PAPPARDELLE_REPO_URL: path.join(testDir(t), 'missing'),
	});

	t.not(result.status, 0);
	t.is(
		fs.readFileSync(path.join(repoDir, 'dist', 'cli.js'), 'utf8'),
		'old build',
	);
});

test('a successful build replaces the install and keeps the old one as a rollback', t => {
	const home = testDir(t);
	const repoDir = existingInstall(home);

	const result = runInstallFunction(t, 'install_repo_atomically', {
		HOME: home,
		PATH: toolsWithFakeBun(t),
		PAPPARDELLE_REPO_URL: sourceRepo(
			t,
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
// install_local_snapshot and install_local_clone
// ============================================================================

const buildCheckout = (marker: string) =>
	`mkdir -p dist && printf '#!/bin/bash\\necho ${marker}\\n' > dist/pappardelle && chmod +x dist/pappardelle\n`;

// A built pappardelle checkout, committed, with what install.sh copies and a
// node_modules it must leave behind.
function builtCheckout(t: Teardown, marker = 'first build'): string {
	const repo = sourceRepo(t, buildCheckout(marker));
	for (const file of [
		'package.json',
		'scripts/idow',
		'plugins/pappardelle/hooks/update-status.py',
		'.claude-plugin/marketplace.json',
		'node_modules/dep/index.js',
	]) {
		fs.mkdirSync(path.dirname(path.join(repo, file)), {recursive: true});
		fs.writeFileSync(path.join(repo, file), file);
	}

	const git = (...args: string[]) =>
		spawnSync('git', ['-C', repo, ...args], {encoding: 'utf8'});
	fs.writeFileSync(path.join(repo, '.gitignore'), 'dist\nnode_modules\n');
	git('add', '.');
	git(
		'-c',
		'user.name=t',
		'-c',
		'user.email=t@example.com',
		'commit',
		'-q',
		'-m',
		'checkout',
	);
	spawnSync('bash', ['build.sh'], {cwd: repo});
	return repo;
}

function headSha(repo: string): string {
	return spawnSync('git', ['-C', repo, 'log', '-1', '--format=%h'], {
		encoding: 'utf8',
	}).stdout.trim();
}

// install.sh sets REPO_DIR when sourced, so the checkout goes in after it.
function runWithRepo(
	t: Teardown,
	call: string,
	repo: string,
	env: Record<string, string>,
): ReturnType<typeof runInstallFunction> {
	return runInstallFunction(t, `REPO_DIR="$TEST_REPO"; ${call}`, {
		...env,
		TEST_REPO: repo,
	});
}

const installedBinary = (home: string) =>
	fs.readFileSync(
		path.join(home, '.pappardelle', 'local', 'dist', 'pappardelle'),
		'utf8',
	);

test('install_local_snapshot installs a copy, so a later build in the checkout does not go live', t => {
	const home = testDir(t);
	const repo = builtCheckout(t, 'first build');

	const result = runWithRepo(t, `install_local_snapshot`, repo, {HOME: home});
	t.is(result.status, 0, `stderr: ${result.stderr}`);
	spawnSync('bash', ['-c', buildCheckout('second build')], {cwd: repo});

	const local = path.join(home, '.pappardelle', 'local');
	t.true(installedBinary(home).includes('first build'));
	t.deepEqual(fs.readdirSync(local).sort(), [
		'.claude-plugin',
		'commit-sha',
		'dist',
		'package.json',
		'plugins',
		'scripts',
	]);
	t.is(
		fs.readFileSync(path.join(local, 'commit-sha'), 'utf8').trim(),
		headSha(repo),
	);
	// mktemp -d makes a 0700 directory; the install moves a child of it.
	t.not(fs.statSync(local).mode.toString(8).slice(-3), '700');
});

test('install_local_snapshot keeps the replaced snapshot and marks a build with uncommitted changes', t => {
	const home = testDir(t);
	const first = builtCheckout(t, 'first build');
	const second = builtCheckout(t, 'second build');
	fs.writeFileSync(path.join(second, 'package.json'), 'edited');

	for (const repo of [first, second]) {
		const result = runWithRepo(t, `install_local_snapshot`, repo, {HOME: home});
		t.is(result.status, 0, `stderr: ${result.stderr}`);
	}

	const local = path.join(home, '.pappardelle', 'local');
	t.true(installedBinary(home).includes('second build'));
	t.true(
		fs
			.readFileSync(
				path.join(`${local}.previous`, 'dist', 'pappardelle'),
				'utf8',
			)
			.includes('first build'),
	);
	t.is(
		fs.readFileSync(path.join(local, 'commit-sha'), 'utf8').trim(),
		`${headSha(second)}-dirty`,
	);
});

test('install_local_clone links the snapshot of a checkout', t => {
	const home = testDir(t);
	const repo = builtCheckout(t);

	const result = runWithRepo(
		t,
		`install_local_clone && echo "linking $INSTALL_DIR"`,
		repo,
		{HOME: home, PATH: toolsWithFakeBun(t)},
	);

	t.is(result.status, 0, `stderr: ${result.stderr}`);
	t.true(
		result.stdout.includes(
			`linking ${path.join(home, '.pappardelle', 'local')}`,
		),
	);
});

test('install_local_clone runs the release clone in place', t => {
	const home = testDir(t);
	const repo = path.join(home, '.pappardelle', 'repo');
	fs.mkdirSync(path.dirname(repo), {recursive: true});
	fs.renameSync(builtCheckout(t), repo);

	const result = runWithRepo(
		t,
		`install_local_clone && echo "linking $INSTALL_DIR"`,
		repo,
		{HOME: home, PATH: toolsWithFakeBun(t)},
	);

	t.is(result.status, 0, `stderr: ${result.stderr}`);
	t.true(
		result.stdout.includes(`linking ${repo}
`),
	);
	t.false(fs.existsSync(path.join(home, '.pappardelle', 'local')));
});

test('install_local_clone stops before installing a checkout that does not typecheck', t => {
	const home = testDir(t);
	const repo = builtCheckout(t);
	fs.writeFileSync(path.join(repo, 'typecheck.sh'), 'exit 2\n');

	const result = runWithRepo(t, `install_local_clone`, repo, {
		HOME: home,
		PATH: toolsWithFakeBun(t),
	});

	t.not(result.status, 0);
	t.false(fs.existsSync(path.join(home, '.pappardelle', 'local')));
});

// ============================================================================
// updateShellScript (the `U` wrapper)
// ============================================================================

function runUpdateScript(
	t: Teardown,
	installCommand: string,
	waitOnFailure?: boolean,
) {
	const home = testDir(t);
	const result = spawnSync(
		'/bin/bash',
		['-c', updateShellScript({installCommand, waitOnFailure})],
		{encoding: 'utf8', env: {...process.env, HOME: home}, stdio: 'pipe'},
	);
	const log = path.join(home, '.pappardelle', 'logs', 'update.log');
	return {result, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''};
}

test('a failed update keeps its exit status, explains it, and writes a log', t => {
	const {result, log} = runUpdateScript(t, 'echo installer ran; exit 3');

	t.is(result.status, 3);
	t.true(result.stdout.includes('The Pappardelle update failed (exit 3)'));
	t.true(result.stdout.includes('Press any key to close'));
	t.true(log.includes('installer ran'));
});

test('a failed update run from the shell reports the log without waiting for a key', t => {
	const {result, log} = runUpdateScript(t, 'echo installer ran; exit 3', false);

	t.is(result.status, 3);
	t.true(result.stdout.includes('The Pappardelle update failed (exit 3)'));
	t.false(result.stdout.includes('Press any key'));
	t.true(log.includes('installer ran'));
});

test('a successful update exits 0 without a failure message', t => {
	const {result, log} = runUpdateScript(t, 'echo all good');

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

// ============================================================================
// local_clone_dir
// ============================================================================

function pappardelleCheckout(t: Teardown): string {
	const dir = testDir(t);
	fs.writeFileSync(
		path.join(dir, 'package.json'),
		JSON.stringify({name: 'pappardelle'}),
	);
	fs.writeFileSync(path.join(dir, 'install.sh'), '');
	return dir;
}

test('a piped install run from inside a pappardelle checkout is not a local install', t => {
	const checkout = pappardelleCheckout(t);
	const result = runInstallFunction(
		t,
		`cd "${checkout}" && local_clone_dir ""`,
		{},
	);
	t.not(result.status, 0);
	t.is(result.stdout, '');
});

test('an install script run from a pappardelle checkout installs from that checkout', t => {
	const checkout = pappardelleCheckout(t);
	const elsewhere = testDir(t);
	const result = runInstallFunction(
		t,
		`cd "${elsewhere}" && local_clone_dir "${path.join(checkout, 'install.sh')}"`,
		{},
	);
	t.is(result.status, 0);
	t.is(result.stdout.trim(), checkout);
});

// ============================================================================
// install_skill_scripts
// ============================================================================

test('install_skill_scripts replaces the installed scripts with the checkout ones', t => {
	const home = testDir(t);
	const repo = testDir(t);
	const shipped = path.join(
		repo,
		'plugins/pappardelle/skills/init-pappardelle/scripts',
	);
	fs.mkdirSync(shipped, {recursive: true});
	fs.writeFileSync(path.join(shipped, 'detect.sh'), 'echo new\n');
	fs.mkdirSync(path.join(repo, 'plugins/pappardelle/skills/sous-chef'));
	const installed = path.join(home, '.pappardelle', 'scripts');
	for (const file of [
		'sous-chef/gather-spaces.sh',
		'init-pappardelle/detect.sh',
		'init-pappardelle/retired.sh',
	]) {
		fs.mkdirSync(path.dirname(path.join(installed, file)), {recursive: true});
		fs.writeFileSync(path.join(installed, file), 'echo old\n');
	}

	const result = runInstallFunction(
		t,
		'INSTALL_DIR="$TEST_REPO"; install_skill_scripts',
		{HOME: home, PATH: process.env['PATH'] ?? '', TEST_REPO: repo},
	);

	t.is(result.status, 0, `stderr: ${result.stderr}`);
	t.deepEqual(fs.readdirSync(installed), ['init-pappardelle']);
	t.deepEqual(fs.readdirSync(path.join(installed, 'init-pappardelle')), [
		'detect.sh',
	]);
	const script = path.join(installed, 'init-pappardelle', 'detect.sh');
	t.is(fs.readFileSync(script, 'utf8'), 'echo new\n');
	t.notThrows(() => {
		fs.accessSync(script, fs.constants.X_OK);
	});
});
