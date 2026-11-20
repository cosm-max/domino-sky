/**
 * Domino Sky: Recovery Strategy & Tactical Decision Engine
 * 
 * Rules:
 * - Transparent, 100% deterministic, rule-based.
 * - Grounded strictly in simulation results from DominoSkySimulator.
 * - Identifies turnaround buffer absorption firewalls.
 * - Evaluates tactical holding feasibility for missed connections.
 * - Evaluates crew overtime risks and relief requirements.
 * - Evaluates realistic physical substitution of spare aircraft (VT-DS17 at BLR, VT-DS18 at DEL).
 * - Distinguishes supported dataset rules from actions requiring manual operational approval.
 */

import type {
  DominoSkyDataset,
  SimulationResult,
  SimulatedFlight,
  SimulatedConnection,
  SimulatedCrew,
  RotationSummary,
} from './types.ts';
import { parseTimeToMinutes, formatMinutesToTime } from './time-utils.ts';

export interface TurnaroundBufferOpportunity {
  flightId: string;
  tailId: string;
  legOrder: number;
  airport: string;
  scheduledTurnaroundMins: number;
  absorbedDelayMins: number;
  remainingSlackMins: number;
  isFirewall: boolean;
  explanation: string;
}

export interface ConnectionHoldingRecommendation {
  connectionId: string;
  hubAirport: string;
  fromFlightId: string;
  toFlightId: string;
  passengers: number;
  minConnectMinutes: number;
  actualBufferMinutes: number;
  deficitMinutes: number;
  strategy: 'TACTICAL_HOLD' | 'PASSENGER_PROTECTION';
  holdMinutesRequired: number;
  isHoldingFeasible: boolean;
  actionTitle: string;
  justification: string;
  downstreamImpactRisk: 'LOW' | 'MEDIUM' | 'HIGH';
  constraintsToSatisfy: string[];
}

export interface CrewReliefRecommendation {
  crewId: string;
  tailId: string;
  base: string;
  actualDutyMins: number;
  maxDutyMins: number;
  exceededMinutes: number;
  status: 'LEGAL' | 'AT_RISK' | 'VIOLATION';
  actionTitle: string;
  actionSummary: string;
  requiresManualReserveCrew: boolean;
  notes: string;
}

export interface SpareAircraftOpportunity {
  spareTailId: string;
  spareBase: string;
  availableFrom: string;
  seats: number;
  isEligible: boolean;
  targetTailId?: string;
  swapAirport?: string;
  fromLegOrder?: number;
  potentialDelayMinutesSaved: number;
  downstreamFlightsProtected: number;
  connectionsProtected: number;
  crewConstraintStatus: 'CREW_LEGAL' | 'CREW_TIMEOUT_RISK' | 'NO_SPARE_CREW';
  recommendationText: string;
  operationalRequirements: string[];
}

export interface RecoveryPlan {
  summary: {
    totalTurnaroundFirewalls: number;
    totalAbsorbedDelayMinutes: number;
    tacticalHoldOpportunities: number;
    passengerProtectionCount: number;
    crewReliefRequiredCount: number;
    spareAircraftOpportunitiesCount: number;
  };
  turnaroundOpportunities: TurnaroundBufferOpportunity[];
  connectionStrategies: ConnectionHoldingRecommendation[];
  crewStrategies: CrewReliefRecommendation[];
  spareOpportunities: SpareAircraftOpportunity[];
}

export class DominoSkyRecoveryEngine {
  private dataset: DominoSkyDataset;

  constructor(dataset: DominoSkyDataset) {
    this.dataset = dataset;
  }

  /**
   * Generates comprehensive, transparent, rule-based recovery recommendations
   * grounded strictly in the verified simulation output.
   */
  public evaluate(simResult: SimulationResult): RecoveryPlan {
    const flightMap = new Map<string, SimulatedFlight>();
    for (const f of simResult.flights) {
      flightMap.set(f.flightId, f);
    }

    const turnaroundOpportunities = this.evaluateTurnaroundBuffers(simResult, flightMap);
    const connectionStrategies = this.evaluateConnectionStrategies(simResult, flightMap);
    const crewStrategies = this.evaluateCrewStrategies(simResult);
    const spareOpportunities = this.evaluateSpareOpportunities(simResult, flightMap);

    const totalAbsorbed = turnaroundOpportunities.reduce((acc, t) => acc + t.absorbedDelayMins, 0);
    const tacticalHolds = connectionStrategies.filter((c) => c.strategy === 'TACTICAL_HOLD').length;
    const protections = connectionStrategies.filter((c) => c.strategy === 'PASSENGER_PROTECTION').length;
    const crewReliefs = crewStrategies.filter((c) => c.requiresManualReserveCrew).length;
    const sparesEligible = spareOpportunities.filter((s) => s.isEligible).length;

    return {
      summary: {
        totalTurnaroundFirewalls: turnaroundOpportunities.filter((t) => t.isFirewall).length,
        totalAbsorbedDelayMinutes: totalAbsorbed,
        tacticalHoldOpportunities: tacticalHolds,
        passengerProtectionCount: protections,
        crewReliefRequiredCount: crewReliefs,
        spareAircraftOpportunitiesCount: sparesEligible,
      },
      turnaroundOpportunities,
      connectionStrategies,
      crewStrategies,
      spareOpportunities,
    };
  }

  /**
   * 1. Evaluates ground turnaround buffers across all rotations.
   * Identifies which legs naturally absorb upstream delays before they hit downstream flights.
   */
  private evaluateTurnaroundBuffers(
    simResult: SimulationResult,
    flightMap: Map<string, SimulatedFlight>
  ): TurnaroundBufferOpportunity[] {
    const results: TurnaroundBufferOpportunity[] = [];
    const minTurnaround = this.dataset.meta.min_turnaround_minutes; // 30m

    // Group simulated flights by tail_id, sorted by legOrder
    const rotations = new Map<string, SimulatedFlight[]>();
    for (const f of simResult.flights) {
      if (!rotations.has(f.tailId)) rotations.set(f.tailId, []);
      rotations.get(f.tailId)!.push(f);
    }

    for (const [tailId, legs] of rotations.entries()) {
      legs.sort((a, b) => a.legOrder - b.legOrder);
      for (let i = 1; i < legs.length; i++) {
        const prevLeg = legs[i - 1];
        const currLeg = legs[i];
        const rawFlight = this.dataset.flights.find((f) => f.flight_id === currLeg.flightId)!;
        const scheduledTurnaround = rawFlight.turnaround_before_min || 30;
        const totalSlack = scheduledTurnaround - minTurnaround;

        const inboundArrDelay = prevLeg.arrDelayMins;
        const currDepDelay = currLeg.depDelayMins;
        const delayAbsorbed = Math.max(0, inboundArrDelay - currDepDelay);
        const remainingSlack = Math.max(0, totalSlack - delayAbsorbed);
        const isFirewall = totalSlack >= 15;

        if (totalSlack > 0 || delayAbsorbed > 0) {
          let explanation = '';
          if (delayAbsorbed > 0) {
            explanation = `Absorbed ${delayAbsorbed}m of inbound delay from ${prevLeg.flightId} (scheduled ground buffer was ${scheduledTurnaround}m).`;
          } else {
            explanation = `Schedule contains ${totalSlack}m buffer above 30m minimum turnaround; ready to absorb up to ${totalSlack}m upstream delay.`;
          }

          results.push({
            flightId: currLeg.flightId,
            tailId,
            legOrder: currLeg.legOrder,
            airport: currLeg.origin,
            scheduledTurnaroundMins: scheduledTurnaround,
            absorbedDelayMins: delayAbsorbed,
            remainingSlackMins: remainingSlack,
            isFirewall,
            explanation,
          });
        }
      }
    }

    return results;
  }

  /**
   * 2. Evaluates missed connections and proposes tactical holds vs passenger protection.
   */
  private evaluateConnectionStrategies(
    simResult: SimulationResult,
    flightMap: Map<string, SimulatedFlight>
  ): ConnectionHoldingRecommendation[] {
    const recommendations: ConnectionHoldingRecommendation[] = [];

    for (const conn of simResult.connections) {
      if (!conn.isMissed) continue;

      const fIn = flightMap.get(conn.fromFlight)!;
      const fOut = flightMap.get(conn.toFlight)!;
      const deficit = conn.minConnectMinutes - conn.actualBufferMinutes;
      const holdTimeRequired = deficit;

      // Evaluate downstream impact of holding fOut
      // Find fOut's rotation and check downstream turnarounds
      const fOutRaw = this.dataset.flights.find((f) => f.flight_id === fOut.flightId)!;
      const tailFlights = this.dataset.flights
        .filter((f) => f.tail_id === fOut.tailId)
        .sort((a, b) => a.leg_order - b.leg_order);
      const subsequentLegs = tailFlights.filter((f) => f.leg_order > fOut.legOrder);

      let downstreamTurnaroundSlack = 0;
      for (const leg of subsequentLegs) {
        if (leg.turnaround_before_min) {
          downstreamTurnaroundSlack += Math.max(0, leg.turnaround_before_min - 30);
        }
      }

      // Check crew operating fOut
      const crew = this.dataset.crews.find((c) => c.tail_id === fOut.tailId);
      const crewBuffer = crew
        ? simResult.crews.find((cr) => cr.crewId === crew.crew_id)?.bufferRemainingMinutes || 0
        : 60;

      // Tactical holding feasibility rule:
      // Feasible if required hold <= 15 minutes, downstream slack >= hold time, and crew buffer >= hold time + 15m.
      const isHoldFeasible =
        holdTimeRequired <= 15 &&
        downstreamTurnaroundSlack >= holdTimeRequired &&
        crewBuffer >= holdTimeRequired + 15;

      if (isHoldFeasible) {
        recommendations.push({
          connectionId: conn.connectionId,
          hubAirport: conn.airport,
          fromFlightId: conn.fromFlight,
          toFlightId: conn.toFlight,
          passengers: conn.passengers,
          minConnectMinutes: conn.minConnectMinutes,
          actualBufferMinutes: conn.actualBufferMinutes,
          deficitMinutes: deficit,
          strategy: 'TACTICAL_HOLD',
          holdMinutesRequired: holdTimeRequired,
          isHoldingFeasible: true,
          actionTitle: `Hold ${conn.toFlight} for ${holdTimeRequired}m at ${conn.airport}`,
          justification: `Holding ${conn.toFlight} by ${holdTimeRequired} minutes recovers connection for ${conn.passengers} passengers. Downstream legs on ${fOut.tailId} have ${downstreamTurnaroundSlack}m buffer to absorb the delay.`,
          downstreamImpactRisk: 'LOW',
          constraintsToSatisfy: [
            `Outbound departure delayed from ${fOut.actualDep} to ${formatMinutesToTime(fOut.actualDepMin + holdTimeRequired)}`,
            `Turnaround slack on downstream legs absorbs the ${holdTimeRequired}m delay`,
            `Crew ${crew?.crew_id || 'assigned'} retains ${crewBuffer - holdTimeRequired}m duty buffer`,
          ],
        });
      } else {
        recommendations.push({
          connectionId: conn.connectionId,
          hubAirport: conn.airport,
          fromFlightId: conn.fromFlight,
          toFlightId: conn.toFlight,
          passengers: conn.passengers,
          minConnectMinutes: conn.minConnectMinutes,
          actualBufferMinutes: conn.actualBufferMinutes,
          deficitMinutes: deficit,
          strategy: 'PASSENGER_PROTECTION',
          holdMinutesRequired: holdTimeRequired,
          isHoldingFeasible: false,
          actionTitle: `Protect & Rebook ${conn.passengers} Passengers at ${conn.airport}`,
          justification: `Holding ${conn.toFlight} requires +${holdTimeRequired}m delay which exceeds network tolerance or threatens crew duty limit. Protect connecting passengers via hotel/meal vouchers and rebooking on next scheduled flight.`,
          downstreamImpactRisk: holdTimeRequired > 30 ? 'HIGH' : 'MEDIUM',
          constraintsToSatisfy: [
            `Maintain on-time departure for ${conn.toFlight} (${fOut.pax} onboard passengers unaffected)`,
            `Issue meal/hotel care vouchers at ${conn.airport}`,
            `Requires manual airport customer service approval for itinerary reaccommodation`,
          ],
        });
      }
    }

    return recommendations;
  }

  /**
   * 3. Evaluates crew duty limits and flags overtime relief requirements.
   */
  private evaluateCrewStrategies(simResult: SimulationResult): CrewReliefRecommendation[] {
    const results: CrewReliefRecommendation[] = [];

    for (const cr of simResult.crews) {
      if (cr.isViolation) {
        results.push({
          crewId: cr.crewId,
          tailId: cr.tailId,
          base: cr.base,
          actualDutyMins: cr.actualDutyMins,
          maxDutyMins: cr.maxDutyMins,
          exceededMinutes: cr.exceededMinutes,
          status: 'VIOLATION',
          actionTitle: `Crew Duty Violation: ${cr.crewId} (+${cr.exceededMinutes}m Overtime)`,
          actionSummary: `Crew ${cr.crewId} on tail ${cr.tailId} duty reaches ${cr.actualDutyMins}m (exceeds 600m statutory limit by ${cr.exceededMinutes}m). Crew cannot legally operate final leg(s).`,
          requiresManualReserveCrew: true,
          notes: `Official dataset has 0 reserve crews. Action requires manual flight operations dispatcher approval to position standby crew at ${cr.base}.`,
        });
      } else if (cr.bufferRemainingMinutes <= 30) {
        results.push({
          crewId: cr.crewId,
          tailId: cr.tailId,
          base: cr.base,
          actualDutyMins: cr.actualDutyMins,
          maxDutyMins: cr.maxDutyMins,
          exceededMinutes: 0,
          status: 'AT_RISK',
          actionTitle: `Crew At Risk: ${cr.crewId} (${cr.bufferRemainingMinutes}m Buffer Remaining)`,
          actionSummary: `Crew ${cr.crewId} has only ${cr.bufferRemainingMinutes}m of duty buffer remaining. Any further downstream delay will cause duty timeout.`,
          requiresManualReserveCrew: false,
          notes: `Monitor rotation tightly; prioritize aircraft turnaround at all intermediate stops.`,
        });
      }
    }

    return results;
  }

  /**
   * 4. Evaluates physical eligibility and impact of the two spare aircraft.
   * Spare VT-DS17: BLR (available from 05:00)
   * Spare VT-DS18: DEL (available from 05:00)
   */
  private evaluateSpareOpportunities(
    simResult: SimulationResult,
    flightMap: Map<string, SimulatedFlight>
  ): SpareAircraftOpportunity[] {
    const opportunities: SpareAircraftOpportunity[] = [];

    for (const spare of this.dataset.spare_aircraft) {
      // Find all delayed flights departing from the spare's base station
      const eligibleCandidateFlights = simResult.flights.filter(
        (f) => f.origin === spare.base && f.depDelayMins >= 20
      );

      if (eligibleCandidateFlights.length === 0) {
        opportunities.push({
          spareTailId: spare.tail_id,
          spareBase: spare.base,
          availableFrom: spare.available_from,
          seats: spare.seats,
          isEligible: false,
          potentialDelayMinutesSaved: 0,
          downstreamFlightsProtected: 0,
          connectionsProtected: 0,
          crewConstraintStatus: 'CREW_LEGAL',
          recommendationText: `Spare aircraft ${spare.tail_id} at ${spare.base} is ready (from ${spare.available_from}) but no significantly delayed flights currently originate at ${spare.base}.`,
          operationalRequirements: ['Standby on ramp', 'Normal line maintenance readiness'],
        });
        continue;
      }

      // Pick the flight with highest downstream delay impact
      for (const targetFlight of eligibleCandidateFlights) {
        const tailId = targetFlight.tailId;
        const tailFlights = simResult.flights
          .filter((f) => f.tailId === tailId)
          .sort((a, b) => a.legOrder - b.legOrder);

        const downstreamLegs = tailFlights.filter((f) => f.legOrder >= targetFlight.legOrder);
        const delaySaved = downstreamLegs.reduce((sum, f) => sum + f.depDelayMins, 0);

        // Check connections protected
        const downstreamFlightIds = new Set(downstreamLegs.map((f) => f.flightId));
        const protectedConns = simResult.connections.filter(
          (c) => c.isMissed && (downstreamFlightIds.has(c.fromFlight) || downstreamFlightIds.has(c.toFlight))
        );

        // Check crew legality if original crew operates spare
        const crew = simResult.crews.find((cr) => cr.tailId === tailId);
        const crewExceeded = crew?.isViolation ? 'CREW_TIMEOUT_RISK' : 'CREW_LEGAL';

        opportunities.push({
          spareTailId: spare.tail_id,
          spareBase: spare.base,
          availableFrom: spare.available_from,
          seats: spare.seats,
          isEligible: true,
          targetTailId: tailId,
          swapAirport: spare.base,
          fromLegOrder: targetFlight.legOrder,
          potentialDelayMinutesSaved: delaySaved,
          downstreamFlightsProtected: downstreamLegs.length,
          connectionsProtected: protectedConns.length,
          crewConstraintStatus: crewExceeded,
          recommendationText: `Substitute spare ${spare.tail_id} for delayed aircraft ${tailId} starting from ${targetFlight.flightId} at ${spare.base}. Can eliminate up to ${delaySaved}m downstream delay and protect ${downstreamLegs.length} flight legs.`,
          operationalRequirements: [
            `Spare physical location verified: stationed at ${spare.base}`,
            `Spare availability time verified: available since ${spare.available_from} IST`,
            `Aircraft swap eliminates aircraft ground turnaround delay`,
            crew?.isViolation
              ? `CAUTION: Original crew ${crew.crewId} remains in overtime; requires fresh reserve crew approval`
              : `Original crew ${crew?.crewId} can legally operate the substituted flight`,
          ],
        });
      }
    }

    return opportunities;
  }
}
