import stringWidth from 'string-width';
import {RGBA, type ColorInput} from '@opentui/core';
import {REPO} from '../../fixtures.ts';
import {chip, hexOf, paint, type Look} from '../../kit/color.ts';
import {Block, DROP, type Seg} from '../../kit/line.tsx';
import {cycle, isRunning, progressOf} from '../../kit/motion.ts';
import {needYou, age, describeSpace, type RowModel} from '../../kit/row.ts';
import type {SurfaceProps} from '../../kit/surface.ts';
import {surfaces, tokens} from './tokens.ts';

const SPIN = ['◴', '◷', '◶', '◵'];
export const SPIN_INTERVAL = 125;
/** Three pulses when an agent starts needing you, then it holds steady. */
export const PULSE = {count: 3, period: 600};
const PULSE_DURATION = PULSE.count * PULSE.period;
export const CLOSE_DURATION = 500;

export function glyphFor(
	row: RowModel,
	now: number,
): {glyph: string; token?: keyof typeof tokens; dim?: boolean} {
	switch (row.state) {
		case 'working':
		case 'tool': {
			return {glyph: cycle(SPIN, now, SPIN_INTERVAL)};
		}

		case 'pending': {
			return {glyph: cycle(SPIN, now, SPIN_INTERVAL), dim: true};
		}

		case 'compacting': {
			return {glyph: '◌', dim: true};
		}

		case 'idle': {
			return {glyph: '○'};
		}

		case 'done': {
			return {glyph: '●', token: 'ok'};
		}

		case 'question': {
			return {glyph: '◆', token: 'question'};
		}

		case 'permission': {
			return {glyph: '◆', token: 'permission'};
		}

		case 'error': {
			return {glyph: '✕', token: 'error'};
		}

		case 'unknown': {
			return {glyph: '·', dim: true};
		}
	}
}

function pipelineSeg(row: RowModel, look: Look): Seg[] {
	const segs: Seg[] = [];
	if (row.comments > 0)
		segs.push({text: ` ✎${row.comments}`, dim: true, drop: DROP.comments});
	if (row.conflict)
		segs.push({
			text: ' ↯',
			fg: paint(tokens.error, look),
			drop: DROP.pipeline,
		});
	switch (row.pipeline) {
		case 'passing': {
			segs.push({text: ' ✓', fg: paint(tokens.ok, look), drop: DROP.pipeline});
			break;
		}

		case 'failing': {
			segs.push({
				text: ' ✗',
				fg: paint(tokens.error, look),
				bold: true,
				drop: DROP.pipeline,
			});
			break;
		}

		case 'progressing_clean': {
			segs.push({text: ' ◌', dim: true, drop: DROP.pipeline});
			break;
		}

		case 'progressing_dirty': {
			segs.push({
				text: ' ◌',
				fg: paint(tokens.error, look),
				drop: DROP.pipeline,
			});
			break;
		}

		case undefined: {
			break;
		}
	}

	return segs;
}

/** `▰▰▱▱▱` in five cells: coarse on purpose, the number carries precision. */
function meter(progress: number) {
	const filled = Math.round((progress / 100) * 5);
	return '▰'.repeat(filled) + '▱'.repeat(5 - filled);
}

type RowStyle = {
	bg?: ColorInput;
	selected: boolean;
	closing: number;
	pulseOn: boolean;
};

function rowStyle(row: RowModel, props: SurfaceProps): RowStyle {
	const {look, now, frame} = props;
	const selected = row.space.name === frame.selected;
	const change = frame.changes[row.space.name];
	const closingAt = frame.closing?.[row.space.name];
	const closing =
		closingAt === undefined ? 0 : progressOf(now, closingAt, CLOSE_DURATION);
	const pulsing =
		row.needsYou &&
		change?.kind === 'state' &&
		isRunning(now, change.at, PULSE_DURATION);
	const phase = pulsing
		? ((now - change!.at) % PULSE.period) / PULSE.period
		: 1;
	const pulseOn = pulsing && phase < 0.5;
	if (look.tier === 'ansi') return {selected, closing, pulseOn};

	const s = surfaces(look);
	const accent = hexOf(
		row.state === 'question' ? tokens.question : tokens.permission,
		look.theme,
	);
	let bg: string | undefined = selected ? s.selectedRow : undefined;
	if (row.needsYou) {
		// A truecolor wash that eases out of each pulse into a faint steady tint.
		const wave = pulsing ? (1 - Math.cos(phase * Math.PI * 2)) / 2 : 0;
		bg = s.accentWash(accent, 0.1 + wave * 0.22);
	}

	return {bg: bg ? RGBA.fromHex(bg) : undefined, selected, closing, pulseOn};
}

function rowLines(
	row: RowModel,
	props: SurfaceProps,
): {lines: Seg[][]; bg?: ColorInput} {
	const {look, now, layout} = props;
	const style = rowStyle(row, props);
	const {glyph, token, dim} = glyphFor(row, now);
	const accentToken =
		row.state === 'question' ? tokens.question : tokens.permission;
	const muted =
		look.tier === 'truecolor' ? RGBA.fromHex(surfaces(look).muted) : undefined;
	const fading = style.closing > 0;
	const fadeFg =
		fading && look.tier === 'truecolor'
			? RGBA.fromHex(
					surfaces(look).accentWash(
						hexOf(tokens.text, look.theme),
						1 - style.closing,
					),
				)
			: undefined;

	const bar: Seg = style.selected
		? {text: '▌', fg: paint(tokens.selection, look)}
		: {text: ' '};
	const emoji: Seg[] = row.emoji ? [{text: `${row.emoji} `}] : [];
	const glyphSeg: Seg = style.pulseOn
		? {
				text: glyph,
				...chip(paint(accentToken, look), paint(tokens.onAccent, look), look),
				bold: true,
			}
		: {
				text: glyph,
				fg: token ? paint(tokens[token], look) : undefined,
				dim: dim && !muted,
				...(dim && muted ? {fg: muted} : {}),
			};
	const keySeg: Seg = {
		text: row.key,
		clip: true,
		bold: style.selected || row.needsYou,
		fg: fadeFg ?? (row.needsYou ? paint(accentToken, look) : undefined),
		dim: row.state === 'pending' || (fading && look.tier === 'ansi'),
		...(style.pulseOn
			? chip(paint(accentToken, look), paint(tokens.onAccent, look), look)
			: {}),
	};
	const quietTitle = !style.selected && !row.needsYou;
	const titleSeg: Seg = {
		text: row.title,
		shrink: true,
		grow: true,
		italic: row.state === 'pending',
		dim: quietTitle && !muted,
		fg: fadeFg ?? (quietTitle ? muted : undefined),
	};
	const right = pipelineSeg(row, look);
	const indent = ' '.repeat(1 + row.emojiCells + (row.emoji ? 1 : 0) + 2);

	const lines: Seg[][] =
		layout === 'two_line' && row.state !== 'pending'
			? [
					[
						bar,
						...emoji,
						glyphSeg,
						{text: ' '},
						{...keySeg, grow: true},
						...right,
					],
					[
						{text: style.selected ? ' ' : ' '},
						{text: indent.slice(1)},
						titleSeg,
					],
				]
			: [
					[
						bar,
						...emoji,
						glyphSeg,
						{text: ' '},
						keySeg,
						{text: ' '},
						titleSeg,
						...right,
					],
				];

	// Every row an agent is reporting on shows the report, so moving the
	// selection never reflows the list. Only the selected row's is full
	// strength.
	if (row.detail) {
		// A question the agent is waiting on stays full strength too.
		const quiet: Partial<Seg> =
			style.selected || row.needsYou ? {} : {dim: !muted, fg: muted};
		const detail: Seg[] = [
			{text: indent},
			{text: '↳ ', dim: !muted, fg: muted},
			{text: row.detail, shrink: true, ...quiet},
		];
		if (row.progress !== undefined)
			detail.push({
				text: ` ${meter(row.progress)}`,
				fg: paint(tokens.selection, look),
			});
		if (row.stateSince !== undefined && !row.progress)
			detail.push({
				text: ` · ${age(now - row.stateSince)}`,
				drop: DROP.age,
				dim: !muted,
				fg: muted,
			});
		lines.push(detail);
	}

	return {lines, bg: style.bg};
}

export function counts(rows: RowModel[]) {
	return {
		needsYou: rows.filter(row => row.needsYou).length,
		working: rows.filter(row =>
			['working', 'tool', 'compacting'].includes(row.state),
		).length,
	};
}

export function QuietRail(props: SurfaceProps) {
	const {look, width, height, frame} = props;
	const rows = frame.spaces.map(space => describeSpace(space));
	const {needsYou, working} = counts(rows);
	const muted =
		look.tier === 'truecolor' ? RGBA.fromHex(surfaces(look).muted) : undefined;
	const hairline =
		look.tier === 'truecolor'
			? RGBA.fromHex(surfaces(look).hairline)
			: undefined;
	const summary: Seg[] = [];
	if (needsYou > 0)
		summary.push({
			text: width >= 30 ? ` ◆ ${needYou(needsYou)}` : ` ◆${needsYou}`,
			fg: paint(tokens.question, look),
			bold: true,
		});
	if (working > 0)
		summary.push({
			text: `  ${SPIN[0]} ${working}`,
			dim: !muted,
			fg: muted,
			drop: DROP.decoration,
		});

	const header: Seg[] = [
		{text: ` ${REPO}`, bold: true, shrink: true, grow: true},
		...summary,
		{text: ' '},
	];
	// The rule names the selected row's tracker state, so keys stay plain
	// text and no row carries a second palette.
	const selected = rows.find(row => row.space.name === frame.selected);
	const label =
		selected?.workflow && selected.key
			? ` ${selected.key} · ${selected.workflow.name} `
			: '';
	const hair = (text: string): Seg => ({text, dim: !hairline, fg: hairline});
	const rule: Seg[] = [
		{text: ' '},
		hair(label ? '┄┄' : ''),
		{text: label, dim: !muted, fg: muted, shrink: true},
		hair(
			'┄'.repeat(Math.max(0, width - 2 - (label ? 2 + stringWidth(label) : 0))),
		),
		{text: ' '},
	];

	const blocks = rows
		.filter(row => {
			const closingAt = frame.closing?.[row.space.name];
			return closingAt === undefined || props.now < closingAt + CLOSE_DURATION;
		})
		.map(row => ({row, ...rowLines(row, props)}));
	return (
		<box flexDirection="column" width={width} height={height}>
			<Block lines={[header, rule]} cols={width} />
			{blocks.map(({row, lines, bg}) => (
				<Block
					key={row.space.name || 'new'}
					lines={lines}
					cols={width}
					bg={bg}
				/>
			))}
		</box>
	);
}
