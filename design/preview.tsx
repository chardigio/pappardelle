import {parseArgs} from 'node:util';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {useEffect, useState} from 'react';
import {
	useAnimationTick,
	useKeyboard,
	useRenderer,
	useTerminalDimensions,
} from '@opentui/react';
import {renderTui} from '../source/render-tui.ts';
import {terminalColor, textAttributes} from '../source/tui-style.ts';
import type {ListLayout} from '../source/config.ts';
import {MAX_LIST_WIDTH, MIN_LIST_WIDTH} from '../source/layout-sizing.ts';
import {calm, scenes, still, type SceneFrame} from './fixtures.ts';
import {THEMES, TIERS, type Look} from './kit/color.ts';
import {
	RAIL_HEIGHT,
	SURFACE_SIZE,
	type SurfaceName,
	type SurfaceProps,
} from './kit/surface.ts';
import {targetById, targets} from './directions/index.tsx';

const LAYOUTS: ListLayout[] = ['single_line', 'two_line'];
const RESTING = {still, calm};

function fail(message: string): never {
	console.error(message);
	// eslint-disable-next-line unicorn/no-process-exit
	process.exit(1);
}

function parse() {
	try {
		return parseArgs({
			allowPositionals: true,
			options: {
				surface: {type: 'string', default: 'rail'},
				width: {type: 'string', default: '34'},
				tier: {type: 'string'},
				theme: {type: 'string', default: 'dark'},
				layout: {type: 'string', default: 'single_line'},
				scene: {type: 'string'},
				static: {type: 'string'},
				frame: {type: 'string', default: 'still'},
				bench: {type: 'boolean', default: false},
			},
		});
	} catch (error) {
		fail((error as Error).message);
	}
}

const {values, positionals} = parse();

function oneOf<T extends string>(
	flag: string,
	value: string,
	allowed: readonly T[],
): T {
	if (!(allowed as readonly string[]).includes(value))
		fail(`--${flag} must be one of: ${allowed.join(', ')} (got "${value}")`);
	return value as T;
}

if (positionals.length > 1)
	fail(`Takes one direction, got: ${positionals.join(' ')}`);

let target: ReturnType<typeof targetById>;
try {
	target = targetById(positionals[0] ?? 'current');
} catch (error) {
	fail((error as Error).message);
}

const hasTruecolor = ['truecolor', '24bit'].includes(
	process.env['COLORTERM'] ?? '',
);
const tier =
	values.tier === undefined
		? hasTruecolor
			? 'truecolor'
			: 'ansi'
		: oneOf('tier', values.tier, TIERS);
const theme = oneOf('theme', values.theme, THEMES);
const layout = oneOf('layout', values.layout, LAYOUTS);
const surface = oneOf('surface', values.surface, target.surfaces);
const restingFrame =
	RESTING[oneOf('frame', values.frame, Object.keys(RESTING) as Array<'still'>)];

const railWidth = /^\d+$/.test(values.width)
	? Number(values.width)
	: Number.NaN;
if (!(railWidth >= MIN_LIST_WIDTH && railWidth <= MAX_LIST_WIDTH))
	fail(
		`--width must be a whole number from ${MIN_LIST_WIDTH} to ${MAX_LIST_WIDTH}, the app's rail range (got "${values.width}")`,
	);

const staticTime =
	values.static === undefined
		? undefined
		: /^\d+(\.\d+)?$/.test(values.static)
			? Number(values.static)
			: Number.NaN;
if (staticTime !== undefined && Number.isNaN(staticTime))
	fail(`--static takes a time in ms (got "${values.static}")`);

let sceneIndex: number | undefined;
if (values.scene !== undefined) {
	sceneIndex = scenes.findIndex(scene => scene.name === values.scene);
	if (sceneIndex === -1)
		fail(
			`--scene must be one of: ${scenes.map(scene => scene.name).join(', ')} (got "${values.scene}")`,
		);
}

type State = {
	target: number;
	surface: SurfaceName;
	/** When the surface was opened, so popups play their opening. */
	surfaceStart: number;
	look: Look;
	layout: ListLayout;
	scene: number | undefined;
	sceneStart: number;
	/** j/k selection on the resting frame, with the move's start for glides. */
	selection?: {name: string; from: string; at: number};
};

/** What the command line sets; the start times come from the renderer clock. */
type Setup = Omit<State, 'surfaceStart' | 'sceneStart'>;

/** Scene time loops; every scene event is a time inside one pass. */
function sceneTime(state: State, now: number) {
	if (state.scene === undefined) return now;
	return (now - state.sceneStart) % scenes[state.scene]!.duration;
}

function frameAt(state: State, now: number): SceneFrame {
	if (state.scene !== undefined)
		return scenes[state.scene]!.at(sceneTime(state, now));
	if (!state.selection) return restingFrame;
	const {name, from, at} = state.selection;
	return {
		...restingFrame,
		selected: name,
		changes: {
			...restingFrame.changes,
			selection: {kind: 'selection', at, from},
		},
	};
}

function sizeOf(surface: SurfaceName, rows: number): [number, number] {
	return surface === 'rail'
		? [railWidth, Math.min(rows - 1, RAIL_HEIGHT)]
		: SURFACE_SIZE[surface];
}

function Preview({setup, isBench}: {setup: Setup; isBench?: boolean}) {
	const renderer = useRenderer();
	// `--static` times are absolute; live runs start everything from mount.
	const [state, setState] = useState<State>(() => {
		const start = staticTime === undefined ? renderer.clock.now() : 0;
		return {...setup, surfaceStart: start, sceneStart: start};
	});
	const [now, setNow] = useState(() => staticTime ?? renderer.clock.now());
	const {width: cols, height: rows} = useTerminalDimensions();
	const target = targets[state.target]!;
	const [width, height] = sizeOf(state.surface, rows);
	const isPopup = state.surface !== 'rail' && state.surface !== 'chrome';
	const frame = frameAt(state, now);
	const props: SurfaceProps = {
		now: isPopup ? now - state.surfaceStart : sceneTime(state, now),
		look: state.look,
		width,
		height,
		layout: state.layout,
		frame,
	};
	const fps =
		staticTime === undefined ? target.fps(state.surface, props) : undefined;
	useAnimationTick(fps, (_delta, _ticks, time) => {
		setNow(time);
	});

	// A scene's events reach the rail the way a real status change would: as
	// a render at that moment. Between events each direction gets exactly the
	// frame rate it asks for.
	const scene = state.scene === undefined ? undefined : scenes[state.scene];
	const elapsed = sceneTime(state, now);
	useEffect(() => {
		if (!scene || staticTime !== undefined) return;
		const next = [...scene.events, scene.duration].find(at => at > elapsed)!;
		const timer = setTimeout(() => {
			setNow(renderer.clock.now());
		}, next - elapsed);
		return () => {
			clearTimeout(timer);
		};
	}, [scene, elapsed, renderer]);

	useKeyboard(key => {
		if (isBench) return;
		// Ticks stop when nothing moves, so `now` can be stale by the time a key
		// arrives; anything a key starts is timed from the clock instead.
		const time = staticTime ?? renderer.clock.now();
		setNow(time);
		const update = (patch: (s: State) => Partial<State>) => {
			setState(s => ({...s, ...patch(s)}));
		};

		switch (key.name) {
			case 'q':
			case 'escape': {
				renderer.destroy();
				break;
			}

			case 'right':
			case 'left': {
				const step = key.name === 'right' ? 1 : -1;
				update(s => {
					const next = (s.target + step + targets.length) % targets.length;
					return {
						target: next,
						surface: targets[next]!.surfaces.includes(s.surface)
							? s.surface
							: 'rail',
						surfaceStart: time,
					};
				});
				break;
			}

			case 'tab': {
				update(s => {
					const available = targets[s.target]!.surfaces;
					return {
						surface:
							available[(available.indexOf(s.surface) + 1) % available.length]!,
						surfaceStart: time,
					};
				});
				break;
			}

			case 't': {
				update(s => ({
					look: {
						...s.look,
						tier: s.look.tier === 'ansi' ? 'truecolor' : 'ansi',
					},
				}));
				break;
			}

			case 'l': {
				update(s => ({
					look: {
						...s.look,
						theme: THEMES[(THEMES.indexOf(s.look.theme) + 1) % THEMES.length]!,
					},
				}));
				break;
			}

			case 'o': {
				update(s => ({
					layout: s.layout === 'single_line' ? 'two_line' : 'single_line',
				}));
				break;
			}

			case 'j':
			case 'k': {
				update(s => {
					if (s.scene !== undefined) return {};
					const names = targets[s.target]!.order(restingFrame);
					const from = s.selection?.name ?? restingFrame.selected;
					const step = key.name === 'j' ? 1 : -1;
					const name =
						names[(names.indexOf(from) + step + names.length) % names.length]!;
					return {selection: {name, from, at: time}};
				});
				break;
			}

			case 'space': {
				update(s => ({
					scene:
						s.scene === undefined
							? 0
							: s.scene + 1 < scenes.length
								? s.scene + 1
								: undefined,
					sceneStart: time,
				}));
				break;
			}

			default:
		}
	});

	const surface = target.render(state.surface, props);
	const clipped = (
		<box width={width} height={height} overflow="hidden">
			{surface}
		</box>
	);
	if (staticTime !== undefined) return clipped;
	const sceneName =
		state.scene === undefined ? 'still' : scenes[state.scene]!.name;
	const warnings = [
		cols < width || rows - 1 < height ? `⚠ needs ${width}x${height + 1}` : '',
		state.look.tier === 'truecolor' && !hasTruecolor
			? '⚠ COLORTERM unset, truecolor is quantized'
			: '',
	].filter(Boolean);
	// The current rail is the shipped component on its own timers and ANSI
	// colors, so tier, theme and fps don't apply to it.
	const look =
		target.id === 'current'
			? 'as shipped'
			: `${state.look.tier}/${state.look.theme} · ${fps ?? 0} fps`;
	// Warnings lead, so a narrow terminal cuts the labels instead.
	const status = [
		...warnings,
		target.name,
		state.surface === 'rail'
			? `rail ${railWidth}c ${state.layout === 'two_line' ? '2-line' : '1-line'}`
			: state.surface,
		look,
		sceneName,
	].join(' · ');
	return (
		<box flexDirection="column" height={rows}>
			<box height={rows - 1} alignItems="flex-start" overflow="hidden">
				{clipped}
			</box>
			<text
				fg={terminalColor()}
				attributes={textAttributes({dim: true})}
				wrapMode="none"
			>
				{`${status}   ←→ dir  tab surface  t tier  l theme  o layout  j/k select  space scene  q quit`}
			</text>
		</box>
	);
}

const setup: Setup = {
	target: targets.indexOf(target),
	surface,
	look: {tier, theme},
	layout,
	scene: sceneIndex,
};

if (values.bench) await runBench();
else await renderTui(<Preview setup={setup} />);

/**
 * CPU cost of each scene with the real renderer writing to a real terminal:
 * 10 s still (whatever ambient motion the direction asks for), then 10 s
 * per scene. Run inside tmux so output goes through a real pty.
 */
async function runBench() {
	const results: Record<string, number> = {};
	const {renderer, root} = await renderTui(<box />);
	const runFor = async (label: string, state: Setup) => {
		root.render(<Preview key={label} isBench setup={state} />);
		const start = process.cpuUsage();
		await new Promise(resolve => {
			setTimeout(resolve, 10_000);
		});
		const used = process.cpuUsage(start);
		results[label] = Math.round((used.user + used.system) / 10_000) / 10;
	};

	// Unmeasured warm-up through every phase, so JIT compilation isn't billed
	// to the phase that first runs each code path.
	for (const scene of [...scenes.keys(), undefined]) {
		root.render(
			<Preview key={`warmup-${scene}`} isBench setup={{...setup, scene}} />,
		);
		await new Promise(resolve => {
			setTimeout(resolve, 5000);
		});
	}

	// Costs keep falling for about the first minute of measuring: the first
	// phase read 10-25% above the same phase measured again at the end, and
	// one discarded phase only removed part of that. Two full passes, and the
	// second is the one reported.
	for (let pass = 0; pass < 2; pass++) {
		for (const [index, scene] of scenes.entries())
			await runFor(scene.name, {...setup, scene: index});
		await runFor('still', {...setup, scene: undefined});
	}

	root.unmount();
	renderer.destroy();
	mkdirSync('design/out', {recursive: true});
	const file = 'design/out/bench.json';
	let all: Record<string, unknown> = {};
	try {
		all = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
	} catch {}

	all[`${target.id}/${tier}`] = results;
	writeFileSync(file, JSON.stringify(all, null, 2) + '\n');
	// OpenTUI's native renderer keeps the event loop alive after destroy.
	// eslint-disable-next-line unicorn/no-process-exit
	process.exit(0);
}
