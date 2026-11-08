// Main-thread cost of logging at the peak volume seen in real logs: a status
// poll plus relayout writes ~250 debug lines of ~120 bytes within a frame.
// Prints one JSON sample. Compare loggers by alternating runs, e.g. against the
// base branch's copy: git show <base>:source/logger.ts > /some/dir/logger.ts
// Usage: bun scripts/benchmarks/logger-cost.ts <path/to/logger.ts>
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {setTimeout as sleep} from 'node:timers/promises';

const BURSTS = 20;
const LINES_PER_BURST = 250;
const FRAME_MS = 16;

async function measure(loggerPath: string) {
	const {createLogger} = (await import(loggerPath)) as {
		createLogger: (component: string) => {debug: (message: string) => void};
	};
	const log = createLogger('bench');
	const padding = 'x'.repeat(80);

	const delay = monitorEventLoopDelay({resolution: 1});
	delay.enable();
	const burstMs: number[] = [];
	for (let burst = 0; burst < BURSTS; burst++) {
		const start = performance.now();
		for (let line = 0; line < LINES_PER_BURST; line++) {
			log.debug(`burst ${burst} line ${line} ${padding}`);
		}

		burstMs.push(performance.now() - start);
		await sleep(FRAME_MS);
	}

	delay.disable();
	await sleep(500);

	const logDir = path.join(homedir(), '.pappardelle', 'logs');
	const written = readdirSync(logDir)
		.map(file => readFileSync(path.join(logDir, file), 'utf8'))
		.join('')
		.split('\n')
		.filter(line => line.includes('[bench]')).length;

	const sorted = [...burstMs].sort((a, b) => a - b);
	const at = (fraction: number) =>
		sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
	console.log(
		JSON.stringify({
			logger: loggerPath,
			linesWritten: written,
			linesExpected: BURSTS * LINES_PER_BURST,
			burstMs: {median: at(0.5), p95: at(0.95), max: sorted.at(-1)},
			eventLoopDelayMs: {
				p99: delay.percentile(99) / 1e6,
				max: delay.max / 1e6,
			},
		}),
	);
}

// Bun reads HOME once at startup, so the logger only lands in a scratch HOME
// when the measurement runs in a child spawned with it. /tmp is often tmpfs,
// which would hide the cost of synchronous disk writes, so stay on ~.
function measureInScratchHome(loggerPath: string) {
	const home = mkdtempSync(
		path.join(homedir(), '.cache', 'pappardelle-logger-bench-'),
	);
	try {
		const child = spawnSync(
			process.execPath,
			[import.meta.filename, loggerPath, '--measure'],
			{env: {...process.env, HOME: home}, stdio: 'inherit'},
		);
		process.exitCode = child.status ?? 1;
	} finally {
		rmSync(home, {recursive: true, force: true});
	}
}

const [loggerPath, mode] = process.argv.slice(2);
if (!loggerPath) throw new Error('Usage: logger-cost.ts <logger module>');
if (mode === '--measure') await measure(loggerPath);
else measureInScratchHome(path.resolve(loggerPath));
