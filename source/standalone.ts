// The compiled process can run a status monitor without initializing the UI.
if (process.argv[2] === '--internal-status-monitor') {
	process.argv.splice(2, 1);
	await import('./program-status-monitor-cli.ts');
} else {
	await import('./cli.tsx');
}
