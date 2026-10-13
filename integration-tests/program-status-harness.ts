import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {execFileSync} from 'node:child_process';
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {Box} from 'ink';
import {render} from 'ink-testing-library';
import SpaceListItem from '../source/components/SpaceListItem.tsx';
import {
	WorkspaceStatuses,
	applyStatusUpdates,
} from '../source/workspace-status.ts';
import {
	statusTmuxArgs,
	runStatusTmux,
	shellQuoteStatus,
	removeProgramSnapshots,
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

export class StatusHarness {
	readonly root = mkdtempSync(path.join(tmpdir(), 'pappa-program-status-'));
	readonly socket = `pappa_status_${process.pid}`;
	readonly checks: Array<{
		label: string;
		info?: ProgramStatusInfo;
		frame?: string;
	}> = [];

	private readonly previous = new Map<string, string | undefined>();
	private stopWatch?: () => void;
	private view?: ReturnType<typeof render>;
	private spaces: SpaceData[] = [];
	constructor() {
		for (const [name, value] of Object.entries({
			PAPPARDELLE_TMUX_SOCKET: this.socket,
			PAPPARDELLE_STATUS_DIR: path.join(this.root, 'hooks'),
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
		mkdirSync(path.join(this.root, 'hooks'));
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
			`${session} capability reply before DA`,
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

	writeHook(key: string, status: string, tool?: string) {
		writeFileSync(
			path.join(this.root, 'hooks', `${key}.json`),
			JSON.stringify({status, currentTool: tool, lastUpdate: Date.now()}),
		);
	}

	async mount(repo: string, key: string, session: string) {
		this.unmount();
		const statuses = new WorkspaceStatuses(repo, () => session);
		this.spaces = [
			{
				name: key,
				worktreePath: this.root,
				programStatus: (await statuses.read(key)) ?? undefined,
			},
		];
		const tree = () =>
			React.createElement(
				Box,
				{width: 30},
				React.createElement(SpaceListItem, {
					space: this.spaces[0]!,
					isSelected: false,
					width: 30,
					layout: 'single_line',
				}),
			);
		this.view = render(tree());
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
		if (repo && key) removeProgramSnapshots(repo, key);
		await delay(200);
		for (const [name, value] of this.previous) {
			if (value === undefined) Reflect.deleteProperty(process.env, name);
			else process.env[name] = value;
		}
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
