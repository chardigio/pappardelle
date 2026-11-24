import {useSyncExternalStore} from 'react';
import type {CliRenderer} from '@opentui/core';
import {flushSync, useRenderer} from '@opentui/react';

type Clock = {
	getSnapshot(): number;
	subscribe(listener: () => void): () => void;
};

function animationFrames(intervalMs: number) {
	const fps = 1000 / intervalMs;
	const clocks = new WeakMap<CliRenderer, Clock>();
	function createClock(renderer: CliRenderer): Clock {
		const listeners = new Set<() => void>();
		let frame = 0;
		let stop: (() => void) | undefined;
		return {
			getSnapshot: () => frame,
			subscribe(listener) {
				listeners.add(listener);
				stop ??= renderer.onAnimationTick(
					fps,
					(deltaTime, ticks) => {
						// Ticks fall on the renderer clock's boundaries, not on when the
						// animation started, so the first can come moments later and
						// cut a new blink's "on" short.
						if (frame === 0 && deltaTime < intervalMs / 2) return;
						frame += ticks;
						flushSync(() => {
							for (const notify of listeners) notify();
						});
					},
					// Without it the slower blink runs early on spinner frames, and its
					// phases alternate between 450 and 600 ms.
					{tolerance: 0},
				);
				return () => {
					listeners.delete(listener);
					if (listeners.size === 0) {
						stop?.();
						stop = undefined;
						frame = 0;
					}
				};
			},
		};
	}

	return (renderer: CliRenderer) => {
		let clock = clocks.get(renderer);
		if (!clock) {
			clock = createClock(renderer);
			clocks.set(renderer, clock);
		}

		return clock;
	};
}

const spinnerClock = animationFrames(150);
const attentionClock = animationFrames(500);
const subscribeIdle = () => () => {};
const idleSnapshot = () => 0;

export function useSpinnerFrame(): number {
	const clock = spinnerClock(useRenderer());
	return useSyncExternalStore(clock.subscribe, clock.getSnapshot);
}

export function useAttentionFrame(enabled: boolean): number {
	const clock = attentionClock(useRenderer());
	return useSyncExternalStore(
		enabled ? clock.subscribe : subscribeIdle,
		enabled ? clock.getSnapshot : idleSnapshot,
	);
}
