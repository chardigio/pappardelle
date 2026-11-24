import fs from 'node:fs';
import path from 'node:path';

const fixtures = path.join(
	import.meta.dirname,
	'..',
	'fixtures',
	'agent-screens',
);

/** A `capture-pane -p -e -J` capture of a real agent, by fixture name. */
export function agentScreenFixture(name: string): string {
	return fs.readFileSync(path.join(fixtures, `${name}.txt`), 'utf8');
}
