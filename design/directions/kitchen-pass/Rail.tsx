import {RGBA, type ColorInput} from '@opentui/core';
import stringWidth from 'string-width';
import {REPO} from '../../fixtures.ts';
import {chip, hexOf, mix, paint, type Look} from '../../kit/color.ts';
import {Block, DROP, Line, type Seg} from '../../kit/line.tsx';
import {cycle, ease, isRunning, progressOf} from '../../kit/motion.ts';
import {age, describeSpace, type RowModel} from '../../kit/row.ts';
import type {SurfaceProps} from '../../kit/surface.ts';
import type {SceneFrame} from '../../fixtures.ts';
import {GROUPS, STATIONS, surfaces, tokens} from './tokens.ts';

const HEAT = ['≋', '≈', '∼', '≈'];
export const HEAT_INTERVAL = 140;
export const BELL = {duration: 360, step: 60};
export const TYPE_SPEED = 22;
export const STAMP_DURATION = 1300;
export const TEAR_DURATION = 450;
export const PENDING_INTERVAL = 90;
/** A ticket that changes station slides to its new group. */
export const MOVE_DURATION = 250;

/** `PAP-412` reads as ticket `#412`; the team prefix repeats on every row. */
export function ticketNumber(key: string) {
	const match = /-([\w.]+)$/.exec(key);
	return match ? `#${match[1]}` : key;
}

function muted(look: Look, text: string, extra: Partial<Seg> = {}): Seg {
	return look.tier === 'truecolor'
		? {text, fg: RGBA.fromHex(surfaces(look).muted), ...extra}
		: {text, dim: true, ...extra};
}

function stationGlyph(row: RowModel, look: Look, now: number): Seg {
	const station = STATIONS[row.state];
	switch (row.state) {
		case 'working':
		case 'tool': {
			const glyph = cycle(HEAT, now, HEAT_INTERVAL);
			if (look.tier === 'truecolor') {
				// Truecolor flickers between two ambers like a burner.
				const flicker = (Math.sin(now / 90) + 1) / 2;
				const hex = mix(
					hexOf(tokens.heat, look.theme),
					hexOf(tokens.heatHot, look.theme),
					flicker,
				);
				return {text: glyph, fg: RGBA.fromHex(hex)};
			}

			return {text: glyph, fg: paint(tokens.heat, look)};
		}

		case 'pending': {
			return muted(
				look,
				cycle(['⠁', '⠃', '⠇', '⠧', '⠷', '⠿'], now, PENDING_INTERVAL),
			);
		}

		case 'done': {
			return {text: '✓', fg: paint(tokens.plated, look)};
		}

		case 'idle': {
			return muted(look, '·');
		}

		case 'unknown': {
			return muted(look, ' ');
		}

		case 'compacting': {
			return {text: '∿', fg: paint(tokens.reduce, look)};
		}

		case 'question':
		case 'permission':
		case 'error': {
			return {
				text: '●',
				fg: station.token ? paint(tokens[station.token], look) : undefined,
			};
		}
	}
}

function courses(progress: number) {
	const served = Math.round((progress / 100) * 5);
	return '●'.repeat(served) + '○'.repeat(5 - served);
}

function pipelineSegs(row: RowModel, look: Look): Seg[] {
	const segs: Seg[] = [];
	if (row.comments > 0) segs.push(muted(look, ` ${row.comments}✎`));
	if (row.conflict) segs.push({text: ' ↯', fg: paint(tokens.burnt, look)});
	if (row.pipeline === 'passing')
		segs.push({text: ' ✓', fg: paint(tokens.plated, look)});
	if (row.pipeline === 'failing')
		segs.push({text: ' ✗', fg: paint(tokens.burnt, look), bold: true});
	if (row.pipeline === 'progressing_clean') segs.push(muted(look, ' ◔'));
	if (row.pipeline === 'progressing_dirty')
		segs.push({text: ' ◑', fg: paint(tokens.burnt, look)});
	return segs.map(seg => ({
		...seg,
		drop: seg.text.includes('✎') ? DROP.comments : DROP.pipeline,
	}));
}

type Ticket = {lines: Seg[][]; bg?: ColorInput};

function ticket(row: RowModel, props: SurfaceProps): Ticket {
	const {look, now, layout, frame} = props;
	const selected = row.space.name === frame.selected;
	const change = frame.changes[row.space.name];
	const closingAt = frame.closing?.[row.space.name];
	const s = surfaces(look);

	if (closingAt !== undefined && now >= closingAt) {
		// The ticket is torn off the rail.
		const {width} = props;
		const torn = Math.round(progressOf(now, closingAt, TEAR_DURATION) * width);
		return {
			lines: [[muted(look, '✂ ' + '┄'.repeat(Math.max(0, width - 2 - torn)))]],
		};
	}

	const number = row.space.isMainWorktree
		? '⌂ main'
		: row.key
			? ticketNumber(row.key)
			: '#new';
	const bell =
		row.needsYou &&
		change?.kind === 'state' &&
		isRunning(now, change.at, BELL.duration);
	const nudge =
		bell && Math.floor((now - change.at) / BELL.step) % 2 === 0 ? ' ' : '';
	const stamping =
		row.state === 'done' &&
		change?.kind === 'state' &&
		isRunning(now, change.at, STAMP_DURATION);
	// The title types in when the ticket prints, and again when a pending
	// ticket learns its real title.
	const typesIn =
		change?.kind === 'created' ||
		(change?.kind === 'state' && change.before?.isPending === true);
	const typing = typesIn
		? Math.max(0, Math.floor((now - change.at) / TYPE_SPEED))
		: Infinity;

	const marker: Seg = selected
		? {text: '▸', fg: paint(tokens.marker, look), bold: true}
		: {text: ' '};
	const numberSeg: Seg = {
		text: number,
		clip: true,
		bold: true,
		fg: row.needsYou
			? paint(
					row.state === 'question' ? tokens.question : tokens.permission,
					look,
				)
			: undefined,
	};
	const title = row.title.slice(0, typing);
	const titleSeg: Seg = stamping
		? {
				text: ' PLATED ',
				...chip(paint(tokens.plated, look), paint(tokens.onAccent, look), look),
				bold: true,
			}
		: selected || row.needsYou
			? {text: title, shrink: true, grow: true, italic: row.state === 'pending'}
			: muted(look, title, {
					shrink: true,
					grow: true,
					italic: row.state === 'pending',
				});
	const since =
		row.stateSince !== undefined && row.state !== 'unknown'
			? [muted(look, ` ${age(now - row.stateSince)}`, {drop: DROP.age})]
			: [];
	const right = [...since, ...pipelineSegs(row, look)];
	const lead: Seg[] = [
		{text: nudge},
		marker,
		...(row.emoji ? [{text: row.emoji}] : []),
		{text: ' '},
	];

	const lines: Seg[][] =
		layout === 'two_line'
			? [
					[
						...lead,
						numberSeg,
						{text: ' '},
						stationGlyph(row, look, now),
						{text: ' '},
						muted(look, STATIONS[row.state].word, {grow: true, shrink: true}),
						...right,
					],
					[
						{
							text: ' '.repeat(
								stringWidth(lead.map(seg => seg.text).join('')) + 1,
							),
						},
						...(stamping ? [titleSeg, {text: '', grow: true}] : [titleSeg]),
					],
				]
			: [
					[
						...lead,
						numberSeg,
						{text: ' '},
						stationGlyph(row, look, now),
						{text: ' '},
						// The main worktree has no title, so it shows its station.
						...(row.title
							? stamping
								? [titleSeg, {text: '', grow: true}]
								: [titleSeg]
							: [
									muted(look, STATIONS[row.state].word, {
										grow: true,
										shrink: true,
									}),
								]),
						...right,
					],
				];

	// Every ticket with a note shows it, so moving the selection never reflows
	// the pass.
	if (row.detail || row.progress !== undefined) {
		const indent = ' '.repeat(
			stringWidth(lead.map(seg => seg.text).join('')) + 1,
		);
		const note: Seg[] = [{text: indent}];
		if (row.detail) {
			const text = `“${row.detail}”`;
			note.push(
				selected
					? {text, italic: true, shrink: true}
					: muted(look, text, {italic: true, shrink: true}),
			);
		}
		if (row.progress !== undefined)
			note.push(
				{text: ' '},
				{text: courses(row.progress), fg: paint(tokens.heat, look)},
			);
		lines.push(note);
	}

	let bg: ColorInput | undefined;
	if (look.tier === 'truecolor') {
		if (row.needsYou) {
			const accent = hexOf(
				row.state === 'question' ? tokens.question : tokens.permission,
				look.theme,
			);
			bg = RGBA.fromHex(s.wash(accent, bell ? 0.3 : 0.12));
		} else if (selected) bg = RGBA.fromHex(s.ticket);
	}

	return {lines, bg};
}

function groupRule(
	label: string,
	count: number,
	look: Look,
	width: number,
	accent?: ColorInput,
): Seg[] {
	const s = surfaces(look);
	const rule = (text: string): Seg =>
		look.tier === 'truecolor'
			? {text, fg: RGBA.fromHex(s.rule)}
			: {text, dim: true};
	const head = `┄ ${label} `;
	const tail = ` ${count} ┄`;
	const fill = width - stringWidth(head) - stringWidth(tail);
	return [
		rule('┄ '),
		{
			text: label,
			shrink: true,
			bold: Boolean(accent),
			fg: accent,
			...(accent
				? {}
				: look.tier === 'truecolor'
					? {fg: RGBA.fromHex(s.muted)}
					: {dim: true}),
		},
		// The fill shrinks away before the label does, keeping one space so the
		// counts stay in one column down the rail.
		rule(fill > 0 ? ' ' + '┄'.repeat(fill) : ' '),
		// The count is information, so it reads at muted strength, not as rule.
		{
			text: ` ${count}`,
			...(look.tier === 'truecolor' ? {fg: RGBA.fromHex(s.muted)} : {}),
		},
		rule(' ┄'),
	];
}

export function callingCount(rows: RowModel[]) {
	return rows.filter(row => row.needsYou).length;
}

type PassBlock = {id: string; lines: Seg[][]; bg?: ColorInput};
type PassLine = {segs: Seg[]; bg?: ColorInput};

function groupOf(row: RowModel) {
	if (row.space.isMainWorktree) return 'main';
	return GROUPS.find(group => group.states.includes(row.state))?.id;
}

/** Ticket names top to bottom: main, then each station in turn. */
export function passOrder(frame: SceneFrame): string[] {
	const rows = frame.spaces.map(space => describeSpace(space));
	return [
		...rows.filter(row => row.space.isMainWorktree),
		...GROUPS.flatMap(group =>
			rows.filter(
				row => !row.space.isMainWorktree && group.states.includes(row.state),
			),
		),
	].map(row => row.space.name);
}

/** The rail's tickets in order: main, then each station with its rule. */
function passBlocks(rows: RowModel[], props: SurfaceProps): PassBlock[] {
	const {look, width, frame} = props;
	const blocks: PassBlock[] = rows
		.filter(row => row.space.isMainWorktree)
		.map(row => ({id: 'main', ...ticket(row, props)}));
	for (const group of GROUPS) {
		const members = rows.filter(row => {
			if (row.space.isMainWorktree || !group.states.includes(row.state))
				return false;
			const closingAt = frame.closing?.[row.space.name];
			return closingAt === undefined || props.now <= closingAt + TEAR_DURATION;
		});
		if (members.length === 0) continue;
		const accent =
			group.id === 'calling'
				? paint(tokens.permission, look)
				: group.id === 'firing'
					? paint(tokens.heat, look)
					: group.id === 'burnt'
						? paint(tokens.burnt, look)
						: undefined;
		blocks.push({
			id: `rule-${group.id}`,
			lines: [groupRule(group.label, members.length, look, width, accent)],
		});
		for (const row of members)
			blocks.push({id: row.space.name || 'new', ...ticket(row, props)});
	}

	return blocks;
}

/** A ticket whose state change just moved it to another station. */
function movingTicket(rows: RowModel[], props: SurfaceProps) {
	for (const row of rows) {
		const change = props.frame.changes[row.space.name];
		if (
			change?.kind !== 'state' ||
			!change.before ||
			!isRunning(props.now, change.at, MOVE_DURATION)
		)
			continue;
		const before = describeSpace(change.before);
		if (groupOf(before) !== groupOf(row)) return {row, before, at: change.at};
	}

	return undefined;
}

/**
 * The pass mid-move: every other ticket is already in its new place, and the
 * moving ticket travels between them, a block at a time, from where it was
 * to where it is going.
 */
function slide(
	from: PassBlock[],
	to: PassBlock[],
	movingId: string,
	t: number,
): PassLine[] {
	// Station counts switch halfway, as the ticket changes groups.
	const others = to
		.filter(block => block.id !== movingId)
		.map(block =>
			t < 0.5 && block.id.startsWith('rule-')
				? (from.find(old => old.id === block.id) ?? block)
				: block,
		);
	const moving = to.find(block => block.id === movingId);
	if (!moving) return toLines(to);
	// Where it was: just after the last block that preceded it then and is
	// still on the pass.
	const index = from.findIndex(block => block.id === movingId);
	const anchor = from
		.slice(0, index)
		.findLast(block => others.some(other => other.id === block.id));
	const start = anchor
		? others.findIndex(block => block.id === anchor.id) + 1
		: 0;
	const end = to.findIndex(block => block.id === movingId);
	const slot = Math.round(start + (end - start) * t);
	return toLines([...others.slice(0, slot), moving, ...others.slice(slot)]);
}

function toLines(blocks: PassBlock[]): PassLine[] {
	return blocks.flatMap(block =>
		block.lines.map(segs => ({segs, bg: block.bg})),
	);
}

export function KitchenRail(props: SurfaceProps) {
	const {look, width, height, frame} = props;
	const rows = frame.spaces.map(space => describeSpace(space));
	const calling = callingCount(rows);
	const header: Seg[] = [
		{text: ' 🍝 '},
		{text: REPO, bold: true, shrink: true, grow: true},
		...(calling > 0
			? [
					{
						text: width >= 24 ? ` ${calling} calling ` : ` ${calling} `,
						...chip(
							paint(tokens.permission, look),
							paint(tokens.onAccent, look),
							look,
						),
						bold: true,
					},
				]
			: [muted(look, ' all quiet')]),
		{text: ' '},
	];
	const pass: Seg[] = [muted(look, '━'.repeat(width))];

	const blocks = passBlocks(rows, props);
	const move = movingTicket(rows, props);
	const lines = move
		? slide(
				passBlocks(
					rows.map(row => (row === move.row ? move.before : row)),
					props,
				),
				blocks,
				move.row.space.name,
				ease.inOutSine(progressOf(props.now, move.at, MOVE_DURATION)),
			)
		: toLines(blocks);

	return (
		<box flexDirection="column" width={width} height={height}>
			<Block lines={[header, pass]} cols={width} />
			{lines.map((line, index) => (
				<Line key={index} segs={line.segs} cols={width} bg={line.bg} />
			))}
		</box>
	);
}
