import {RGBA, type ColorInput} from '@opentui/core';
import {REPO} from '../../fixtures.ts';
import {chip, hexOf, paint, type Look} from '../../kit/color.ts';
import {Block, DROP, MIN_SHRINK, type Seg} from '../../kit/line.tsx';
import {eighthBar, isRunning, sparkline} from '../../kit/motion.ts';
import {age, describeSpace, type RowModel} from '../../kit/row.ts';
import type {SurfaceProps} from '../../kit/surface.ts';
import {READOUT, surfaces, tokens, type Channel} from './tokens.ts';

/** Master caution flashes for 2.4 s when an agent starts needing you. */
export const CAUTION = {duration: 2400, flash: 300};
export const CLOSE_DURATION = 450;
export const BOOT_BLINK = 250;
/** Sparklines scroll one sample per second, the rail's only ambient motion. */
export const SPARK_STEP = 1000;
const SPARK_CELLS = 6;
/** Between the comment count and the pipeline in the shared drop order. */
const TITLE_DROP = (DROP.comments + DROP.pipeline) / 2;
/**
 * The narrowest rail where titles survive: cursor, lamp and a 7-cell key,
 * a MIN_SHRINK title, then the pipeline glyph and readout.
 */
const TITLED_WIDTH = 3 + 7 + MIN_SHRINK + 2 + 5;

export function channelColor(
	channel: Channel,
	look: Look,
): ColorInput | undefined {
	switch (channel) {
		case 'live': {
			return paint(tokens.live, look);
		}

		case 'caution': {
			return paint(tokens.caution, look);
		}

		case 'warning': {
			return paint(tokens.warning, look);
		}

		case 'nominal': {
			return paint(tokens.nominal, look);
		}

		case 'quiet': {
			return look.tier === 'truecolor'
				? RGBA.fromHex(surfaces(look).muted)
				: undefined;
		}
	}
}

export function muted(look: Look, text: string, extra: Partial<Seg> = {}): Seg {
	return look.tier === 'truecolor'
		? {text, fg: RGBA.fromHex(surfaces(look).muted), ...extra}
		: {text, dim: true, ...extra};
}

/** What the readout column shows: telemetry first, then the state code. */
export function readout(row: RowModel): {text: string; channel: Channel} {
	const {code, channel} = READOUT[row.state];
	if (row.progress !== undefined && !row.needsYou)
		return {text: `${row.progress}%`, channel: 'live'};
	if (row.state === 'tool' && row.space.programStatus?.tool)
		return {
			text: row.space.programStatus.tool.slice(0, 4).toUpperCase(),
			channel,
		};
	return {text: code, channel};
}

/** Activity samples, shifted with time so the trace scrolls while live. */
function trace(row: RowModel, now: number) {
	const samples = row.space.extras?.activity;
	if (!samples) return ' '.repeat(SPARK_CELLS);
	const live = ['working', 'tool', 'compacting'].includes(row.state);
	const shift = live ? Math.floor(now / SPARK_STEP) : 0;
	const window = Array.from(
		{length: SPARK_CELLS},
		(_, i) => samples[(i + shift) % samples.length]!,
	);
	return sparkline(window);
}

function pipelineGlyph(row: RowModel, look: Look): Seg {
	switch (row.pipeline) {
		case 'passing': {
			return {text: '✓', fg: paint(tokens.nominal, look)};
		}

		case 'failing': {
			return {text: '✗', fg: paint(tokens.warning, look), bold: true};
		}

		case 'progressing_clean': {
			return muted(look, '◔');
		}

		case 'progressing_dirty': {
			return {text: '◑', fg: paint(tokens.warning, look)};
		}

		case undefined: {
			return {text: ' '};
		}
	}
}

type RowBlock = {id: string; lines: Seg[][]; bg?: ColorInput};

function rowBlock(row: RowModel, props: SurfaceProps): RowBlock | undefined {
	const {look, now, width, frame} = props;
	const s = surfaces(look);
	const isTrue = look.tier === 'truecolor';
	const selected = row.space.name === frame.selected;
	const change = frame.changes[row.space.name];
	const closingAt = frame.closing?.[row.space.name];
	const id = row.space.name || 'new';
	if (closingAt !== undefined && now >= closingAt) {
		if (now >= closingAt + CLOSE_DURATION) return undefined;
		return {
			id,
			lines: [
				[
					muted(look, `   ${row.key.padEnd(7)}`, {clip: true}),
					muted(look, ' CLOSED', {shrink: true}),
					{text: '', grow: true},
				],
			],
		};
	}

	const {channel} = READOUT[row.state];
	const booting = row.state === 'pending';
	const lampOn = !booting || Math.floor(now / BOOT_BLINK) % 2 === 0;
	const lamp: Seg = {text: lampOn ? '●' : '○', fg: channelColor(channel, look)};
	const cursor: Seg = selected
		? {text: '▶', fg: paint(tokens.live, look), bold: true}
		: {text: ' '};
	const value = readout(row);
	const showTrace = width >= 32;
	const glyph = pipelineGlyph(row, look);
	const right: Seg[] = [
		...(showTrace
			? [muted(look, ` ${trace(row, now)}`, {drop: DROP.decoration})]
			: []),
		...(row.comments > 0
			? [muted(look, ` ✎${row.comments}`, {drop: DROP.comments})]
			: []),
		...(row.conflict
			? [
					{
						text: ' ↯',
						fg: paint(tokens.warning, look),
						drop: DROP.pipeline,
					},
				]
			: []),
		{...glyph, text: ` ${glyph.text}`, drop: DROP.pipeline},
		{
			text: ` ${value.text.padStart(4)}`,
			fg: channelColor(value.channel, look),
			bold: value.channel !== 'quiet',
		},
	];
	const quiet = !selected && !row.needsYou;
	const lines: Seg[][] = [
		[
			cursor,
			lamp,
			{text: ' '},
			{
				text: row.key.padEnd(7),
				clip: true,
				bold: selected || row.needsYou,
				fg: row.needsYou ? channelColor(channel, look) : undefined,
			},
			// The readout and pipeline are the point of this direction, so on
			// narrow rails the title goes before they do.
			quiet
				? muted(look, ` ${row.title}`, {
						shrink: true,
						grow: true,
						drop: TITLE_DROP,
					})
				: {text: ` ${row.title}`, shrink: true, grow: true, drop: TITLE_DROP},
			{text: '', grow: true},
			...right,
		],
	];

	// Every row with telemetry shows its gauges, so moving the cursor never
	// reflows the panel. Only the selected row's are full strength.
	const branch = (last: boolean) => muted(look, last ? '   └ ' : '   ├ ');
	const gauges: Seg[][] = [];
	// The bar gets what's left after the branch, label, ends and percentage;
	// too narrow for a readable bar, the gauge is just the number.
	const barCells = width - 17;
	if (row.progress !== undefined)
		gauges.push([
			muted(look, 'PROG '),
			...(barCells >= 3
				? [
						muted(look, '▕'),
						{
							text: eighthBar(row.progress / 100, barCells),
							fg: paint(tokens.live, look),
						},
						muted(look, '▏'),
					]
				: [{text: '', grow: true}]),
			{text: ` ${row.progress}%`.padStart(5), bold: selected},
		]);
	if (row.detail)
		gauges.push([
			muted(look, 'MSG  '),
			selected
				? {text: row.detail, shrink: true}
				: muted(look, row.detail, {shrink: true}),
			{text: '', grow: true},
			...(row.stateSince === undefined
				? []
				: [
						muted(look, ` T+${age(now - row.stateSince)}`, {
							drop: DROP.age,
						}),
					]),
		]);
	for (const [index, gauge] of gauges.entries())
		lines.push([branch(index === gauges.length - 1), ...gauge]);

	let bg: ColorInput | undefined;
	if (isTrue && selected) bg = RGBA.fromHex(s.selected);
	if (isTrue && row.needsYou) {
		const fresh =
			change?.kind === 'state' && isRunning(now, change.at, CAUTION.duration);
		bg = RGBA.fromHex(
			s.wash(hexOf(tokens.caution, look.theme), fresh ? 0.2 : 0.1),
		);
	}

	return {id, lines, bg};
}

/**
 * The fleet bar: one cell per slot of the rail's width, split by how many
 * agents are in each state, so the whole fleet reads at a glance.
 */
function fleetBar(rows: RowModel[], look: Look, cells: number): Seg[] {
	const order: Channel[] = ['warning', 'caution', 'live', 'nominal', 'quiet'];
	const counts = order.map(
		channel =>
			rows.filter(row => READOUT[row.state].channel === channel).length,
	);
	const total = Math.max(
		1,
		counts.reduce((a, b) => a + b, 0),
	);
	const segs: Seg[] = [];
	let used = 0;
	for (const [index, channel] of order.entries()) {
		const size =
			index === order.length - 1
				? cells - used
				: Math.round((counts[index]! / total) * cells);
		if (size <= 0) continue;
		used += size;
		segs.push(
			channel === 'quiet'
				? muted(look, '▁'.repeat(size))
				: {text: '█'.repeat(size), fg: channelColor(channel, look)},
		);
	}

	return segs;
}

export function fleetCounts(rows: RowModel[]) {
	return {
		run: rows.filter(row => READOUT[row.state].channel === 'live').length,
		ask: rows.filter(row => row.needsYou).length,
		err: rows.filter(row => row.state === 'error').length,
	};
}

/** The row an agent most recently started needing you on, while it's fresh. */
export function cautionRow(rows: RowModel[], props: SurfaceProps) {
	return rows.find(row => {
		const change = props.frame.changes[row.space.name];
		return (
			row.needsYou &&
			change?.kind === 'state' &&
			isRunning(props.now, change.at, CAUTION.duration)
		);
	});
}

export function MissionRail(props: SurfaceProps) {
	const {look, now, width, height, frame} = props;
	const rows = frame.spaces.map(space => describeSpace(space));
	const {run, ask, err} = fleetCounts(rows);
	const alert = cautionRow(rows, props);
	const flashOn =
		alert &&
		Math.floor((now - frame.changes[alert.space.name]!.at) / CAUTION.flash) %
			2 ===
			0;
	const caution = paint(tokens.caution, look);
	// The long banner only when the key and code still fit beside it.
	// The leading space stays unpainted, so the flashing chip reads as a badge
	// beside the key rather than glued to it.
	const subject = alert ? ` ${alert.key} ${READOUT[alert.state].code}` : '';
	const banner =
		width >= ' ▲ MASTER CAUTION '.length + subject.length
			? ' ▲ MASTER CAUTION '
			: ' ▲ CAUTION ';
	const header: Seg[] = alert
		? [
				flashOn
					? {
							text: banner,
							...chip(caution, paint(tokens.onAccent, look), look),
							bold: true,
						}
					: {text: banner, fg: caution, bold: true},
				{
					text: subject,
					fg: caution,
					bold: true,
					shrink: true,
					grow: true,
				},
			]
		: [
				{text: ' ▣', fg: paint(tokens.live, look)},
				{
					text: ` ${REPO.toUpperCase()}`,
					bold: true,
					shrink: true,
					grow: true,
					drop: 2,
				},
				...(ask > 0 ? [{text: ` ASK ${ask}`, fg: caution, bold: true}] : []),
				...(err > 0
					? [{text: ` ERR ${err}`, fg: paint(tokens.warning, look), bold: true}]
					: []),
				{text: ` RUN ${run} `, fg: paint(tokens.live, look), drop: 1},
			];
	const bar: Seg[] = [
		muted(look, ' ▕'),
		...fleetBar(rows, look, width - 4),
		muted(look, '▏ '),
	];
	const columns: Seg[] = [
		muted(look, '   ID'),
		...(width >= TITLED_WIDTH ? [muted(look, '      TASK')] : []),
		{text: '', grow: true},
		muted(look, width >= 32 ? 'ACTIVITY   TEL ' : 'TEL '),
	];
	const blocks = rows
		.map(row => rowBlock(row, props))
		.filter(block => block !== undefined);
	return (
		<box flexDirection="column" width={width} height={height}>
			<Block lines={[header, bar, columns]} cols={width} />
			{blocks.map(block => (
				<Block key={block.id} lines={block.lines} cols={width} bg={block.bg} />
			))}
		</box>
	);
}
