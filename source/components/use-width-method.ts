import type {CliRenderer, WidthMethod} from '@opentui/core';
import {useRenderer} from '@opentui/react';
import {useCallback, useSyncExternalStore} from 'react';

// Every rail row reads the width method, so the rows share one renderer
// listener rather than tripping Node's per-emitter listener warning.
const subscribers = new WeakMap<CliRenderer, Set<() => void>>();

function subscribe(renderer: CliRenderer, listener: () => void) {
	let listeners = subscribers.get(renderer);
	if (!listeners) {
		const shared = new Set<() => void>();
		listeners = shared;
		subscribers.set(renderer, shared);
		renderer.on('capabilities', () => {
			for (const notify of shared) notify();
		});
	}

	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * The renderer's width method, which can change once the terminal answers the
 * mode 2027 query, re-rendering the caller when it does.
 */
export function useWidthMethod(): WidthMethod {
	const renderer = useRenderer();
	const subscribeToRenderer = useCallback(
		(listener: () => void) => subscribe(renderer, listener),
		[renderer],
	);
	return useSyncExternalStore(subscribeToRenderer, () => renderer.widthMethod);
}
