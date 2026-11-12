// The compiled process can run one of these without initializing the UI.
const internalEntries: Record<string, () => Promise<unknown>> = {
	'--internal-status-monitor': async () =>
		import('./program-status-monitor-cli.ts'),
	'--internal-pane-frame': async () => import('./pane-frame-cli.ts'),
	'--internal-state': async () => import('./state-cli.ts'),
};
const internalEntry = internalEntries[process.argv[2] ?? ''];
if (internalEntry) {
	process.argv.splice(2, 1);
	await internalEntry();
} else {
	await import('./cli.tsx');
}
