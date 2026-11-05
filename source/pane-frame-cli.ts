import {spawnSync} from 'node:child_process';
import process from 'node:process';
import {
	BoxRenderable,
	createCliRenderer,
	EmbeddedTerminalRenderable,
	type OptimizedBuffer,
} from '@opentui/core';
import {paintFrame} from './components/frame-paint.ts';
import {routeDrops} from './drop-routing.ts';
import {OscScanner} from './pane-frame-osc.ts';
import {paletteSequences} from './pane-frame-palette.ts';
import {CLIENT_TTY_OPTION, PANE_TITLE_OPTION} from './pane-frame-options.ts';

// Draws a rounded, titled frame in a viewer pane and runs the pane's command
// (a nested `tmux attach`, or a message) inside it. tmux can only draw the
// dividers between panes, so the frame has to come from the pane itself.

const args = process.argv.slice(2);
const separator = args.indexOf('--');
const command = args.slice(separator + 1);
const titleFlag = args.indexOf('--title');
const outerSocket = (process.env['TMUX'] ?? '').split(',')[0] ?? '';
const paneId = process.env['TMUX_PANE'] ?? '';

function outerTmux(tmuxArgs: string[]): string {
	if (!outerSocket || !paneId) return '';
	const result = spawnSync('tmux', ['-S', outerSocket, ...tmuxArgs], {
		encoding: 'utf8',
	});
	return result.status === 0 ? result.stdout.trim() : '';
}

let title =
	titleFlag !== -1 && titleFlag < separator
		? (args[titleFlag + 1] ?? '')
		: outerTmux([
				'display-message',
				'-p',
				'-t',
				paneId,
				`#{${PANE_TITLE_OPTION}}`,
			]);
let isActive =
	outerTmux(['display-message', '-p', '-t', paneId, '#{pane_active}']) === '1';

const renderer = await createCliRenderer({exitOnCtrlC: false, exitSignals: []});
const frame = new BoxRenderable(renderer, {
	id: 'frame',
	width: '100%',
	height: '100%',
	border: true,
	borderStyle: 'rounded',
	renderAfter(this: BoxRenderable, buffer: OptimizedBuffer) {
		paintFrame(this, buffer, {
			title,
			style: 'rounded',
			isDim: !isActive,
			inset: 1,
		});
	},
});
renderer.root.add(frame);

// Filled once the child starts; the terminal's callbacks need it first.
const childPty: {current?: Bun.Terminal} = {};
const terminal = new EmbeddedTerminalRenderable(renderer, {
	id: 'terminal',
	width: '100%',
	height: '100%',
	maxScrollback: 0,
	transparentBackground: true,
	selectable: false,
	onData(data) {
		childPty.current?.write(data);
	},
	onTerminalResize(cols, rows) {
		childPty.current?.resize(cols, rows);
	},
});
frame.add(terminal);
terminal.focus();

renderer.on('focus', () => {
	isActive = true;
	renderer.requestRender();
});
renderer.on('blur', () => {
	isActive = false;
	renderer.requestRender();
});
if (outerSocket && paneId)
	routeDrops(renderer, {socket: outerSocket, paneId, isFocused: isActive});

// Loaded before the child starts so its first output is already in the
// user's colors, and again whenever the terminal switches theme.
const palette = await renderer.getPalette({timeout: 500}).catch(() => null);
if (palette) terminal.write(paletteSequences(palette));
renderer.on('palette', (colors: Parameters<typeof paletteSequences>[0]) => {
	terminal.write(paletteSequences(colors));
	terminal.invalidate();
	renderer.requestRender();
});

const scanner = new OscScanner();
const childEnv: Record<string, string | undefined> = {
	...process.env,
	TERM: 'xterm-256color',
	COLORTERM: 'truecolor',
};
delete childEnv['TMUX'];
delete childEnv['TMUX_PANE'];

// The rail moves this pane's nested tmux client between sessions by its tty,
// which only the child can see, so the child publishes it before starting.
const child = Bun.spawn(
	[
		'/bin/sh',
		'-c',
		'[ -n "$1" ] && tmux -S "$1" set-option -p -t "$2" "$3" "$(tty)" 2>/dev/null; shift 3; exec "$@"',
		'sh',
		outerSocket,
		paneId,
		CLIENT_TTY_OPTION,
		...command,
	],
	{
		env: childEnv,
		terminal: {
			cols: Math.max(1, renderer.width - 2),
			rows: Math.max(1, renderer.height - 2),
			data(_terminal, data) {
				const events = scanner.feed(data);
				if (events.title !== undefined && events.title !== title) {
					title = events.title;
					renderer.requestRender();
				}

				for (const sequence of events.passthrough)
					process.stdout.write(sequence);
				terminal.write(data);
			},
		},
	},
);

// The child runs in its own pty, so closing or respawning the pane signals
// only this process. Without passing it on, the nested client would keep this
// process waiting forever.
for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT'] as const) {
	process.on(signal, () => {
		child.kill(signal);
		renderer.destroy();
		process.exit(0);
	});
}

childPty.current = child.terminal;
process.exitCode = await child.exited;
renderer.destroy();
