/**
 * Domino Sky: Local Development HTTP Server
 *
 * Thin wrapper around the shared handleRequest() function.
 * Uses Node's http.createServer() for local `npm start` / `npm dev`.
 * Not deployed to Vercel — see api/index.ts for the serverless entry.
 */

import { createServer } from 'node:http';
import { handleRequest } from './handler.ts';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

// Export `server` so the existing test suite (server.test.ts) can keep using
// `server.emit('request', req, res)` without any changes.
export const server = createServer(handleRequest);

// Start listening only when invoked directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  server.listen(PORT, HOST, () => {
    console.log('========================================================================');
    console.log('  DOMINO SKY: Flight Disruption Cascade & Recovery Simulator');
    console.log(`  Control Center running at: http://localhost:${PORT}`);
    console.log('========================================================================');
  });
}
