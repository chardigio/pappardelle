import {RGBA, type ColorInput} from '@opentui/core';
import {buildHelpRows} from '../../../source/components/help-rows.ts';
import {prompt} from '../../fixtures.ts';
import {chip, hexOf, mix, paint, type Look} from '../../kit/color.ts';
import {Block, type Seg} from '../../kit/line.tsx';
import {cycle, ease, progressOf, sweepColumn} from '../../kit/motion.ts';
import {panelInner, Panel} from '../../kit/panel.tsx';
import {
	sampleErrors,
	type ConfirmProps,
	type SurfaceProps,
} from '../../kit/surface.ts';
import {RING, RING_INTERVAL, SPIN, SPIN_INTERVAL} from './Rail.tsx';
import {surfaces, tokens} from './tokens.ts';

export const OPEN_DURATION = 150;
export const ERROR_GLOW = 900;
const CASCADE_STEP = 18;
const CURSOR_BLINK = 530;
const SHEEN_PERIOD = 2600;

function kit(look: Look) {
	const s = surfaces(look);
	const isTrue = look.tier === 'truecolor';
	return {
		muted: (text: string, extra: Partial<Seg> = {}): Seg =>
			isTrue
				? {text, fg: RGBA.fromHex(s.muted), ...extra}
				: {text, dim: true, ...extra},
		isTrue,
		s,
	};
}

function keycap(key: string, accent?: ColorInput, look?: Look): Seg {
	return accent && look
		? {
				text: ` ${key} `,
				...chip(accent, paint(tokens.onAccent, look), look),
				bold: true,
			}
		: {text: ` ${key} `, inverse: true, bold: true};
}

/**
 * Dialogs open by growing from a three-row sliver to full height in 150 ms
 * (ease-out), so the eye follows where they came from.
 */
function openHeight(now: number, rows: number) {
	return Math.max(
		3,
		Math.round(
			3 + (rows - 3) * ease.outCubic(progressOf(now, 0, OPEN_DURATION)),
		),
	);
}

/** In truecolor the border brightens briefly once every 2.6 s. */
function sheenBorder(
	look: Look,
	now: number,
	cols: number,
	accent: string,
): Seg {
	const {isTrue, s} = kit(look);
	if (!isTrue) return {text: '', fg: paint({ansi: undefined}, look), dim: true};
	const head = sweepColumn(now % SHEEN_PERIOD, 0, SHEEN_PERIOD, cols);
	return {
		text: '',
		fg: RGBA.fromHex(
			mix(s.faint, accent, head > 0 && head < cols ? 0.55 : 0.35),
		),
	};
}

export function LivingPrompt({look, now, width, height}: SurfaceProps) {
	const {muted} = kit(look);
	const inner = panelInner(width);
	const live = paint(tokens.live, look);
	const cursorOn = Math.floor(now / CURSOR_BLINK) % 2 === 0;
	const lines: Seg[][] = [
		[
			{text: '❯ ', fg: live, bold: true},
			{text: prompt.draft},
			{text: cursorOn ? '▏' : ' ', fg: live},
		],
		[
			muted(
				'PAP-123 or 123 opens that issue · anything else starts a new space',
			),
		],
		[],
		[muted('ready work')],
		...prompt.ready.map((item, index): Seg[] => [
			index === 0 ? {text: '▌', fg: paint(tokens.pill, look)} : {text: ' '},
			{text: ` ${item.key}  `, bold: index === 0},
			index === 0 ? {text: item.title} : muted(item.title),
		]),
		[],
		[muted('profile')],
		prompt.profiles.flatMap((profile, index): Seg[] => [
			index === prompt.selectedProfile
				? {
						text: ` ${profile.emoji} ${profile.name} `,
						...chip(
							paint(tokens.pill, look),
							paint(tokens.onAccent, look),
							look,
						),
						bold: true,
					}
				: {text: ` ${profile.emoji} ${profile.name} `},
			{text: '  '},
		]),
		[],
		[
			keycap('⏎', live, look),
			muted(' start  '),
			keycap('tab'),
			muted(' ready  '),
			keycap('←→'),
			muted(' profile  '),
			keycap('esc'),
			muted(' cancel'),
		],
	];
	const rows = openHeight(now, Math.min(height, lines.length + 4));
	return (
		<Panel
			cols={width}
			rows={rows}
			border={sheenBorder(look, now, width, hexOf(tokens.live, look.theme))}
			title={[{text: ' new space ', bold: true, fg: live}]}
			paddingY={1}
		>
			<Block lines={lines} cols={inner} />
		</Panel>
	);
}

export function LivingConfirm({
	look,
	now,
	width,
	height,
	destructive,
}: ConfirmProps) {
	const {muted} = kit(look);
	const inner = panelInner(width);
	const accentToken = destructive ? tokens.error : tokens.live;
	const accent = paint(accentToken, look);
	// After 1.2 s the scene presses y: the hint row becomes a progress sweep
	// for the close hooks, instead of today's frozen dialog with a spinner.
	const processing = now >= 1200;
	const sweep = sweepColumn((now - 1200) % 1100, 0, 1100, inner);
	const bar: Seg[] = [];
	for (let column = 0; column < inner; column++)
		bar.push(
			Math.abs(column - sweep) <= 3 ? {text: '━', fg: accent} : muted('─'),
		);
	const lines: Seg[][] = destructive
		? [
				[
					{text: 'Close ', bold: true},
					{text: 'PAP-390', bold: true, fg: accent},
					{text: '?', bold: true},
				],
				[muted('Close done spaces in bulk')],
				[],
				[muted('issue state  '), {text: '‹ Done ›'}],
				[muted('The worktree and branch stay on disk.')],
				[],
				processing
					? [
							{text: cycle(SPIN, now, SPIN_INTERVAL), fg: accent},
							{text: ' Running close hooks…'},
						]
					: [
							keycap('y', accent, look),
							{text: ' close', fg: accent},
							{text: '   '},
							keycap('n'),
							muted(' keep'),
						],
				processing ? bar : [],
			]
		: [
				[
					{text: 'Update to ', bold: true},
					{text: 'v0.9.0', bold: true, fg: accent},
					{text: '?', bold: true},
				],
				[muted('You are on v0.8.0.')],
				[],
				[muted('Downloads and runs the installer, then restarts.')],
				[],
				[],
				processing
					? [
							{text: cycle(SPIN, now, SPIN_INTERVAL), fg: accent},
							{text: ' Downloading…'},
						]
					: [
							keycap('y', accent, look),
							{text: ' update', fg: accent},
							{text: '   '},
							keycap('n'),
							muted(' later'),
						],
				processing ? bar : [],
			];
	return (
		<Panel
			cols={width}
			rows={openHeight(now, height)}
			border={{text: '', fg: accent}}
			paddingY={0}
		>
			<Block lines={[[], ...lines]} cols={inner} />
		</Panel>
	);
}

export function LivingHelp({look, now, width, height}: SurfaceProps) {
	const {muted} = kit(look);
	const inner = panelInner(width);
	const {fixed, overridable} = buildHelpRows();
	const row = (key: string, description: string): Seg[] => [
		{text: key.padEnd(10), bold: true, fg: paint(tokens.live, look)},
		{text: description},
	];
	const legend: Seg[][] = [
		[
			{text: cycle(SPIN, now, SPIN_INTERVAL), fg: paint(tokens.live, look)},
			muted(' working       '),
			{text: '◌', dim: true},
			muted(' compacting'),
		],
		[
			{
				text: cycle(RING, now, RING_INTERVAL),
				fg: paint(tokens.question, look),
				bold: true,
			},
			muted(' needs you     '),
			{text: '○', dim: true},
			muted(' idle'),
		],
		[
			{text: '●', fg: paint(tokens.ok, look)},
			muted(' done          '),
			{text: '✕', fg: paint(tokens.error, look)},
			muted(' error'),
		],
		[
			{text: '▁▃▅', fg: paint(tokens.live, look)},
			muted(' fleet activity, header'),
		],
	];
	const all: Seg[][] = [
		...fixed.map(r => row(r.key, r.description)),
		[],
		...overridable.map(r => row(r.key, r.description)),
		[],
		[muted('legend · these move like the rail does')],
		...legend,
	];
	// Rows cascade in, one every 18 ms, after the panel has opened.
	const shown = Math.max(0, Math.floor((now - OPEN_DURATION) / CASCADE_STEP));
	return (
		<Panel
			cols={width}
			rows={openHeight(now, height)}
			border={sheenBorder(look, now, width, hexOf(tokens.live, look.theme))}
			title={[{text: ' keys ', bold: true}]}
			bottomTitle={[muted(' esc ')]}
		>
			<Block lines={all.slice(0, shown)} cols={inner} />
		</Panel>
	);
}

export function LivingErrors({look, now, width, height}: SurfaceProps) {
	const {muted, isTrue, s} = kit(look);
	const inner = panelInner(width);
	const lines: Seg[][] = [];
	for (const [index, entry] of sampleErrors.entries()) {
		const newest = index === sampleErrors.length - 1;
		const glow = newest
			? Math.max(0, 1 - progressOf(now, OPEN_DURATION, ERROR_GLOW))
			: 0;
		const bg =
			newest && isTrue && glow > 0
				? RGBA.fromHex(s.wash(hexOf(tokens.error, look.theme), 0.25 * glow))
				: undefined;
		const accent = entry.level === 'error' ? tokens.error : tokens.warn;
		lines.push([
			{
				text: entry.level === 'error' ? '✕ ' : '! ',
				fg: paint(accent, look),
				bg,
			},
			{text: entry.component.padEnd(8), fg: paint(accent, look), bg},
			{
				text: entry.message,
				shrink: true,
				grow: true,
				bg,
				bold: newest && glow > 0.5 && !isTrue,
			},
			{...muted(`  ${entry.timestamp.slice(11, 16)}`), bg},
		]);
		if (entry.error) lines.push([{text: '          '}, muted(entry.error)]);
	}

	lines.push(
		[],
		[
			muted('~/.pappardelle/logs/'),
			{text: '', grow: true},
			keycap('c'),
			muted(' clear  '),
			keycap('esc'),
			muted(' close'),
		],
	);
	return (
		<Panel
			cols={width}
			rows={openHeight(now, height)}
			border={{text: '', fg: paint(tokens.error, look)}}
			title={[
				{
					text: ` ${sampleErrors.length} errors `,
					bold: true,
					fg: paint(tokens.error, look),
				},
			]}
		>
			<Block lines={lines} cols={inner} />
		</Panel>
	);
}
