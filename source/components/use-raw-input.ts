import {useEffect, useRef} from 'react';
import type {Buffer} from 'node:buffer';
import {useStdin} from 'ink';
import {parseRawKey, type RawKey} from './parse-raw-key.ts';

/**
 * Drop-in replacement for Ink's `useInput` that parses raw stdin via our own
 * `parseRawKey`. Exists so the TextInput component can distinguish the Mac
 * Delete/Backspace key (`\x7f`) from fn+Delete (`\x1b[3~`) — Ink 4.x's
 * `parseKeypress` names both `'delete'`, which silently broke regular delete
 * after STA-1131 (see STA-1145).
 *
 * We listen to the same `internal_eventEmitter('input', ...)` channel Ink's
 * own hook uses, so behavior matches in every respect except the
 * backspace/delete classification.
 *
 * Verified against ink@^4.1.0. The `internal_*` fields are Ink's private API
 * (the prefix is Ink's own convention) — audit this hook after any `ink`
 * version bump. The runtime assertion below turns a silent misfire into a
 * loud startup error if those internals disappear or get renamed.
 */
type StdinHandle = {
	stdin: NodeJS.ReadStream;
	setRawMode: (value: boolean) => void;
	internal_exitOnCtrlC: boolean;
	internal_eventEmitter: NodeJS.EventEmitter;
};

export function useRawInput(
	handler: (input: string, key: RawKey) => void,
	options?: {isActive: boolean},
): void {
	const isActive = options?.isActive ?? true;
	const stdinCtx = useStdin() as unknown as StdinHandle;
	if (!('internal_eventEmitter' in stdinCtx)) {
		throw new Error(
			'useRawInput: ink useStdin() did not expose internal_eventEmitter. ' +
				'This hook depends on Ink private API (verified against ink@^4.1.0) — ' +
				'check the installed Ink version after a dep bump.',
		);
	}
	const {setRawMode, internal_exitOnCtrlC, internal_eventEmitter} = stdinCtx;

	// Hold the caller's handler in a ref so the listener-attach effect's
	// dependency array can stay stable. Without this, each parent render
	// passes a fresh inline closure and we'd tear down + re-register the
	// stdin listener every render (semantically wrong, and in principle
	// drops keypresses that arrive in the window between removeListener
	// and the next on()). Same pattern Ink's own useInput uses internally
	// and what React's docs recommend for event-listener hooks.
	const handlerRef = useRef(handler);
	useEffect(() => {
		handlerRef.current = handler;
	}, [handler]);

	useEffect(() => {
		if (!isActive) {
			return;
		}
		setRawMode(true);
		return () => {
			setRawMode(false);
		};
	}, [isActive, setRawMode]);

	useEffect(() => {
		if (!isActive) {
			return;
		}
		const handleData = (data: string | Buffer) => {
			const {input, key} = parseRawKey(
				typeof data === 'string' ? data : data.toString(),
			);
			// Mirror Ink's exit-on-Ctrl+C escape hatch so this hook stays a
			// safe drop-in.
			if (input === 'c' && key.ctrl && internal_exitOnCtrlC) {
				return;
			}
			handlerRef.current(input, key);
		};
		internal_eventEmitter.on('input', handleData);
		return () => {
			internal_eventEmitter.removeListener('input', handleData);
		};
	}, [isActive, internal_exitOnCtrlC, internal_eventEmitter]);
}
