import {RGBA, type ColorInput} from '@opentui/core';
import stringWidth from 'string-width';
import {truncateToWidth} from '../../../source/truncate-to-width.ts';
import {REPO} from '../../fixtures.ts';
import {
	chip,
	hexOf,
	mix,
	paint,
	trackerColor,
	type Look,
} from '../../kit/color.ts';
import {terminalColor} from '../../../source/tui-style.ts';
import {Block, DROP, dropExtras, Line, type Seg} from '../../kit/line.tsx';
import {
	cycle,
	ease,
	isRunning,
	progressOf,
	pulse,
	sparkline,
	sweepColumn,
} from '../../kit/motion.ts';
import {describeSpace, type RowModel} from '../../kit/row.ts';
import type {SurfaceProps} from '../../kit/surface.ts';
import {surfaces, tokens} from './tokens.ts';

export const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const SPIN_INTERVAL = 80;
/** 16-color pulse: a ring that fills and empties, since color can't ease. */
/** Its own two glyphs: `○` is idle and `●` is done. */
export const RING = ['◎', '◉'];
export const RING_INTERVAL = 260;
export const BREATH_PERIOD = 2400;
export const ATTENTION_PERIOD = 1600;
export const SHIMMER = 700;
export const GLIDE = 140;
const PROGRESS_WASH = 0.18;
export const SLIDE_IN = 320;
export const COLLAPSE = 360;

const segmenter = new Intl.Segmenter();

/** Splits text into per-grapheme segments styled by column, merging runs. */
function styledCells(
	text: string,
	style: (column: number) => Partial<Seg>,
): Seg[] {
	const segs: Seg[] = [];
	let column = 0;
	let last = '';
	for (const {segment} of segmenter.segment(text)) {
		const cellStyle = style(column);
		const signature = JSON.stringify(cellStyle);
		const previous = segs.at(-1);
		if (previous && signature === last) previous.text += segment;
		else segs.push({...cellStyle, text: segment});
		last = signature;
		column += stringWidth(segment);
	}

	return segs;
}

function stateAccent(row: RowModel) {
	if (row.state === 'question') return tokens.question;
	if (row.state === 'permission') return tokens.permission;
	if (row.state === 'error') return tokens.error;
	if (row.state === 'done') return tokens.ok;
	return tokens.live;
}

function glyph(row: RowModel, look: Look, now: number): Seg {
	const s = surfaces(look);
	switch (row.state) {
		case 'working':
		case 'tool':
		case 'pending': {
			return {
				text: cycle(SPIN, now, SPIN_INTERVAL),
				fg:
					row.state === 'pending'
						? look.tier === 'truecolor'
							? RGBA.fromHex(s.muted)
							: undefined
						: paint(tokens.live, look),
				dim: row.state === 'pending' && look.tier === 'ansi',
			};
		}

		case 'compacting': {
			if (look.tier === 'truecolor') {
				const breath = pulse(now, BREATH_PERIOD);
				return {
					text: '◌',
					fg: RGBA.fromHex(
						mix(s.faint, hexOf(tokens.live, look.theme), breath),
					),
				};
			}

			return {text: '◌', dim: true};
		}

		case 'question':
		case 'permission': {
			return {
				text: look.tier === 'truecolor' ? '●' : cycle(RING, now, RING_INTERVAL),
				fg: paint(stateAccent(row), look),
				bold: true,
			};
		}

		case 'done': {
			return {text: '●', fg: paint(tokens.ok, look)};
		}

		case 'error': {
			return {text: '✕', fg: paint(tokens.error, look)};
		}

		case 'idle': {
			return {
				text: '○',
				fg: look.tier === 'truecolor' ? RGBA.fromHex(s.muted) : undefined,
				dim: look.tier === 'ansi',
			};
		}

		case 'unknown': {
			return {
				text: '·',
				fg: look.tier === 'truecolor' ? RGBA.fromHex(s.faint) : undefined,
				dim: look.tier === 'ansi',
			};
		}
	}
}

function rightCluster(row: RowModel, look: Look): Seg[] {
	const segs: Seg[] = [];
	const muted =
		look.tier === 'truecolor'
			? {fg: RGBA.fromHex(surfaces(look).muted)}
			: {dim: true};
	if (row.comments > 0) segs.push({text: ` ${row.comments}✎`, ...muted});
	if (row.conflict) segs.push({text: ' ↯', fg: paint(tokens.error, look)});
	if (row.pipeline === 'passing')
		segs.push({text: ' ✓', fg: paint(tokens.ok, look)});
	if (row.pipeline === 'failing')
		segs.push({text: ' ✗', fg: paint(tokens.error, look), bold: true});
	if (row.pipeline === 'progressing_clean')
		segs.push({text: ' ◔', fg: paint(tokens.warn, look)});
	if (row.pipeline === 'progressing_dirty')
		segs.push({text: ' ◑', fg: paint(tokens.error, look)});
	return segs.map(seg => ({
		...seg,
		drop: seg.text.includes('✎') ? DROP.comments : DROP.pipeline,
	}));
}

type RowBlock = {id: string; lines: Seg[][]; bg?: ColorInput; height: number};

function rowBlock(
	row: RowModel,
	props: SurfaceProps,
	cols: number,
): RowBlock | undefined {
	const {look, now, frame, layout} = props;
	const s = surfaces(look);
	const isTrue = look.tier === 'truecolor';
	const selected = row.space.name === frame.selected;
	const change = frame.changes[row.space.name];
	const closingAt = frame.closing?.[row.space.name];
	const id = row.space.name || 'new';

	let enter = 1;
	if (change?.kind === 'created')
		enter = ease.outCubic(progressOf(now, change.at, SLIDE_IN));
	let leave = 0;
	if (closingAt !== undefined) {
		leave = progressOf(now, closingAt, COLLAPSE);
		if (leave >= 1) return undefined;
	}

	const emoji: Seg[] = row.emoji ? [{text: `${row.emoji} `}] : [];
	const key: Seg = {text: row.key, bold: true, clip: true};
	// Keys carry the tracker's workflow color, held to a readable contrast on
	// whatever sits behind them (the progress fill, when there is one).
	const behind =
		row.progress === undefined
			? s.bg
			: s.wash(hexOf(tokens.live, look.theme), PROGRESS_WASH);
	const workflow =
		row.workflow && trackerColor(row.workflow.color, look, behind);
	if (row.needsYou) key.fg = paint(stateAccent(row), look);
	else if (isTrue && (row.state === 'working' || row.state === 'tool')) {
		// Working keys breathe between the tracker color and the background.
		key.fg = RGBA.fromHex(
			mix(
				workflow ?? s.fg,
				s.muted,
				pulse(now, BREATH_PERIOD, row.key.length * 300) * 0.7,
			),
		);
	} else if (workflow)
		key.fg = isTrue ? RGBA.fromHex(workflow) : terminalColor(workflow);

	// The gap after the pill goes first on the narrowest rails, for every row
	// at once so the glyph column stays aligned.
	const prefix: Seg[] = [
		{text: cols >= 15 ? ' ' : ''},
		...emoji,
		glyph(row, look, now),
		{text: ' '},
		key,
		{text: ' '},
	];
	const cluster = rightCluster(row, look);
	const twoLine = layout === 'two_line';
	// Two-line rows end the first line at the key; the cluster brings its own
	// leading spaces.
	const head = twoLine ? prefix.slice(0, -1) : prefix;
	const fitted = dropExtras(
		twoLine
			? [...head, ...cluster]
			: [...prefix, {text: row.title, shrink: true}, ...cluster],
		cols,
	);
	const right = cluster.filter(seg => fitted.includes(seg));
	const prefixCells = prefix.reduce(
		(sum, seg) => sum + stringWidth(seg.text),
		0,
	);
	const rightCells = right.reduce((sum, seg) => sum + stringWidth(seg.text), 0);
	const titleCells = Math.max(
		row.title ? 1 : 0,
		twoLine
			? cols - prefixCells + stringWidth(row.key)
			: cols - prefixCells - rightCells,
	);
	const title = truncateToWidth(row.title, titleCells);

	// A highlight band sweeps the title whenever the agent says something new.
	const shimmering =
		change !== undefined &&
		(change.kind === 'message' || change.kind === 'state') &&
		isRunning(now, change.at, SHIMMER);
	const band = shimmering
		? sweepColumn(now, change.at, SHIMMER, titleCells)
		: -99;
	const quiet = !selected && !row.needsYou;
	const titleSegs = styledCells(title, column => {
		const distance = Math.abs(column - band);
		if (distance <= 2) {
			if (isTrue) {
				const glow = 1 - distance / 3;
				return {
					fg: RGBA.fromHex(mix(quiet ? s.muted : s.fg, s.glint, glow * 0.85)),
				};
			}

			return {bold: true};
		}

		if (quiet) return isTrue ? {fg: RGBA.fromHex(s.muted)} : {dim: true};
		return {};
	});

	let lines: Seg[][] = twoLine
		? [
				[...head, {text: '', grow: true}, ...right],
				[
					{text: ' '.repeat(prefixCells - stringWidth(row.key) - 1)},
					...titleSegs,
				],
			]
		: [[...prefix, ...titleSegs, {text: '', grow: true}, ...right]];

	// Every row with something to say shows it, so moving the selection never
	// reflows the list.
	if (row.detail) {
		const detailText = truncateToWidth(row.detail, cols - 6);
		lines.push([
			{text: '    '},
			{text: '› ', fg: paint(tokens.live, look)},
			{
				text: detailText,
				italic: true,
				...(isTrue ? {fg: RGBA.fromHex(s.muted)} : {dim: true}),
			},
		]);
	}

	// Rows slide in from the right edge: laid out at full width, then pushed
	// right and cut by the rail's edge, so nothing re-fits mid-slide.
	if (enter < 1) {
		const offset = Math.round((1 - enter) * cols);
		lines = lines.map(line => [
			{text: ' '.repeat(offset)},
			...line.map(seg => ({
				...seg,
				drop: undefined,
				clip: undefined,
				shrink: undefined,
			})),
		]);
	}

	// Progress fills the row from the left. Truecolor tints the cells; 16
	// colors underline them, which every terminal can draw.
	const {progress} = row;
	let bg: ColorInput | undefined;
	if (progress !== undefined && lines[0]) {
		// 16 colors underlines the title only; an underline under the emoji and
		// spinner reads as stray underscores.
		const start = isTrue ? 0 : prefixCells;
		const filled = start + Math.round((progress / 100) * (cols - start));
		const fill = isTrue
			? {
					bg: RGBA.fromHex(
						s.wash(hexOf(tokens.live, look.theme), PROGRESS_WASH),
					),
				}
			: {underline: true};
		lines[0] = splitAt(lines[0], cols, [start, filled], fill);
	}

	if (row.needsYou && isTrue) {
		const accent = hexOf(stateAccent(row), look.theme);
		bg = RGBA.fromHex(
			s.wash(accent, 0.06 + pulse(now, ATTENTION_PERIOD) * 0.16),
		);
	}

	if (leave > 0) {
		const fade: Partial<Seg> = isTrue
			? {fg: RGBA.fromHex(mix(s.muted, s.bg, leave))}
			: {dim: true, italic: true};
		lines = lines.map(line =>
			line.map(seg => ({...seg, ...fade, bg: undefined})),
		);
		// Collapse: the block loses its lines as it fades.
		lines = lines.slice(0, Math.max(1, Math.ceil(lines.length * (1 - leave))));
	}

	return {id, lines, bg, height: lines.length};
}

/** Applies `style` to columns `from` (inclusive) to `to` of a line. */
function splitAt(
	line: Seg[],
	cols: number,
	[from, to]: [number, number],
	style: Partial<Seg>,
): Seg[] {
	const total = line.reduce((sum, seg) => sum + stringWidth(seg.text), 0);
	const padded = line.map(seg =>
		seg.grow
			? {
					...seg,
					text: seg.text + ' '.repeat(Math.max(0, cols - total)),
					grow: false,
				}
			: seg,
	);
	const out: Seg[] = [];
	const runs: string[] = [];
	let used = 0;
	for (const [index, seg] of padded.entries()) {
		for (const {segment} of segmenter.segment(seg.text)) {
			const inside = used >= from && used < to;
			const run = `${index}:${inside}`;
			if (runs.at(-1) === run) out.at(-1)!.text += segment;
			else {
				out.push(
					inside ? {...seg, ...style, text: segment} : {...seg, text: segment},
				);
				runs.push(run);
			}

			used += stringWidth(segment);
		}
	}

	return out;
}

/**
 * The selection pill sits in column 0 and glides between rows at half-row
 * resolution: `▀` and `▄` draw it straddling two rows mid-move.
 */
function pillColumn(
	blocks: RowBlock[],
	props: SurfaceProps,
	rows: number,
): Seg[] {
	const {frame, now, look} = props;
	const tops = new Map<string, number>();
	let y = 0;
	for (const block of blocks) {
		tops.set(block.id, y);
		y += block.height;
	}

	const target = tops.get(frame.selected);
	if (target === undefined)
		return Array.from({length: rows}, () => ({text: ' '}));
	const move = frame.changes['selection'];
	let position = target;
	if (move?.from && isRunning(now, move.at, GLIDE)) {
		const from = tops.get(move.from) ?? target;
		position =
			from + (target - from) * ease.outCubic(progressOf(now, move.at, GLIDE));
	}

	const top = Math.round(position * 2);
	const color = paint(tokens.pill, look);
	return Array.from({length: rows}, (_, row) => {
		const upper = top <= row * 2 && row * 2 < top + 2;
		const lower = top <= row * 2 + 1 && row * 2 + 1 < top + 2;
		if (upper && lower) return {text: '█', fg: color};
		if (upper) return {text: '▀', fg: color};
		if (lower) return {text: '▄', fg: color};
		return {text: ' '};
	});
}

/**
 * The second header row carries the newest thing any agent said, so a
 * message from a row scrolled out of view still reaches you.
 */
export function ticker(rows: RowModel[], props: SurfaceProps): Seg[] {
	const {look, now, frame} = props;
	const s = surfaces(look);
	const faint =
		look.tier === 'truecolor' ? {fg: RGBA.fromHex(s.faint)} : {dim: true};
	const latest = rows
		.filter(row => row.detail && frame.changes[row.space.name])
		.sort(
			(a, b) =>
				frame.changes[b.space.name]!.at - frame.changes[a.space.name]!.at,
		)[0];
	// A question an agent is waiting on outranks the newest message, and
	// stays at full strength until it's answered.
	const asking = rows.find(r => r.needsYou && r.detail);
	const row =
		asking ??
		latest ??
		rows.find(r => r.space.name === frame.selected && r.detail) ??
		rows.find(r => r.detail);
	if (!row?.detail) return [];
	const change = frame.changes[row.space.name];
	const fresh = change !== undefined && isRunning(now, change.at, SHIMMER * 2);
	const keyStyle: Partial<Seg> = row.needsYou
		? {fg: paint(stateAccent(row), look), bold: true}
		: fresh
			? {fg: paint(tokens.live, look), bold: true}
			: faint;
	return [
		{text: ' '},
		{text: row.key, ...keyStyle},
		{text: ' ', ...faint},
		{
			text: row.detail,
			italic: true,
			shrink: true,
			...(fresh || row.needsYou ? {} : faint),
		},
	];
}

export function fleetActivity(rows: RowModel[]): number[] {
	const series = rows
		.map(row => row.space.extras?.activity)
		.filter(a => a !== undefined);
	const length = Math.max(0, ...series.map(a => a.length));
	return Array.from(
		{length},
		(_, i) =>
			series.reduce((sum, a) => sum + (a[i] ?? 0), 0) /
			Math.max(1, series.length),
	);
}

export function LivingRail(props: SurfaceProps) {
	const {look, width, height, frame} = props;
	const rows = frame.spaces.map(space => describeSpace(space));
	const needsYou = rows.filter(row => row.needsYou).length;
	const body = width - 1;
	const header: Seg[] = [
		{text: ' '},
		{text: REPO, bold: true, shrink: true},
		{
			text: ` ${sparkline(fleetActivity(rows))}`,
			fg: paint(tokens.live, look),
			drop: DROP.decoration,
		},
		{text: '', grow: true},
		...(needsYou > 0
			? [
					{
						text: ` ${needsYou} `,
						...chip(
							paint(tokens.question, look),
							paint(tokens.onAccent, look),
							look,
						),
						bold: true,
					},
				]
			: []),
		{text: ' '},
	];
	const subline = ticker(rows, props);

	const blocks = rows
		.map(row => rowBlock(row, props, body))
		.filter(block => block !== undefined);
	const bodyRows = height - 2;
	// Agents waiting on you below the fold still reach the header.
	let top = 0;
	let hidden = 0;
	for (const block of blocks) {
		// A row counts as below the fold once its key line is.
		const below = top >= bodyRows;
		if (below && rows.find(row => row.space.name === block.id)?.needsYou)
			hidden++;
		top += block.height;
	}

	if (hidden > 0)
		header.splice(-1, 0, {
			text: ` ↓${hidden}`,
			fg: paint(tokens.question, look),
			bold: true,
		});
	const pill = pillColumn(blocks, props, bodyRows);
	return (
		<box flexDirection="column" width={width} height={height}>
			<Block lines={[header, subline]} cols={width} />
			<box flexDirection="row">
				<box flexDirection="column" width={1}>
					{pill.map((seg, index) => (
						<Line key={index} cols={1} segs={[seg]} />
					))}
				</box>
				<box flexDirection="column" width={body}>
					{blocks.map(block => (
						<Block
							key={block.id}
							lines={block.lines}
							cols={body}
							bg={block.bg}
						/>
					))}
				</box>
			</box>
		</box>
	);
}
