import {terminalColor} from '../tui-style.ts';
import type {ReactNode} from 'react';

/** OpenTUI draws the title in the border and recomputes it with the layout. */
export default function TitledBox({
	title,
	borderColor,
	titleColor,
	borderStyle = 'double',
	width,
	paddingY = 1,
	isDim = false,
	children,
}: {
	title: string;
	borderColor: string;
	titleColor: string;
	borderStyle?: 'double' | 'round';
	width: number;
	paddingY?: number;
	isDim?: boolean;
	children: ReactNode;
}) {
	return (
		<box
			flexDirection="column"
			width={width}
			border
			borderStyle={borderStyle === 'round' ? 'rounded' : borderStyle}
			borderColor={terminalColor(borderColor)}
			title={` ${title} `}
			titleColor={terminalColor(titleColor)}
			opacity={isDim ? 0.5 : 1}
			paddingX={2}
			paddingY={paddingY}
		>
			{children}
		</box>
	);
}
