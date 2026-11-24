/* eslint-disable no-bitwise -- frameWork.fullPathReasons is a bit field. */
/**
 * What the rail costs to render: 40 real rows in the rail's frame, one working
 * (spinner) and one blocked (blink), measured in a real terminal through
 * OpenTUI's own frame statistics. See docs/rail-render-cost.md.
 *
 * Usage: bun scripts/benchmarks/rail-render.tsx [--runs 5] [--phase-ms 3000]
 *   [--blink-ms 6000] [--output benchmark-results/rail-render.jsonl]
 *   [--checkout <other checkout>]
 */
import {
	copyFile,
	mkdir,
	mkdtemp,
	rm,
	unlink,
	writeFile,
} from 'node:fs/promises';
import {existsSync, readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {useEffect, useState, type ReactNode} from 'react';
import {useKeyboard} from '@opentui/react';
import type {CliRenderer, CliRendererStats} from '@opentui/core';
import {renderTui, tmuxRendererEnvironment} from '../../source/render-tui.ts';
import PaneFrame, {
	PANE_FRAME_STYLE,
} from '../../source/components/PaneFrame.tsx';
import SpaceListItem from '../../source/components/SpaceListItem.tsx';

// The fixture is copied into older checkouts for --checkout, and the frame
// size constant has lived in different modules over time, so the fixture
// keeps its own copy: one border cell on each side.
const PANE_FRAME_SIZE = 2;
import type {SpaceData} from '../../source/types.ts';

const COLUMNS = 40;
const ROWS = 42;
const ROW_COUNT = 40;
const WORKING_ROW = 3;
const BLOCKED_ROW = 6;
const WARMUP_MS = 1000;
const SETTLE_MS = 300;
// Output still in flight when the child reports a phase's end.
const BYTE_TAIL_MS = 30;
// The spinner (150 ms) and the blink (500 ms) tick on the renderer clock's
// multiples of their interval, and both divide this. Phases start this far
// past one of its boundaries, between two spinner ticks, and last a multiple
// of it, so no tick falls on either edge of a phase or in its byte tail, and
// each run sees the same ticks against the same keys.
const TICK_GRID_MS = 1500;
const PHASE_OFFSET_MS = 75;
// A held key's auto-repeat rate.
const KEYS_PER_SECOND = 30;
const SWEEP_LENGTH = 10;
// The last key goes this long before the phase ends, so every key written is
// handled inside it.
const KEY_MARGIN_MS = 150;
const FIXTURE_NAME = '.rail-render-fixture.tsx';

const variants = ['pane-frame', 'native-border'] as const;
type Variant = (typeof variants)[number];
const phases = ['idle', 'burst', 'blink'] as const;
type Phase = (typeof phases)[number];

const counters = [
	'paintVisits',
	'membersPainted',
	'memberCells',
	'damageRows',
	'rowsDiffed',
	'yogaSolves',
	'layoutRounds',
	'hostRequests',
] as const satisfies ReadonlyArray<keyof CliRendererStats['frameWork']>;
type Counter = (typeof counters)[number];

// OpenTUI's OT_SCENE_FULL_PATH_* bits, lowest first; @opentui/core does not
// export the constants.
const fullPathReasonNames = [
	'forced',
	'screen',
	'images',
	'tainted',
	'unretained',
	'options',
	'non-local',
];

type Mean = {mean: number | undefined; samples: number};

type ChildRecord = {
	phase: Phase;
	durationMs: number;
	frames: number;
	keysHandled: number;
	staleSnapshots: number;
	cpuMs: number;
	cellsUpdated: number;
	counters: Record<Counter, number>;
	fullPathFrames: number;
	fullPathReasons: number;
	nativeRenderTime: Mean;
	nativeStdoutWriteTime: Mean;
	frameTimeMs: {median: number | undefined; p95: number | undefined};
};

type ChildMessage =
	| {type: 'phase-start'; phase: Phase; durationMs: number}
	| {type: 'phase-end'; record: ChildRecord};

const {values: options} = parseArgs({
	options: {
		child: {type: 'string'},
		runs: {type: 'string', default: '5'},
		'phase-ms': {type: 'string', default: '3000'},
		'blink-ms': {type: 'string', default: '6000'},
		output: {type: 'string', default: 'benchmark-results/rail-render.jsonl'},
		checkout: {type: 'string'},
	},
});
const phaseMs = Number(options['phase-ms']);
const blinkMs = Number(options['blink-ms']);
if (phaseMs % TICK_GRID_MS || blinkMs % TICK_GRID_MS)
	throw new Error(
		`--phase-ms and --blink-ms must be multiples of ${TICK_GRID_MS}`,
	);
const phaseDuration = (phase: Phase) => (phase === 'blink' ? blinkMs : phaseMs);

// Child: the fixture, in the terminal the parent gives it.

function space(index: number): SpaceData {
	const name = 'BENCH-' + String(index + 1).padStart(2, '0');
	return {
		name,
		worktreePath: null,
		profileEmoji: index % 2 ? '🍝' : '⚙️',
		programStatus:
			index === WORKING_ROW
				? {status: 'working'}
				: index === BLOCKED_ROW
					? {status: 'blocked', kind: 'permission'}
					: {status: 'idle'},
		linearIssue: {
			identifier: name,
			title: 'Preserve workspace selection, status and title',
			state: {name: 'Open', type: 'unstarted', color: '#4ea7fc'},
		},
		railStatus: {
			pipeline: 'passing',
			unresolvedCommentCount: 3,
			hasConflict: false,
		},
	};
}

// Rows are memoised, so a row re-renders only when its object changes.
const initialRows = Array.from({length: ROW_COUNT}, (_, index) => space(index));

const fixture = {
	keysHandled: 0,
	select(_row: number) {},
	stopSpinner() {},
};

function Frame({variant, children}: {variant: Variant; children: ReactNode}) {
	if (variant === 'pane-frame') {
		return (
			<PaneFrame isGrowing title="rail" isActive>
				{children}
			</PaneFrame>
		);
	}

	// PaneFrame's layout without its paint hook, so the two differ only there.
	return (
		<box
			border
			flexDirection="column"
			width="100%"
			flexGrow={1}
			flexShrink={1}
			borderStyle={PANE_FRAME_STYLE}
			title="rail"
		>
			{children}
		</box>
	);
}

function Rail({variant}: {variant: Variant}) {
	const [rows, setRows] = useState(initialRows);
	const [selected, setSelected] = useState(0);
	useKeyboard(key => {
		if (key.name !== 'j' && key.name !== 'k') return;
		fixture.keysHandled++;
		const step = key.name === 'j' ? 1 : -1;
		setSelected(row => (row + step + ROW_COUNT) % ROW_COUNT);
	});
	useEffect(() => {
		fixture.select = setSelected;
		fixture.stopSpinner = () => {
			setRows(current =>
				current.with(WORKING_ROW, {
					...current[WORKING_ROW]!,
					programStatus: {status: 'idle'},
				}),
			);
		};
	}, []);
	return (
		<box flexDirection="column" width="100%" height="100%">
			<Frame variant={variant}>
				<box flexDirection="column">
					{rows.map((row, index) => (
						<SpaceListItem
							key={row.name}
							space={row}
							isSelected={index === selected}
							width={COLUMNS - PANE_FRAME_SIZE}
							layout="single_line"
						/>
					))}
				</box>
			</Frame>
		</box>
	);
}

function percentile(sorted: number[], fraction: number): number | undefined {
	return sorted[
		Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
	];
}

function meanOf(sum: number, samples: number): Mean {
	return {mean: samples ? sum / samples : undefined, samples};
}

function phaseRecorder(renderer: CliRenderer) {
	const zeroCounters = () =>
		Object.fromEntries(counters.map(name => [name, 0])) as Record<
			Counter,
			number
		>;
	let phase: Phase = 'idle';
	let frames = 0;
	let staleSnapshots = 0;
	let cellsUpdated = 0;
	let fullPathFrames = 0;
	let fullPathReasons = 0;
	let renderSum = 0;
	let renderSamples = 0;
	let writeSum = 0;
	let writeSamples = 0;
	let sums = zeroCounters();
	let lastWorkFrame = -1;
	let started = performance.now();
	let cpuStarted = process.cpuUsage();
	let isRecording = false;

	renderer.on('frame', () => {
		const stats = renderer.getNativeStats();
		const work = stats.frameWork;
		const isStale = work.workFrameId === lastWorkFrame;
		lastWorkFrame = work.workFrameId;
		if (!isRecording) return;
		if (isStale) staleSnapshots++;
		frames++;
		cellsUpdated += stats.cellsUpdated;
		for (const name of counters) sums[name] += work[name];
		if (work.fullPathReasons) {
			fullPathFrames++;
			fullPathReasons |= work.fullPathReasons;
		}

		// Each time is missing from a frame whose valid flag OpenTUI left unset.
		if (stats.nativeRenderTime !== undefined) {
			renderSum += stats.nativeRenderTime;
			renderSamples++;
		}

		if (stats.nativeStdoutWriteTime !== undefined) {
			writeSum += stats.nativeStdoutWriteTime;
			writeSamples++;
		}
	});

	return {
		start(next: Phase) {
			phase = next;
			frames = 0;
			staleSnapshots = 0;
			cellsUpdated = 0;
			fullPathFrames = 0;
			fullPathReasons = 0;
			renderSum = 0;
			renderSamples = 0;
			writeSum = 0;
			writeSamples = 0;
			sums = zeroCounters();
			fixture.keysHandled = 0;
			renderer.resetStats();
			started = performance.now();
			cpuStarted = process.cpuUsage();
			isRecording = true;
		},
		end(): ChildRecord {
			isRecording = false;
			const cpu = process.cpuUsage(cpuStarted);
			const frameTimes = renderer
				.getStats()
				.frameTimes.toSorted((a, b) => a - b);
			return {
				phase,
				durationMs: performance.now() - started,
				frames,
				keysHandled: fixture.keysHandled,
				staleSnapshots,
				cpuMs: (cpu.user + cpu.system) / 1000,
				cellsUpdated,
				counters: sums,
				fullPathFrames,
				fullPathReasons,
				nativeRenderTime: meanOf(renderSum, renderSamples),
				nativeStdoutWriteTime: meanOf(writeSum, writeSamples),
				frameTimeMs: {
					median: percentile(frameTimes, 0.5),
					p95: percentile(frameTimes, 0.95),
				},
			};
		},
	};
}

async function runChild(variant: Variant) {
	const send = (message: ChildMessage) => process.send!(message);
	const {renderer} = await renderTui(<Rail variant={variant} />, {
		exitOnCtrlC: false,
		gatherStats: true,
		// One sample a millisecond is more frames than any frame-rate cap allows.
		maxStatSamples: Math.max(phaseMs, blinkMs),
		environment: tmuxRendererEnvironment,
	});
	const recorder = phaseRecorder(renderer);
	await Bun.sleep(WARMUP_MS);
	for (const phase of phases) {
		if (phase === 'blink') fixture.stopSpinner();
		fixture.select(0);
		await Bun.sleep(SETTLE_MS);
		await Bun.sleep(
			(PHASE_OFFSET_MS - (renderer.clock.now() % TICK_GRID_MS) + TICK_GRID_MS) %
				TICK_GRID_MS,
		);
		recorder.start(phase);
		send({type: 'phase-start', phase, durationMs: phaseDuration(phase)});
		await Bun.sleep(phaseDuration(phase));
		// The next phase's setup draws, so it waits until the parent has counted
		// this phase's bytes.
		const bytesCounted = new Promise(resolve => {
			process.once('message', resolve);
		});
		send({type: 'phase-end', record: recorder.end()});
		await bytesCounted;
	}

	await Bun.sleep(SETTLE_MS);
	renderer.destroy();
}

// Parent: runs the child in a PTY per run, target and variant, and reports.

type Target = {commit: string; fixture: string};

type RunRecord = ChildRecord & {
	type: 'run';
	run: number;
	commit: string;
	variant: Variant;
	outputBytes: number;
	keysWritten: number;
};

function git(cwd: string, ...args: string[]): string {
	return Bun.spawnSync(['git', ...args], {cwd})
		.stdout.toString()
		.trim();
}

const childEnvironmentKeys = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE'];

async function runOnce(
	target: Target,
	variant: Variant,
	run: number,
	home: string,
): Promise<RunRecord[]> {
	const env: Record<string, string> = {
		HOME: home,
		TERM: 'xterm-256color',
		NODE_ENV: 'production',
	};
	for (const key of childEnvironmentKeys) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}

	let bytes = 0;
	let phaseBytesFrom = 0;
	let keysWritten = 0;
	let keyTimer: ReturnType<typeof setInterval> | undefined;
	const records: Array<Promise<RunRecord>> = [];
	const child = Bun.spawn(
		[
			process.execPath,
			target.fixture,
			'--child',
			variant,
			'--phase-ms',
			String(phaseMs),
			'--blink-ms',
			String(blinkMs),
		],
		{
			cwd: path.dirname(target.fixture),
			env,
			terminal: {
				cols: COLUMNS,
				rows: ROWS,
				data(_terminal, data) {
					bytes += data.length;
				},
			},
			ipc(message: ChildMessage) {
				if (message.type === 'phase-start') {
					phaseBytesFrom = bytes;
					keysWritten = 0;
					if (message.phase === 'burst') {
						const stopAt =
							performance.now() + message.durationMs - KEY_MARGIN_MS;
						keyTimer = setInterval(() => {
							if (performance.now() >= stopAt) {
								clearInterval(keyTimer);
								return;
							}

							const isDown = Math.floor(keysWritten / SWEEP_LENGTH) % 2 === 0;
							child.terminal!.write(isDown ? 'j' : 'k');
							keysWritten++;
						}, 1000 / KEYS_PER_SECOND);
					}

					return;
				}

				clearInterval(keyTimer);
				const written = keysWritten;
				records.push(
					Bun.sleep(BYTE_TAIL_MS).then(() => {
						const outputBytes = bytes - phaseBytesFrom;
						child.send('bytes-counted');
						return {
							type: 'run',
							run,
							commit: target.commit,
							variant,
							...message.record,
							outputBytes,
							keysWritten: written,
						};
					}),
				);
			},
		},
	);
	const limitMs =
		WARMUP_MS +
		phases.reduce((sum, phase) => sum + phaseDuration(phase) + SETTLE_MS, 0) +
		20_000;
	const timeout = setTimeout(() => {
		child.kill();
	}, limitMs);
	const exitCode = await child.exited;
	clearTimeout(timeout);
	clearInterval(keyTimer);
	child.terminal?.close();
	if (exitCode !== 0 || records.length !== phases.length)
		throw new Error(
			`${variant} at ${target.commit} exited ${exitCode} after ${records.length} phases`,
		);
	return Promise.all(records);
}

function check(records: RunRecord[]) {
	const failures: string[] = [];
	const label = (record: RunRecord) =>
		`run ${record.run} ${record.variant} at ${record.commit.slice(0, 7)}`;
	for (const record of records) {
		if (record.staleSnapshots > 0)
			failures.push(
				`${label(record)} ${record.phase}: ${record.staleSnapshots} frame events read a stale stats snapshot`,
			);
		if (record.phase === 'burst' && record.keysHandled !== record.keysWritten)
			failures.push(
				`${label(record)} burst: handled ${record.keysHandled} of ${record.keysWritten} keys`,
			);
	}

	const frameRate = (record: RunRecord, phase: Phase) => {
		const other = records.find(
			candidate =>
				candidate.run === record.run &&
				candidate.commit === record.commit &&
				candidate.variant === record.variant &&
				candidate.phase === phase,
		)!;
		return other.frames / other.durationMs;
	};

	for (const record of records.filter(record => record.phase === 'idle')) {
		if (frameRate(record, 'idle') <= frameRate(record, 'blink'))
			failures.push(
				`${label(record)}: idle drew frames no faster than blink, so the spinner did not run`,
			);
	}

	if (failures.length > 0) throw new Error(failures.join('\n'));
}

const perSecond = (r: RunRecord, total: number) =>
	(total * 1000) / r.durationMs;

// Gate metrics are rates per second: when animations share frames, there are
// fewer frames that each carry more, so a per-frame figure rises while the
// terminal receives less. Per-frame figures are diagnostic, and so is frame
// time, which counts the React commits run inside the renderer's frame loop.
const metrics: Array<{
	name: string;
	gate: boolean;
	value: (record: RunRecord) => number | undefined;
}> = [
	{name: 'framesPerSecond', gate: true, value: r => perSecond(r, r.frames)},
	{name: 'cpuMsPerSecond', gate: true, value: r => perSecond(r, r.cpuMs)},
	{
		name: 'outputBytesPerSecond',
		gate: true,
		value: r => perSecond(r, r.outputBytes),
	},
	{
		name: 'cellsUpdatedPerSecond',
		gate: true,
		value: r => perSecond(r, r.cellsUpdated),
	},
	{
		name: 'nativeRenderTimePerSecond',
		gate: true,
		value: r =>
			r.nativeRenderTime.mean === undefined
				? undefined
				: perSecond(r, r.nativeRenderTime.mean * r.nativeRenderTime.samples),
	},
	...counters.map(name => ({
		name: `${name}PerSecond`,
		gate: true,
		value: (r: RunRecord) => perSecond(r, r.counters[name]),
	})),
	{name: 'fullPathFrames', gate: true, value: r => r.fullPathFrames},
	{
		name: 'outputBytesPerFrame',
		gate: false,
		value: r => r.outputBytes / r.frames,
	},
	{
		name: 'cellsUpdatedPerFrame',
		gate: false,
		value: r => r.cellsUpdated / r.frames,
	},
	{
		name: 'nativeRenderTimePerFrame',
		gate: false,
		value: r => r.nativeRenderTime.mean,
	},
	...counters.map(name => ({
		name: `${name}PerFrame`,
		gate: false,
		value: (r: RunRecord) => r.counters[name] / r.frames,
	})),
	{
		name: 'nativeStdoutWriteTimePerFrame',
		gate: false,
		value: r => r.nativeStdoutWriteTime.mean,
	},
	{name: 'frameTimeMedianMs', gate: false, value: r => r.frameTimeMs.median},
	{name: 'frameTimeP95Ms', gate: false, value: r => r.frameTimeMs.p95},
];

function median(sorted: number[]): number {
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2
		? sorted[middle]!
		: (sorted[middle - 1]! + sorted[middle]!) / 2;
}

type Summary = {
	type: 'summary';
	commit: string;
	variant: Variant;
	phase: Phase;
	metric: string;
	gate: boolean;
	runs: number;
	median: number;
	min: number;
	max: number;
	range: number;
	/** Range over median; undefined when the median is 0. */
	spread: number | undefined;
	fullPathReasons?: string[];
};

function summarize(records: RunRecord[]): Summary[] {
	const summaries: Summary[] = [];
	const commits = new Set(records.map(record => record.commit));
	const groups = [...commits].flatMap(commit =>
		variants.flatMap(variant =>
			phases.map(phase => ({commit, variant, phase})),
		),
	);
	for (const {commit, variant, phase} of groups) {
		const group = records.filter(
			record =>
				record.commit === commit &&
				record.variant === variant &&
				record.phase === phase,
		);
		const reasons = group.reduce(
			(bits, record) => bits | record.fullPathReasons,
			0,
		);
		for (const metric of metrics) {
			const values = group
				.map(record => metric.value(record))
				.filter(value => value !== undefined)
				.toSorted((a, b) => a - b);
			if (values.length === 0) continue;
			const middle = median(values);
			const min = values[0]!;
			const max = values.at(-1)!;
			summaries.push({
				type: 'summary',
				commit,
				variant,
				phase,
				metric: metric.name,
				gate: metric.gate,
				runs: values.length,
				median: middle,
				min,
				max,
				range: max - min,
				spread: middle === 0 ? undefined : (max - min) / middle,
				...(metric.name === 'fullPathFrames' && {
					fullPathReasons: fullPathReasonNames.filter(
						(_, bit) => reasons & (1 << bit),
					),
				}),
			});
		}
	}

	return summaries;
}

function formatNumber(value: number): string {
	if (value >= 100) return value.toFixed(0);
	return value >= 10 ? value.toFixed(1) : value.toFixed(2);
}

function table(summaries: Summary[]): string {
	const lines: string[] = [];
	const commits = new Set(summaries.map(summary => summary.commit));
	for (const commit of commits)
		for (const variant of variants) {
			lines.push(
				'',
				`${variant} at ${commit.slice(0, 7)}: median (min-max, spread)`,
				'',
				`| metric | gate | ${phases.join(' | ')} |`,
				`| --- | --- | ${phases.map(() => '---').join(' | ')} |`,
			);
			for (const metric of metrics) {
				const cells = phases.map(phase => {
					const summary = summaries.find(
						s =>
							s.commit === commit &&
							s.variant === variant &&
							s.phase === phase &&
							s.metric === metric.name,
					);
					if (!summary) return 'n/a';
					const spread =
						summary.spread === undefined
							? 'n/a'
							: `${(summary.spread * 100).toFixed(0)}%`;
					return `${formatNumber(summary.median)} (${formatNumber(summary.min)}-${formatNumber(summary.max)}, ${spread})`;
				});
				lines.push(
					`| ${metric.name} | ${metric.gate ? 'yes' : 'no'} | ${cells.join(' | ')} |`,
				);
			}
		}

	return lines.join('\n');
}

function cpuModel(): string | undefined {
	if (existsSync('/proc/cpuinfo')) {
		const line = readFileSync('/proc/cpuinfo', 'utf8')
			.split('\n')
			.find(entry => entry.startsWith('model name'));
		if (line) return line.split(':')[1]?.trim();
	}

	return os.cpus()[0]?.model;
}

async function runParent() {
	const here = path.resolve(import.meta.dirname, '../..');
	const targets: Target[] = [
		{commit: git(here, 'rev-parse', 'HEAD'), fixture: import.meta.path},
	];
	let copied: string | undefined;
	if (options.checkout) {
		// At the same depth as this script, so the fixture's ../../source imports
		// that checkout's components and its React.
		const checkout = path.resolve(options.checkout);
		copied = path.join(checkout, 'scripts/benchmarks', FIXTURE_NAME);
		if (existsSync(copied)) throw new Error(`${copied} already exists`);
		targets.push({commit: git(checkout, 'rev-parse', 'HEAD'), fixture: copied});
	}

	const home = await mkdtemp(path.join(os.tmpdir(), 'rail-render-'));
	try {
		if (copied) await copyFile(import.meta.path, copied);
		const runs = Number(options.runs);
		const environment = {
			type: 'environment',
			os: `${os.type()} ${os.release()}`,
			cpu: cpuModel(),
			logicalCpus: os.cpus().length,
			bun: Bun.version,
			terminal: `PTY ${COLUMNS}x${ROWS} TERM=xterm-256color`,
			commits: targets.map(target => target.commit),
			runs,
			phaseMs,
			blinkMs,
			settleMs: SETTLE_MS,
			keysPerSecond: KEYS_PER_SECOND,
		};
		const records: RunRecord[] = [];
		// Base and head, and both variants, alternate inside each run so drift
		// over the session lands on all of them.
		const pairs = targets.flatMap(target =>
			variants.map(variant => ({target, variant})),
		);
		for (let run = 1; run <= runs; run++)
			for (const {target, variant} of pairs) {
				records.push(...(await runOnce(target, variant, run, home)));
				console.error(
					`run ${run} ${variant} at ${target.commit.slice(0, 7)} done`,
				);
			}

		const summaries = summarize(records);
		await mkdir(path.dirname(path.resolve(options.output)), {recursive: true});
		await writeFile(
			options.output,
			[environment, ...records, ...summaries]
				.map(line => JSON.stringify(line))
				.join('\n') + '\n',
		);
		console.log(table(summaries));
		check(records);
	} finally {
		if (copied) await unlink(copied);
		await rm(home, {recursive: true, force: true});
	}
}

if (options.child) await runChild(options.child as Variant);
else await runParent();
