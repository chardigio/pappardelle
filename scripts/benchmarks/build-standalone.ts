import {buildNative} from '../build-native.ts';

const [destination, mode] = process.argv.slice(2);
if (!destination)
	throw new Error('Usage: build-standalone.ts <output> [bytecode]');
await buildNative(destination, mode === 'bytecode');
