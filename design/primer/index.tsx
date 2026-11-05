import type {ReactNode} from 'react';
import {RGBA} from '@opentui/core';
import {terminalColor} from '../../source/tui-style.ts';
import {
	mix,
	terminalBackground,
	terminalForeground,
	type Look,
} from '../kit/color.ts';
import {Block, type Seg} from '../kit/line.tsx';
import {
	cycle,
	ease,
	eighthBar,
	progressOf,
	pulse,
	sweepColumn,
} from '../kit/motion.ts';

/**
 * Small, self-contained demos of each motion technique a terminal can do.
 * Every one is a pure function of time so the exporter can capture it.
 */
export type Demo = {
	id: string;
	title: string;
	/** What it is, how it works in cells, and what it costs. */
	body: string;
	cols: number;
	rows: number;
	duration: number;
	render(now: number, look: Look): ReactNode;
};

const COLS = 44;
const label = (text: string): Seg => ({text: text.padEnd(14), dim: true});
const accent = (look: Look) =>
	look.tier === 'truecolor'
		? RGBA.fromHex(look.theme === 'light' ? '#6a4fd6' : '#b4a0ff')
		: terminalColor('magenta');

const glyphs: Demo = {
	id: 'glyphs',
	title: 'Glyph cycling',
	body: 'Swap one character on a timer. Cheapest motion there is: one cell repaints per tick, and every spinner on screen can share a single clock.',
	cols: COLS,
	rows: 5,
	duration: 2400,
	render: (now, look) => (
		<Block
			cols={COLS}
			lines={[
				[
					label('braille 80ms'),
					{
						text: cycle(
							['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
							now,
							80,
						),
						fg: accent(look),
					},
				],
				[
					label('quarter 125ms'),
					{text: cycle(['◴', '◷', '◶', '◵'], now, 125), fg: accent(look)},
				],
				[
					label('today 150ms'),
					{
						text: cycle(['·', '✢', '✳', '∗', '✻', '✽'], now, 150),
						fg: RGBA.fromHex('#de7356'),
					},
				],
				[
					label('ring 130ms'),
					{
						text: cycle(['○', '◎', '◉', '●', '◉', '◎'], now, 130),
						fg: accent(look),
					},
				],
				[
					label('heat 140ms'),
					{
						text: cycle(['≋', '≈', '∼', '≈'], now, 140),
						fg: terminalColor('yellow'),
					},
				],
			]}
		/>
	),
};

const subcell: Demo = {
	id: 'subcell',
	title: 'Sub-cell progress',
	body: 'Eighth blocks ▏▎▍▌▋▊▉█ give a bar eight steps per cell, so a 20-cell bar moves in 160 steps instead of 20. Pure text, works in 16 colors.',
	cols: COLS,
	rows: 3,
	duration: 3000,
	render(now, look) {
		const t = ease.inOutSine(progressOf(now % 3000, 0, 2600));
		const cells = 24;
		return (
			<Block
				cols={COLS}
				lines={[
					[
						label('whole cells'),
						{
							text: '█'.repeat(Math.round(t * cells)).padEnd(cells, '·'),
							fg: accent(look),
						},
					],
					[],
					[label('eighths'), {text: eighthBar(t, cells), fg: accent(look)}],
				]}
			/>
		);
	},
};

const glide: Demo = {
	id: 'glide',
	title: 'Half-row glide',
	body: 'A cell is two half-blocks tall (▀ ▄). A selection marker drawn from half-blocks can sit between rows mid-move, which halves the jump the eye has to follow.',
	cols: COLS,
	rows: 5,
	duration: 2400,
	render(now, look) {
		const step = Math.floor(now / 600) % 4;
		const from = [0, 1, 3, 2][step]!;
		const to = [1, 3, 2, 0][step]!;
		const position =
			from + (to - from) * ease.outCubic(progressOf(now % 600, 0, 160));
		const top = Math.round(position * 2);
		const pill = (row: number): Seg => {
			const upper = top <= row * 2 && row * 2 < top + 2;
			const lower = top <= row * 2 + 1 && row * 2 + 1 < top + 2;
			return {
				text: upper && lower ? '█' : upper ? '▀' : lower ? '▄' : ' ',
				fg: accent(look),
			};
		};

		const jump = (row: number): Seg => ({
			text: Math.round(position) === row ? '█' : ' ',
			fg: accent(look),
		});
		return (
			<Block
				cols={COLS}
				lines={[0, 1, 2, 3].map((row): Seg[] => [
					jump(row),
					{text: ` row ${row + 1}`.padEnd(14), dim: true},
					pill(row),
					{text: ` row ${row + 1}`},
				])}
			/>
		);
	},
};

const fade: Demo = {
	id: 'fade',
	title: 'Color fade',
	body: 'Truecolor can ease a color between any two values each frame. 16 colors cannot: the fallback is a step between normal and dim, so designs must still read without the fade.',
	cols: COLS,
	rows: 3,
	duration: 2400,
	render(now, look) {
		const t = pulse(now, 2400);
		const fg = terminalForeground(look.theme);
		const bg = terminalBackground(look.theme);
		const breathing: Seg =
			look.tier === 'truecolor'
				? {
						text: 'PAP-412 working',
						bold: true,
						fg: RGBA.fromHex(mix(fg, bg, t * 0.7)),
					}
				: {text: 'PAP-412 working', bold: true, dim: t > 0.5};
		return (
			<Block
				cols={COLS}
				lines={[
					[label('breathing'), breathing],
					[],
					[
						label(look.tier === 'truecolor' ? 'truecolor' : '16 colors'),
						{
							text:
								look.tier === 'truecolor'
									? 'eased every frame'
									: 'two steps only',
							dim: true,
						},
					],
				]}
			/>
		);
	},
};

const shimmer: Demo = {
	id: 'shimmer',
	title: 'Shimmer',
	body: 'A narrow band of brighter cells sweeps across text when something new arrives. Truecolor brightens the band; 16 colors bolds it.',
	cols: COLS,
	rows: 1,
	duration: 1800,
	render(now, look) {
		const text = 'Running tests 30/30, building release';
		const band = sweepColumn(now % 1800, 0, 900, text.length);
		const fg = terminalForeground(look.theme);
		const bg = terminalBackground(look.theme);
		const glint = look.theme === 'light' ? '#000000' : '#ffffff';
		const segs: Seg[] = [...text].map((char, column) => {
			const distance = Math.abs(column - band);
			if (distance > 2)
				return look.tier === 'truecolor'
					? {text: char, fg: RGBA.fromHex(mix(fg, bg, 0.45))}
					: {text: char, dim: true};
			return look.tier === 'truecolor'
				? {text: char, fg: RGBA.fromHex(mix(fg, glint, 1 - distance / 3))}
				: {text: char, bold: true};
		});
		return <Block cols={COLS} lines={[segs]} />;
	},
};

const slide: Demo = {
	id: 'slide',
	title: 'Slide in',
	body: 'Text cannot move by less than a cell, but an ease-out over 300 ms makes cell steps read as one motion. Linear motion looks mechanical next to it.',
	cols: COLS,
	rows: 3,
	duration: 2000,
	render(now) {
		const t = progressOf(now % 2000, 200, 320);
		const row = '● PAP-415 Add mouse wheel';
		const at = (amount: number): Seg => ({
			text:
				' '.repeat(Math.round((1 - amount) * (COLS - 14 - row.length))) + row,
		});
		return (
			<Block
				cols={COLS}
				lines={[
					[label('linear'), at(t)],
					[],
					[label('ease-out'), at(ease.outCubic(t))],
				]}
			/>
		);
	},
};

const scrim: Demo = {
	id: 'scrim',
	title: 'Scrim',
	body: 'Dimming what sits behind a dialog. OpenTUI blends cells with opacity in truecolor; in 16 colors the same intent is the dim attribute.',
	cols: COLS,
	rows: 5,
	duration: 2400,
	render(now, look) {
		const t = ease.outCubic(progressOf(now % 2400, 300, 200));
		const fg = terminalForeground(look.theme);
		const bg = terminalBackground(look.theme);
		const behind = (text: string): Seg =>
			look.tier === 'truecolor'
				? {text, fg: RGBA.fromHex(mix(fg, bg, t * 0.65))}
				: {text, dim: t > 0.5};
		return (
			<Block
				cols={COLS}
				lines={[
					[behind('● PAP-412 Stream OSC progress into the rail')],
					[
						behind('● PAP-409 '),
						{text: t > 0.5 ? '╭─ close PAP-390? ─────────╮' : '', bold: true},
					],
					[
						behind('● PAP-405 '),
						{text: t > 0.5 ? '│  y close     n keep      │' : ''},
					],
					[
						behind('○ PAP-401 '),
						{text: t > 0.5 ? '╰──────────────────────────╯' : ''},
					],
					[behind('○ PAP-396 Document agent profiles')],
				]}
			/>
		);
	},
};

const typewriter: Demo = {
	id: 'typewriter',
	title: 'Typewriter',
	body: 'Revealing text a few characters per frame. Good for something arriving (a ticket printing), tiring for anything you read often.',
	cols: COLS,
	rows: 2,
	duration: 2400,
	render(now) {
		const text = 'Add mouse wheel scrolling to the rail';
		const shown = Math.max(0, Math.floor(((now % 2400) - 200) / 28));
		return (
			<Block
				cols={COLS}
				lines={[
					[
						{text: '#415 ', bold: true},
						{text: text.slice(0, shown)},
						{text: shown < text.length ? '▏' : ''},
					],
				]}
			/>
		);
	},
};

export const demos: Demo[] = [
	glyphs,
	subcell,
	glide,
	fade,
	shimmer,
	slide,
	scrim,
	typewriter,
];
