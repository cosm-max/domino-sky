/**
 * Domino Sky: Shared HTTP Request Handler
 *
 * This module contains the entire routing logic, decoupled from the
 * transport layer (createServer / listen). It is consumed by:
 *   - src/server.ts   → local Node.js HTTP server
 *   - api/index.ts    → Vercel serverless function
 *
 * Dataset and engine singletons are initialised once at module load time.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  DominoSkyDataset,
  ClosureInput,
  ChatMessage,
  PreviewProposal,
} from './types.ts';
import { DominoSkySimulator } from './engine.ts';
import { DominoSkyRecoveryEngine } from './recovery.ts';
import { DominoSkyAIDispatcher } from './ai-dispatcher.ts';

// ── 1. Load official dataset once ─────────────────────────────────────────────
// When running on Vercel, process.cwd() is /var/task (the deployment root),
// so `data/domino_sky.json` resolves correctly.
const datasetPath = resolve(process.cwd(), 'data/domino_sky.json');
if (!existsSync(datasetPath)) {
  throw new Error(`FATAL: Dataset not found at ${datasetPath}`);
}

const dataset: DominoSkyDataset = JSON.parse(readFileSync(datasetPath, 'utf8'));
const simulator = new DominoSkySimulator(dataset);
const recoveryEngine = new DominoSkyRecoveryEngine(dataset);
const aiDispatcher = new DominoSkyAIDispatcher(dataset, simulator, recoveryEngine);

console.log(
  `[DominoSky] Dataset loaded (${dataset.airports.length} airports, ` +
    `${dataset.flights.length} flights, ${dataset.connections.length} connections, ` +
    `${dataset.crews.length} crews, ${dataset.spare_aircraft.length} spares)`
);

// ── 2. Helpers ─────────────────────────────────────────────────────────────────
function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  const json = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-cache',
  });
  res.end(json);
}

function parseRequestBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
      if (body.length > 1_024 * 1_024) reject(new Error('Request payload too large'));
    });
    req.on('end', () => {
      try {
        resolve(body.trim() ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON in request body'));
      }
    });
    req.on('error', reject);
  });
}

function closureInputFrom(body: any): ClosureInput {
  return {
    airportId: body.airportId || null,
    startTime: body.startTime || '08:00',
    durationMinutes: typeof body.durationMinutes === 'number' ? body.durationMinutes : 0,
  };
}

// ── 3. The shared request handler (no createServer wrapping) ───────────────────
export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // CORS pre-flight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  try {
    // ── API routes ────────────────────────────────────────────────────────────

    if (pathname === '/api/dataset' && req.method === 'GET') {
      sendJson(res, 200, dataset);
      return;
    }

    if (pathname === '/api/simulate' && req.method === 'POST') {
      const body = await parseRequestBody(req);
      sendJson(res, 200, simulator.simulate(closureInputFrom(body)));
      return;
    }

    if (pathname === '/api/recovery' && req.method === 'POST') {
      const body = await parseRequestBody(req);
      const input = closureInputFrom(body);
      const simResult = simulator.simulate(input);
      sendJson(res, 200, {
        simulation: simResult,
        recovery: recoveryEngine.evaluate(simResult),
      });
      return;
    }

    if (pathname === '/api/evaluate-spare' && req.method === 'POST') {
      const body = await parseRequestBody(req);
      sendJson(
        res,
        200,
        simulator.evaluateSpareSubstitution({
          spareTailId: body.spareTailId,
          targetTailId: body.targetTailId,
          swapAirport: body.swapAirport,
          effectiveFromLegOrder: parseInt(body.effectiveFromLegOrder, 10) || 1,
        })
      );
      return;
    }

    // ── Gemini AI Dispatcher routes ───────────────────────────────────────────

    if (pathname === '/api/dispatcher/status' && req.method === 'GET') {
      sendJson(res, 200, aiDispatcher.getStatus());
      return;
    }

    if (pathname === '/api/dispatcher/analyze' && req.method === 'POST') {
      const body = await parseRequestBody(req);
      const input = closureInputFrom(body);
      const simResult = simulator.simulate(input);
      const recoveryPlan = recoveryEngine.evaluate(simResult);
      const analysis = await aiDispatcher.analyzeDisruption(input, simResult, recoveryPlan);
      sendJson(res, 200, { analysis, simulationSummary: simResult.summary });
      return;
    }

    if (pathname === '/api/dispatcher/chat' && req.method === 'POST') {
      const body = await parseRequestBody(req);
      const question = typeof body.question === 'string' ? body.question.trim() : '';
      if (!question || question.length > 1000) {
        sendJson(res, 400, { error: 'Question is required and must be under 1000 characters.' });
        return;
      }
      const input = closureInputFrom(body);
      const history: ChatMessage[] = Array.isArray(body.history)
        ? body.history
            .filter(
              (m: any) =>
                m &&
                (m.role === 'user' || m.role === 'model') &&
                typeof m.text === 'string'
            )
            .slice(-6)
            .map((m: any) => ({ role: m.role, text: m.text.slice(0, 2000) }))
        : [];
      const simResult = simulator.simulate(input);
      const recoveryPlan = recoveryEngine.evaluate(simResult);
      sendJson(res, 200, await aiDispatcher.chat(question, history, input, simResult, recoveryPlan));
      return;
    }

    if (pathname === '/api/dispatcher/preview' && req.method === 'POST') {
      const body = await parseRequestBody(req);
      const input = closureInputFrom(body);
      const proposal = body.proposal as PreviewProposal;
      if (
        !proposal ||
        !['spare_aircraft_substitution', 'connection_hold', 'turnaround_firewall', 'unsupported'].includes(
          proposal.actionType
        )
      ) {
        sendJson(res, 400, { error: 'Invalid preview proposal.' });
        return;
      }
      sendJson(res, 200, {
        preview: aiDispatcher.evaluatePreview(proposal, input),
        previewIsEstimate: true,
        note: 'Preview values are estimates, not verified outcomes from a re-simulated recovery plan.',
      });
      return;
    }

    // ── Static dashboard ──────────────────────────────────────────────────────

    if (pathname === '/' || pathname === '/index.html') {
      const htmlPath = resolve(process.cwd(), 'src/public/index.html');
      if (existsSync(htmlPath)) {
        const html = readFileSync(htmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(html);
        return;
      }
    }

    if (pathname.startsWith('/static/')) {
      const staticFile = join(process.cwd(), 'src/public', pathname.replace('/static/', ''));
      if (existsSync(staticFile)) {
        const content = readFileSync(staticFile);
        const ext = staticFile.split('.').pop() || '';
        const mimeTypes: Record<string, string> = {
          js: 'application/javascript',
          css: 'text/css',
          svg: 'image/svg+xml',
          png: 'image/png',
          json: 'application/json',
        };
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
        res.end(content);
        return;
      }
    }

    // 404
    sendJson(res, 404, { error: `Not found: ${pathname}` });
  } catch (err: any) {
    console.error(`[Error] ${pathname}:`, err.message);
    sendJson(res, 400, { error: err.message || 'Internal server error' });
  }
}
