import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import type {Span} from './kit/frame.ts';

/**
 * Builds the publishable page: the template with the frame player bundled in
 * and the frames the template shows, gzipped into the page. Run export.ts and
 * bench.ts first.
 */
const DESIGN = import.meta.dir;
const OUT = path.join(DESIGN, 'out');
const PAGE = path.join(OUT, 'pappardelle-tui-directions.html');
const LIMIT = 12 * 1024 * 1024;

type Stored = {cols: number; rows: number; lines: number[]};
type Sequence = {cols: number; rows: number; fps: number; frames: number[][]};
type Exported = {
	meta: {
		directions: Array<{id: string; tmuxConf: string}>;
		scenes: Array<{name: string; title: string; caption: string}>;
	};
	rows: Span[][];
	frames: Record<string, Stored>;
	sequences: Record<string, Sequence>;
};

function fail(message: string): never {
	console.error(message);
	// eslint-disable-next-line unicorn/no-process-exit
	process.exit(1);
}

function readOutput(name: string, script: string) {
	const file = path.join(OUT, name);
	if (!existsSync(file))
		fail(`design/out/${name} is missing; run bun design/${script}`);
	return readFileSync(file, 'utf8');
}

const data = JSON.parse(readOutput('frames.json', 'export.ts')) as Exported;
const bench = JSON.parse(readOutput('bench.json', 'bench.ts')) as Record<
	string,
	Record<string, number>
>;

const escapeHtml = (text: string) =>
	text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

let page = readFileSync(path.join(DESIGN, 'artifact/template.html'), 'utf8');
const controls = (label: string) =>
	`<div class="controls"><button type="button" class="play">Play</button><input type="range" min="0" value="0" aria-label="Scrub ${escapeHtml(label)}"><span class="clock"></span></div>`;
page = page.replaceAll(/<!-- scenes:([\w-]+) -->/g, (_, id: string) =>
	data.meta.scenes
		.map(
			scene =>
				`<figure class="player" data-sequence="${id}/scene/${scene.name}/{variant}" data-autoplay><h3>${escapeHtml(scene.title)}</h3><div class="screen"></div>${controls(scene.title)}<figcaption>${escapeHtml(scene.caption)}</figcaption></figure>`,
		)
		.join('\n'),
);
page = page.replaceAll(/\{\{tmux:([\w-]+)\}\}/g, (_, id: string) => {
	const direction = data.meta.directions.find(d => d.id === id);
	if (!direction) throw new Error(`No direction ${id}`);
	return escapeHtml(direction.tmuxConf);
});
page = page.replaceAll(
	/\{\{cpu:([\w-]+\/\w+):(\w+)\}\}/g,
	(_, run: string, label: string) => {
		const value = bench[run]?.[label];
		if (value === undefined)
			throw new Error(`No bench result ${run} ${label}; run design/bench.ts`);
		return `${value.toFixed(1)}%`;
	},
);

// The player resolves `{variant}`, `{width}` and `{layout}` in these keys
// from the toolbar, so the page needs every value its buttons can pick.
const referenced = {frame: new Set<string>(), sequence: new Set<string>()};
const toolbar = {
	theme: [] as string[],
	tier: [] as string[],
	width: [] as string[],
	layout: [] as string[],
};
const rewriter = new HTMLRewriter();
for (const kind of ['frame', 'sequence'] as const)
	rewriter.on(`[data-${kind}]`, {
		element(element) {
			referenced[kind].add(element.getAttribute(`data-${kind}`)!);
		},
	});
for (const [control, values] of Object.entries(toolbar))
	rewriter.on(`[data-control="${control}"] button[value]`, {
		element(element) {
			values.push(element.getAttribute('value')!);
		},
	});
await rewriter.transform(new Response(page)).text();

const variants = toolbar.tier.flatMap(tier =>
	tier === 'ansi' ? [tier] : toolbar.theme.map(theme => `${tier}-${theme}`),
);
const placeholders: Array<[string, string[]]> = [
	['{variant}', variants],
	['{width}', toolbar.width],
	['{layout}', toolbar.layout],
];
function expand(key: string) {
	let keys = [key];
	for (const [placeholder, values] of placeholders)
		keys = keys.flatMap(k =>
			k.includes(placeholder)
				? values.map(value => k.replaceAll(placeholder, value))
				: [k],
		);
	return keys;
}

const rows: Span[][] = [];
const rowIds = new Map<number, number>();
const remap = (lines: number[]) =>
	lines.map(id => {
		let next = rowIds.get(id);
		if (next === undefined) {
			next = rows.length;
			rows.push(data.rows[id]!);
			rowIds.set(id, next);
		}

		return next;
	});

const frames: Record<string, Stored> = {};
const sequences: Record<string, Sequence> = {};
const missing: string[] = [];
for (const key of [...referenced.frame].flatMap(k => expand(k))) {
	const frame = data.frames[key];
	if (frame) frames[key] = {...frame, lines: remap(frame.lines)};
	else missing.push(key);
}

for (const key of [...referenced.sequence].flatMap(k => expand(k))) {
	const sequence = data.sequences[key];
	if (sequence)
		sequences[key] = {
			...sequence,
			frames: sequence.frames.map(lines => remap(lines)),
		};
	else missing.push(key);
}

if (missing.length > 0)
	fail(
		`The template shows frames design/out/frames.json doesn't have; run bun design/export.ts:\n  ${missing.join('\n  ')}`,
	);

const build = await Bun.build({
	entrypoints: [path.join(DESIGN, 'artifact/player.ts')],
	target: 'browser',
	format: 'iife',
	minify: true,
});
if (!build.success)
	throw new AggregateError(build.logs, 'player bundle failed');
const player = await build.outputs[0]!.text();

const embedded = gzipSync(JSON.stringify({rows, frames, sequences}), {
	level: 9,
}).toString('base64');
page = page
	.replace(
		'<!-- frames -->',
		`<script type="application/octet-stream" id="frames">${embedded}</script>`,
	)
	.replace(
		'<!-- player -->',
		`<script>${player.replaceAll('</script', '<\\/script')}</script>`,
	);

if (page.length > LIMIT)
	throw new Error(
		`Page is ${(page.length / 1e6).toFixed(1)} MB; the cap is ${LIMIT / 1e6} MB`,
	);
writeFileSync(PAGE, page);
console.log(
	`${path.relative(path.dirname(DESIGN), PAGE)} ${(page.length / 1e6).toFixed(2)} MB: ${Object.keys(frames).length}/${Object.keys(data.frames).length} frames, ${Object.keys(sequences).length}/${Object.keys(data.sequences).length} sequences, ${rows.length}/${data.rows.length} rows`,
);
