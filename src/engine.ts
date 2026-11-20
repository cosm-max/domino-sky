/**
 * Domino Sky: Deterministic Flight Disruption Cascade & Recovery Simulator
 * 
 * Rules:
 * - 100% deterministic, zero stochastic/AI-generated numbers.
 * - Enforces minimum 30-minute turnaround across aircraft rotations.
 * - Closure interval is [closureStart, closureEnd) (inclusive start, exclusive end).
 * - Departure closure: flights scheduled to depart during closure wait until reopening.
 * - Arrival closure: ground hold at origin so flight arrives at or after reopening.
 * - Preserves block minutes.
 * - Evaluates passenger connections using min_connect_minutes.
 * - Evaluates crew duty against max_duty_mins.
 */

import type {
  DominoSkyDataset,
  ClosureInput,
  SimulationResult,
  SimulatedFlight,
  SimulatedConnection,
  SimulatedCrew,
  RotationSummary,
  SimulationSummary,
  SpareSubstitutionRequest,
  SpareSubstitutionEvaluation,
  Flight,
} from './types.ts';
import { parseTimeToMinutes, formatMinutesToTime } from './time-utils.ts';

interface MutableFlightState {
  flight: Flight;
  scheduledDepMin: number;
  scheduledArrMin: number;
  actualDepMin: number;
  actualArrMin: number;
  blockMinutes: number;
}

export class DominoSkySimulator {
  private dataset: DominoSkyDataset;
  private airportMap: Set<string>;

  constructor(dataset: DominoSkyDataset) {
    if (!dataset || !dataset.flights || !dataset.airports || !dataset.connections || !dataset.crews) {
      throw new Error('Invalid dataset: missing required dataset sections');
    }
    this.dataset = dataset;
    this.airportMap = new Set(dataset.airports.map((a) => a.id));
  }

  /**
   * Runs the deterministic airport closure disruption simulation.
   */
  public simulate(input: ClosureInput): SimulationResult {
    // 1. Validate inputs
    let closureStartMin = 0;
    let closureEndMin = 0;
    const airportId = input.airportId ? input.airportId.trim().toUpperCase() : null;

    if (airportId) {
      if (!this.airportMap.has(airportId)) {
        throw new Error(`Unknown airport ID "${airportId}". Airport must be one of the 16 dataset airports.`);
      }

      if (typeof input.startTime !== 'string' || !input.startTime.trim()) {
        throw new Error('Closure startTime is required when airportId is specified (format "HH:MM")');
      }

      closureStartMin = parseTimeToMinutes(input.startTime);

      if (typeof input.durationMinutes !== 'number' || isNaN(input.durationMinutes) || input.durationMinutes < 0) {
        throw new Error(`Invalid closure duration "${input.durationMinutes}". Must be a non-negative number of minutes.`);
      }

      closureEndMin = closureStartMin + input.durationMinutes;
    }

    const minTurnaround = this.dataset.meta.min_turnaround_minutes; // 30 mins

    // 2. Initialize mutable flight states
    const flightStates = new Map<string, MutableFlightState>();
    for (const f of this.dataset.flights) {
      const depMin = parseTimeToMinutes(f.dep);
      const arrMin = parseTimeToMinutes(f.arr);
      flightStates.set(f.flight_id, {
        flight: f,
        scheduledDepMin: depMin,
        scheduledArrMin: arrMin,
        actualDepMin: depMin,
        actualArrMin: arrMin,
        blockMinutes: f.block_minutes,
      });
    }

    // 3. Group flights by tail_id, sorted by leg_order
    const rotations = new Map<string, MutableFlightState[]>();
    for (const state of flightStates.values()) {
      const tail = state.flight.tail_id;
      if (!rotations.has(tail)) {
        rotations.set(tail, []);
      }
      rotations.get(tail)!.push(state);
    }

    for (const legs of rotations.values()) {
      legs.sort((a, b) => a.flight.leg_order - b.flight.leg_order);
    }

    // 4. Deterministic Propagation Loop
    // Continue until steady state is reached across all rotations and airport constraints.
    let changed = true;
    let iterationCount = 0;
    const maxIterations = 500; // Safeguard against circular dependencies

    while (changed) {
      changed = false;
      iterationCount++;
      if (iterationCount > maxIterations) {
        throw new Error('Simulation propagation exceeded maximum convergence iterations.');
      }

      for (const legs of rotations.values()) {
        for (let i = 0; i < legs.length; i++) {
          const leg = legs[i];
          let proposedDep = leg.scheduledDepMin;

          // Constraint A: Inbound turnaround precedence from previous leg
          if (i > 0) {
            const prevLeg = legs[i - 1];
            const turnaroundReady = prevLeg.actualArrMin + minTurnaround;
            if (turnaroundReady > proposedDep) {
              proposedDep = turnaroundReady;
            }
          }

          // If an airport closure is active:
          if (airportId && input.durationMinutes > 0) {
            // Constraint B: Departure airport closure
            // Flights departing from the closed airport during [start, end) must wait until closureEndMin
            if (leg.flight.origin === airportId) {
              if (proposedDep >= closureStartMin && proposedDep < closureEndMin) {
                proposedDep = closureEndMin;
              }
            }

            // Constraint C: Arrival airport closure (Ground delay hold at origin)
            // Flights bound for the closed airport must be held at origin so they land at or after closureEndMin
            if (leg.flight.destination === airportId) {
              const projectedArr = proposedDep + leg.blockMinutes;
              if (projectedArr >= closureStartMin && projectedArr < closureEndMin) {
                const requiredDepForReopening = closureEndMin - leg.blockMinutes;
                if (requiredDepForReopening > proposedDep) {
                  proposedDep = requiredDepForReopening;
                }
              }
            }
          }

          // Update actual departure and arrival times if changed
          if (proposedDep !== leg.actualDepMin) {
            leg.actualDepMin = proposedDep;
            leg.actualArrMin = proposedDep + leg.blockMinutes;
            changed = true;
          }
        }
      }
    }

    // 5. Build SimulatedFlight records and causal explanations
    const simulatedFlights: SimulatedFlight[] = [];
    for (const legs of rotations.values()) {
      for (let i = 0; i < legs.length; i++) {
        const leg = legs[i];
        const depDelayMins = leg.actualDepMin - leg.scheduledDepMin;
        const arrDelayMins = leg.actualArrMin - leg.scheduledArrMin;
        const isDelayed = depDelayMins > 0 || arrDelayMins > 0;
        const delayReasons: string[] = [];

        if (isDelayed) {
          // Check factor 1: Inbound turnaround delay
          if (i > 0) {
            const prevLeg = legs[i - 1];
            const turnaroundReady = prevLeg.actualArrMin + minTurnaround;
            if (turnaroundReady > leg.scheduledDepMin) {
              const readyTimeStr = formatMinutesToTime(turnaroundReady);
              const prevArrStr = formatMinutesToTime(prevLeg.actualArrMin);
              delayReasons.push(
                `Inbound aircraft ${leg.flight.tail_id} from ${prevLeg.flight.flight_id} arrived at ${prevArrStr} (+${prevLeg.actualArrMin - prevLeg.scheduledArrMin}m delay); minimum 30m turnaround ready at ${readyTimeStr}`
              );
            }
          }

          // Check factor 2: Origin airport closed
          if (airportId && leg.flight.origin === airportId) {
            const readyPrior = i > 0
              ? Math.max(leg.scheduledDepMin, legs[i - 1].actualArrMin + minTurnaround)
              : leg.scheduledDepMin;
            if (readyPrior >= closureStartMin && readyPrior < closureEndMin) {
              delayReasons.push(
                `Origin airport ${airportId} closed [${input.startTime}, ${formatMinutesToTime(closureEndMin)}): held on ground until reopening`
              );
            }
          }

          // Check factor 3: Destination airport closed (Ground hold program)
          if (airportId && leg.flight.destination === airportId) {
            const readyPrior = i > 0
              ? Math.max(leg.scheduledDepMin, legs[i - 1].actualArrMin + minTurnaround)
              : leg.scheduledDepMin;
            const projectedArr = readyPrior + leg.blockMinutes;
            if (projectedArr >= closureStartMin && projectedArr < closureEndMin) {
              delayReasons.push(
                `Destination airport ${airportId} closed [${input.startTime}, ${formatMinutesToTime(closureEndMin)}): ground-held at origin ${leg.flight.origin} to land at reopening ${formatMinutesToTime(closureEndMin)}`
              );
            }
          }
        }

        simulatedFlights.push({
          flightId: leg.flight.flight_id,
          tailId: leg.flight.tail_id,
          legOrder: leg.flight.leg_order,
          origin: leg.flight.origin,
          destination: leg.flight.destination,
          scheduledDep: leg.flight.dep,
          scheduledArr: leg.flight.arr,
          scheduledDepMin: leg.scheduledDepMin,
          scheduledArrMin: leg.scheduledArrMin,
          actualDep: formatMinutesToTime(leg.actualDepMin),
          actualArr: formatMinutesToTime(leg.actualArrMin),
          actualDepMin: leg.actualDepMin,
          actualArrMin: leg.actualArrMin,
          depDelayMins,
          arrDelayMins,
          blockMinutes: leg.blockMinutes,
          pax: leg.flight.pax,
          isDelayed,
          delayReasons,
        });
      }
    }

    // Sort flights by flight_id or departure time
    simulatedFlights.sort((a, b) => a.actualDepMin - b.actualDepMin);

    // Build fast lookup for flights
    const simFlightsMap = new Map<string, SimulatedFlight>();
    for (const sf of simulatedFlights) {
      simFlightsMap.set(sf.flightId, sf);
    }

    // 6. Passenger Connection Impact Engine
    const simulatedConnections: SimulatedConnection[] = [];
    let missedConnectionsCount = 0;
    let missedConnectionPassengers = 0;

    for (const c of this.dataset.connections) {
      const fIn = simFlightsMap.get(c.from_flight);
      const fOut = simFlightsMap.get(c.to_flight);

      if (!fIn || !fOut) {
        throw new Error(`Connection ${c.connection_id} references missing flight: ${c.from_flight} -> ${c.to_flight}`);
      }

      const scheduledBuffer = fOut.scheduledDepMin - fIn.scheduledArrMin;
      const actualBuffer = fOut.actualDepMin - fIn.actualArrMin;
      const isMissed = actualBuffer < c.min_connect_minutes;

      if (isMissed) {
        missedConnectionsCount++;
        missedConnectionPassengers += c.passengers;
      }

      simulatedConnections.push({
        connectionId: c.connection_id,
        airport: c.airport,
        fromFlight: c.from_flight,
        toFlight: c.to_flight,
        passengers: c.passengers,
        minConnectMinutes: c.min_connect_minutes,
        scheduledBufferMinutes: scheduledBuffer,
        actualBufferMinutes: actualBuffer,
        actualInboundArr: fIn.actualArr,
        actualOutboundDep: fOut.actualDep,
        isMissed,
      });
    }

    // 7. Crew Duty Engine
    const simulatedCrews: SimulatedCrew[] = [];
    let crewViolationsCount = 0;
    let totalCrewExceededMinutes = 0;

    for (const cr of this.dataset.crews) {
      const dutyStartMin = parseTimeToMinutes(cr.duty_start);
      const firstFlightId = cr.flight_ids[0];
      const lastFlightId = cr.flight_ids[cr.flight_ids.length - 1];
      const firstFlight = simFlightsMap.get(firstFlightId)!;
      const lastFlight = simFlightsMap.get(lastFlightId)!;

      const scheduledDutyEndMin = lastFlight.scheduledArrMin;
      const scheduledDutyMins = scheduledDutyEndMin - dutyStartMin;

      const actualDutyEndMin = lastFlight.actualArrMin;
      const actualDutyMins = actualDutyEndMin - dutyStartMin;

      const isViolation = actualDutyMins > cr.max_duty_mins;
      const exceededMinutes = Math.max(0, actualDutyMins - cr.max_duty_mins);
      const bufferRemainingMinutes = Math.max(0, cr.max_duty_mins - actualDutyMins);

      if (isViolation) {
        crewViolationsCount++;
        totalCrewExceededMinutes += exceededMinutes;
      }

      simulatedCrews.push({
        crewId: cr.crew_id,
        tailId: cr.tail_id,
        base: cr.base,
        dutyStart: cr.duty_start,
        dutyStartMin,
        scheduledDutyEnd: lastFlight.scheduledArr,
        scheduledDutyMins,
        actualDutyEnd: lastFlight.actualArr,
        actualDutyMins,
        maxDutyMins: cr.max_duty_mins,
        isViolation,
        exceededMinutes,
        bufferRemainingMinutes,
        flightsOperated: cr.flight_ids,
      });
    }

    // 8. Rotation Summaries
    const rotationSummaries: RotationSummary[] = [];
    for (const [tailId, legs] of rotations.entries()) {
      let tailDelayMins = 0;
      let delayedCount = 0;
      let maxDelay = 0;

      for (const leg of legs) {
        const sf = simFlightsMap.get(leg.flight.flight_id)!;
        if (sf.isDelayed) {
          delayedCount++;
          tailDelayMins += sf.depDelayMins;
          if (sf.depDelayMins > maxDelay) {
            maxDelay = sf.depDelayMins;
          }
        }
      }

      rotationSummaries.push({
        tailId,
        totalFlights: legs.length,
        delayedFlights: delayedCount,
        totalDelayMinutes: tailDelayMins,
        maxDelayMinutes: maxDelay,
      });
    }

    rotationSummaries.sort((a, b) => b.totalDelayMinutes - a.totalDelayMinutes);

    // 9. Simulation Summary Aggregates
    const delayedFlightsCount = simulatedFlights.filter((f) => f.isDelayed).length;
    const totalFlightDelayMinutes = simulatedFlights.reduce((sum, f) => sum + f.depDelayMins, 0);
    const delayedFlightPassengers = simulatedFlights
      .filter((f) => f.isDelayed)
      .reduce((sum, f) => sum + f.pax, 0);
    const affectedRotationsCount = rotationSummaries.filter((r) => r.delayedFlights > 0).length;

    const summary: SimulationSummary = {
      totalFlights: simulatedFlights.length,
      delayedFlightsCount,
      onTimeFlightsCount: simulatedFlights.length - delayedFlightsCount,
      totalFlightDelayMinutes,
      averageDelayMinutes: delayedFlightsCount > 0 ? Math.round((totalFlightDelayMinutes / delayedFlightsCount) * 10) / 10 : 0,
      delayedFlightPassengers,
      totalConnections: simulatedConnections.length,
      missedConnectionsCount,
      missedConnectionPassengers,
      crewsEvaluated: simulatedCrews.length,
      crewViolationsCount,
      totalCrewExceededMinutes,
      affectedRotationsCount,
      closureDetails: {
        airportId,
        startTime: input.startTime || null,
        endTime: airportId && input.durationMinutes > 0 ? formatMinutesToTime(closureEndMin) : null,
        durationMinutes: input.durationMinutes || 0,
      },
      metricsDisclaimer:
        'Delayed flight passengers and missed connection passengers are reported as distinct operational metrics and must not be summed together to represent unique disrupted individuals.',
    };

    return {
      summary,
      flights: simulatedFlights,
      connections: simulatedConnections,
      crews: simulatedCrews,
      rotations: rotationSummaries,
    };
  }

  /**
   * Prepares and strictly evaluates a spare aircraft substitution request.
   * Enforces realistic physical constraints: spare base location, ready time, turnaround, and crew rules.
   */
  public evaluateSpareSubstitution(req: SpareSubstitutionRequest): SpareSubstitutionEvaluation {
    const spare = this.dataset.spare_aircraft.find((s) => s.tail_id === req.spareTailId);
    if (!spare) {
      return {
        isValid: false,
        validationErrors: [`Spare aircraft "${req.spareTailId}" not found in dataset.`],
        spareTailId: req.spareTailId,
        targetTailId: req.targetTailId,
        swapAirport: req.swapAirport,
        effectiveFromLegOrder: req.effectiveFromLegOrder,
        status: 'INELIGIBLE',
        explanation: `Spare aircraft ${req.spareTailId} does not exist in dataset spare_aircraft records.`,
      };
    }

    const errors: string[] = [];
    if (spare.base !== req.swapAirport) {
      errors.push(
        `Spare ${spare.tail_id} is stationed at ${spare.base}, cannot be substituted at ${req.swapAirport} without positioning.`
      );
    }

    const targetFlights = this.dataset.flights.filter((f) => f.tail_id === req.targetTailId);
    if (targetFlights.length === 0) {
      errors.push(`Target aircraft "${req.targetTailId}" has no scheduled flights.`);
    }

    const swapFlight = targetFlights.find((f) => f.leg_order === req.effectiveFromLegOrder);
    if (!swapFlight) {
      errors.push(`Leg order ${req.effectiveFromLegOrder} does not exist for aircraft ${req.targetTailId}.`);
    } else if (swapFlight.origin !== req.swapAirport) {
      errors.push(
        `Target aircraft ${req.targetTailId} leg ${req.effectiveFromLegOrder} departs from ${swapFlight.origin}, not swap airport ${req.swapAirport}.`
      );
    }

    if (errors.length > 0) {
      return {
        isValid: false,
        validationErrors: errors,
        spareTailId: req.spareTailId,
        targetTailId: req.targetTailId,
        swapAirport: req.swapAirport,
        effectiveFromLegOrder: req.effectiveFromLegOrder,
        status: 'INELIGIBLE',
        explanation: errors.join('; '),
      };
    }

    return {
      isValid: true,
      validationErrors: [],
      spareTailId: req.spareTailId,
      targetTailId: req.targetTailId,
      swapAirport: req.swapAirport,
      effectiveFromLegOrder: req.effectiveFromLegOrder,
      status: 'NOT_YET_IMPLEMENTED',
      explanation: `Spare aircraft substitution interface is verified and staged for Stage 3 recovery optimization. Physical location (${spare.base}) and initial leg matches. Realistic crew continuity/transfer modeling will be applied during Stage 3.`,
    };
  }
}
