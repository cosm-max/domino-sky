/**
 * Domino Sky: CLI Runner
 * Execute the simulation directly from the command line.
 * 
 * Usage:
 *   node --experimental-strip-types src/cli.ts [--airport <code>] [--start <HH:MM>] [--duration <minutes>]
 * 
 * Example:
 *   node --experimental-strip-types src/cli.ts --airport DEL --start 08:00 --duration 60
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DominoSkyDataset, ClosureInput } from './types.ts';
import { DominoSkySimulator } from './engine.ts';

// Parse command line flags
const args = process.argv.slice(2);
let airport: string | null = null;
let start = '08:00';
let duration = 60;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--airport' && i + 1 < args.length) {
    airport = args[++i];
  } else if (args[i] === '--start' && i + 1 < args.length) {
    start = args[++i];
  } else if (args[i] === '--duration' && i + 1 < args.length) {
    duration = parseInt(args[++i], 10);
  } else if (args[i] === '--baseline') {
    airport = null;
    duration = 0;
  }
}

const datasetPath = resolve(process.cwd(), 'data/domino_sky.json');
const dataset: DominoSkyDataset = JSON.parse(readFileSync(datasetPath, 'utf8'));

const simulator = new DominoSkySimulator(dataset);

const input: ClosureInput = {
  airportId: airport,
  startTime: start,
  durationMinutes: duration,
};

console.log('========================================================================');
console.log('  DOMINO SKY: Flight Disruption Cascade & Recovery Simulator');
console.log('========================================================================');
if (airport) {
  console.log(`Disruption Scenario: Airport [${airport}] closed from ${start} for ${duration} minutes`);
} else {
  console.log('Disruption Scenario: Baseline on-time schedule (no closure)');
}
console.log('------------------------------------------------------------------------');

const result = simulator.simulate(input);
const s = result.summary;

console.log('\n--- NETWORK KPI SUMMARY ---');
console.log(`Total Flights:                 ${s.totalFlights}`);
console.log(`Delayed Flights:               ${s.delayedFlightsCount} (${Math.round((s.delayedFlightsCount / s.totalFlights) * 100)}%)`);
console.log(`On-Time Flights:               ${s.onTimeFlightsCount}`);
console.log(`Total Flight Delay Minutes:    ${s.totalFlightDelayMinutes} min`);
console.log(`Average Delay (Delayed Only):  ${s.averageDelayMinutes} min`);
console.log(`Passengers on Delayed Flights: ${s.delayedFlightPassengers}`);
console.log(`Missed Connections:            ${s.missedConnectionsCount} of ${s.totalConnections}`);
console.log(`Passengers Missing Connects:   ${s.missedConnectionPassengers}`);
console.log(`Crew Duty Violations:          ${s.crewViolationsCount} of ${s.crewsEvaluated}`);
console.log(`Crew Overtime Exceeded:        ${s.totalCrewExceededMinutes} min`);
console.log(`Affected Aircraft Rotations:   ${s.affectedRotationsCount} of 16`);

if (result.flights.filter((f) => f.isDelayed).length > 0) {
  console.log('\n--- DELAYED FLIGHTS SAMPLE (Top 10) ---');
  const delayed = result.flights.filter((f) => f.isDelayed).slice(0, 10);
  for (const f of delayed) {
    console.log(
      `[${f.flightId}] ${f.origin}->${f.destination} (${f.tailId} Leg ${f.legOrder}) | Sched: ${f.scheduledDep}->${f.scheduledArr} | Actual: ${f.actualDep}->${f.actualArr} | Delay: +${f.depDelayMins}m`
    );
    for (const r of f.delayReasons) {
      console.log(`   └─ Reason: ${r}`);
    }
  }
}

if (result.connections.filter((c) => c.isMissed).length > 0) {
  console.log('\n--- MISSED CONNECTIONS ---');
  for (const c of result.connections.filter((c) => c.isMissed)) {
    console.log(
      `[${c.connectionId}] At ${c.airport}: ${c.fromFlight} (arr ${c.actualInboundArr}) -> ${c.toFlight} (dep ${c.actualOutboundDep}) | Buffer: ${c.actualBufferMinutes}m (MCT: ${c.minConnectMinutes}m) | Stranded Pax: ${c.passengers}`
    );
  }
}

if (result.crews.filter((c) => c.isViolation).length > 0) {
  console.log('\n--- CREW DUTY VIOLATIONS ---');
  for (const cr of result.crews.filter((c) => c.isViolation)) {
    console.log(
      `[${cr.crewId}] Tail ${cr.tailId} (Base ${cr.base}): Duty ${cr.dutyStart} -> ${cr.actualDutyEnd} (${cr.actualDutyMins}m / max ${cr.maxDutyMins}m) | EXCEEDED BY ${cr.exceededMinutes}m!`
    );
  }
}

console.log('\n------------------------------------------------------------------------');
console.log(`Note: ${s.metricsDisclaimer}`);
console.log('========================================================================\n');
