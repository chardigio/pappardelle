import fs from 'node:fs';
import path from 'node:path';
import test from 'ava';

// Regression tests for STA-1459: the STA-732 release bumped the marketplace
// entry to 1.0.1 but forgot the plugin's own manifest, leaving the two
// surfaces disagreeing about what version (and feature set) ships. These
// tests pin the marketplace entry and plugin.json together so a future
// release can't bump one without the other.

const root = path.join(import.meta.dirname, '..');

type MarketplacePluginEntry = {
	name: string;
	version: string;
	description: string;
};

type Marketplace = {
	metadata: {version: string};
	plugins: MarketplacePluginEntry[];
};

type PluginManifest = {
	name: string;
	version: string;
	description: string;
};

function readJson<T>(relativePath: string): T {
	return JSON.parse(
		fs.readFileSync(path.join(root, relativePath), 'utf8'),
	) as T;
}

const marketplace = readJson<Marketplace>('.claude-plugin/marketplace.json');
const plugin = readJson<PluginManifest>(
	'plugins/pappardelle/.claude-plugin/plugin.json',
);

const marketplaceEntry = marketplace.plugins.find(p => p.name === plugin.name);

test('marketplace lists the pappardelle plugin', t => {
	t.truthy(marketplaceEntry);
});

test('plugin manifest version matches its marketplace entry', t => {
	if (!t.truthy(marketplaceEntry, 'pappardelle must be listed in marketplace'))
		return;
	t.is(plugin.version, marketplaceEntry.version);
});

test('plugin manifest description matches its marketplace entry', t => {
	if (!t.truthy(marketplaceEntry, 'pappardelle must be listed in marketplace'))
		return;
	t.is(plugin.description, marketplaceEntry.description);
});
