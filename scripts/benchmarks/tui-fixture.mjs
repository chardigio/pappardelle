// Copied temporarily into each checkout by benchmark.py so dependencies resolve
// against that checkout. Both variants render its actual built SpaceListItem.
import React, {useEffect, useLayoutEffect, useState} from 'react';
import {appendFileSync, writeFileSync} from 'node:fs';
import SpaceListItem from './dist/components/SpaceListItem.js';

const native = process.env.BENCH_FRAMEWORK === 'opentui';
const output = process.env.BENCH_RESULT;
const core = native ? await import('@opentui/core') : null;
const framework = await import(native ? '@opentui/react' : 'ink');
const Box = native ? 'box' : framework.Box;
const Text = native ? 'text' : framework.Text;
let phase = 'startup';
let inputAt = null;
let inputFrame = null;
let committedFrame = 0;
let firstFrame = null;
let activeFrames = 0;
const latencies = [];
const phaseCpu = {};
let phaseStarted = performance.now();
let cpuStarted = process.cpuUsage();
let renderer;
let ink;
function recordFrame() {
	if (!firstFrame) {
		firstFrame = Date.now();
		appendFileSync(output, JSON.stringify({firstFrame}) + '\n');
	}
	if (phase === 'saturation') activeFrames++;
	if (phase === 'input' && inputAt !== null && committedFrame >= inputFrame) {
		latencies.push(performance.now() - inputAt);
		inputAt = null;
	}
}
function changePhase(next) {
	const usage = process.cpuUsage(cpuStarted);
	phaseCpu[phase] = {
		wallMs: performance.now() - phaseStarted,
		cpuMs: (usage.user + usage.system) / 1000,
	};
	phase = next;
	phaseStarted = performance.now();
	cpuStarted = process.cpuUsage();
	appendFileSync(output, JSON.stringify({phase}) + '\n');
}
const spaces = Array.from({length: 20}, (_, i) => ({
	name: 'BENCH-' + String(i + 1).padStart(2, '0'),
	worktreePath: null,
	profileEmoji: i % 2 ? '🍝' : '⚙️',
	programStatus: {status: 'idle'},
	linearIssue: {
		identifier: 'BENCH-' + (i + 1),
		title: 'Preserve workspace selection, status and title',
		state: {name: 'Open', type: 'unstarted', color: '#4ea7fc'},
	},
	railStatus: {
		pipeline: 'passing',
		unresolvedCommentCount: 3,
		hasConflict: false,
	},
}));
function App() {
	const [frame, setFrame] = useState(0);
	const handle = name => {
		if (name !== 'j' || phase !== 'input') return;
		inputAt = performance.now();
		inputFrame = frame + 1;
		setFrame(value => value + 1);
	};
	if (native) framework.useKeyboard(key => handle(key.name));
	else framework.useInput(input => handle(input));
	useLayoutEffect(() => {
		committedFrame = frame;
	}, [frame]);
	useEffect(() => {
		let interval;
		const timers = [
			setTimeout(() => changePhase('idle'), 200),
			setTimeout(() => {
				changePhase('saturation');
				interval = setInterval(() => setFrame(value => value + 1), 1000 / 120);
			}, 1200),
			setTimeout(() => {
				clearInterval(interval);
				changePhase('input');
			}, 3200),
			setTimeout(async () => {
				changePhase('done');
				const summary = {
					firstFrame,
					activeFrames,
					phaseCpu,
					latencies,
					maxRssKb: process.resourceUsage().maxRSS,
				};
				appendFileSync(output, JSON.stringify({summary}) + '\n');
				if (renderer) {
					renderer.destroy();
					await renderer.closed;
				} else {
					ink.unmount();
					await ink.waitUntilExit();
				}
				process.exit(0);
			}, 5300),
		];
		return () => {
			clearInterval(interval);
			timers.forEach(clearTimeout);
		};
	}, []);
	return React.createElement(
		Box,
		{flexDirection: 'column', width: 80, height: 30},
		React.createElement(Text, null, 'Pappardelle benchmark ' + frame),
		...spaces.map((space, i) =>
			React.createElement(SpaceListItem, {
				key: space.name,
				space,
				isSelected: frame % spaces.length === i,
				width: 80,
				layout: 'single_line',
			}),
		),
	);
}
writeFileSync(output, '');
if (native) {
	renderer = await core.createCliRenderer({
		targetFps: 60,
		maxFps: 60,
		screenMode: 'alternate-screen',
		consoleMode: 'disabled',
		externalOutputMode: 'passthrough',
		useMouse: false,
	});
	renderer.on('frame', recordFrame);
	framework.createRoot(renderer).render(React.createElement(App));
} else {
	process.stdout.write('\x1b[?1049h');
	ink = framework.render(React.createElement(App), {
		incrementalRendering: true,
		patchConsole: false,
		onRender: recordFrame,
	});
}
