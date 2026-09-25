import {useSyncExternalStore} from 'react';

export function createAnimationClock(intervalMs: number) {
	const listeners = new Set<() => void>();
	let frame = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	return {
		getSnapshot: () => frame,
		subscribe(listener: () => void) {
			listeners.add(listener);
			timer ??= setInterval(() => {
				frame++;
				for (const notify of listeners) notify();
			}, intervalMs);
			return () => {
				listeners.delete(listener);
				if (listeners.size === 0) {
					clearInterval(timer);
					timer = undefined;
					frame = 0;
				}
			};
		},
	};
}

const spinnerClock = createAnimationClock(150);
const attentionClock = createAnimationClock(500);
const subscribeIdle = () => () => {};
const idleSnapshot = () => 0;

export function useSpinnerFrame(): number {
	return useSyncExternalStore(spinnerClock.subscribe, spinnerClock.getSnapshot);
}

export function useAttentionFrame(enabled: boolean): number {
	return useSyncExternalStore(
		enabled ? attentionClock.subscribe : subscribeIdle,
		enabled ? attentionClock.getSnapshot : idleSnapshot,
	);
}
