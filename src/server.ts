/**
 * Domino Sky: Application Server & REST API
 * 
 * Standalone, high-performance HTTP server built on Node.js native primitives.
 * Zero external runtime dependencies required.
 * Integrates DominoSkySimulator and DominoSkyRecoveryEngine.
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { DominoSkyDataset, ClosureInput } from './types.ts';
import { DominoSkySimulator } from './engine.ts';
import { DominoSkyRecoveryEngine } from './recovery.ts';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

// 1. Load official dataset
const datasetPath = resolve(process.cwd(), 'data/domino_sky.json');
if (!existsSync(datasetPath)) {
  console.error(`ERROR: Dataset not found at ${datasetPath}`);
  process.exit(1);
}

const dataset: DominoSkyDataset = JSON.parse(readFileSync(datasetPath, 'utf8'));
const simulator = new DominoSkySimulator(dataset);
const recoveryEngine = new DominoSkyRecoveryEngine(dataset);

console.log(`[DominoSky] Dataset loaded successfully (${dataset.airports.length} airports, ${dataset.flights.length} flights, ${dataset.connections.length} connections, ${dataset.crews.length} crews, ${dataset.spare_aircraft.length} spares)`);

// 2. Helper to send JSON responses
function sendJson(res: ServerResponse, statusCode: number, data: any) {
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

// 3. Helper to read request body
function parseRequestBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
      if (body.length > 1024 * 1024) {
        reject(new Error('Request payload too large'));
      }
    });
    req.on('end', () => {
      try {
        if (!body.trim()) {
          resolve({});
        } else {
          resolve(JSON.parse(body));
        }
      } catch (err) {
        reject(new Error('Invalid JSON in request body'));
      }
    });
    req.on('error', reject);
  });
}

// 4. Create the HTTP Server
export const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // Handle CORS Pre-flight
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
    // API: GET /api/dataset
    if (pathname === '/api/dataset' && req.method === 'GET') {
      sendJson(res, 200, dataset);
      return;
    }

    // API: POST /api/simulate
    if (pathname === '/api/simulate' && req.method === 'POST') {
      const body = await parseRequestBody(req);
      const input: ClosureInput = {
        airportId: body.airportId || null,
        startTime: body.startTime || '08:00',
        durationMinutes: typeof body.durationMinutes === 'number' ? body.durationMinutes : 0,
      };

      const result = simulator.simulate(input);
      sendJson(res, 200, result);
      return;
    }

    // API: POST /api/recovery
    if (pathname === '/api/recovery' && req.method === 'POST') {
      const body = await parseRequestBody(req);
      const input: ClosureInput = {
        airportId: body.airportId || null,
        startTime: body.startTime || '08:00',
        durationMinutes: typeof body.durationMinutes === 'number' ? body.durationMinutes : 0,
      };

      const simResult = simulator.simulate(input);
      const recoveryPlan = recoveryEngine.evaluate(simResult);

      sendJson(res, 200, {
        simulation: simResult,
        recovery: recoveryPlan,
      });
      return;
    }

    // API: POST /api/evaluate-spare
    if (pathname === '/api/evaluate-spare' && req.method === 'POST') {
      const body = await parseRequestBody(req);
      const evaluation = simulator.evaluateSpareSubstitution({
        spareTailId: body.spareTailId,
        targetTailId: body.targetTailId,
        swapAirport: body.swapAirport,
        effectiveFromLegOrder: parseInt(body.effectiveFromLegOrder, 10) || 1,
      });
      sendJson(res, 200, evaluation);
      return;
    }

    // Web Application Client: GET / or /index.html
    if (pathname === '/' || pathname === '/index.html') {
      const htmlPath = resolve(process.cwd(), 'src/public/index.html');
      if (existsSync(htmlPath)) {
        const html = readFileSync(htmlPath, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        res.end(html);
        return;
      }
    }

    // Static Assets: /public/*
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

    // Fallback 404
    sendJson(res, 404, { error: `Not found: ${pathname}` });
  } catch (err: any) {
    console.error(`[Error] ${pathname}:`, err.message);
    sendJson(res, 400, { error: err.message || 'Internal server error' });
  }
});

// Start listening if run directly
if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  server.listen(PORT, HOST, () => {
    console.log(`========================================================================`);
    console.log(`  DOMINO SKY: Flight Disruption Cascade & Recovery Simulator`);
    console.log(`  Control Center running at: http://localhost:${PORT}`);
    console.log(`========================================================================`);
  });
}
