import type {ReactNode} from 'react';
import {render, type RenderOptions} from 'ink';

export function renderTui(node: ReactNode, options: RenderOptions = {}) {
	return render(node, {...options, incrementalRendering: true});
}
