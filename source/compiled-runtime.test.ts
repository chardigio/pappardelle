import {Buffer} from 'node:buffer';
import {execFileSync, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';

const project = path.resolve(import.meta.dirname, '..');

test.serial(
	'relocated executable renders and exits without Bun, Node, or node_modules',
	async t => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pappa-exe-'));
		const install = path.join(root, 'install with spaces');
		const home = path.join(root, 'home');
		const repo = path.join(home, 'repo');
		const bin = path.join(root, 'tools');
		for (const dir of [
			path.join(install, 'dist'),
			repo,
			bin,
			path.join(home, '.pappardelle'),
		])
			fs.mkdirSync(dir, {recursive: true});
		const executable = path.join(install, 'dist/pappardelle');
		fs.copyFileSync(
			path.join(project, 'dist/pappardelle'),
			executable,
			fs.constants.COPYFILE_FICLONE,
		);
		fs.copyFileSync(
			path.join(project, 'package.json'),
			path.join(install, 'package.json'),
		);
		const git = execFileSync('which', ['git'], {encoding: 'utf8'}).trim();
		const tmux = execFileSync('which', ['tmux'], {encoding: 'utf8'}).trim();
		fs.symlinkSync(git, path.join(bin, 'git'));
		fs.symlinkSync(tmux, path.join(bin, 'tmux'));
		execFileSync(git, ['init', '-q', '-b', 'main', repo]);
		fs.writeFileSync(
			path.join(repo, '.pappardelle.yml'),
			'version: 1\nissue_tracker:\n  provider: beads\nprofiles: {}\n',
		);
		fs.writeFileSync(
			path.join(home, '.pappardelle/update-check.json'),
			JSON.stringify({checkedAt: Date.now(), latestVersion: 'v0.0.0'}),
		);
		const env = {
			...process.env,
			HOME: home,
			PATH: bin,
			SHELL: '/bin/sh',
			TERM: 'xterm-256color',
		};
		delete env.TMUX;
		delete env.TMUX_PANE;
		const socket = path.join(root, 'socket');
		const runTmux = (...args: string[]) =>
			execFileSync(tmux, ['-S', socket, ...args], {
				env,
				encoding: 'utf8',
				stdio: ['pipe', 'pipe', 'pipe'],
			});
		t.teardown(() => {
			spawnSync(tmux, ['-S', socket, 'kill-server'], {env, stdio: 'ignore'});
			fs.rmSync(root, {
				recursive: true,
				force: true,
				maxRetries: 10,
				retryDelay: 50,
			});
		});
		const version = execFileSync(executable, ['--version'], {
			env,
			cwd: repo,
			encoding: 'utf8',
		}).trim();
		t.is(
			version,
			JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'))
				.version,
		);
		t.is(
			spawnSync(executable, ['--internal-status-monitor'], {env, cwd: repo})
				.status,
			1,
		);
		const malformedPane = Buffer.from('notjson').toString('base64');
		const crash = spawnSync(
			executable,
			[
				'--internal-status-monitor',
				'watch',
				'r',
				'k',
				's',
				malformedPane,
				root,
			],
			{env, cwd: repo, encoding: 'utf8'},
		);
		t.is(crash.status, 1);
		t.regex(
			crash.stderr,
			/at .*source\/program-status-monitor-cli\.ts:\d+:\d+/,
		);
		runTmux(
			'new-session',
			'-d',
			'-s',
			'test',
			'-x',
			'80',
			'-y',
			'24',
			'-c',
			repo,
			executable,
			'--no-layout',
		);
		const frame = () => runTmux('capture-pane', '-p', '-t', '=test:');
		const until = async (check: () => boolean) => {
			const deadline = Date.now() + 5000;
			while (!check()) {
				if (Date.now() > deadline) throw new Error('Compiled TUI timed out');
				await delay(30);
			}
		};
		await until(() => frame().includes('main'));
		t.true(frame().includes('repo'));
		runTmux('send-keys', '-t', '=test:', '?');
		await until(() => frame().includes('Keyboard Shortcuts'));
		runTmux('send-keys', '-t', '=test:', 'Escape');
		await until(() => !frame().includes('Keyboard Shortcuts'));
		runTmux('send-keys', '-t', '=test:', 'q');
		await until(
			() =>
				spawnSync(tmux, ['-S', socket, 'has-session', '-t', '=test'], {env})
					.status !== 0,
		);
		t.pass();
	},
);
