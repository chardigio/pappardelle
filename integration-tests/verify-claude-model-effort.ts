#!/usr/bin/env npx tsx
/**
 * End-to-end verification of claude.model / claude.effort (STA-1829).
 *
 * Walks the whole chain a real workspace takes, using the real artifacts at
 * each step — no mocks, no reimplemented resolution:
 *
 *   1. A throwaway 3-layer config on disk (home / project / local)
 *   2. resolve-claude-config.sh  — the bash resolver idow calls
 *   3. getClaudeModel/getClaudeEffort — the TS resolver the TUI calls
 *      → asserts the two languages agree on every permutation
 *   4. start-claude-session.sh   — launched for real against a throwaway tmux
 *      socket with a `claude` shim on PATH that records its argv, proving the
 *      flags reach the actual command line
 *   5. open-iterm-claude.sh      — the AppleScript-assembled command line, typed
 *      into a real shell (tmux standing in for iTerm) with a deliberately
 *      hostile model value, proving both quoting layers hold
 *   6. The installed `claude` binary — a live `--model … --effort … --print`
 *      call, proving the flags Pappardelle emits are ones Claude accepts
 *
 * NOT an ava test — run manually with:
 *   npx tsx integration-tests/verify-claude-model-effort.ts
 *
 * Step 6 makes a real (tiny) API call and is skipped with --no-live; step 5 is
 * macOS-only (osascript). Everything else is hermetic: temp dirs, a temp HOME,
 * and per-run tmux sockets. Nothing touches the shared pappardelle_inner socket
 * or a real repo.
 */

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
	getClaudeEffort,
	getClaudeModel,
	loadConfigFromPaths,
} from '../source/config.ts';

const scriptsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'scripts',
);
const live = !process.argv.includes('--no-live');

let failed = false;

function header(title: string) {
	console.log(`\n${'='.repeat(64)}`);
	console.log(`  ${title}`);
	console.log('='.repeat(64));
}

function pass(msg: string) {
	console.log(`  ✅ ${msg}`);
}

function fail(msg: string) {
	console.log(`  ❌ ${msg}`);
	failed = true;
}

function check(label: string, actual: unknown, expected: unknown) {
	if (actual === expected) {
		pass(`${label} → ${JSON.stringify(actual)}`);
	} else {
		fail(
			`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
		);
	}
}

// ── Fixture ────────────────────────────────────────────────────────────────
// Deliberately exercises all three layers at once: home supplies a baseline,
// the project config overrides it, local overrides one profile, and one
// profile clears the global model with "".

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pappa-model-effort-'));
const homeDir = path.join(tmpRoot, 'home');
const projectDir = path.join(tmpRoot, 'project');
fs.mkdirSync(homeDir, {recursive: true});
fs.mkdirSync(projectDir, {recursive: true});

fs.writeFileSync(
	path.join(homeDir, '.pappardelle.yml'),
	`version: 1
claude:
  model: haiku
  effort: low
profiles: {}
`,
);

fs.writeFileSync(
	path.join(projectDir, '.pappardelle.yml'),
	`version: 1
default_profile: backend
claude:
  initialization_command: /do
  dangerously_skip_permissions: true
  model: opus
  effort: high
profiles:
  backend:
    display_name: Backend
    keywords: [backend]
    claude:
      model: sonnet
      effort: medium
  frontend:
    display_name: Frontend
    keywords: [frontend]
  docs:
    display_name: Docs
    keywords: [docs]
    claude:
      model: ""
      effort: ""
`,
);

fs.writeFileSync(
	path.join(projectDir, '.pappardelle.local.yml'),
	`version: 1
profiles:
  frontend:
    claude:
      model: "claude-opus-5[1m]"
`,
);

function cleanup() {
	fs.rmSync(tmpRoot, {recursive: true, force: true});
}

// ── Step 1+2: the bash resolver ────────────────────────────────────────────

type Resolved = {
	init_cmd: string;
	skip_permissions: string;
	model: string;
	effort: string;
};

function resolveViaBash(profile?: string): Resolved {
	const args = [
		path.join(scriptsDir, 'resolve-claude-config.sh'),
		'--config',
		path.join(projectDir, '.pappardelle.yml'),
		'--local-config',
		path.join(projectDir, '.pappardelle.local.yml'),
		'--home-config',
		path.join(homeDir, '.pappardelle.yml'),
	];
	if (profile) args.push('--profile', profile);
	return JSON.parse(
		execFileSync('bash', args, {encoding: 'utf-8'}),
	) as Resolved;
}

function main() {
	console.log('claude.model / claude.effort — end-to-end verification');
	console.log(`Fixture: ${tmpRoot}`);

	header('1. resolve-claude-config.sh (the resolver idow calls)');

	const topLevel = resolveViaBash();
	check('no profile → model', topLevel.model, 'opus');
	check('no profile → effort', topLevel.effort, 'high');
	check('pre-existing init_cmd still resolves', topLevel.init_cmd, '/do');
	check(
		'pre-existing skip_permissions still resolves',
		topLevel.skip_permissions,
		'true',
	);

	const backend = resolveViaBash('backend');
	check('backend (profile override) → model', backend.model, 'sonnet');
	check('backend (profile override) → effort', backend.effort, 'medium');

	const frontend = resolveViaBash('frontend');
	check(
		'frontend (local-config profile override) → model',
		frontend.model,
		'claude-opus-5[1m]',
	);
	check('frontend inherits top-level effort', frontend.effort, 'high');

	const docs = resolveViaBash('docs');
	check('docs (explicit "") → model cleared', docs.model, '');
	check('docs (explicit "") → effort cleared', docs.effort, '');

	// ── Step 3: the TS resolver, on the same bytes ─────────────────────────

	header('2. getClaudeModel/getClaudeEffort (the resolver the TUI calls)');

	const config = loadConfigFromPaths({homeConfigDir: homeDir, projectDir});
	pass('3-layer config loaded and validated by the TS loader');

	// The TS side matches a profile from the issue title rather than by name,
	// so these titles stand in for the profile the bash side was handed.
	const cases: Array<{title: string | undefined; profile?: string}> = [
		{title: undefined},
		{title: 'backend work', profile: 'backend'},
		{title: 'frontend work', profile: 'frontend'},
		{title: 'docs work', profile: 'docs'},
	];

	for (const {title, profile} of cases) {
		const bash = resolveViaBash(profile);
		const tsModel = getClaudeModel(config, title);
		const tsEffort = getClaudeEffort(config, title);
		const label = profile ?? '(no profile)';
		if (tsModel === bash.model && tsEffort === bash.effort) {
			pass(
				`${label}: TS and bash agree — model=${JSON.stringify(tsModel)} effort=${JSON.stringify(tsEffort)}`,
			);
		} else {
			fail(
				`${label}: resolvers disagree — bash={model:${JSON.stringify(bash.model)}, effort:${JSON.stringify(bash.effort)}} ts={model:${JSON.stringify(tsModel)}, effort:${JSON.stringify(tsEffort)}}`,
			);
		}
	}

	// ── Step 4: the real launch, argv captured ─────────────────────────────

	header('3. start-claude-session.sh → the real claude command line');

	const shimDir = path.join(tmpRoot, 'shim');
	const shimHome = path.join(tmpRoot, 'shim-home');
	fs.mkdirSync(shimDir, {recursive: true});
	fs.mkdirSync(shimHome, {recursive: true});

	function launch(
		issueKey: string,
		flags: string[],
	): {argv: string; socket: string} {
		const argvLog = path.join(tmpRoot, `argv-${issueKey}.log`);
		fs.writeFileSync(
			path.join(shimDir, 'claude'),
			`#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}\nexit 0\n`,
		);
		fs.chmodSync(path.join(shimDir, 'claude'), 0o755);

		const worktree = path.join(tmpRoot, `wt-${issueKey}`);
		fs.mkdirSync(worktree, {recursive: true});
		const socket = `pappa_verify_${process.pid}_${issueKey}`;

		execFileSync(
			'bash',
			[
				path.join(scriptsDir, 'start-claude-session.sh'),
				'--issue-key',
				issueKey,
				'--repo-name',
				`pappaverify${process.pid}`,
				'--worktree',
				worktree,
				...flags,
			],
			{
				encoding: 'utf-8',
				env: {
					...process.env,
					PATH: `${shimDir}:${process.env['PATH'] ?? ''}`,
					// A throwaway HOME keeps the developer's ~/.zshrc from putting the
					// real claude ahead of the shim, and keeps the pre-trust write out
					// of the real ~/.claude.json.
					HOME: shimHome,
					PAPPARDELLE_TMUX_SOCKET: socket,
				},
			},
		);

		// send-keys is async; give the shell a moment to run the shim.
		execFileSync('sleep', ['1.5']);
		const argv = fs.existsSync(argvLog)
			? (fs.readFileSync(argvLog, 'utf-8').split('\n')[0] ?? '')
			: '';
		try {
			execFileSync('tmux', ['-L', socket, 'kill-server'], {stdio: 'ignore'});
		} catch {
			// Server already gone — nothing to tear down.
		}
		return {argv, socket};
	}

	const withFlags = launch('VERIFY-1', [
		'--model',
		backend.model,
		'--effort',
		backend.effort,
	]);
	check(
		'resolved backend values reach claude',
		withFlags.argv,
		'--model sonnet --effort medium --name VERIFY-1 --continue',
	);

	const exotic = launch('VERIFY-2', ['--model', frontend.model]);
	check(
		'bracketed model id survives send-keys intact',
		exotic.argv,
		'--model claude-opus-5[1m] --name VERIFY-2 --continue',
	);

	const bare = launch('VERIFY-3', []);
	check(
		'off by default: no flags → command line unchanged',
		bare.argv,
		'--name VERIFY-3 --continue',
	);

	// ── Step 5: the iTerm path's AppleScript-assembled command line ────────
	// open-iterm-claude.sh builds its command inside AppleScript, where the
	// string crosses two shells. --print-command returns the exact bytes the
	// AppleScript would type, so we can run them through a real shell (driven
	// by tmux, standing in for iTerm) and see what `claude` actually receives.

	header('4. open-iterm-claude.sh → AppleScript-assembled command line');

	if (process.platform !== 'darwin') {
		pass('skipped (osascript is macOS-only)');
	} else {
		// Deliberately hostile: if either quoting layer leaks, this writes the
		// canary file instead of reaching claude as one literal argument.
		const canary = path.join(tmpRoot, 'pwned.txt');
		const hostileModel = `ev"il; echo PWNED > ${canary}`;
		const argvLog = path.join(tmpRoot, 'argv-iterm.log');
		fs.writeFileSync(
			path.join(shimDir, 'claude'),
			`#!/bin/bash\n{ for a in "$@"; do printf '<%s>' "$a"; done; printf '\\n'; } >> ${JSON.stringify(argvLog)}\nexit 0\n`,
		);
		fs.chmodSync(path.join(shimDir, 'claude'), 0o755);

		const innerSocket = `pappa_verify_as_inner_${process.pid}`;
		const outerSocket = `pappa_verify_as_outer_${process.pid}`;
		const worktree = path.join(tmpRoot, 'wt-iterm');
		fs.mkdirSync(worktree, {recursive: true});

		const line = execFileSync(
			'bash',
			[
				path.join(scriptsDir, 'open-iterm-claude.sh'),
				'--worktree',
				worktree,
				'--issue-key',
				'VERIFY-4',
				'--repo-name',
				`pappaverify${process.pid}`,
				'--prompt',
				'',
				'--model',
				hostileModel,
				'--effort',
				'medium',
				'--companion-command',
				'',
				'--print-command',
			],
			{
				encoding: 'utf-8',
				env: {...process.env, PAPPARDELLE_TMUX_SOCKET: innerSocket},
			},
		)
			.split('\n')[0]!
			.trim();

		const shimEnv = {
			...process.env,
			PATH: `${shimDir}:${process.env['PATH'] ?? ''}`,
			HOME: shimHome,
		};
		// tmux stands in for iTerm: the line is *typed* into a real shell,
		// exactly as `write text` would type it.
		execFileSync(
			'tmux',
			['-L', outerSocket, 'new-session', '-d', '-s', 'driver', '-c', tmpRoot],
			{env: shimEnv},
		);
		execFileSync(
			'tmux',
			['-L', outerSocket, 'send-keys', '-t', 'driver', line, 'Enter'],
			{
				env: shimEnv,
			},
		);
		execFileSync('sleep', ['4']);

		const argv = fs.existsSync(argvLog)
			? (fs.readFileSync(argvLog, 'utf-8').split('\n')[0] ?? '')
			: '';
		check(
			'hostile model value arrives as one literal argument',
			argv,
			`<--model><${hostileModel}><--effort><medium><--name><VERIFY-4><--continue>`,
		);
		if (fs.existsSync(canary)) {
			fail('shell injection succeeded — the quoting leaked');
		} else {
			pass('no injection: the value was quoted, never executed');
		}

		for (const socket of [outerSocket, innerSocket]) {
			try {
				execFileSync('tmux', ['-L', socket, 'kill-server'], {stdio: 'ignore'});
			} catch {
				// Server already gone — nothing to tear down.
			}
		}
	}

	// ── Step 6: does the installed claude actually accept these? ───────────

	header('5. live claude — are the emitted flags accepted?');

	if (!live) {
		pass('skipped (--no-live)');
	} else {
		try {
			const out = execFileSync(
				'claude',
				[
					'--model',
					'sonnet',
					'--effort',
					'low',
					'--print',
					'Reply with exactly: PAPPARDELLE_OK',
				],
				{encoding: 'utf-8', timeout: 120_000},
			);
			if (out.includes('PAPPARDELLE_OK')) {
				pass(`claude --model sonnet --effort low → ${out.trim().slice(0, 60)}`);
			} else {
				fail(`unexpected reply from live claude: ${out.trim().slice(0, 200)}`);
			}
		} catch (error) {
			fail(
				`live claude rejected the flags: ${
					error instanceof Error ? error.message.split('\n')[0] : String(error)
				}`,
			);
		}
	}

	header('Summary');
	if (failed) {
		fail('Some checks failed — see above');
		cleanup();
		process.exit(1);
	} else {
		pass('Every layer agrees: config → resolvers → launch → claude');
		cleanup();
	}
}

try {
	main();
} catch (error) {
	cleanup();
	throw error;
}
