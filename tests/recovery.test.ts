import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { DominoSkyDataset } from '../src/types.ts';
import { DominoSkySimulator } from '../src/engine.ts';
import { DominoSkyRecoveryEngine } from '../src/recovery.ts';

const datasetPath = resolve(process.cwd(), 'data/domino_sky.json');
const dataset: DominoSkyDataset = JSON.parse(readFileSync(datasetPath, 'utf8'));

describe('Domino Sky: Recovery Engine & Strategy Evaluation', () => {
  const simulator = new DominoSkySimulator(dataset);
  const recoveryEngine = new DominoSkyRecoveryEngine(dataset);

  it('Baseline schedule has zero violations and standby spares', () => {
    const simBaseline = simulator.simulate({ airportId: null, startTime: '00:00', durationMinutes: 0 });
    const recovery = recoveryEngine.evaluate(simBaseline);

    assert.equal(recovery.summary.tacticalHoldOpportunities, 0);
    assert.equal(recovery.summary.passengerProtectionCount, 0);
    assert.equal(recovery.summary.crewReliefRequiredCount, 0);
    assert.equal(recovery.summary.spareAircraftOpportunitiesCount, 0);
    assert.ok(recovery.turnaroundOpportunities.length > 0, 'Should identify scheduled turnaround buffers');
  });

  it('Identifies turnaround buffer firewalls under disruption', () => {
    // Disruption at DEL from 08:00 for 60m
    const simResult = simulator.simulate({ airportId: 'DEL', startTime: '08:00', durationMinutes: 60 });
    const recovery = recoveryEngine.evaluate(simResult);

    // DS0104 on VT-DS01 has scheduled turnaround of 70m (40m slack above 30m)
    const ds0104Turnaround = recovery.turnaroundOpportunities.find((t) => t.flightId === 'DS0104');
    assert.ok(ds0104Turnaround);
    assert.equal(ds0104Turnaround.isFirewall, true);
    assert.ok(ds0104Turnaround.absorbedDelayMins > 0, 'DS0104 should absorb delay from DS0103');
    assert.ok(recovery.summary.totalAbsorbedDelayMinutes > 0);
  });

  it('Differentiates tactical connection hold vs passenger protection', () => {
    // BOM closed 07:30 for 90m produces 6 missed connections
    const simResult = simulator.simulate({ airportId: 'BOM', startTime: '07:30', durationMinutes: 90 });
    const recovery = recoveryEngine.evaluate(simResult);

    assert.ok(recovery.connectionStrategies.length >= 6);

    for (const cs of recovery.connectionStrategies) {
      assert.ok(['TACTICAL_HOLD', 'PASSENGER_PROTECTION'].includes(cs.strategy));
      assert.ok(cs.actionTitle.length > 0);
      assert.ok(cs.constraintsToSatisfy.length > 0);
      if (cs.strategy === 'PASSENGER_PROTECTION') {
        assert.ok(cs.constraintsToSatisfy.some((c) => c.includes('approval')));
      }
    }
  });

  it('Flags crew duty violations and manual reserve crew requirements', () => {
    // DEL closed 12:00 for 60m causes CR03 to exceed duty limit
    const simResult = simulator.simulate({ airportId: 'DEL', startTime: '12:00', durationMinutes: 60 });
    const recovery = recoveryEngine.evaluate(simResult);

    const cr03Relief = recovery.crewStrategies.find((c) => c.crewId === 'CR03');
    assert.ok(cr03Relief);
    assert.equal(cr03Relief.status, 'VIOLATION');
    assert.equal(cr03Relief.requiresManualReserveCrew, true);
    assert.ok(cr03Relief.notes.includes('0 reserve crews'));
  });

  it('Evaluates spare aircraft substitution at base stations', () => {
    // Disruption at DEL creates delayed departures from DEL
    const simResult = simulator.simulate({ airportId: 'DEL', startTime: '08:00', durationMinutes: 60 });
    const recovery = recoveryEngine.evaluate(simResult);

    // Spare VT-DS18 is stationed at DEL
    const vtDs18 = recovery.spareOpportunities.find((s) => s.spareTailId === 'VT-DS18');
    assert.ok(vtDs18);
    assert.equal(vtDs18.spareBase, 'DEL');

    // Spare VT-DS17 is stationed at BLR
    const vtDs17 = recovery.spareOpportunities.find((s) => s.spareTailId === 'VT-DS17');
    assert.ok(vtDs17);
    assert.equal(vtDs17.spareBase, 'BLR');
    assert.equal(vtDs17.isEligible, false, 'VT-DS17 cannot be deployed for DEL-originating flights');
  });
});
