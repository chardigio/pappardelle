/**
 * useMouse hook — enables SGR mouse tracking and fires a callback on click.
 *
 * Terminal mouse reporting works by:
 * 1. Sending escape sequences to enable mouse tracking (SGR mode 1006)
 * 2. The terminal encodes clicks as escape sequences in stdin
 * 3. We parse those sequences to extract button + coordinates
 *
 * SGR format: ESC [ < button ; col ; row M (press) or m (release)
 * We only care about press events (M suffix) with button 0 (left click).
 * Coordinates are 1-based.
 */

import {useEffect} from 'react';

export interface MouseEvent {
	/** 0-based column */
	x: number;
	/** 0-based row */
	y: number;
	button: 'left' | 'right' | 'middle' | 'scrollUp' | 'scrollDown';
}

type MouseCallback = (event: MouseEvent) => void;

// SGR mouse sequence regex: ESC [ < button ; col ; row M/m
const SGR_MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

function parseButton(
	code: number,
): 'left' | 'right' | 'middle' | 'scrollUp' | 'scrollDown' | null {
	// Low 2 bits encode button, bit 6 (64) marks scroll events
	const base = code & 0x03;
	const isScroll = (code & 64) !== 0;

	if (isScroll) {
		return base === 0 ? 'scrollUp' : 'scrollDown';
	}

	switch (base) {
		case 0:
			return 'left';
		case 1:
			return 'middle';
		case 2:
			return 'right';
		default:
			return null;
	}
}

/**
 * Enable SGR mouse tracking and call `onMouse` on click events.
 *
 * @param onMouse - Callback for mouse press events
 * @param isActive - Whether mouse tracking is active (disabled during dialogs)
 */
export function useMouse(onMouse: MouseCallback, isActive = true): void {
	useEffect(() => {
		if (!isActive) return;

		const {stdin} = process;
		if (!stdin || !stdin.setRawMode) return;

		// Enable basic mouse press/release (1000) + SGR extended coordinates (1006)
		// 1006 = SGR format (supports coordinates > 223)
		process.stdout.write('\x1b[?1000h'); // Enable basic mouse press/release
		process.stdout.write('\x1b[?1006h'); // Enable SGR extended coordinates

		const handleData = (data: Buffer) => {
			const str = data.toString('utf8');

			// Reset lastIndex for global regex
			SGR_MOUSE_RE.lastIndex = 0;

			let match;
			while ((match = SGR_MOUSE_RE.exec(str)) !== null) {
				const buttonCode = parseInt(match[1]!, 10);
				const col = parseInt(match[2]!, 10);
				const row = parseInt(match[3]!, 10);
				const isPress = match[4] === 'M';

				// Only fire on press, not release
				if (!isPress) continue;

				const button = parseButton(buttonCode);
				if (!button) continue;

				onMouse({
					x: col - 1, // Convert to 0-based
					y: row - 1,
					button,
				});
			}
		};

		stdin.on('data', handleData);

		return () => {
			stdin.off('data', handleData);
			// Disable mouse tracking
			process.stdout.write('\x1b[?1006l');
			process.stdout.write('\x1b[?1000l');
		};
	}, [onMouse, isActive]);
}
