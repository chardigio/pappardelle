import path from 'node:path';
import {parseArgs} from 'node:util';
import {MAX_LIST_WIDTH, MIN_LIST_WIDTH} from '../source/layout-sizing.ts';
import {calm, still} from './fixtures.ts';
import {diffFrames, fromAnsi, renderFrame} from './kit/frame.ts';
import {cleanupOnExit, openPrivateTmux} from './kit/private-tmux.ts';
import {
	RAIL_HEIGHT,
	SURFACE_SIZE,
	type SurfaceName,
	type SurfaceProps,
} from './kit/surface.ts';
import {THEMES, TIERS} from './kit/color.ts';
import {targetById, type Target} from './directions/index.tsx';

/**
 * Proves the artifact shows what a terminal draws: renders a surface live in
 * a real tmux pane and offscreen, then compares them cell by cell.
 */
const DESIGN = import.meta.dir;
const FRAMES = {still, calm};
type FrameName = keyof typeof FRAMES;

function fail(message: string): never {
	console.error(message);
	// eslint-disable-next-line unicorn/no-process-exit
	process.exit(1);
}

function oneOf<T extends string>(
	flag: string,
	value: string,
	allowed: readonly T[],
): T {
	if (!(allowed as readonly string[]).includes(value))
		fail(`--${flag} must be one of: ${allowed.join(', ')} (got "${value}")`);
	return value as T;
}

function parse() {
	try {
		return parseArgs({
			options: {
				direction: {type: 'string', multiple: true, default: ['current']},
				surface: {type: 'string', default: 'rail'},
				tier: {type: 'string', default: 'ansi'},
				theme: {type: 'string', default: 'dark'},
				width: {type: 'string', default: '34'},
				frame: {type: 'string'},
			},
		}).values;
	} catch (error) {
		fail((error as Error).message);
	}
}

const values = parse();
const tier = oneOf('tier', values.tier, TIERS);
const theme = oneOf('theme', values.theme, THEMES);
const requestedFrame =
	values.frame === undefined
		? undefined
		: oneOf('frame', values.frame, Object.keys(FRAMES) as FrameName[]);
const targets: Target[] = [];
for (const id of values.direction) {
	try {
		targets.push(targetById(id));
	} catch (error) {
		fail((error as Error).message);
	}
}

const surface = values.surface as SurfaceName;
for (const target of targets)
	if (!target.surfaces.includes(surface))
		fail(
			`--surface must be one that ${target.id} draws: ${target.surfaces.join(', ')} (got "${values.surface}")`,
		);

const railWidth = Number(values.width);
if (
	surface === 'rail' &&
	!(
		Number.isInteger(railWidth) &&
		railWidth >= MIN_LIST_WIDTH &&
		railWidth <= MAX_LIST_WIDTH
	)
)
	fail(
		`--width must be a whole number from ${MIN_LIST_WIDTH} to ${MAX_LIST_WIDTH} (got "${values.width}")`,
	);

const [cols, rows] =
	surface === 'rail' ? [railWidth, RAIL_HEIGHT] : SURFACE_SIZE[surface];
// The preview keeps a terminal row for its status bar even with --static, so
// a rail gets one row less than its pane.
const paneRows = surface === 'rail' ? rows + 1 : rows;

/** current's spinner and blink run on the wall clock; `calm` has neither. */
const frameFor = (target: Target): FrameName =>
	requestedFrame ?? (target.id === 'current' ? 'calm' : 'still');

const tmux = openPrivateTmux('pf-');
const cleanup = cleanupOnExit(() => {
	tmux.close();
});

let failed = false;
try {
	for (const target of targets) {
		const frame = frameFor(target);
		const props: SurfaceProps = {
			now: 0,
			look: {tier, theme},
			width: cols,
			height: rows,
			layout: 'single_line',
			frame: FRAMES[frame],
		};
		const command = [
			'COLORTERM=truecolor',
			'bun',
			path.join(DESIGN, 'preview.tsx'),
			target.id,
			`--surface=${surface}`,
			...(surface === 'rail' ? [`--width=${cols}`] : []),
			`--tier=${tier}`,
			`--theme=${theme}`,
			'--static=0',
			`--frame=${frame}`,
		].join(' ');
		tmux.run(
			'new-session',
			'-d',
			'-s',
			'f',
			'-x',
			String(cols),
			'-y',
			String(paneRows),
			`cd ${path.dirname(DESIGN)} && ${command}; sleep 30`,
		);
		await new Promise(resolve => {
			setTimeout(resolve, 3000);
		});
		const live = fromAnsi(
			tmux.run('capture-pane', '-e', '-N', '-p', '-t', 'f'),
			cols,
			rows,
		);
		tmux.run('kill-session', '-t', 'f');
		const offscreen = await renderFrame(
			target.render(surface, props),
			cols,
			rows,
		);
		const diffs = diffFrames(offscreen, live);
		const note =
			requestedFrame === undefined && frame === 'calm'
				? ` (calm frame: ${target.id}'s spinner and blink run on the wall clock)`
				: ` (${frame} frame)`;
		console.log(
			`${target.id} ${surface} ${tier}/${theme} ${cols}x${rows}${note}: ${diffs.length} differing cells`,
		);
		for (const diff of diffs.slice(0, 12))
			console.log(
				`  (${diff.x},${diff.y}) offscreen=${JSON.stringify(diff.a)} live=${JSON.stringify(diff.b)}`,
			);
		if (diffs.length > 0) failed = true;
	}
} finally {
	cleanup();
}

// OpenTUI's native renderers keep the event loop alive after dispose.
// eslint-disable-next-line unicorn/no-process-exit
process.exit(failed ? 1 : 0);
