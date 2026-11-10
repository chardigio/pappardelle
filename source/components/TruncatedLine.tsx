import type {BoxRenderable, ColorInput} from '@opentui/core';
import {useRef, useState} from 'react';
import {terminalColor} from '../tui-style.ts';
import {truncateRunsToWidth} from '../truncate-to-width.ts';
import {useWidthMethod} from './use-width-method.ts';

export type Run = {text: string; fg?: ColorInput; attributes?: number};

/**
 * One row that fills its parent's width and ends in '…' when the text does not
 * fit. OpenTUI's own `truncate` cuts from the middle with '...', so the row is
 * measured and cut here.
 */
export default function TruncatedLine({runs}: {runs: Run[]}) {
	const box = useRef<BoxRenderable>(null);
	const [width, setWidth] = useState<number>();
	const widthMethod = useWidthMethod();
	const shown =
		width === undefined ? runs : truncateRunsToWidth(runs, width, widthMethod);
	return (
		<box
			ref={box}
			flexDirection="row"
			width="100%"
			height={1}
			overflow="hidden"
			onSizeChange={() => {
				if (box.current) setWidth(box.current.width);
			}}
		>
			{shown.map((run, index) => (
				<text
					key={index}
					flexShrink={0}
					wrapMode="none"
					fg={run.fg ?? terminalColor()}
					attributes={run.attributes}
				>
					{run.text}
				</text>
			))}
		</box>
	);
}
