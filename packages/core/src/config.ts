import { z } from 'zod';
import { ModeSchema } from './decision.js';
import { JsonPointerSchema, SCHEMA_VERSION, ServerIdSchema } from './primitives.js';

/**
 * A config value: either a literal or a reference to an environment variable.
 * Secrets must use `{ fromEnv }` so config files never contain them.
 */
export const EnvValueSchema = z.union([
  z.string(),
  z.strictObject({ fromEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }),
]);
export type EnvValue = z.infer<typeof EnvValueSchema>;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** https anywhere; plain http only to loopback, so credentials never cross the network in clear. */
const UpstreamUrlSchema = z.url().refine(
  (raw) => {
    const u = new URL(raw);
    return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname));
  },
  { message: 'upstream URL must be https, or http to 127.0.0.1 / localhost / [::1]' },
);

export const StdioUpstreamSchema = z.strictObject({
  id: ServerIdSchema,
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), EnvValueSchema).default({}),
  cwd: z.string().min(1).optional(),
});

export const HttpUpstreamSchema = z.strictObject({
  id: ServerIdSchema,
  transport: z.literal('streamable-http'),
  url: UpstreamUrlSchema,
  headers: z.record(z.string(), EnvValueSchema).default({}),
});

export const UpstreamSchema = z.discriminatedUnion('transport', [
  StdioUpstreamSchema,
  HttpUpstreamSchema,
]);
export type Upstream = z.infer<typeof UpstreamSchema>;

/** Glob over names: `*` matches any run of characters; everything else is literal. */
const GlobSchema = z.string().min(1);

export const RedactionRuleSchema = z.strictObject({
  server: GlobSchema.default('*'),
  tool: GlobSchema.default('*'),
  /** Applies to the tool-call arguments, the tool result, or both. */
  target: z.enum(['arguments', 'result', 'both']).default('both'),
  path: JsonPointerSchema,
  method: z.enum(['removed', 'hmac-sha256']),
});

export const ConfigSchema = z
  .strictObject({
    schemaVersion: z.literal(SCHEMA_VERSION),
    /** Observe by default: log what would happen, block nothing, until the user opts in. */
    mode: ModeSchema.default('observe'),
    upstreams: z.array(UpstreamSchema).min(1),
    trust: z
      .strictObject({
        /** Tools whose output is labelled `trusted-tool`. Everything else is `untrusted`. */
        trustedTools: z.array(z.strictObject({ server: GlobSchema, tool: GlobSchema })).default([]),
      })
      .prefault({}),
    policy: z.strictObject({ path: z.string().min(1) }),
    ledger: z.strictObject({
      path: z.string().min(1),
      checkpoint: z
        .strictObject({
          everyEntries: z.int().min(1).max(65536).default(256),
          everySeconds: z.int().min(1).max(86400).default(60),
        })
        .prefault({}),
      /** Stored result size limit in bytes of canonical JSON; larger results are truncated. */
      maxStoredResultBytes: z.int().min(1024).default(262144),
    }),
    redaction: z
      .strictObject({
        ruleVersion: z.int().nonnegative().default(1),
        rules: z.array(RedactionRuleSchema).default([]),
      })
      .prefault({}),
    failure: z
      .strictObject({
        /**
         * Verdict when policy evaluation fails on a call that touches no sink.
         * Calls that touch a sink always block on error; that is not configurable.
         */
        onPolicyErrorNonSink: z.enum(['allow', 'block']).default('block'),
      })
      .prefault({}),
    ui: z
      .strictObject({
        /** Local web UI port on 127.0.0.1; 0 picks a free port. The host is not configurable. */
        port: z.int().min(0).max(65535).default(0),
      })
      .prefault({}),
  })
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    c.upstreams.forEach((u, i) => {
      if (seen.has(u.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['upstreams', i, 'id'],
          message: `duplicate upstream id "${u.id}"`,
        });
      }
      seen.add(u.id);
    });
  });
export type Config = z.infer<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;
