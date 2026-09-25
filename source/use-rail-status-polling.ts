import {useEffect, useRef} from 'react';
import {RAIL_STATUS_POLL_INTERVAL_MS} from './rail-status.ts';

export function useRailStatusPolling(
	enabled: boolean,
	poll: () => Promise<void>,
): void {
	const pollRef = useRef(poll);
	pollRef.current = poll;
	const inFlight = useRef(false);

	useEffect(() => {
		if (!enabled) return;
		const tick = async () => {
			if (inFlight.current) return;
			inFlight.current = true;
			try {
				await pollRef.current();
			} finally {
				inFlight.current = false;
			}
		};

		// Loading workspaces can take longer than a startup timer, so readiness
		// drives the first request; ordinary renders must not restart polling.
		void tick();
		const interval = setInterval(tick, RAIL_STATUS_POLL_INTERVAL_MS);
		return () => clearInterval(interval);
	}, [enabled]);
}
