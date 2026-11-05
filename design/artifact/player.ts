import type {Span} from '../kit/frame.ts';
import {frameCss, frameToHtml, rowToHtml} from './frame-html.ts';
import {palettes, type Palette} from './palettes.ts';

/**
 * Runs in the published page. Frames arrive gzipped and base64-encoded in a
 * <script type="application/octet-stream" id="frames"> tag; every element
 * with `data-frame` or `data-sequence` is filled from them, and the toolbar
 * re-renders everything when the terminal theme or color tier changes.
 */

type Stored = {cols: number; rows: number; lines: number[]};
type Sequence = {cols: number; rows: number; fps: number; frames: number[][]};
type Data = {
	rows: Span[][];
	frames: Record<string, Stored>;
	sequences: Record<string, Sequence>;
};

type ThemeId = keyof typeof palettes;
type State = {
	theme: ThemeId;
	tier: 'ansi' | 'truecolor';
	width: string;
	layout: string;
};

const STORAGE_KEY = 'pappardelle-tui-toolbar';
const state: State = {
	theme: 'dark',
	tier: 'ansi',
	width: '28',
	layout: 'single_line',
};
let data: Data;

async function load(): Promise<Data> {
	const encoded = document.querySelector('#frames')!.textContent!.trim();
	// Uint8Array.fromBase64 is not in every browser the page may open in yet.
	// eslint-disable-next-line no-restricted-globals
	const bytes = Uint8Array.from(atob(encoded), char => char.codePointAt(0)!);
	const stream = new Blob([bytes])
		.stream()
		.pipeThrough(new DecompressionStream('gzip'));
	return JSON.parse(await new Response(stream).text()) as Data;
}

const variant = () =>
	state.tier === 'ansi' ? 'ansi' : `truecolor-${state.theme}`;
const palette = (): Palette => palettes[state.theme];

/** Keys may reference the toolbar: {variant}, {width}, {layout}. */
function resolveKey(template: string) {
	return template
		.replaceAll('{variant}', variant())
		.replaceAll('{width}', state.width)
		.replaceAll('{layout}', state.layout);
}

/** A section's name: its heading, except the primer, whose heading is an answer. */
function sectionOf(element: HTMLElement) {
	const section = element.closest('section');
	if (section?.id === 'motion') return 'Motion primer';
	return section?.querySelector('h2')?.textContent?.trim() ?? '';
}

/** Frames and scrubbers repeat across directions, so their names carry it. */
const withSection = (element: HTMLElement, name: string) => {
	const section = sectionOf(element);
	return section ? `${section}: ${name}` : name;
};

/** A frame is named by its demo or scene heading, else its caption's title. */
function titleOf(element: HTMLElement, fallback: string) {
	const holder = element.closest('figure, .demo');
	const title = holder
		?.querySelector('h3, figcaption b')
		?.textContent?.trim()
		.replace(/\.$/, '');
	return title || fallback;
}

const rowCache = new Map<string, string>();
function frameHtml(cols: number, lines: number[], label: string) {
	const pal = palette();
	const rows = lines.map(id => {
		const cacheKey = `${pal.name}:${id}`;
		let row = rowCache.get(cacheKey);
		if (row === undefined) {
			row = rowToHtml(data.rows[id]!, pal);
			rowCache.set(cacheKey, row);
		}

		return row;
	});
	return frameToHtml(cols, rows, pal, label);
}

function renderStill(element: HTMLElement) {
	const key = resolveKey(element.dataset['frame']!);
	const frame = data.frames[key];
	if (frame)
		element.innerHTML = frameHtml(
			frame.cols,
			frame.lines,
			withSection(element, titleOf(element, key)),
		);
	else element.textContent = `No frame for ${key}`;
}

type Player = {
	element: HTMLElement;
	index: number;
	playing: boolean;
	visible: boolean;
	/** When frame 0 would have shown for the current run; set on the next tick. */
	origin: number | undefined;
};
const players: Player[] = [];

function sequenceOf(player: Player) {
	return data.sequences[resolveKey(player.element.dataset['sequence']!)];
}

function drawPlayer(player: Player) {
	const key = resolveKey(player.element.dataset['sequence']!);
	const sequence = data.sequences[key];
	const screen = player.element.querySelector<HTMLElement>('.screen')!;
	if (!sequence) {
		screen.textContent = `No sequence for ${key}`;
		return;
	}

	player.index %= sequence.frames.length;
	screen.innerHTML = frameHtml(
		sequence.cols,
		sequence.frames[player.index]!,
		withSection(player.element, titleOf(player.element, key)),
	);
	const scrub =
		player.element.querySelector<HTMLInputElement>('input[type=range]');
	if (scrub) {
		scrub.max = String(sequence.frames.length - 1);
		scrub.value = String(player.index);
	}

	const clock = player.element.querySelector<HTMLElement>('.clock');
	if (clock)
		clock.textContent = `${((player.index / sequence.fps) * 1000).toFixed(0).padStart(4, ' ')} ms`;
}

function setPlaying(player: Player, playing: boolean) {
	player.playing = playing;
	player.origin = undefined;
	const button = player.element.querySelector<HTMLButtonElement>('button.play');
	if (button) button.textContent = playing ? 'Pause' : 'Play';
}

/**
 * The frame index comes from time elapsed since the run started, so playback
 * holds the sequence's fps whatever the display's refresh rate.
 */
function tick(now: number) {
	for (const player of players) {
		if (!player.playing || !player.visible) continue;
		const sequence = sequenceOf(player);
		if (!sequence) continue;
		const interval = 1000 / sequence.fps;
		player.origin ??= now - player.index * interval;
		// A frame timestamp can predate an origin set from performance.now(),
		// which must not step the player back.
		const elapsed = Math.max(player.index * interval, now - player.origin);
		const index =
			Math.floor(elapsed / interval + 1e-6) % sequence.frames.length;
		if (index !== player.index) {
			player.index = index;
			drawPlayer(player);
		}
	}

	requestAnimationFrame(tick);
}

const SCROLLERS = '.well, .screen, .table-wrap, pre.conf';

function regionLabel(element: HTMLElement) {
	const section = sectionOf(element);
	if (element.matches('.screen')) return titleOf(element, section);
	if (element.matches('pre.conf')) return `${section}: tmux options`;
	if (element.matches('.table-wrap')) return `${section}: table`;
	const titles = [
		...element.querySelectorAll<HTMLElement>('[data-frame], .screen'),
	].map(frame => titleOf(frame, ''));
	return `${section}: ${titles.filter(Boolean).join(', ')}`;
}

/**
 * Chrome lets the keyboard scroll any overflowing box; other browsers need
 * it focusable. Only boxes that overflow right now become tab stops.
 */
function markScrollable(element: HTMLElement) {
	const scrolls =
		element.scrollWidth > element.clientWidth + 1 &&
		getComputedStyle(element).overflowX !== 'visible';
	if (scrolls === element.hasAttribute('tabindex')) return;
	if (scrolls) {
		element.tabIndex = 0;
		element.setAttribute('role', 'region');
		element.setAttribute('aria-label', regionLabel(element));
	} else {
		element.removeAttribute('tabindex');
		element.removeAttribute('role');
		element.removeAttribute('aria-label');
	}
}

const markAllScrollable = () => {
	for (const element of document.querySelectorAll<HTMLElement>(SCROLLERS))
		markScrollable(element);
};

function renderAll() {
	rowCache.clear();
	for (const element of document.querySelectorAll<HTMLElement>('[data-frame]'))
		renderStill(element);
	// After a slow re-render the next frame's timestamp is from before it
	// started, so playback resumes from now rather than from that timestamp.
	const now = performance.now();
	for (const player of players) {
		const sequence = sequenceOf(player);
		player.origin = sequence
			? now - player.index * (1000 / sequence.fps)
			: undefined;
		drawPlayer(player);
	}

	for (const element of document.querySelectorAll<HTMLElement>(
		'[data-theme-name]',
	))
		element.textContent =
			element.dataset['themeName'] === 'tier'
				? state.tier === 'ansi'
					? '16 colors'
					: 'truecolor'
				: palette().name;
	// Measuring every box forces a layout; do it once the click has painted.
	if ('requestIdleCallback' in globalThis)
		requestIdleCallback(markAllScrollable);
	else setTimeout(markAllScrollable, 100);
}

const toolbarGroups = () =>
	document.querySelectorAll<HTMLElement>('.toolbar [data-control]');

function bindToolbar() {
	for (const group of toolbarGroups()) {
		const control = group.dataset['control'] as keyof State;
		for (const button of group.querySelectorAll<HTMLButtonElement>('button')) {
			button.setAttribute(
				'aria-pressed',
				String(button.value === state[control]),
			);
			button.addEventListener('click', () => {
				(state as Record<string, string>)[control] = button.value;
				for (const sibling of group.querySelectorAll('button'))
					sibling.setAttribute('aria-pressed', String(sibling === button));
				try {
					localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
				} catch {}

				renderAll();
			});
		}
	}
}

/** Saved values that no longer match a toolbar button keep the default. */
function restoreToolbar() {
	let saved: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(
			localStorage.getItem(STORAGE_KEY) ?? 'null',
		);
		if (parsed && typeof parsed === 'object')
			saved = parsed as Record<string, unknown>;
	} catch {}

	for (const group of toolbarGroups()) {
		const control = group.dataset['control'] as keyof State;
		const value = saved[control];
		const values = [...group.querySelectorAll('button')].map(b => b.value);
		if (typeof value === 'string' && values.includes(value))
			(state as Record<string, string>)[control] = value;
	}
}

/**
 * On narrow screens the toolbar is one row that scrolls sideways. The page
 * fades whichever edge has more buttons past it, and keeps the toolbar's
 * height in --toolbar-height for scroll-padding.
 */
function bindToolbarLayout() {
	const toolbar = document.querySelector<HTMLElement>('.toolbar')!;
	const inner = toolbar.querySelector<HTMLElement>('.inner')!;
	const update = () => {
		const more = [];
		if (inner.scrollLeft > 1) more.push('start');
		if (inner.scrollLeft + inner.clientWidth < inner.scrollWidth - 1)
			more.push('end');
		inner.dataset['more'] = more.join(' ');
		document.documentElement.style.setProperty(
			'--toolbar-height',
			`${toolbar.offsetHeight}px`,
		);
	};

	inner.addEventListener('scroll', update, {passive: true});
	const observer = new ResizeObserver(update);
	observer.observe(inner);
	for (const group of toolbarGroups()) observer.observe(group);
}

function bindPlayers() {
	const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
	const observer = new IntersectionObserver(entries => {
		for (const entry of entries) {
			const player = players.find(p => p.element === entry.target);
			if (player) {
				player.visible = entry.isIntersecting;
				player.origin = undefined;
			}
		}
	});
	for (const element of document.querySelectorAll<HTMLElement>(
		'[data-sequence]',
	)) {
		const player: Player = {
			element,
			index: 0,
			playing: false,
			visible: false,
			origin: undefined,
		};
		players.push(player);
		observer.observe(element);
		element.querySelector('button.play')?.addEventListener('click', () => {
			setPlaying(player, !player.playing);
		});
		const scrub = element.querySelector<HTMLInputElement>('input[type=range]');
		scrub?.setAttribute(
			'aria-label',
			`Scrub ${withSection(element, (scrub.getAttribute('aria-label') ?? '').replace(/^Scrub /, ''))}`,
		);
		scrub?.addEventListener('input', event => {
			setPlaying(player, false);
			player.index = Number((event.target as HTMLInputElement).value);
			drawPlayer(player);
		});
		setPlaying(player, !reduced && element.dataset['autoplay'] !== undefined);
	}
}

async function start() {
	const style = document.createElement('style');
	style.textContent = frameCss;
	document.head.append(style);
	bindToolbarLayout();
	data = await load();
	restoreToolbar();
	bindToolbar();
	bindPlayers();
	renderAll();
	const resized = new ResizeObserver(entries => {
		for (const entry of entries) markScrollable(entry.target as HTMLElement);
	});
	for (const element of document.querySelectorAll<HTMLElement>(SCROLLERS))
		resized.observe(element);
	void document.fonts.ready.then(markAllScrollable);
	requestAnimationFrame(tick);
}

// The bundle is an IIFE, which can't contain top-level await.
// eslint-disable-next-line unicorn/prefer-top-level-await
void start();
