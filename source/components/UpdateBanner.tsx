import {useRef} from 'react';
import type {BoxRenderable} from '@opentui/core';
import {textAttributes, terminalColor} from '../tui-style.ts';

import type {UpdateInfo} from '../update-check.ts';

interface Props {
	info: UpdateInfo;
	// Called with the total rendered footprint of the banner (box height +
	// marginBottom) whenever it changes, so the list and dialogs reserve
	// enough space when the banner wraps at narrow pane widths.
	onMeasure?: (height: number) => void;
}

// marginBottom on the outer Box. Kept as a named constant because
// The renderer reports the Box's own layout size but not its outer margin,
// so we have to add this back in when reporting the total footprint.
const MARGIN_BOTTOM = 1;

// Prominent banner shown above the workspace list when a newer pappardelle
// version is available on chardigio/pappardelle. Press U to update, X to
// dismiss — both handled by the parent app.tsx key handler.
export default function UpdateBanner({info, onMeasure}: Props) {
	const box = useRef<BoxRenderable>(null);
	return (
		<box
			flexDirection="row"
			border
			ref={box}
			onSizeChange={() => {
				if (box.current) onMeasure?.(box.current.height + MARGIN_BOTTOM);
			}}
			borderStyle="rounded"
			borderColor={terminalColor('magenta')}
			paddingX={1}
			marginBottom={MARGIN_BOTTOM}
		>
			<text fg={terminalColor()} flexShrink={1}>
				<span
					attributes={textAttributes({bold: true})}
					fg={terminalColor('magenta')}
				>
					Update available:
				</span>{' '}
				<span fg={terminalColor('yellow')}>
					v{info.installedVersion.replace(/^v/, '')}
				</span>
				<span attributes={textAttributes({dim: true})}> → </span>
				<span fg={terminalColor('green')}>
					v{info.latestVersion.replace(/^v/, '')}
				</span>
				<span attributes={textAttributes({dim: true})}> · </span>
				<span fg={terminalColor('cyan')}>U</span>
				<span attributes={textAttributes({dim: true})}> to update · </span>
				<span fg={terminalColor('cyan')}>X</span>
				<span attributes={textAttributes({dim: true})}> to dismiss</span>
			</text>
		</box>
	);
}
