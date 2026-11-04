// Entry point for `pappardelle mcp`, apart from cli.tsx so that a server idling
// in every Claude Code session doesn't hold the TUI's modules in memory.

import {runMcpServer} from './mcp-server.ts';

await runMcpServer();
process.exit(0);
