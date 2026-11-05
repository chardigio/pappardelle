import type {ReactNode} from 'react';
import {RGBA, type ColorInput} from '@opentui/core';
import {buildHelpRows} from '../../../source/components/help-rows.ts';
import {prompt} from '../../fixtures.ts';
import {chip, paint, type Look} from '../../kit/color.ts';
import {Block, type Seg} from '../../kit/line.tsx';
import {panelInner, Panel} from '../../kit/panel.tsx';
import {
	sampleErrors,
	type ConfirmProps,
	type SurfaceProps,
} from '../../kit/surface.ts';
import {surfaces, tokens} from './tokens.ts';

function quiet(look: Look) {
	const s = surfaces(look);
	const isTrue = look.tier === 'truecolor';
	return {
		/** Secondary text: native dim in 16 colors, a computed grey in truecolor. */
		muted: (text: string, extra: Partial<Seg> = {}): Seg =>
			isTrue
				? {text, fg: RGBA.fromHex(s.muted), ...extra}
				: {text, dim: true, ...extra},
		border: isTrue ? RGBA.fromHex(s.hairline) : undefined,
	};
}

/** A key drawn as a small inverse chip: ` y `. Default-on-default inverse is
 * the one inverse that renders correctly with OpenTUI on every theme. */
function keycap(key: string, accent?: ColorInput, look?: Look): Seg {
	return accent && look
		? {
				text: ` ${key} `,
				...chip(accent, paint(tokens.onAccent, look), look),
				bold: true,
			}
		: {text: ` ${key} `, inverse: true, bold: true};
}

function Frame({
	look,
	width,
	height,
	title,
	bottomTitle,
	children,
}: {
	look: Look;
	width: number;
	height: number;
	title?: string;
	bottomTitle?: string;
	children: ReactNode;
}) {
	const {border, muted} = quiet(look);
	return (
		<Panel
			cols={width}
			rows={height}
			border={border ? {text: '', fg: border} : {text: '', dim: true}}
			title={title ? [{text: title, bold: true}] : []}
			bottomTitle={bottomTitle ? [muted(bottomTitle)] : []}
		>
			{children}
		</Panel>
	);
}

export function QuietPrompt({look, width, height}: SurfaceProps) {
	const {muted} = quiet(look);
	const inner = panelInner(width);
	const {draft} = prompt;
	const lines: Seg[][] = [
		[
			{text: '› ', fg: paint(tokens.selection, look), bold: true},
			{text: draft},
			{text: ' ', inverse: true},
		],
		[],
		[
			muted(
				'PAP-123 or 123 opens that issue. Anything else starts a new space.',
			),
		],
	];
	const ready: Seg[][] = [
		[muted('ready')],
		...prompt.ready.map((item, index): Seg[] => [
			{text: '  '},
			{text: item.key, bold: index === 0},
			{text: '  '},
			index === 0 ? {text: item.title} : muted(item.title),
		]),
	];
	const chips: Seg[] = [];
	for (const [index, profile] of prompt.profiles.entries()) {
		const label = ` ${profile.emoji} ${profile.name} `;
		chips.push(
			index === prompt.selectedProfile
				? {text: label, inverse: true, bold: true}
				: {text: label},
			{text: ' '},
		);
	}

	const matched = prompt.profiles[prompt.selectedProfile]!;
	const profileLines: Seg[][] = [
		[
			muted('profile'),
			muted('matched' in matched ? `  matched “${matched.matched}”` : '', {
				italic: true,
			}),
		],
		chips,
	];
	const hints: Seg[] = [
		keycap('⏎'),
		muted(' start   '),
		keycap('tab'),
		muted(' pick ready work   '),
		keycap('←→'),
		muted(' profile   '),
		keycap('esc'),
		muted(' cancel'),
	];
	return (
		<box flexDirection="column" width={width} height={height}>
			<Frame look={look} width={width} height={7} title=" new space ">
				<Block lines={lines} cols={inner} />
			</Frame>
			<box paddingX={2} paddingY={1} flexDirection="column">
				<Block
					lines={[...ready, [], ...profileLines, [], hints]}
					cols={width - 4}
				/>
			</box>
		</box>
	);
}

export function QuietConfirm({look, width, height, destructive}: ConfirmProps) {
	const {muted} = quiet(look);
	const inner = panelInner(width);
	const accent = paint(destructive ? tokens.error : tokens.selection, look);
	const lines: Seg[][] = destructive
		? [
				[{text: 'Close PAP-390?', bold: true}],
				[muted('Close done spaces in bulk')],
				[],
				[muted('Issue state  '), {text: '‹ Done ›'}],
				[muted('The worktree and branch stay on disk.')],
				[],
				[
					keycap('y', accent, look),
					{text: ' close space', fg: accent},
					{text: '    '},
					keycap('n'),
					muted(' keep it'),
				],
			]
		: [
				[{text: 'Update to v0.9.0?', bold: true}],
				[muted('You are on v0.8.0.')],
				[],
				[muted('Downloads and runs the installer, then restarts.')],
				[],
				[],
				[
					keycap('y', accent, look),
					{text: ' update', fg: accent},
					{text: '    '},
					keycap('n'),
					muted(' not now'),
				],
			];
	return (
		<Frame look={look} width={width} height={height}>
			<Block lines={lines} cols={inner} />
		</Frame>
	);
}

const GLYPH_LEGEND: Array<[string, string, keyof typeof tokens | undefined]> = [
	['◴', 'working', undefined],
	['○', 'idle', undefined],
	['●', 'done', 'ok'],
	['◆', 'needs you', 'question'],
	['✕', 'error', 'error'],
	['◌', 'compacting', undefined],
];

export function QuietHelp({look, width, height}: SurfaceProps) {
	const {muted} = quiet(look);
	const inner = panelInner(width);
	const {fixed, overridable} = buildHelpRows();
	const keyCol = 11;
	const row = (key: string, description: string): Seg[] => [
		{text: key.padStart(keyCol - 2) + '  ', bold: true},
		{text: description},
	];
	const lines: Seg[][] = [
		...fixed.map(r => row(r.key, r.description)),
		[],
		[muted('open & run')],
		...overridable.map(r => row(r.key, r.description)),
		[],
		[muted('legend')],
		...[GLYPH_LEGEND.slice(0, 3), GLYPH_LEGEND.slice(3)].map(group =>
			group.flatMap(([glyph, word, token]): Seg[] => [
				{text: glyph, fg: token ? paint(tokens[token], look) : undefined},
				muted(` ${word.padEnd(12)}`),
			]),
		),
	];
	return (
		<Frame
			look={look}
			width={width}
			height={height}
			title=" pappardelle 0.8.0 "
			bottomTitle=" esc close "
		>
			<Block lines={lines} cols={inner} />
		</Frame>
	);
}

export function QuietErrors({look, width, height}: SurfaceProps) {
	const {muted} = quiet(look);
	const inner = panelInner(width);
	const lines: Seg[][] = [];
	for (const entry of sampleErrors) {
		const time = entry.timestamp.slice(11, 16);
		lines.push([
			entry.level === 'error'
				? {text: '✕ ', fg: paint(tokens.error, look)}
				: {text: '! ', fg: paint(tokens.warn, look)},
			muted(entry.component.padEnd(8)),
			{text: entry.message, shrink: true, grow: true},
			muted(`  ${time}`),
		]);
		if (entry.error) lines.push([{text: '          '}, muted(entry.error)]);
	}

	lines.push([], [muted('logs  ~/.pappardelle/logs/')]);
	return (
		<Frame
			look={look}
			width={width}
			height={height}
			title={` errors · ${sampleErrors.length} `}
			bottomTitle=" c clear · esc close "
		>
			<Block lines={lines} cols={inner} />
		</Frame>
	);
}
