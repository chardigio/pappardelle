import {RGBA, type ColorInput} from '@opentui/core';
import {buildHelpRows} from '../../../source/components/help-rows.ts';
import {prompt} from '../../fixtures.ts';
import {paint, type Look} from '../../kit/color.ts';
import {Block, type Seg} from '../../kit/line.tsx';
import {panelInner, Panel, type PanelChars} from '../../kit/panel.tsx';
import type {AgentState} from '../../kit/row.ts';
import {
	sampleErrors,
	type ConfirmProps,
	type SurfaceProps,
} from '../../kit/surface.ts';
import {channelColor, muted} from './Rail.tsx';
import {READOUT, surfaces, tokens} from './tokens.ts';

const HEAVY: PanelChars = {
	tl: '┏',
	tr: '┓',
	bl: '┗',
	br: '┛',
	h: '━',
	v: '┃',
};

function border(look: Look, accent?: ColorInput): Seg {
	if (accent) return {text: '', fg: accent};
	return look.tier === 'truecolor'
		? {text: '', fg: RGBA.fromHex(surfaces(look).grid)}
		: {text: '', dim: true};
}

const label = (look: Look, text: string) =>
	muted(look, text.padEnd(9), {bold: true});

/** A bracketed key in the panel's footer: `[⏎] LAUNCH`. */
function key(
	look: Look,
	keyName: string,
	action: string,
	accent?: ColorInput,
): Seg[] {
	return [
		{text: `[${keyName}]`, bold: true, fg: accent},
		accent ? {text: ` ${action}   `, fg: accent} : muted(look, ` ${action}   `),
	];
}

/** Keys for a right-aligned footer, without the gap after the last one. */
function trailingKeys(...keys: Seg[][]): Seg[] {
	const segs = keys.flat();
	const last = segs.at(-1);
	if (last) segs[segs.length - 1] = {...last, text: last.text.trimEnd()};
	return segs;
}

export function MissionPrompt({look, width}: SurfaceProps) {
	const inner = panelInner(width, 3);
	const live = paint(tokens.live, look);
	const chips = prompt.profiles.flatMap((profile, index): Seg[] => [
		index === prompt.selectedProfile
			? {text: `[${profile.name.toUpperCase()}]`, bold: true, fg: live}
			: muted(look, ` ${profile.name.toUpperCase()} `),
		{text: ' '},
	]);
	const matched = prompt.profiles[prompt.selectedProfile]!;
	const lines: Seg[][] = [
		[
			label(look, 'TASK'),
			{text: '› ', fg: live, bold: true},
			{text: prompt.draft},
			{text: '▏', fg: live},
		],
		[
			{text: ' '.repeat(9)},
			muted(
				look,
				'PAP-123 or 123 attaches to that issue; anything else launches a new space',
			),
		],
		[],
		[
			label(look, 'PROFILE'),
			...chips,
			muted(look, 'matched' in matched ? `  matched “${matched.matched}”` : ''),
		],
		[],
		[label(look, 'QUEUE'), muted(look, 'ID       TITLE')],
		...prompt.ready.map((item, index): Seg[] => [
			{text: ' '.repeat(7)},
			index === 0 ? {text: '▶ ', fg: live, bold: true} : {text: '  '},
			{text: item.key.padEnd(9), bold: index === 0},
			index === 0 ? {text: item.title} : muted(look, item.title),
		]),
		[],
		[muted(look, '━'.repeat(inner))],
		[
			...key(look, '⏎', 'LAUNCH', live),
			...key(look, 'TAB', 'QUEUE'),
			...key(look, '←→', 'PROFILE'),
			...key(look, 'ESC', 'ABORT'),
		],
	];
	return (
		<Panel
			cols={width}
			rows={lines.length + 4}
			border={border(look)}
			chars={HEAVY}
			title={[{text: ' LAUNCH ', bold: true, fg: live}]}
			paddingX={3}
		>
			<Block lines={lines} cols={inner} />
		</Panel>
	);
}

export function MissionConfirm({
	look,
	width,
	height,
	destructive,
}: ConfirmProps) {
	const inner = panelInner(width, 3);
	const accent = paint(destructive ? tokens.warning : tokens.live, look);
	const lines: Seg[][] = destructive
		? [
				[
					label(look, 'TARGET'),
					{text: 'PAP-390  ', bold: true},
					muted(look, 'Close done spaces in bulk', {shrink: true}),
				],
				[label(look, 'ISSUE'), {text: '‹ Done ›'}],
				[label(look, 'DISK'), muted(look, 'worktree and branch are kept')],
				[],
				[...key(look, 'Y', 'CLOSE SPACE', accent), ...key(look, 'N', 'ABORT')],
			]
		: [
				[
					label(look, 'VERSION'),
					{text: 'v0.8.0 '},
					muted(look, '→'),
					{text: ' v0.9.0', bold: true},
				],
				[
					label(look, 'ACTION'),
					muted(look, 'downloads and runs the installer, then restarts'),
				],
				[],
				[],
				[...key(look, 'Y', 'INSTALL', accent), ...key(look, 'N', 'DEFER')],
			];
	return (
		<Panel
			cols={width}
			rows={height}
			border={border(look, destructive ? accent : undefined)}
			chars={HEAVY}
			title={[
				{
					text: destructive ? ' CLOSE SPACE ' : ' UPDATE ',
					bold: true,
					fg: accent,
				},
			]}
			paddingX={3}
		>
			<Block lines={lines} cols={inner} />
		</Panel>
	);
}

const CODES: AgentState[] = [
	'working',
	'tool',
	'compacting',
	'idle',
	'done',
	'question',
	'permission',
	'error',
	'pending',
	'unknown',
];

/** Every readout code with its meaning, two to a line. */
function readoutLines(look: Look, column: number): Seg[][] {
	const cells: Seg[][] = [
		...CODES.map((state): Seg[] => {
			const {code, channel, meaning} = READOUT[state];
			return [
				{text: code.padStart(4), bold: true, fg: channelColor(channel, look)},
				muted(look, ` ${meaning}`.padEnd(column - 4)),
			];
		}),
		[
			{text: ' 40%', bold: true, fg: paint(tokens.live, look)},
			muted(look, ' progress reported'),
		],
	];
	const lines: Seg[][] = [];
	for (let index = 0; index < cells.length; index += 2)
		lines.push([...cells[index]!, ...(cells[index + 1] ?? [])]);
	return lines;
}

export function MissionHelp({look, width, height}: SurfaceProps) {
	const inner = panelInner(width, 3);
	const {fixed, overridable} = buildHelpRows();
	const row = (keyName: string, action: string): Seg[] => [
		{text: keyName.padEnd(11), bold: true, fg: paint(tokens.live, look)},
		muted(look, '│ '),
		{text: action},
	];
	const lines: Seg[][] = [
		[muted(look, 'KEY        │ ACTION')],
		[muted(look, '───────────┼' + '─'.repeat(inner - 12))],
		...fixed.map(r => row(r.key, r.description)),
		[muted(look, '───────────┼' + '─'.repeat(inner - 12))],
		...overridable.map(r => row(r.key, r.description)),
		[],
		[muted(look, 'READOUTS')],
		...readoutLines(look, Math.floor(inner / 2)),
	];
	return (
		<Panel
			cols={width}
			rows={height}
			border={border(look)}
			chars={HEAVY}
			title={[{text: ' KEYMAP ', bold: true, fg: paint(tokens.live, look)}]}
			bottomTitle={[muted(look, ' [ESC] ')]}
			paddingX={3}
		>
			<Block lines={lines} cols={inner} />
		</Panel>
	);
}

export function MissionErrors({look, width, height}: SurfaceProps) {
	const inner = panelInner(width, 3);
	const lines: Seg[][] = [
		[muted(look, 'TIME   LVL   SYS      MESSAGE')],
		[muted(look, '─'.repeat(inner))],
	];
	for (const entry of sampleErrors) {
		const channel = entry.level === 'error' ? 'warning' : 'caution';
		lines.push([
			muted(look, `${entry.timestamp.slice(11, 16)}  `),
			{
				text: (entry.level === 'error' ? 'ERR' : 'WARN').padEnd(6),
				bold: true,
				fg: channelColor(channel, look),
			},
			{text: entry.component.toUpperCase().padEnd(9)},
			{text: entry.message, shrink: true},
		]);
		if (entry.error)
			lines.push([{text: ' '.repeat(22)}, muted(look, entry.error)]);
	}

	lines.push(
		[],
		[
			muted(look, 'LOGS ~/.pappardelle/logs/'),
			{text: '', grow: true},
			...trailingKeys(key(look, 'C', 'CLEAR'), key(look, 'ESC', 'CLOSE')),
		],
	);
	return (
		<Panel
			cols={width}
			rows={height}
			border={border(look, paint(tokens.warning, look))}
			chars={HEAVY}
			title={[
				{
					text: ` FAULT LOG · ${sampleErrors.length} `,
					bold: true,
					fg: paint(tokens.warning, look),
				},
			]}
			paddingX={3}
		>
			<Block lines={lines} cols={inner} />
		</Panel>
	);
}
