/**
 * Domino Sky: Types and Domain Models
 * Source of truth: data/domino_sky.json
 */

export interface Airport {
  id: string;
  name: string;
  city: string;
  lat: number;
  lng: number;
  tier: 'mega_hub' | 'regional_hub' | 'spoke';
  capacity_per_hour: number;
}

export interface Flight {
  flight_id: string;
  tail_id: string;
  leg_order: number;
  origin: string;
  destination: string;
  dep: string;
  arr: string;
  block_minutes: number;
  pax: number;
  turnaround_before_min: number | null;
}

export interface Connection {
  connection_id: string;
  airport: string;
  from_flight: string;
  to_flight: string;
  passengers: number;
  min_connect_minutes: number;
}

export interface Crew {
  crew_id: string;
  tail_id: string;
  base: string;
  duty_start: string;
  max_duty_mins: number;
  flight_ids: string[];
}

export interface SpareAircraft {
  tail_id: string;
  base: string;
  available_from: string;
  seats: number;
}

export interface DatasetMeta {
  dataset: string;
  operating_day: string;
  min_turnaround_minutes: number;
  seats_per_aircraft: number;
  notes: string[];
}

export interface DominoSkyDataset {
  meta: DatasetMeta;
  airports: Airport[];
  flights: Flight[];
  connections: Connection[];
  crews: Crew[];
  spare_aircraft: SpareAircraft[];
}

export interface ClosureInput {
  airportId: string | null;
  startTime: string; // "HH:MM"
  durationMinutes: number; // minutes >= 0
}

export interface SimulatedFlight {
  flightId: string;
  tailId: string;
  legOrder: number;
  origin: string;
  destination: string;
  scheduledDep: string;
  scheduledArr: string;
  scheduledDepMin: number;
  scheduledArrMin: number;
  actualDep: string;
  actualArr: string;
  actualDepMin: number;
  actualArrMin: number;
  depDelayMins: number;
  arrDelayMins: number;
  blockMinutes: number;
  pax: number;
  isDelayed: boolean;
  delayReasons: string[];
}

export interface SimulatedConnection {
  connectionId: string;
  airport: string;
  fromFlight: string;
  toFlight: string;
  passengers: number;
  minConnectMinutes: number;
  scheduledBufferMinutes: number;
  actualBufferMinutes: number;
  actualInboundArr: string;
  actualOutboundDep: string;
  isMissed: boolean;
}

export interface SimulatedCrew {
  crewId: string;
  tailId: string;
  base: string;
  dutyStart: string;
  dutyStartMin: number;
  scheduledDutyEnd: string;
  scheduledDutyMins: number;
  actualDutyEnd: string;
  actualDutyMins: number;
  maxDutyMins: number;
  isViolation: boolean;
  exceededMinutes: number;
  bufferRemainingMinutes: number;
  flightsOperated: string[];
}

export interface RotationSummary {
  tailId: string;
  totalFlights: number;
  delayedFlights: number;
  totalDelayMinutes: number;
  maxDelayMinutes: number;
}

export interface SimulationSummary {
  totalFlights: number;
  delayedFlightsCount: number;
  onTimeFlightsCount: number;
  totalFlightDelayMinutes: number;
  averageDelayMinutes: number;
  delayedFlightPassengers: number;
  totalConnections: number;
  missedConnectionsCount: number;
  missedConnectionPassengers: number;
  crewsEvaluated: number;
  crewViolationsCount: number;
  totalCrewExceededMinutes: number;
  affectedRotationsCount: number;
  closureDetails: {
    airportId: string | null;
    startTime: string | null;
    endTime: string | null;
    durationMinutes: number;
  };
  metricsDisclaimer: string;
}

export interface SimulationResult {
  summary: SimulationSummary;
  flights: SimulatedFlight[];
  connections: SimulatedConnection[];
  crews: SimulatedCrew[];
  rotations: RotationSummary[];
}

export interface SpareSubstitutionRequest {
  spareTailId: string;
  targetTailId: string;
  swapAirport: string;
  effectiveFromLegOrder: number;
}

export interface SpareSubstitutionEvaluation {
  isValid: boolean;
  validationErrors: string[];
  spareTailId: string;
  targetTailId: string;
  swapAirport: string;
  effectiveFromLegOrder: number;
  status: 'ELIGIBLE' | 'INELIGIBLE' | 'NOT_YET_IMPLEMENTED';
  explanation: string;
}

// Stage 4: AI Dispatcher Types
export interface AIDispatcherStatus {
  available: boolean;
  model: string;
  reason?: string;
}

export interface AIDispatcherRecommendation {
  recommendation_id: string;
  title: string;
  category: 'aircraft_rotation' | 'turnaround_buffer' | 'connection_protection' | 'crew_duty' | 'spare_aircraft';
  explanation: string;
  evidence: string;
  affected_flights: string[];
  affected_aircraft: string[];
  feasibility: 'high' | 'medium' | 'low' | 'manual_approval_required';
  operational_constraints: string[];
  expected_benefit: string;
  limitations: string;
  can_preview: boolean;
  preview_type?: 'spare_aircraft_substitution' | 'connection_hold' | 'turnaround_firewall' | 'unsupported';
  preview_payload?: any;
}

export interface AIDispatcherAnalysis {
  status: 'success' | 'AI_UNAVAILABLE' | 'error';
  scenario_summary: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  key_findings: string[];
  root_causes: {
    flight_id: string;
    tail_id: string;
    explanation: string;
  }[];
  recommendations: AIDispatcherRecommendation[];
  limitations: string[];
  model_used?: string;
}

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
}

export interface AIChatResponse {
  status: 'success' | 'AI_UNAVAILABLE' | 'error';
  response: string;
  question: string;
  grounded_context_summary?: string;
  model_used?: string;
  error?: string;
}

export interface PreviewProposal {
  actionType: 'spare_aircraft_substitution' | 'connection_hold' | 'turnaround_firewall' | 'unsupported';
  payload: any;
}

export interface PreviewResult {
  supported: boolean;
  title: string;
  actionSummary: string;
  before: {
    totalDelayMinutes: number;
    delayedFlightsCount: number;
    missedConnectionsCount: number;
    delayedFlightPassengers: number;
    missedConnectionPassengers: number;
    crewViolationsCount: number;
  };
  after: {
    totalDelayMinutes: number;
    delayedFlightsCount: number;
    missedConnectionsCount: number;
    delayedFlightPassengers: number;
    missedConnectionPassengers: number;
    crewViolationsCount: number;
  };
  delta: {
    delayMinutesSaved: number;
    delayedFlightsReduced: number;
    missedConnectionsSaved: number;
    passengersProtected: number;
    crewViolationsPrevented: number;
  };
  constraints: string[];
  unsupportedReason?: string;
}
