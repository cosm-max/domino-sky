/**
 * Domino Sky: Vercel Serverless Entry Point
 *
 * Vercel requires the default export to be a plain function with signature:
 *   (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
 *
 * We delegate immediately to the shared handleRequest() so there is no
 * logic duplication between local dev (src/server.ts) and production.
 */

import { handleRequest } from '../src/handler.ts';

export default handleRequest;
