import {existsSync, readFileSync, renameSync, rmSync} from 'node:fs';
import path from 'node:path';
import {cleanupOnExit, openPrivateTmux} from './kit/private-tmux.ts';
import {targets} from './directions/index.tsx';

/**
 * Runs `preview.tsx --bench` for every direction and tier inside a real tmux
 * pane, one after another so runs don't compete for CPU. Each run adds its
 * numbers to design/out/bench.json. Takes about 50 s per run.
 *
 * The page must never mix numbers from different passes, so the previous
 * bench.json is set aside first and only comes back if a run fails.
 */
const DESIGN = import.meta.dir;
const BENCH = path.join(DESIGN, 'out/bench.json');
const PREVIOUS = `${BENCH}.previous`;

const runs = targets.flatMap(target =>
	target.id === 'current'
		? [{id: target.id, tier: 'ansi'}]
		: [
				{id: target.id, tier: 'ansi'},
				{id: target.id, tier: 'truecolor'},
			],
);

const tmux = openPrivateTmux('pb-');
const status = path.join(tmux.dir, 'status');
if (existsSync(BENCH)) renameSync(BENCH, PREVIOUS);
let isComplete = false;
const cleanup = cleanupOnExit(() => {
	// Kill the panes first, so no run writes bench.json after it's restored.
	tmux.close();
	if (isComplete) {
		rmSync(PREVIOUS, {force: true});
		return;
	}

	rmSync(BENCH, {force: true});
	if (existsSync(PREVIOUS)) renameSync(PREVIOUS, BENCH);
	console.error('design/out/bench.json is unchanged');
});

async function bench(run: {id: string; tier: string}) {
	tmux.run(
		'new-session',
		'-d',
		'-s',
		'b',
		'-x',
		'120',
		'-y',
		'34',
		`cd ${path.dirname(DESIGN)} && COLORTERM=truecolor bun ${path.join(DESIGN, 'preview.tsx')} ${run.id} --tier=${run.tier} --bench; echo $? > ${status}.tmp; mv ${status}.tmp ${status}; sleep 60`,
	);
	while (!existsSync(status))
		await new Promise(resolve => {
			setTimeout(resolve, 250);
		});

	const code = Number(readFileSync(status, 'utf8'));
	rmSync(status);
	const screen = tmux.run('capture-pane', '-p', '-t', 'b').trimEnd();
	tmux.run('kill-session', '-t', 'b');
	if (code !== 0)
		throw new Error(`${run.id}/${run.tier} exited ${code}:\n${screen}`);

	const results = existsSync(BENCH)
		? (JSON.parse(readFileSync(BENCH, 'utf8')) as Record<string, unknown>)
		: {};
	if (!(`${run.id}/${run.tier}` in results))
		throw new Error(
			`${run.id}/${run.tier} exited 0 but wrote no results to ${BENCH}`,
		);
}

try {
	for (const run of runs) {
		await bench(run);
		console.log(`${run.id}/${run.tier} done`);
	}

	isComplete = true;
} catch (error) {
	console.error((error as Error).message);
	process.exitCode = 1;
} finally {
	cleanup();
}
