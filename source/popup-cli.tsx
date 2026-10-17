#!/usr/bin/env node
import React from 'react';
import {connect} from 'node:net';
import {render} from 'ink';
import {captureStderr, setStderrTerminalPassthrough} from './logger.ts';
import PopupRoot, {type PopupChannel} from './components/PopupRoot.tsx';
import {createNormalizingStdin} from './components/kitty-keyboard.ts';
import {
	createMessageDecoder,
	encodeMessage,
	type HostMessage,
} from './popup/protocol.ts';
import {bootstrapRepo} from './repo-bootstrap.ts';

// Runs inside `tmux display-popup`, launched by the TUI's openPopup with the
// socket path to report back on.
captureStderr();
setStderrTerminalPassthrough(false);

const socketPath = process.argv[2];
if (!socketPath) {
	console.error('Usage: popup-cli <socket>');
	process.exit(2);
}

const socket = connect(socketPath);
const listeners = new Set<(message: HostMessage) => void>();
let started = false;

const exit = (code: number) => {
	socket.end();
	process.exit(code);
};

socket.on('error', () => {
	exit(1);
});
socket.on('close', () => {
	exit(started ? 0 : 1);
});

const channel: PopupChannel = {
	send(message) {
		socket.write(encodeMessage(message));
	},
	onMessage(listener) {
		listeners.add(listener);
		return () => listeners.delete(listener);
	},
};

function start(message: Extract<HostMessage, {type: 'init'}>) {
	started = true;
	// tmux starts the popup with its server's global environment, which can
	// hold variables the TUI doesn't have (another space's repo root, say).
	for (const key of Object.keys(process.env)) {
		if (!(key in message.env)) Reflect.deleteProperty(process.env, key);
	}

	Object.assign(process.env, message.env);
	process.chdir(message.cwd);
	bootstrapRepo();

	const {type: _type, env: _env, cwd: _cwd, ...spec} = message;
	const stdin = process.stdin.isTTY
		? createNormalizingStdin(process.stdin)
		: process.stdin;
	const app = render(
		<PopupRoot
			spec={spec}
			channel={channel}
			width={process.stdout.columns ?? 80}
			height={process.stdout.rows ?? 24}
			onExit={() => {
				exit(0);
			}}
		/>,
		{stdin},
	);
	// Ink unmounts itself on Ctrl+C, but the open socket would keep this
	// process, and so the popup, alive. Treat it as a cancel.
	void app.waitUntilExit().then(() => {
		channel.send({type: 'cancel'});
		exit(0);
	});
}

socket.on(
	'data',
	createMessageDecoder<HostMessage>(message => {
		if (message.type === 'init') {
			if (!started) start(message);
			return;
		}

		for (const listener of listeners) listener(message);
	}),
);
