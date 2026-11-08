import type {WidthMethod} from '@opentui/core';
import {useRenderer} from '@opentui/react';
import {useCallback, useSyncExternalStore} from 'react';

/**
 * The renderer's width method, which can change once the terminal answers the
 * mode 2027 query, re-rendering the caller when it does.
 */
export function useWidthMethod(): WidthMethod {
	const renderer = useRenderer();
	const subscribe = useCallback(
		(listener: () => void) => {
			renderer.on('capabilities', listener);
			return () => {
				renderer.off('capabilities', listener);
			};
		},
		[renderer],
	);
	return useSyncExternalStore(subscribe, () => renderer.widthMethod);
}
