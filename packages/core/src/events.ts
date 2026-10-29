import { z } from 'zod';
import { DecisionActionSchema, DecisionSchema } from './decision.js';
import {
  IdSchema,
  JsonObjectSchema,
  JsonPointerSchema,
  JsonValueSchema,
  SCHEMA_VERSION,
  ServerIdSchema,
  Sha256HexSchema,
  TimestampSchema,
  TransportSchema,
} from './primitives.js';
import { ProvenanceReportSchema } from './provenance.js';
import { SourceSchema } from './trust.js';

const Envelope = {
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: IdSchema,
  ts: TimestampSchema,
  sessionId: IdSchema,
};

export const ClientInfoSchema = z.strictObject({
  name: z.string(),
  version: z.string(),
});

export const ServerRefSchema = z.strictObject({
  id: ServerIdSchema,
  /** Name and version the upstream reported about itself (untrusted, informational). */
  name: z.string().nullable(),
  version: z.string().nullable(),
  transport: TransportSchema,
});

/** Which fields were changed before storage, and under which redaction rule set. */
export const RedactionSchema = z.strictObject({
  ruleVersion: z.int().nonnegative(),
  applied: z.array(
    z.strictObject({
      path: JsonPointerSchema,
      method: z.enum(['removed', 'hmac-sha256']),
    }),
  ),
});

/** JSON-RPC request id, as sent by the client. */
export const RequestIdSchema = z.union([z.string(), z.int()]);

export const SessionStartedEventSchema = z.strictObject({
  ...Envelope,
  type: z.literal('session.started'),
  client: ClientInfoSchema.nullable(),
  /** Negotiated MCP protocol revision, e.g. "2025-11-25" or "2026-07-28". */
  protocolVersion: z.string().nullable(),
  transport: TransportSchema,
});

export const SessionEndedEventSchema = z.strictObject({
  ...Envelope,
  type: z.literal('session.ended'),
  reason: z.enum(['client-closed', 'gateway-shutdown', 'error']),
});

export const ToolCallEventSchema = z.strictObject({
  ...Envelope,
  type: z.literal('tool.call'),
  client: ClientInfoSchema.nullable(),
  server: ServerRefSchema,
  /** Tool name as the upstream server knows it (not the namespaced name the client saw). */
  tool: z.string().min(1),
  requestId: RequestIdSchema,
  /** SHA-256 of the exact JSON-RPC message text the client sent (a commitment to the raw bytes). */
  rawSha256: Sha256HexSchema,
  /** Arguments after redaction. */
  arguments: JsonObjectSchema,
  redaction: RedactionSchema,
  /** Null when no provenance analysis ran (the provenance engine arrives in Phase 3). */
  provenance: ProvenanceReportSchema.nullable(),
  decision: DecisionSchema,
});

export const ToolResultEventSchema = z.strictObject({
  ...Envelope,
  type: z.literal('tool.result'),
  callEventId: IdSchema,
  server: ServerRefSchema,
  tool: z.string().min(1),
  outcome: z.enum([
    'ok',
    'tool-error',
    'protocol-error',
    'blocked',
    'denied',
    'timeout',
    'cancelled',
  ]),
  /** SHA-256 of the exact JSON-RPC response text the upstream sent; null if it never answered. */
  rawSha256: Sha256HexSchema.nullable(),
  /** JSON-RPC error from the upstream (protocol-error outcome); null otherwise. */
  error: z.strictObject({ code: z.int(), message: z.string() }).nullable(),
  /** Result after redaction; null when the call never reached the upstream. */
  result: JsonValueSchema.nullable(),
  /** True when `result` was cut to the configured storage limit. */
  truncated: z.boolean(),
  /** SHA-256 of the canonical JSON of the full redacted result, before truncation. */
  resultSha256: Sha256HexSchema.nullable(),
  /** The source record created from this result, or null if it was not recorded as a source. */
  source: SourceSchema.nullable(),
  durationMs: z.number().nonnegative(),
});

export const ApprovalResolvedEventSchema = z.strictObject({
  ...Envelope,
  type: z.literal('approval.resolved'),
  approvalId: IdSchema,
  callEventId: IdSchema,
  /** SHA-256 of the canonical JSON of the exact (pre-redaction) arguments that were approved. */
  argumentsSha256: Sha256HexSchema,
  outcome: z.enum(['approved', 'denied', 'timed-out']),
  /** Final action the gateway took for the call. */
  resultingAction: DecisionActionSchema,
  channel: z.enum(['cli', 'web-ui', 'desktop', 'timeout']),
});

export const PolicyLoadedEventSchema = z.strictObject({
  ...Envelope,
  type: z.literal('policy.loaded'),
  policySha256: Sha256HexSchema,
  policyName: z.string().min(1),
  /** Policy document version (the `version` field inside the policy file). */
  policyVersion: z.int().positive(),
});

export const EventSchema = z.discriminatedUnion('type', [
  SessionStartedEventSchema,
  SessionEndedEventSchema,
  ToolCallEventSchema,
  ToolResultEventSchema,
  ApprovalResolvedEventSchema,
  PolicyLoadedEventSchema,
]);
export type Event = z.infer<typeof EventSchema>;
export type EventType = Event['type'];
export type ToolCallEvent = z.infer<typeof ToolCallEventSchema>;
export type ToolResultEvent = z.infer<typeof ToolResultEventSchema>;
