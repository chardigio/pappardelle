import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {execFileSync} from 'node:child_process';
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import React from 'react';
import {render} from '../test/helpers/opentui-render.ts';
import {sendHookEvent, subscribeRaw} from '../test/helpers/status-daemon.ts';
import type {
	ClaudeSessionState,
	ClaudeStatus,
	ClaudeStatusDao,
} from '../source/claude-status.ts';
import SpaceListItem from '../source/components/SpaceListItem.tsx';
import {stateDaosByRepo, type StateDaos} from '../source/state-daos.ts';
import {closeStateDb, statusSocketPath} from '../source/state-db.ts';
import {
	createStatusServer,
	type StatusServer,
} from '../source/status-daemon.ts';
import {
	WorkspaceStatuses,
	applyStatusUpdates,
} from '../source/workspace-status.ts';
import {
	programStatusDir,
	statusTmuxArgs,
	runStatusTmux,
	shellQuoteStatus,
	type ProgramStatusDao,
} from '../source/program-status-monitor.ts';
import type {ProgramStatusInfo} from '../source/program-status.ts';
import type {SpaceData} from '../source/types.ts';

export const projectRoot = fileURLToPath(new URL('..', import.meta.url));

export async function until<T>(
	read: () => T | Promise<T>,
	accept: (value: T) => boolean,
	label: string,
	timeout = 10000,
): Promise<T> {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const value = await read();
		if (accept(value)) return value;
		await delay(100);
	}
	throw new Error(`Timed out: ${label}`);
}

function entriesIn(directory: string): string[] {
	try {
		return readdirSync(directory);
	} catch {
		return [];
	}
}

function jsonFilesIn(directory: string): string[] {
	return entriesIn(directory)
		.filter(file => file.endsWith('.json'))
		.map(file => path.join(directory, file));
}

export class StatusHarness {
	readonly root = mkdtempSync(path.join(tmpdir(), 'pappa-program-status-'));
	readonly socket = `pappa_status_${process.pid}`;
	readonly stateDir = path.join(this.root, 'state');
	readonly sqlite = process.env['PAPPARDELLE_SQLITE_STATE'] === '1';
	/**
	 * Under the harness's own short root: a run may be given a database path
	 * too long for a Unix socket beside it.
	 */
	readonly statusSocket = statusSocketPath(this.stateDir);
	/** The hook statuses, as a Pappardelle run against this harness reads them. */
	readonly claudeStatus: ClaudeStatusDao;
	readonly checks: Array<{
		label: string;
		info?: ProgramStatusInfo;
		frame?: string;
	}> = [];

	private readonly daosFor: (repo: string) => StateDaos;
	/**
	 * With the flag on, the status daemon's hub, served from this process, so
	 * that the monitors in the harness's panes start no daemon.
	 */
	private readonly statusServer?: StatusServer;
	private readonly previous = new Map<string, string | undefined>();
	private stopWatch?: () => void;
	private view?: Awaited<ReturnType<typeof render>>;
	private spaces: SpaceData[] = [];
	constructor() {
		for (const [name, value] of Object.entries({
			PAPPARDELLE_TMUX_SOCKET: this.socket,
			PAPPARDELLE_STATUS_DIR: path.join(this.root, 'hooks'),
			// Hooks run in the harness's panes write to its database, never to
			// the developer's own.
			PAPPARDELLE_STATE_DB: path.join(this.stateDir, 'state.db'),
			PAPPARDELLE_STATUS_SOCKET: this.statusSocket,
			PAPPARDELLE_PROGRAM_STATUS_DIR: path.join(this.root, 'status'),
			PAPPARDELLE_PROGRAM_STATUS_TRACE_DIR: path.join(this.root, 'trace'),
			PAPPARDELLE_CLAUDE_CONFIG_PATH: path.join(
				this.root,
				'claude-config.json',
			),
			SHELL: '/bin/bash',
		})) {
			this.previous.set(name, process.env[name]);
			process.env[name] = value;
		}
		if (this.sqlite) {
			mkdirSync(this.stateDir, {recursive: true});
			this.statusServer = createStatusServer();
			this.statusServer.server.listen(this.statusSocket);
		}

		this.daosFor = stateDaosByRepo({
			stateDir: this.stateDir,
			sqlite: this.sqlite,
		});
		this.claudeStatus = this.daosFor('status-harness').claudeStatus;
	}

	/** A repo's status snapshots, as a Pappardelle run against this harness keeps them. */
	programStatus(repo: string): ProgramStatusDao {
		return this.daosFor(repo).programStatus;
	}

	/** Where a repo's snapshot and lease files are. */
	statusDir(repo: string): string {
		return programStatusDir(repo, this.stateDir);
	}

	/**
	 * How many snapshots of a space the status daemon holds. A run with the
	 * flag off has no daemon.
	 */
	async heldSnapshots(repo: string, key: string): Promise<number> {
		if (!this.sqlite) return 0;
		const closers: Array<() => void | Promise<void>> = [];
		try {
			const rail = await subscribeRaw(
				{teardown: close => closers.push(close)},
				this.statusSocket,
				repo,
			);
			return rail.messages
				.flatMap(message => (message.type === 'state' ? message.snapshots : []))
				.filter(snapshot => snapshot.key === key).length;
		} finally {
			for (const close of closers) await close();
		}
	}

	/**
	 * The status files under the harness's root. With the flag on every
	 * status goes to the daemon, so there are none.
	 */
	private statusFiles(): string[] {
		const hookFiles = [
			path.join(this.root, 'hooks'),
			path.join(this.stateDir, 'claude-status'),
		].flatMap(directory => jsonFilesIn(directory));
		const snapshotRoot = path.join(this.root, 'status');
		const snapshotFiles = entriesIn(snapshotRoot).flatMap(repo =>
			jsonFilesIn(path.join(snapshotRoot, repo)),
		);
		return [...hookFiles, ...snapshotFiles];
	}

	async tmux(args: string[]) {
		return runStatusTmux(statusTmuxArgs(args, this.socket));
	}

	async type(session: string, text: string) {
		await this.tmux(['send-keys', '-t', `=${session}:`, '-l', text]);
		await this.tmux(['send-keys', '-t', `=${session}:`, 'Enter']);
	}

	async screen(session: string) {
		return this.tmux(['capture-pane', '-p', '-t', `=${session}:`]);
	}

	async fixture(session: string) {
		const ready = path.join(this.root, `${session}.ready`);
		rmSync(ready, {force: true});
		const command = [
			'python3',
			path.join(projectRoot, 'integration-tests/program-status-fixture.py'),
			ready,
		]
			.map(value => shellQuoteStatus(value))
			.join(' ');
		await this.type(session, command);
		await until(
			() => {
				try {
					return JSON.parse(readFileSync(ready, 'utf8')) as {reply: string};
				} catch {
					return null;
				}
			},
			Boolean,
			`${session} receives only tmux device attributes`,
		);
	}

	async emit(session: string, body: string, terminator = 'st') {
		await this.type(session, JSON.stringify({body, terminator}));
	}

	async raw(session: string, bytes: Uint8Array) {
		await this.type(
			session,
			JSON.stringify({raw: Buffer.from(bytes).toString('base64')}),
		);
	}

	/** Report a hook status the way the hook does in this run's mode. */
	async writeHook(key: string, status: ClaudeStatus, tool?: string) {
		const state: ClaudeSessionState = {
			sessionId: 'harness',
			workspaceName: key,
			status,
			...(tool ? {currentTool: tool} : {}),
			lastUpdate: Date.now(),
		};
		if (this.sqlite) {
			await sendHookEvent(this.statusSocket, state);
			await until(
				async () => this.claudeStatus.readState(key),
				stored =>
					stored.kind === 'state' && isDeepStrictEqual(stored.state, state),
				`hook status ${status} of ${key} reaches the stores`,
			);
			return;
		}

		const file = path.join(this.root, 'hooks', `${key}.json`);
		const temporary = `${file}.tmp.${process.pid}`;
		mkdirSync(path.dirname(file), {recursive: true});
		writeFileSync(temporary, JSON.stringify(state, null, 2));
		renameSync(temporary, file);
	}

	async mount(repo: string, key: string, session: string) {
		this.unmount();
		const statuses = new WorkspaceStatuses(
			this.programStatus(repo),
			() => session,
			this.claudeStatus,
		);
		this.spaces = [
			{
				name: key,
				worktreePath: this.root,
				programStatus: (await statuses.read(key)) ?? undefined,
			},
		];
		const tree = () =>
			React.createElement(
				'box',
				{width: 30, flexDirection: 'row'},
				React.createElement(SpaceListItem, {
					space: this.spaces[0]!,
					isSelected: false,
					width: 30,
					layout: 'single_line',
				}),
			);
		this.view = await render(tree());
		this.stopWatch = statuses.watch(
			updates => {
				this.spaces = applyStatusUpdates(this.spaces, updates);
				this.view?.rerender(tree());
			},
			candidate => candidate === key,
		);
		return statuses;
	}

	async expect(
		status: ProgramStatusInfo['status'],
		label: string,
		details: Partial<ProgramStatusInfo> = {},
		icon?: string,
		timeout = 10000,
	) {
		const info = await until(
			() => this.spaces[0]?.programStatus,
			value =>
				value?.status === status &&
				Object.entries(details).every(
					([name, expected]) =>
						value[name as keyof ProgramStatusInfo] === expected,
				),
			label,
			timeout,
		);
		if (icon)
			await until(
				() => this.view?.lastFrame() ?? '',
				frame => frame.includes(`${icon} ${this.spaces[0]!.name}`),
				`${label} visible indicator`,
			);
		this.checks.push({label, info, frame: this.view?.lastFrame()});
		console.log(`PASS ${label}`);
		return info!;
	}

	unmount() {
		this.stopWatch?.();
		this.view?.unmount();
	}

	async expectUnknown(label: string) {
		assert.equal(this.spaces[0]?.programStatus?.status ?? 'unknown', 'unknown');
		await until(
			() => this.view?.lastFrame() ?? '',
			frame => frame.includes(`? ${this.spaces[0]!.name}`),
			`${label} visible indicator`,
		);
		this.checks.push({
			label,
			info: this.spaces[0]?.programStatus,
			frame: this.view?.lastFrame(),
		});
		console.log(`PASS ${label}`);
	}

	async cleanup(repo?: string, key?: string) {
		this.unmount();
		try {
			await this.tmux(['kill-server']);
		} catch {}
		if (repo && key) await this.programStatus(repo).remove(key);
		await delay(200);
		const left = this.sqlite ? this.statusFiles() : [];
		if (left.length > 0) {
			console.error(
				`FAIL status files left with the flag on: ${left.join(', ')}`,
			);
			process.exitCode = 1;
		}

		for (const [name, value] of this.previous) {
			if (value === undefined) Reflect.deleteProperty(process.env, name);
			else process.env[name] = value;
		}
		closeStateDb(path.join(this.stateDir, 'state.db'));
		this.daosFor('status-harness').disconnectStatusDaemon();
		this.statusServer?.disconnectAll();
		this.statusServer?.server.close();
		if (!process.argv.includes('--keep'))
			rmSync(this.root, {recursive: true, force: true});
	}

	assertScreenContains(session: string, text: string) {
		const output = execFileSync(
			'tmux',
			statusTmuxArgs(['capture-pane', '-p', '-t', `=${session}:`], this.socket),
			{encoding: 'utf8'},
		);
		assert.ok(output.includes(text), output);
	}
}
