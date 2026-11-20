import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { server } from '../src/server.ts';

/**
 * Dispatches an HTTP request directly to the Node server instance
 * without opening a TCP port (circumventing Windows sandbox socket restriction).
 */
function request(method: string, path: string, bodyObj?: any): Promise<{ status: number; headers: any; body: string }> {
  return new Promise((resolve) => {
    const req: any = new PassThrough();
    req.method = method;
    req.url = path;
    req.headers = { host: 'localhost' };

    let resBody = '';
    const resHeaders: Record<string, string> = {};
    let resStatus = 200;

    const res: any = new PassThrough();
    res.writeHead = (status: number, headers: any) => {
      resStatus = status;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          resHeaders[k.toLowerCase()] = v as string;
        }
      }
      return res;
    };
    res.setHeader = (name: string, val: string) => {
      resHeaders[name.toLowerCase()] = val;
    };
    res.getHeader = (name: string) => resHeaders[name.toLowerCase()];

    res.on('data', (chunk: any) => {
      resBody += chunk.toString();
    });

    res.on('end', () => {
      resolve({ status: resStatus, headers: resHeaders, body: resBody });
    });

    server.emit('request', req, res);

    if (bodyObj !== undefined) {
      req.end(JSON.stringify(bodyObj));
    } else {
      req.end();
    }
  });
}

describe('Domino Sky: Server API & Integration Tests', () => {
  it('GET /api/dataset returns the official dataset integrity', async () => {
    const res = await request('GET', '/api/dataset');
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);

    assert.equal(data.airports.length, 16);
    assert.equal(data.flights.length, 70);
    assert.equal(data.connections.length, 21);
    assert.equal(data.crews.length, 16);
    assert.equal(data.spare_aircraft.length, 2);
    assert.equal(data.meta.min_turnaround_minutes, 30);
  });

  it('POST /api/simulate returns deterministic baseline when no closure', async () => {
    const res = await request('POST', '/api/simulate', {
      airportId: null,
      startTime: '08:00',
      durationMinutes: 0,
    });

    assert.equal(res.status, 200);
    const result = JSON.parse(res.body);

    assert.equal(result.summary.totalFlights, 70);
    assert.equal(result.summary.delayedFlightsCount, 0);
    assert.equal(result.summary.totalFlightDelayMinutes, 0);
    assert.equal(result.summary.missedConnectionsCount, 0);
    assert.equal(result.summary.crewViolationsCount, 0);
  });

  it('POST /api/simulate accurately simulates airport closure disruption', async () => {
    const res = await request('POST', '/api/simulate', {
      airportId: 'DEL',
      startTime: '08:00',
      durationMinutes: 60,
    });

    assert.equal(res.status, 200);
    const result = JSON.parse(res.body);

    assert.ok(result.summary.delayedFlightsCount > 0);
    assert.ok(result.summary.totalFlightDelayMinutes > 0);
    const ds0101 = result.flights.find((f: any) => f.flightId === 'DS0101');
    assert.ok(ds0101);
    assert.equal(ds0101.actualDep, '09:00');
    assert.equal(ds0101.depDelayMins, 60);
  });

  it('POST /api/recovery returns verified recovery plans and tactical holding options', async () => {
    const res = await request('POST', '/api/recovery', {
      airportId: 'BOM',
      startTime: '07:30',
      durationMinutes: 90,
    });

    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);

    assert.ok(data.simulation);
    assert.ok(data.recovery);

    // Verify recovery components
    assert.ok(data.recovery.turnaroundOpportunities.length > 0);
    assert.ok(data.recovery.connectionStrategies.length > 0);
    assert.ok(data.recovery.spareOpportunities.length >= 2);
  });

  it('POST /api/evaluate-spare evaluates physical substitution constraints', async () => {
    // Valid request: VT-DS17 at BLR
    const resValid = await request('POST', '/api/evaluate-spare', {
      spareTailId: 'VT-DS17',
      targetTailId: 'VT-DS06',
      swapAirport: 'BLR',
      effectiveFromLegOrder: 1,
    });

    assert.equal(resValid.status, 200);
    const validData = JSON.parse(resValid.body);
    assert.equal(validData.isValid, true);

    // Ineligible request: VT-DS17 (BLR spare) swapped at DEL
    const resInvalid = await request('POST', '/api/evaluate-spare', {
      spareTailId: 'VT-DS17',
      targetTailId: 'VT-DS01',
      swapAirport: 'DEL',
      effectiveFromLegOrder: 1,
    });

    assert.equal(resInvalid.status, 200);
    const invalidData = JSON.parse(resInvalid.body);
    assert.equal(invalidData.isValid, false);
    assert.equal(invalidData.status, 'INELIGIBLE');
  });

  it('GET / serves the complete AOC Control Center HTML application', async () => {
    const res = await request('GET', '/');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type']?.includes('text/html'));
    const html = res.body;

    assert.ok(html.includes('DOMINO SKY'));
    assert.ok(html.includes('AOC CONTROL CENTER'));
    assert.ok(html.includes('network-map-svg'));
    assert.ok(html.includes('RECOVERY STRATEGY INTERFACE'));
  });
});
