import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { DominoSkyDataset } from '../src/types.ts';
import { DominoSkySimulator } from '../src/engine.ts';
import { parseTimeToMinutes, formatMinutesToTime, formatMinutesNormalized } from '../src/time-utils.ts';

// Load the official dataset
const datasetPath = resolve(process.cwd(), 'data/domino_sky.json');
const dataset: DominoSkyDataset = JSON.parse(readFileSync(datasetPath, 'utf8'));

describe('Domino Sky: Time Utilities', () => {
  it('parses valid HH:MM strings into minutes from day start', () => {
    assert.equal(parseTimeToMinutes('00:00'), 0);
    assert.equal(parseTimeToMinutes('08:30'), 510);
    assert.equal(parseTimeToMinutes('13:45'), 825);
    assert.equal(parseTimeToMinutes('23:59'), 1439);
  });

  it('rejects invalid time strings with descriptive errors', () => {
    assert.throws(() => parseTimeToMinutes(''), /Invalid time format/);
    assert.throws(() => parseTimeToMinutes('8:5'), /Invalid time format/);
    assert.throws(() => parseTimeToMinutes('24:00'), /Invalid hours/);
    assert.throws(() => parseTimeToMinutes('12:60'), /Invalid minutes/);
    assert.throws(() => parseTimeToMinutes('invalid'), /Invalid time format/);
  });

  it('formats minutes into standard HH:MM', () => {
    assert.equal(formatMinutesToTime(0), '00:00');
    assert.equal(formatMinutesToTime(510), '08:30');
    assert.equal(formatMinutesToTime(825), '13:45');
    assert.equal(formatMinutesToTime(1439), '23:59');
  });

  it('correctly handles times crossing midnight (>= 1440 minutes)', () => {
    assert.equal(formatMinutesToTime(1440), '00:00 (+1d)');
    assert.equal(formatMinutesToTime(1475), '00:35 (+1d)');
    assert.equal(formatMinutesToTime(2880), '00:00 (+2d)');
    assert.equal(formatMinutesNormalized(1475), '00:35');
  });
});

describe('Domino Sky: Core Disruption Simulation Engine', () => {
  const simulator = new DominoSkySimulator(dataset);

  it('Test 1: Baseline No-Closure Scenario — 100% on-time network', () => {
    const result = simulator.simulate({
      airportId: null,
      startTime: '00:00',
      durationMinutes: 0,
    });

    assert.equal(result.summary.totalFlights, 70);
    assert.equal(result.summary.delayedFlightsCount, 0);
    assert.equal(result.summary.onTimeFlightsCount, 70);
    assert.equal(result.summary.totalFlightDelayMinutes, 0);
    assert.equal(result.summary.delayedFlightPassengers, 0);
    assert.equal(result.summary.missedConnectionsCount, 0);
    assert.equal(result.summary.missedConnectionPassengers, 0);
    assert.equal(result.summary.crewViolationsCount, 0);
    assert.equal(result.summary.totalCrewExceededMinutes, 0);
    assert.equal(result.summary.affectedRotationsCount, 0);

    // Verify all 70 flights have actual == scheduled
    for (const f of result.flights) {
      assert.equal(f.depDelayMins, 0, `Flight ${f.flightId} should have 0 dep delay`);
      assert.equal(f.arrDelayMins, 0, `Flight ${f.flightId} should have 0 arr delay`);
      assert.equal(f.actualDep, f.scheduledDep);
      assert.equal(f.actualArr, f.scheduledArr);
      assert.equal(f.isDelayed, false);
      assert.equal(f.delayReasons.length, 0);
    }

    // Verify all 21 connections are maintained
    for (const c of result.connections) {
      assert.equal(c.isMissed, false, `Connection ${c.connectionId} should be made`);
      assert.ok(c.actualBufferMinutes >= c.minConnectMinutes);
    }

    // Verify all 16 crews are within duty limit
    for (const cr of result.crews) {
      assert.equal(cr.isViolation, false);
      assert.equal(cr.exceededMinutes, 0);
    }
  });

  it('Test 2: Departure Airport Closure — holds departures until reopening', () => {
    // Close DEL for 60 minutes from 08:00 to 09:00
    const result = simulator.simulate({
      airportId: 'DEL',
      startTime: '08:00',
      durationMinutes: 60,
    });

    // Flight DS0101 (DEL -> JAI) scheduled dep 08:00, arr 08:50 (block 50m)
    const ds0101 = result.flights.find((f) => f.flightId === 'DS0101');
    assert.ok(ds0101);
    assert.equal(ds0101.actualDep, '09:00', 'DS0101 must wait until DEL reopens at 09:00');
    assert.equal(ds0101.actualArr, '09:50', 'DS0101 must maintain 50m block time (09:00 + 50m = 09:50)');
    assert.equal(ds0101.depDelayMins, 60);
    assert.equal(ds0101.arrDelayMins, 60);
    assert.ok(
      ds0101.delayReasons.some((r) => r.includes('Origin airport DEL closed [08:00, 09:00)')),
      'Must record explicit closure reason'
    );

    // Flight DS0201 (DEL -> BOM) scheduled dep 06:00, arr 08:10 -> departed before closure, not affected
    const ds0201 = result.flights.find((f) => f.flightId === 'DS0201');
    assert.ok(ds0201);
    assert.equal(ds0201.actualDep, '06:00');
    assert.equal(ds0201.depDelayMins, 0);
  });

  it('Test 3: Arrival Airport Closure — ground-holds inbounds at origin', () => {
    // Close BOM from 07:30 to 08:30 (60 minutes)
    const result = simulator.simulate({
      airportId: 'BOM',
      startTime: '07:30',
      durationMinutes: 60,
    });

    // DS0701: HYD -> BOM, scheduled dep 06:30, arr 07:55 (block 85m)
    // Projected arrival 07:55 is inside [07:30, 08:30).
    // Must be ground-held at HYD so it arrives at reopening 08:30: dep = 08:30 - 85m = 07:05.
    const ds0701 = result.flights.find((f) => f.flightId === 'DS0701');
    assert.ok(ds0701);
    assert.equal(ds0701.actualDep, '07:05', 'DS0701 must be ground-held at HYD until 07:05');
    assert.equal(ds0701.actualArr, '08:30', 'DS0701 lands at reopening 08:30');
    assert.equal(ds0701.depDelayMins, 35);
    assert.equal(ds0701.arrDelayMins, 35);
    assert.ok(
      ds0701.delayReasons.some((r) => r.includes('Destination airport BOM closed')),
      'Must record destination ground hold reason'
    );

    // DS0201: DEL -> BOM, scheduled dep 06:00, arr 08:10 (block 130m)
    // Projected arrival 08:10 is inside [07:30, 08:30).
    // Must be ground-held at DEL to arrive at 08:30: dep = 08:30 - 130m = 06:20.
    const ds0201 = result.flights.find((f) => f.flightId === 'DS0201');
    assert.ok(ds0201);
    assert.equal(ds0201.actualDep, '06:20', 'DS0201 must be ground-held at DEL until 06:20');
    assert.equal(ds0201.actualArr, '08:30', 'DS0201 lands at reopening 08:30');
    assert.equal(ds0201.depDelayMins, 20);
    assert.equal(ds0201.arrDelayMins, 20);
  });

  it('Test 4: Downstream Delay Propagation and Turnaround Buffer Absorption', () => {
    // Close DEL from 08:00 to 09:00
    const result = simulator.simulate({
      airportId: 'DEL',
      startTime: '08:00',
      durationMinutes: 60,
    });

    // Inspect tail VT-DS01 rotation:
    // Leg 1 DS0101: dep 09:00, arr 09:50 (60m delay)
    // Leg 2 DS0102: JAI -> DEL, scheduled dep 09:25.
    // Turnaround ready: 09:50 + 30m = 10:20.
    // Must depart at 10:20 (55m delay). Turnaround is exactly 30m!
    const ds0102 = result.flights.find((f) => f.flightId === 'DS0102')!;
    assert.equal(ds0102.actualDep, '10:20');
    assert.equal(ds0102.actualArr, '11:10'); // 10:20 + 50m block
    assert.equal(ds0102.depDelayMins, 55);

    // Leg 3 DS0103: DEL -> LKO, scheduled dep 10:50.
    // Turnaround ready: 11:10 + 30m = 11:40.
    // Must depart at 11:40 (50m delay).
    const ds0103 = result.flights.find((f) => f.flightId === 'DS0103')!;
    assert.equal(ds0103.actualDep, '11:40');
    assert.equal(ds0103.actualArr, '12:45'); // 11:40 + 65m block

    // Leg 4 DS0104: LKO -> DEL, scheduled dep 13:05.
    // Turnaround ready: 12:45 + 30m = 13:15.
    // Scheduled turnaround was 70m, absorbing 40m of delay.
    // Must depart at 13:15 (10m delay).
    const ds0104 = result.flights.find((f) => f.flightId === 'DS0104')!;
    assert.equal(ds0104.actualDep, '13:15');
    assert.equal(ds0104.actualArr, '14:20'); // 13:15 + 65m block

    // Leg 5 DS0105: DEL -> IXC, scheduled dep 15:15.
    // Turnaround ready: 14:20 + 30m = 14:50.
    // 14:50 <= 15:15 -> departs on time at 15:15!
    const ds0105 = result.flights.find((f) => f.flightId === 'DS0105')!;
    assert.equal(ds0105.actualDep, '15:15');
    assert.equal(ds0105.depDelayMins, 0);
  });

  it('Test 5: Minimum 30-Minute Turnaround is strictly enforced across all legs', () => {
    // Run an aggressive disruption at BLR (hub with tight turnarounds)
    const result = simulator.simulate({
      airportId: 'BLR',
      startTime: '10:00',
      durationMinutes: 120, // 2-hour closure
    });

    const flightMap = new Map(result.flights.map((f) => [f.flightId, f]));
    const rotations = new Map<string, typeof result.flights>();
    for (const f of result.flights) {
      if (!rotations.has(f.tailId)) rotations.set(f.tailId, []);
      rotations.get(f.tailId)!.push(f);
    }

    for (const [tail, legs] of rotations.entries()) {
      legs.sort((a, b) => a.legOrder - b.legOrder);
      for (let i = 1; i < legs.length; i++) {
        const prev = legs[i - 1];
        const curr = legs[i];
        const prevArr = prev.actualArrMin;
        const currDep = curr.actualDepMin;
        const actualTurnaround = currDep - prevArr;

        assert.ok(
          actualTurnaround >= 30,
          `Aircraft ${tail} leg ${curr.legOrder} (${curr.flightId}) departed with only ${actualTurnaround}m turnaround after ${prev.flightId} (min 30m required)`
        );
      }
    }
  });

  it('Test 6: Missed Passenger Connection Detection and Passenger Accounting', () => {
    // Close BOM from 07:30 to 08:45 (75 minutes)
    // DS0701 arrives BOM at 08:45 instead of 07:55 (+50m delay).
    // Connection CX03: DS0701 -> DS1502 (dep 08:50), min_connect: 45m, pax: 42.
    // Outbound DS1502 dep is 08:50. Buffer = 08:50 - 08:45 = 5m < 45m => MISSED!
    const result = simulator.simulate({
      airportId: 'BOM',
      startTime: '07:30',
      durationMinutes: 75,
    });

    const cx03 = result.connections.find((c) => c.connectionId === 'CX03');
    assert.ok(cx03);
    assert.equal(cx03.isMissed, true, 'CX03 must be missed due to buffer starvation');
    assert.equal(cx03.passengers, 42);

    assert.ok(result.summary.missedConnectionsCount >= 1);
    assert.ok(result.summary.missedConnectionPassengers >= 42);
    assert.ok(result.summary.delayedFlightPassengers > 0);

    // Verify separation of metrics
    assert.notEqual(
      result.summary.delayedFlightPassengers,
      result.summary.missedConnectionPassengers,
      'Delayed flight pax and missed connection pax must be distinct'
    );
  });

  it('Test 7: Crew Duty Violations and Overtime Tracking', () => {
    // Crew CR03 (VT-DS03 at DEL) has scheduled duty 11:30 -> 21:20 (590 min; 10m buffer to 600m max).
    // Close DEL from 12:00 to 13:00 (60 minutes).
    // DS0301 (dep 12:15) is held until 13:00 (+45m delay).
    // The rotation has 3 turnarounds (AMD, BOM, DEL), each having 35m scheduled ground time (5m buffer each).
    // 3 x 5m = 15m is absorbed across turnarounds, leaving 30m delay on final arrival at CCU (21:50).
    // Actual duty: 11:30 -> 21:50 = 620 minutes. Exceeded: 20 minutes.
    const result = simulator.simulate({
      airportId: 'DEL',
      startTime: '12:00',
      durationMinutes: 60,
    });

    const cr03 = result.crews.find((c) => c.crewId === 'CR03');
    assert.ok(cr03);
    assert.equal(cr03.isViolation, true, 'Crew CR03 must violate 600m max duty');
    assert.equal(cr03.actualDutyMins, 620, 'Duty duration must be 620 minutes (45m - 15m absorbed = +30m)');
    assert.equal(cr03.exceededMinutes, 20, 'Exceeded minutes must be 20 (620 - 600)');
    assert.equal(cr03.bufferRemainingMinutes, 0);

    assert.ok(result.summary.crewViolationsCount >= 1);
    assert.ok(result.summary.totalCrewExceededMinutes >= 20);
  });

  it('Test 8: Times Crossing Midnight Handling', () => {
    // A major delay that pushes late flights past midnight (1440 min)
    // Close DEL from 17:00 to 22:00 (300 minutes)
    const result = simulator.simulate({
      airportId: 'DEL',
      startTime: '17:00',
      durationMinutes: 300,
    });

    // Check flights that depart or arrive after 24:00 (1440 mins)
    const midnightFlights = result.flights.filter((f) => f.actualArrMin >= 1440);
    assert.ok(midnightFlights.length > 0, 'Late disruption must produce midnight-crossing flights');

    for (const mf of midnightFlights) {
      assert.ok(mf.actualArr.includes('(+1d)'), `Flight ${mf.flightId} arrival ${mf.actualArr} should have (+1d) tag`);
      assert.ok(mf.actualArrMin > mf.actualDepMin, 'Arrival minutes must exceed departure minutes');
      assert.equal(mf.actualArrMin - mf.actualDepMin, mf.blockMinutes, 'Block minutes preserved past midnight');
    }
  });

  it('Test 9: Strict Input Validation and Error Handling', () => {
    // Non-existent airport
    assert.throws(
      () =>
        simulator.simulate({
          airportId: 'ZZZ',
          startTime: '08:00',
          durationMinutes: 60,
        }),
      /Unknown airport ID "ZZZ"/
    );

    // Negative duration
    assert.throws(
      () =>
        simulator.simulate({
          airportId: 'DEL',
          startTime: '08:00',
          durationMinutes: -10,
        }),
      /Invalid closure duration "-10"/
    );

    // Malformed start time
    assert.throws(
      () =>
        simulator.simulate({
          airportId: 'DEL',
          startTime: '25:00',
          durationMinutes: 60,
        }),
      /Invalid hours/
    );
  });

  it('Test 10: Spare Aircraft Evaluation Interface (No Magic Swaps)', () => {
    // Evaluate spare VT-DS17 (based at BLR)
    // Valid staging request: target aircraft at BLR
    const evalBlr = simulator.evaluateSpareSubstitution({
      spareTailId: 'VT-DS17',
      targetTailId: 'VT-DS06',
      swapAirport: 'BLR',
      effectiveFromLegOrder: 1, // DS0601 starts at BLR
    });

    assert.equal(evalBlr.isValid, true);
    assert.equal(evalBlr.status, 'NOT_YET_IMPLEMENTED');
    assert.ok(evalBlr.explanation.includes('staged for Stage 3'));

    // Ineligible request: trying to swap VT-DS17 (BLR spare) at DEL
    const evalDel = simulator.evaluateSpareSubstitution({
      spareTailId: 'VT-DS17',
      targetTailId: 'VT-DS01',
      swapAirport: 'DEL',
      effectiveFromLegOrder: 1,
    });

    assert.equal(evalDel.isValid, false);
    assert.equal(evalDel.status, 'INELIGIBLE');
    assert.ok(evalDel.explanation.includes('stationed at BLR'));
  });
});
