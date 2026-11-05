import {RGBA, type ColorInput} from '@opentui/core';
import {buildHelpRows} from '../../../source/components/help-rows.ts';
import {prompt} from '../../fixtures.ts';
import {chip, paint, type Look} from '../../kit/color.ts';
import {Block, type Seg} from '../../kit/line.tsx';
import {panelInner, Panel, type PanelChars} from '../../kit/panel.tsx';
import type {AgentState} from '../../kit/row.ts';
import {
	sampleErrors,
	type ConfirmProps,
	type SurfaceProps,
} from '../../kit/surface.ts';
import {STATIONS, surfaces, tokens} from './tokens.ts';

/** A ticket: square top, perforated tear-off bottom edge. */
const TICKET: PanelChars = {
	tl: '┌',
	tr: '┐',
	bl: '└',
	br: '┘',
	h: '─',
	v: '│',
	bottom: '┄',
};

function kit(look: Look) {
	const s = surfaces(look);
	const isTrue = look.tier === 'truecolor';
	return {
		muted: (text: string, extra: Partial<Seg> = {}): Seg =>
			isTrue
				? {text, fg: RGBA.fromHex(s.muted), ...extra}
				: {text, dim: true, ...extra},
		border: (isTrue
			? {text: '', fg: RGBA.fromHex(s.rule)}
			: {text: '', dim: true}) satisfies Seg,
		paper: isTrue ? RGBA.fromHex(s.ticket) : undefined,
	};
}

const label = (look: Look, text: string): Seg =>
	kit(look).muted(text.toUpperCase(), {bold: true});

function chit(key: string, accent?: ColorInput, look?: Look): Seg {
	return accent && look
		? {
				text: ` ${key} `,
				...chip(accent, paint(tokens.onAccent, look), look),
				bold: true,
			}
		: {text: ` ${key} `, inverse: true, bold: true};
}

export function KitchenPrompt({look, width}: SurfaceProps) {
	const {muted, border, paper} = kit(look);
	const inner = panelInner(width, 3);
	const lines: Seg[][] = [
		[label(look, 'order'), {text: '', grow: true}, muted('ticket #new')],
		[
			{text: '» ', fg: paint(tokens.heat, look), bold: true},
			{text: prompt.draft},
			{text: ' ', inverse: true},
		],
		[
			muted(
				'#123 or PAP-123 re-fires that ticket; anything else is a new order.',
				{italic: true},
			),
		],
		[],
		[label(look, 'station')],
		prompt.profiles.flatMap((profile, index): Seg[] => [
			index === prompt.selectedProfile
				? {text: `[x] ${profile.emoji} ${profile.name}`, bold: true}
				: muted(`[ ] ${profile.emoji} ${profile.name}`),
			{text: '   '},
		]),
		[],
		[label(look, 'prep list'), muted('  ready work you can pick up')],
		...prompt.ready.map((item, index): Seg[] => [
			index === 0 ? {text: '▸ ', fg: paint(tokens.marker, look)} : {text: '  '},
			{text: item.key.replace(/^\w+-/, '#'), bold: true},
			{text: '  '},
			index === 0 ? {text: item.title} : muted(item.title),
		]),
		[],
		[
			chit('⏎', paint(tokens.heat, look), look),
			muted(' fire   '),
			chit('tab'),
			muted(' prep list   '),
			chit('←→'),
			muted(' station   '),
			chit('esc'),
			muted(' void'),
		],
	];
	return (
		<Panel
			cols={width}
			rows={18}
			border={border}
			chars={TICKET}
			title={[{text: ' NEW TICKET ', bold: true}]}
			bottomTitle={[]}
			paddingX={3}
			bg={paper}
		>
			<Block lines={lines} cols={inner} />
		</Panel>
	);
}

export function KitchenConfirm({
	look,
	width,
	height,
	destructive,
}: ConfirmProps) {
	const {muted, border, paper} = kit(look);
	const inner = panelInner(width, 3);
	const lines: Seg[][] = destructive
		? [
				[{text: 'Void ticket #390?', bold: true}],
				[muted('Close done spaces in bulk', {italic: true})],
				[],
				[label(look, 'mark issue'), {text: '  ‹ Done ›'}],
				[muted('The worktree and branch stay on disk.')],
				[],
				[
					chit('y', paint(tokens.burnt, look), look),
					{text: ' void it', fg: paint(tokens.burnt, look)},
					{text: '    '},
					chit('n'),
					muted(' keep cooking'),
				],
			]
		: [
				[{text: 'New menu: v0.9.0', bold: true}],
				[muted('You are serving v0.8.0.', {italic: true})],
				[],
				[muted('Downloads and runs the installer, then restarts.')],
				[],
				[
					chit('y', paint(tokens.plated, look), look),
					{text: ' update', fg: paint(tokens.plated, look)},
					{text: '    '},
					chit('n'),
					muted(' not tonight'),
				],
			];
	return (
		<Panel
			cols={width}
			rows={height}
			border={border}
			chars={TICKET}
			title={[{text: destructive ? ' VOID ' : ' UPDATE ', bold: true}]}
			paddingX={3}
			bg={paper}
		>
			<Block lines={lines} cols={inner} />
		</Panel>
	);
}

const LEGEND: AgentState[] = [
	'working',
	'compacting',
	'idle',
	'done',
	'question',
	'permission',
	'error',
];

export function KitchenHelp({look, width, height}: SurfaceProps) {
	const {muted, border} = kit(look);
	const inner = panelInner(width, 3);
	const {fixed, overridable} = buildHelpRows();
	const dish = (key: string, description: string): Seg[] => [
		{text: description},
		muted(' ', {grow: true}),
		muted('·'.repeat(3)),
		{text: ` ${key}`, bold: true, fg: paint(tokens.heat, look)},
	];
	const lines: Seg[][] = [
		[label(look, 'service')],
		...fixed.map(row => dish(row.key, row.description)),
		[],
		[label(look, 'out front')],
		...overridable.map(row => dish(row.key, row.description)),
		[],
		[label(look, 'what the tickets say')],
		...LEGEND.map((state): Seg[] => {
			const station = STATIONS[state];
			return [
				{
					text: station.word.padEnd(8),
					bold: true,
					fg: station.token ? paint(tokens[station.token], look) : undefined,
				},
				muted(station.meaning),
			];
		}),
	];
	return (
		<Panel
			cols={width}
			rows={height}
			border={border}
			chars={TICKET}
			title={[{text: ' THE MENU ', bold: true}]}
			bottomTitle={[muted(' esc ')]}
			paddingX={3}
			paddingY={1}
		>
			<Block lines={lines} cols={inner} />
		</Panel>
	);
}

export function KitchenErrors({look, width, height}: SurfaceProps) {
	const {muted, border} = kit(look);
	const inner = panelInner(width, 3);
	const lines: Seg[][] = [
		[muted('Things the kitchen ran out of, newest last.', {italic: true})],
		[],
	];
	for (const entry of sampleErrors) {
		lines.push([
			muted(entry.timestamp.slice(11, 16) + '  '),
			entry.level === 'error'
				? {text: '86 ', fg: paint(tokens.burnt, look), bold: true}
				: {text: '!! ', fg: paint(tokens.heat, look), bold: true},
			{text: entry.component.toUpperCase().padEnd(8), bold: true},
			{text: entry.message, shrink: true},
		]);
		if (entry.error)
			lines.push([{text: ' '.repeat(18)}, muted(entry.error, {italic: true})]);
	}

	lines.push(
		[],
		[
			muted('~/.pappardelle/logs/'),
			{text: '', grow: true},
			chit('c'),
			muted(' clear  '),
			chit('esc'),
			muted(' close'),
		],
	);
	return (
		<Panel
			cols={width}
			rows={height}
			border={border}
			chars={TICKET}
			title={[
				{
					text: ` 86 LIST · ${sampleErrors.length} `,
					bold: true,
					fg: paint(tokens.burnt, look),
				},
			]}
			paddingX={3}
		>
			<Block lines={lines} cols={inner} />
		</Panel>
	);
}
