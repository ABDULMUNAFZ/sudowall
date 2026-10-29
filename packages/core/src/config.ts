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

/**
 * Environment variables a stdio upstream inherits from the gateway by default. Anything else
 * must be listed in `inheritEnv` or set in `env`, so secrets in the gateway's environment are
 * not handed to every upstream.
 */
export const DEFAULT_INHERITED_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TERM',
  // Windows equivalents needed for processes to start.
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'TEMP',
  'TMP',
] as const;

const EnvNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const StdioUpstreamSchema = z.strictObject({
  id: ServerIdSchema,
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(EnvNameSchema, EnvValueSchema).default({}),
  /** Gateway environment variables passed through. `"*"` passes everything (used by `wrap`). */
  inheritEnv: z.union([z.literal('*'), z.array(EnvNameSchema)]).default([...DEFAULT_INHERITED_ENV]),
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

export const ToolSelectorSchema = z.strictObject({
  server: GlobSchema.default('*'),
  tool: GlobSchema,
});

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
    /** How the gateway listens for its MCP client. */
    listen: z
      .discriminatedUnion('transport', [
        z.strictObject({ transport: z.literal('stdio') }),
        z.strictObject({
          transport: z.literal('streamable-http'),
          /** Always bound to 127.0.0.1; 0 picks a free port. */
          port: z.int().min(0).max(65535).default(0),
          path: z.string().startsWith('/').default('/mcp'),
        }),
      ])
      .default({ transport: 'stdio' }),
    namespacing: z
      .strictObject({
        /** `on-collision`: prefix only tools whose names clash; `always`: prefix every tool. */
        scheme: z.enum(['on-collision', 'always']).default('on-collision'),
        separator: z
          .string()
          .regex(/^[A-Za-z0-9_.-]{1,4}$/)
          .default('__'),
      })
      .prefault({}),
    /** Tools that are always blocked in enforce mode (recorded as would-block in observe mode). */
    deny: z.strictObject({ tools: z.array(ToolSelectorSchema).default([]) }).prefault({}),
    limits: z
      .strictObject({
        /** Largest single JSON-RPC message accepted from either side, in bytes. */
        maxMessageBytes: z
          .int()
          .min(1024)
          .max(256 * 1024 * 1024)
          .default(16 * 1024 * 1024),
        /** A request with no response after this long is answered with an error. 0 disables. */
        requestTimeoutMs: z
          .int()
          .min(0)
          .default(10 * 60 * 1000),
      })
      .prefault({}),
    upstreamLifecycle: z
      .strictObject({
        healthIntervalMs: z.int().min(1000).default(30_000),
        healthTimeoutMs: z.int().min(100).default(10_000),
        restartInitialDelayMs: z.int().min(10).default(250),
        restartMaxDelayMs: z.int().min(10).default(30_000),
        /** Consecutive failed restarts before the upstream is marked down for good. */
        restartMaxAttempts: z.int().min(0).default(8),
        /** Grace period between SIGTERM and SIGKILL on shutdown. */
        shutdownGraceMs: z.int().min(0).default(2_000),
      })
      .prefault({}),
    events: z
      .strictObject({
        jsonl: z
          .strictObject({
            path: z.string().min(1),
            rotateBytes: z
              .int()
              .min(4096)
              .default(64 * 1024 * 1024),
            keepFiles: z.int().min(1).max(1000).default(10),
          })
          .optional(),
      })
      .prefault({}),
    trust: z
      .strictObject({
        /** Tools whose output is labelled `trusted-tool`. Everything else is `untrusted`. */
        trustedTools: z.array(z.strictObject({ server: GlobSchema, tool: GlobSchema })).default([]),
      })
      .prefault({}),
    /** Policy engine config (Phase 4). */
    policy: z.strictObject({ path: z.string().min(1) }).optional(),
    /** Ledger: the default event store (`docs/ledger-spec.md`). */
    ledger: z
      .strictObject({
        /** SQLite database shared by every gateway process of this user. Default `<stateDir>/ledger.db`. */
        path: z.string().min(1).optional(),
        /** Directory holding the signing key and HMAC secret (mode 0700). Default: the config dir. */
        keyDir: z.string().min(1).optional(),
        checkpoint: z
          .strictObject({
            everyEntries: z.int().min(1).max(65536).default(256),
            everySeconds: z.int().min(1).max(86400).default(60),
          })
          .prefault({}),
        /** Stored result size limit in bytes of canonical JSON; larger results are not stored. */
        maxStoredResultBytes: z.int().min(1024).default(262144),
        /**
         * `process-crash` (SQLite WAL, synchronous=NORMAL): a committed entry survives the gateway
         * being killed, but the last entries may be lost if the OS crashes or power fails.
         * `power-loss` (synchronous=FULL): every commit is fsynced; costs one fsync per entry.
         * See ADR 0014.
         */
        durability: z.enum(['process-crash', 'power-loss']).default('process-crash'),
        /** How long a writer waits for another gateway process holding the write lock. */
        busyTimeoutMs: z.int().min(0).max(60_000).default(5_000),
      })
      .prefault({}),
    redaction: z
      .strictObject({
        /** Version of your own rules (0-999). Recorded as 1000 x built-in version + this (ADR 0014). */
        ruleVersion: z.int().min(0).max(999).default(1),
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
