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

type Word = {text: string; fg?: string; bold?: boolean; dim?: boolean};

// OpenTUI's word wrap also breaks after a '.', which can split a version
// number across lines. Laying the words out as unbreakable flex items keeps
// line breaks at the spaces only.
function bannerWords(info: UpdateInfo): Word[] {
	const segments: Word[] = [
		{text: 'Update available:', fg: 'magenta', bold: true},
		{text: `v${info.installedVersion.replace(/^v/, '')}`, fg: 'yellow'},
		{text: '→', dim: true},
		{text: `v${info.latestVersion.replace(/^v/, '')}`, fg: 'green'},
		{text: '·', dim: true},
		{text: 'U', fg: 'cyan'},
		{text: 'to update ·', dim: true},
		{text: 'X', fg: 'cyan'},
		{text: 'to dismiss', dim: true},
	];
	return segments.flatMap(segment =>
		segment.text.split(' ').map(text => ({...segment, text})),
	);
}

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
			<box flexDirection="row" flexWrap="wrap" columnGap={1} flexShrink={1}>
				{bannerWords(info).map((word, index) => (
					<text
						key={index}
						wrapMode="none"
						flexShrink={0}
						fg={terminalColor(word.fg)}
						attributes={textAttributes(word)}
					>
						{word.text}
					</text>
				))}
			</box>
		</box>
	);
}
