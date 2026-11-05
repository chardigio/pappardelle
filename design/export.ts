import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import type {ReactNode} from 'react';
import type {ListLayout} from '../source/config.ts';
import {scenes, still, type SceneFrame} from './fixtures.ts';
import {
	fromAnsi,
	isBlankLine,
	openOffscreen,
	type Frame,
	type OffscreenSession,
	type Span,
} from './kit/frame.ts';
import {THEMES, type Look} from './kit/color.ts';
import {RAIL_HEIGHT, SURFACE_SIZE, type SurfaceName} from './kit/surface.ts';
import {directions, targetById} from './directions/index.tsx';
import {demos} from './primer/index.tsx';

// An open OpenTUI session keeps the event loop alive, so an error escaping
// the top level would leave export hanging after it prints.
function fail(error: unknown) {
	console.error(error);
	// eslint-disable-next-line unicorn/no-process-exit
	process.exit(1);
}

process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

/**
 * Renders every frame the artifact shows and writes design/out/frames.json.
 * Rows are interned: a frame is a list of row ids into one shared table, so
 * an animation that changes two rows per frame stores two new rows per frame.
 */

const DESIGN = import.meta.dir;
const OUT = path.join(DESIGN, 'out');
/** 16-color frames don't depend on the theme; the page maps palette slots. */
const VARIANTS: Array<{id: string; look: Look}> = [
	{id: 'ansi', look: {tier: 'ansi', theme: 'dark'}},
	...THEMES.map(theme => {
		const look: Look = {tier: 'truecolor', theme};
		return {id: `truecolor-${theme}`, look};
	}),
];
const FPS = 25;
const DIALOG_SEQUENCE = 2400;
const RAIL_WIDTHS = [15, 28, 40];
const SCENE_WIDTH = 34;
const RAIL_ROWS = RAIL_HEIGHT;

const rowTable: Span[][] = [];
const rowIds = new Map<string, number>();
function intern(line: Span[]): number {
	const key = JSON.stringify(line);
	let id = rowIds.get(key);
	if (id === undefined) {
		id = rowTable.length;
		rowTable.push(line);
		rowIds.set(key, id);
	}

	return id;
}

type StoredFrame = {cols: number; rows: number; lines: number[]};
type StoredSequence = {
	cols: number;
	rows: number;
	fps: number;
	frames: number[][];
};

const frames: Record<string, StoredFrame> = {};
const sequences: Record<string, StoredSequence> = {};

/**
 * The page doesn't need to show empty pane: keep rows through the last one
 * any of the frames draws on, plus one blank row. Trimming a sequence by all
 * its frames at once keeps its height fixed while it plays.
 */
function keptRows(frames: Frame[]): number {
	let used = 1;
	for (const frame of frames)
		for (const [y, line] of frame.lines.entries())
			if (!isBlankLine(line)) used = Math.max(used, y + 1);
	return Math.min(frames[0]!.lines.length, used + 1);
}

function store(frame: Frame): StoredFrame {
	const lines = frame.lines.slice(0, keptRows([frame]));
	return {
		cols: frame.cols,
		rows: lines.length,
		lines: lines.map(line => intern(line)),
	};
}

/**
 * fromCaptured sizes graphemes with Bun.stringWidth, which disagrees with
 * OpenTUI on some emoji (VS16, skin tones, ZWJ sequences). A row whose cells
 * don't add up to the canvas width would be drawn shifted on the page.
 */
function checkWidths(key: string, frame: Frame) {
	for (const [y, line] of frame.lines.entries()) {
		const width = line.reduce((sum, span) => sum + span[4], 0);
		if (width !== frame.cols)
			throw new Error(
				`${key} row ${y} is ${width} cells wide, not ${frame.cols}: ${JSON.stringify(line.map(span => span[0]).join(''))}`,
			);
	}
}

/**
 * Each renderer holds a listener on OpenTUI's shared console cache, so one
 * per canvas size trips Node's leak warning; keep one open at a time.
 */
let open: {size: string; session: OffscreenSession} | undefined;
async function session(cols: number, rows: number) {
	const size = `${cols}x${rows}`;
	if (open?.size !== size) {
		await open?.session.dispose();
		open = {size, session: await openOffscreen(cols, rows)};
	}

	return open.session;
}

async function renderStill(
	key: string,
	cols: number,
	rows: number,
	node: Parameters<OffscreenSession['render']>[0],
) {
	const renderer = await session(cols, rows);
	const frame = await renderer.render(node);
	checkWidths(key, frame);
	frames[key] = store(frame);
}

async function sequence(
	key: string,
	cols: number,
	rows: number,
	duration: number,
	nodeAt: (t: number) => Parameters<OffscreenSession['render']>[0],
) {
	const renderer = await session(cols, rows);
	const rendered: Frame[] = [];
	for (let t = 0; t < duration; t += 1000 / FPS) {
		const frame = await renderer.render(nodeAt(Math.round(t)));
		checkWidths(`${key} at ${Math.round(t)} ms`, frame);
		rendered.push(frame);
	}

	const kept = keptRows(rendered);
	sequences[key] = {
		cols,
		rows: kept,
		fps: FPS,
		frames: rendered.map(frame =>
			frame.lines.slice(0, kept).map(line => intern(line)),
		),
	};
}

const surfaceProps = (
	look: Look,
	width: number,
	height: number,
	layout: ListLayout,
	frame: SceneFrame,
	now: number,
) => ({now, look, width, height, layout, frame});

// Before: the live captures from the run-through, plus the real components
// rendered with the design fixtures.
const CAPTURES: Record<string, [number, number]> = {
	'rail-160-a': [37, 24],
	'rail-160-b': [37, 24],
	'rail-160-sel3': [37, 24],
	'rail-160-single': [37, 14],
	'rail-120-single': [28, 14],
	'rail-100': [23, 14],
	'rail-90-vertical': [90, 7],
	search: [37, 6],
	'prompt-profile': [160, 22],
	'agent-pane-160': [60, 3],
};
for (const [name, [cols, rows]] of Object.entries(CAPTURES))
	frames[`capture/${name}`] = store(
		fromAnsi(
			readFileSync(path.join(DESIGN, 'captures', `${name}.ansi`), 'utf8'),
			cols,
			rows,
		),
	);

// The live rail captured half a second apart: the blink's on and off phases.
sequences['capture/blink'] = {
	cols: 37,
	rows: 24,
	fps: 2,
	frames: [
		frames['capture/rail-160-a']!.lines,
		frames['capture/rail-160-b']!.lines,
	],
};

const current = targetById('current');
const ansi = VARIANTS[0]!.look;
for (const layout of ['single_line', 'two_line'] as ListLayout[])
	await renderStill(
		`current/rail/${SCENE_WIDTH}/${layout}`,
		SCENE_WIDTH,
		RAIL_ROWS,
		current.render(
			'rail',
			surfaceProps(ansi, SCENE_WIDTH, RAIL_ROWS, layout, still, 0),
		),
	);
for (const surface of [
	'help',
	'errors',
	'confirm',
	'confirm-neutral',
] as SurfaceName[]) {
	const [cols, rows] = SURFACE_SIZE[surface as 'help'];
	await renderStill(
		`current/${surface}`,
		cols,
		rows,
		current.render(
			surface,
			surfaceProps(ansi, cols, rows, 'single_line', still, 0),
		),
	);
}

for (const direction of directions) {
	const target = targetById(direction.id);
	for (const variant of VARIANTS) {
		const {look} = variant;
		for (const width of RAIL_WIDTHS)
			for (const layout of ['single_line', 'two_line'] as ListLayout[])
				await renderStill(
					`${direction.id}/rail/${width}/${layout}/${variant.id}`,
					width,
					RAIL_ROWS,
					target.render(
						'rail',
						surfaceProps(look, width, RAIL_ROWS, layout, still, 0),
					),
				);

		for (const scene of scenes)
			await sequence(
				`${direction.id}/scene/${scene.name}/${variant.id}`,
				SCENE_WIDTH,
				RAIL_ROWS,
				scene.duration,
				(t): ReactNode =>
					target.render(
						'rail',
						surfaceProps(
							look,
							SCENE_WIDTH,
							RAIL_ROWS,
							'single_line',
							scene.at(t),
							t,
						),
					),
			);

		for (const surface of [
			'prompt',
			'confirm',
			'confirm-neutral',
			'help',
			'errors',
			'chrome',
		] as SurfaceName[]) {
			const [cols, rows] = SURFACE_SIZE[surface as 'help'];
			await renderStill(
				`${direction.id}/${surface}/${variant.id}`,
				cols,
				rows,
				target.render(
					surface,
					surfaceProps(
						look,
						cols,
						rows,
						'single_line',
						still,
						DIALOG_SEQUENCE - 600,
					),
				),
			);
			if (direction.id === 'living-rail' && surface !== 'chrome')
				await sequence(
					`${direction.id}/${surface}-motion/${variant.id}`,
					cols,
					rows,
					DIALOG_SEQUENCE + 600,
					(t): ReactNode =>
						target.render(
							surface,
							surfaceProps(look, cols, rows, 'single_line', still, t),
						),
				);
		}
	}
}

for (const demo of demos)
	for (const variant of VARIANTS)
		await sequence(
			`primer/${demo.id}/${variant.id}`,
			demo.cols,
			demo.rows,
			demo.duration,
			(t): ReactNode => demo.render(t, variant.look),
		);

await open?.session.dispose();

const meta = {
	directions: directions.map(direction => ({
		id: direction.id,
		name: direction.name,
		pitch: direction.pitch,
		tmuxConf: direction.tmuxConf(ansi),
	})),
	scenes: scenes.map(({name, title, caption, duration}) => ({
		name,
		title,
		caption,
		duration,
	})),
	demos: demos.map(({id, title, body, duration}) => ({
		id,
		title,
		body,
		duration,
	})),
	themes: THEMES,
	railWidths: RAIL_WIDTHS,
};

mkdirSync(OUT, {recursive: true});
const json = JSON.stringify({meta, rows: rowTable, frames, sequences});
writeFileSync(path.join(OUT, 'frames.json'), json);
console.log(
	`${Object.keys(frames).length} frames, ${Object.keys(sequences).length} sequences, ${rowTable.length} unique rows, ${(json.length / 1e6).toFixed(1)} MB`,
);
// OpenTUI's native renderers keep the event loop alive after dispose.
// eslint-disable-next-line unicorn/no-process-exit
process.exit(0);
