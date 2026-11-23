import { readFileSync } from 'node:fs';
import semver from 'semver';
import { z } from 'zod';
import {
  HANDOFF_MODES,
  JOIN_METHODS,
  type JoinMethod,
  MAX_API_KEY_LENGTH,
  MAX_APP_VERSION_LENGTH,
  NAMESPACE_PATTERN,
} from '@mosherw/sync-system-protocol';
import { type AppConfig, hashApiKey } from '../apps/app-registry.js';
import { defaultAppMethods } from '../joins/join-methods.js';
import { ConfigError } from './config-error.js';
import type { AppCeilings, PartialAppCeilings } from './env.js';

export { NAMESPACE_PATTERN };
export const MIN_API_KEY_LENGTH = 32;

const BOM = String.fromCharCode(0xfeff);

export const APP_DEFAULTS = {
  maxGroupSize: 30,
  maxLeaderUpdatesPerSecond: 5,
  maxMessageBytes: 4096,
  maxConnections: 1000,
  maxSessionMinutes: 180,
  inactivityLimitMinutes: 20,
  qrTicketSeconds: 300,
  approvalTimeoutSeconds: 120,
  disconnectGraceSeconds: 30,
  keepAliveCountdownSeconds: 60,
} as const;

/** Handoff mode of an app that does not set one (#13 AC3, Q2.1). */
export const DEFAULT_HANDOFF = 'auto';

interface LimitField {
  field: keyof typeof APP_DEFAULTS;
  min: number;
  ceilingName: string;
  /** Undefined when the ceiling itself is invalid (#36 Gate 2 Q-4). */
  ceiling: (env: PartialAppCeilings) => number | undefined;
}

const LIMIT_FIELDS: readonly LimitField[] = [
  {
    field: 'maxGroupSize',
    min: 2,
    ceilingName: 'MAX_GROUP_SIZE_CEILING',
    ceiling: (env) => env.maxGroupSizeCeiling,
  },
  {
    field: 'maxLeaderUpdatesPerSecond',
    min: 1,
    ceilingName: 'MAX_LEADER_UPDATE_RATE_CEILING',
    ceiling: (env) => env.maxLeaderUpdateRateCeiling,
  },
  {
    field: 'maxMessageBytes',
    min: 1,
    ceilingName: 'MAX_MESSAGE_SIZE_CEILING',
    ceiling: (env) => env.maxMessageSizeCeiling,
  },
  {
    field: 'maxConnections',
    min: 1,
    ceilingName: 'MAX_APP_CONNECTIONS_CEILING',
    ceiling: (env) => env.maxAppConnectionsCeiling,
  },
  {
    field: 'maxSessionMinutes',
    min: 1,
    ceilingName: 'MAX_SESSION_MINUTES_CEILING',
    ceiling: (env) => env.maxSessionMinutesCeiling,
  },
  {
    field: 'inactivityLimitMinutes',
    min: 1,
    ceilingName: 'INACTIVITY_LIMIT_MINUTES_CEILING',
    ceiling: (env) => env.inactivityLimitMinutesCeiling,
  },
  {
    field: 'qrTicketSeconds',
    min: 30,
    ceilingName: 'QR_TICKET_SECONDS_CEILING',
    ceiling: (env) => env.qrTicketSecondsCeiling,
  },
  {
    field: 'approvalTimeoutSeconds',
    min: 15,
    ceilingName: 'APPROVAL_TIMEOUT_SECONDS_CEILING',
    ceiling: (env) => env.approvalTimeoutSecondsCeiling,
  },
  {
    field: 'disconnectGraceSeconds',
    min: 1,
    ceilingName: 'DISCONNECT_GRACE_SECONDS_CEILING',
    ceiling: (env) => env.disconnectGraceSecondsCeiling,
  },
  {
    field: 'keepAliveCountdownSeconds',
    min: 1,
    ceilingName: 'KEEP_ALIVE_COUNTDOWN_SECONDS_CEILING',
    ceiling: (env) => env.keepAliveCountdownSecondsCeiling,
  },
];

const limitSchema = z.number().int();

const appEntrySchema = z.strictObject({
  namespace: z.string().regex(NAMESPACE_PATTERN),
  apiKey: z.string().min(MIN_API_KEY_LENGTH).max(MAX_API_KEY_LENGTH),
  minAppVersion: z.string().max(MAX_APP_VERSION_LENGTH),
  maxGroupSize: limitSchema.optional(),
  maxLeaderUpdatesPerSecond: limitSchema.optional(),
  maxMessageBytes: limitSchema.optional(),
  maxConnections: limitSchema.optional(),
  maxSessionMinutes: limitSchema.optional(),
  inactivityLimitMinutes: limitSchema.optional(),
  qrTicketSeconds: limitSchema.optional(),
  approvalTimeoutSeconds: limitSchema.optional(),
  disconnectGraceSeconds: limitSchema.optional(),
  keepAliveCountdownSeconds: limitSchema.optional(),
  defaultHandoff: z.enum(HANDOFF_MODES).optional(),
  joinMethods: z.array(z.enum(JOIN_METHODS)).min(1).max(JOIN_METHODS.length).optional(),
});

/** Every field an apps entry may have (the AC37 coverage test checks each one). */
export const APP_ENTRY_FIELDS: readonly string[] = Object.freeze(Object.keys(appEntrySchema.shape));

const FIELD_RULES: Record<string, string> = {
  namespace: 'must match ^[a-z0-9][a-z0-9_-]{0,62}$',
  apiKey: `must be a string of ${MIN_API_KEY_LENGTH}-${MAX_API_KEY_LENGTH} characters`,
  minAppVersion: `must be a semver string of at most ${MAX_APP_VERSION_LENGTH} characters`,
  joinMethods: 'must be a non-empty array of distinct methods "A", "B", "C", "D"',
  defaultHandoff: 'must be "auto" or "frozen"',
};

/**
 * Describes one zod issue using only the field name and the rule. The
 * received value is never included, so an API key can never be printed.
 */
function describeIssue(issue: z.core.$ZodIssue, entry: Record<string, unknown>): string {
  if (issue.code === 'unrecognized_keys') {
    return `unknown field(s): ${issue.keys.map(shownText).join(', ')} (remove them or fix their names)`;
  }
  // Every problem inside the array is reported as the field's rule.
  if (issue.path[0] === 'joinMethods') return `joinMethods ${FIELD_RULES.joinMethods}`;
  const field = issue.path.map(String).join('.');
  if (field !== '' && !(field in entry)) {
    return `${field} is required`;
  }
  const rule = FIELD_RULES[field];
  if (rule !== undefined) return `${field} ${rule}`;
  return `${field} must be an integer`;
}

/**
 * Turns a JSON.parse SyntaxError into a position-only message. V8 includes an
 * input snippet in the message, which could contain an API key (M2), so the
 * message itself is never passed on.
 */
export function describeJsonSyntaxError(err: unknown, text: string): string {
  const message = err instanceof Error ? err.message : '';
  const lineColumn = /\(line (\d+) column (\d+)\)/.exec(message);
  if (lineColumn) {
    return `not valid JSON (line ${lineColumn[1]}, column ${lineColumn[2]})`;
  }
  const position = /at position (\d+)/.exec(message);
  if (position) {
    const offset = Math.min(Number(position[1]), text.length);
    const before = text.slice(0, offset);
    const line = before.split('\n').length;
    const column = offset - before.lastIndexOf('\n');
    return `not valid JSON (line ${line}, column ${column})`;
  }
  return 'not valid JSON';
}

/** Longest operator-supplied text (file path, JSON key name) echoed in a problem. */
export const MAX_SHOWN_TEXT = 64;

/**
 * Operator-supplied text that a problem echoes (the config file path, JSON
 * key names): control and line-separator characters become `?` and the text
 * is cut to MAX_SHOWN_TEXT characters plus `...`, so one problem is always
 * exactly one line (#36 security C6).
 */
export function shownText(text: string): string {
  // eslint-disable-next-line no-control-regex
  const safe = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?');
  const chars = Array.from(safe);
  return chars.length > MAX_SHOWN_TEXT ? `${chars.slice(0, MAX_SHOWN_TEXT).join('')}...` : safe;
}

function label(index: number, namespace: unknown): string {
  return typeof namespace === 'string' && NAMESPACE_PATTERN.test(namespace)
    ? `apps[${index}] (namespace "${namespace}")`
    : `apps[${index}]`;
}

/**
 * Checks the apps registry, pushing every problem to `problems`, each
 * prefixed with `source` (usually the file path). Values above an env
 * ceiling are problems and are never clamped (AC5). Omitted limits use
 * min(default, ceiling). A comparison that needs a ceiling which is itself
 * invalid (`undefined`) is skipped (#36 Gate 2 Q-4); the invalid ceiling is
 * a problem of its own, so the run still fails.
 *
 * Returns the entries that passed every check, or undefined when the file
 * as a whole is unusable (not JSON, no `apps` array). The caller must not
 * use the result when any problem was pushed (#36 security C1); it is only
 * used to look for more problems (dev keys).
 */
export function collectAppsConfig(
  text: string,
  env: PartialAppCeilings,
  source: string,
  problems: string[],
): AppConfig[] | undefined {
  const shown = shownText(source);
  let data: unknown;
  try {
    data = JSON.parse(text.startsWith(BOM) ? text.slice(1) : text);
  } catch (err) {
    problems.push(`${shown}: ${describeJsonSyntaxError(err, text)}`);
    return undefined;
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    problems.push(`${shown}: must be a JSON object with an "apps" array`);
    return undefined;
  }
  const apps = (data as Record<string, unknown>).apps;
  if (!Array.isArray(apps) || apps.length === 0) {
    problems.push(`${shown}: "apps" must be a non-empty array`);
    return undefined;
  }

  const errors: string[] = [];
  const result: AppConfig[] = [];
  const seenNamespaces = new Map<string, number>();
  const seenKeys = new Map<string, { index: number; namespace: string }>();

  apps.forEach((entry: unknown, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`apps[${index}] must be an object`);
      return;
    }
    const record = entry as Record<string, unknown>;
    const where = label(index, record.namespace);
    const parsed = appEntrySchema.safeParse(entry);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors.push(`${where}: ${describeIssue(issue, record)}`);
      }
      return;
    }
    const app = parsed.data;

    let entryOk = true;
    if (semver.valid(app.minAppVersion) === null) {
      errors.push(`${where}: minAppVersion ${FIELD_RULES.minAppVersion}`);
      entryOk = false;
    }

    const limits = {} as Record<keyof typeof APP_DEFAULTS, number>;
    // A limit is unknown when it is omitted and its ceiling is invalid: its
    // default would be min(default, ceiling), which cannot be computed.
    const unknown = new Set<keyof typeof APP_DEFAULTS>();
    for (const spec of LIMIT_FIELDS) {
      const ceiling = spec.ceiling(env);
      const value = app[spec.field];
      if (value === undefined) {
        if (ceiling === undefined) unknown.add(spec.field);
        limits[spec.field] = Math.min(
          APP_DEFAULTS[spec.field],
          ceiling ?? APP_DEFAULTS[spec.field],
        );
        continue;
      }
      if (value < spec.min) {
        errors.push(`${where}: ${spec.field} must be an integer >= ${spec.min}`);
        entryOk = false;
      } else if (ceiling !== undefined && value > ceiling) {
        errors.push(
          `${where}: ${spec.field} ${value} exceeds ${spec.ceilingName} ${ceiling} (lower ${spec.field} or raise ${spec.ceilingName})`,
        );
        entryOk = false;
      }
      limits[spec.field] = value;
    }

    // #13 AC2: the keep-alive countdown must end before the inactivity
    // limit. An omitted countdown takes min(default, ceiling, half the limit).
    const inactivitySeconds = limits.inactivityLimitMinutes * 60;
    if (app.keepAliveCountdownSeconds === undefined) {
      limits.keepAliveCountdownSeconds = Math.max(
        1,
        Math.min(limits.keepAliveCountdownSeconds, Math.floor(inactivitySeconds / 2)),
      );
    } else if (
      entryOk &&
      !unknown.has('inactivityLimitMinutes') &&
      limits.keepAliveCountdownSeconds >= inactivitySeconds
    ) {
      errors.push(
        `${where}: keepAliveCountdownSeconds ${limits.keepAliveCountdownSeconds} must be less than inactivityLimitMinutes in seconds (${inactivitySeconds})`,
      );
      entryOk = false;
    }

    const joinMethods = resolveAppJoinMethods(app.joinMethods, env.joinMethodsAllowed);
    if (!joinMethods.ok) {
      errors.push(...joinMethods.errors.map((error) => `${where}: ${error}`));
      entryOk = false;
    }

    const firstWithNamespace = seenNamespaces.get(app.namespace);
    if (firstWithNamespace !== undefined) {
      errors.push(
        `apps[${index}] has the same namespace "${app.namespace}" as apps[${firstWithNamespace}] (each app needs its own namespace)`,
      );
      entryOk = false;
    } else {
      seenNamespaces.set(app.namespace, index);
    }

    const apiKeyHash = hashApiKey(app.apiKey);
    const firstWithKey = seenKeys.get(apiKeyHash);
    if (firstWithKey !== undefined) {
      errors.push(
        `apps[${index}] (namespace "${app.namespace}") has the same apiKey as apps[${firstWithKey.index}] (namespace "${firstWithKey.namespace}") (each app needs its own key)`,
      );
      entryOk = false;
    } else {
      seenKeys.set(apiKeyHash, { index, namespace: app.namespace });
    }

    if (entryOk) {
      result.push({
        namespace: app.namespace,
        apiKeyHash,
        minAppVersion: app.minAppVersion,
        ...limits,
        joinMethods: joinMethods.ok ? joinMethods.methods : [],
        defaultHandoff: app.defaultHandoff ?? DEFAULT_HANDOFF,
      });
    }
  });

  problems.push(...errors.map((e) => `${shown}: ${e}`));
  return result;
}

/**
 * Parses and validates the apps registry against valid ceilings. Throws one
 * ConfigError with every problem, each prefixed with `source`.
 */
export function parseAppsConfig(
  text: string,
  env: AppCeilings,
  source = 'apps config',
): AppConfig[] {
  const problems: string[] = [];
  const apps = collectAppsConfig(text, env, source, problems);
  if (problems.length > 0 || apps === undefined) throw new ConfigError(problems);
  return apps;
}

type JoinMethodsResult =
  { ok: true; methods: readonly JoinMethod[] } | { ok: false; errors: string[] };

/**
 * An app's join methods (#10 AC2): the listed ones, each allowed by
 * JOIN_METHODS_ALLOWED, or `["A", "D"]` intersected with it when omitted.
 * Never clamped or dropped: a listed method the env does not allow is an
 * error. The result is frozen and in canonical order. When
 * JOIN_METHODS_ALLOWED is itself invalid (`undefined`), only the checks that
 * do not need it run (#36 Gate 2 Q-4).
 */
function resolveAppJoinMethods(
  listed: readonly JoinMethod[] | undefined,
  allowed: readonly JoinMethod[] | undefined,
): JoinMethodsResult {
  if (listed === undefined) {
    if (allowed === undefined) return { ok: true, methods: Object.freeze([]) };
    const methods = defaultAppMethods(allowed);
    if (methods.length === 0) {
      return {
        ok: false,
        errors: ['joinMethods is required because JOIN_METHODS_ALLOWED does not include A or D'],
      };
    }
    return { ok: true, methods: Object.freeze(methods) };
  }
  if (new Set(listed).size !== listed.length) {
    return { ok: false, errors: [`joinMethods ${FIELD_RULES.joinMethods}`] };
  }
  const notAllowed =
    allowed === undefined
      ? []
      : JOIN_METHODS.filter((method) => listed.includes(method) && !allowed.includes(method));
  if (notAllowed.length > 0) {
    return {
      ok: false,
      errors: notAllowed.map((method) => `joinMethods "${method}" is not in JOIN_METHODS_ALLOWED`),
    };
  }
  return { ok: true, methods: Object.freeze(JOIN_METHODS.filter((m) => listed.includes(m))) };
}

/**
 * Reads and checks the apps registry file at `path`, pushing every problem.
 * A missing or unreadable file is one problem. See `collectAppsConfig` for
 * the result.
 */
export function collectAppsConfigFile(
  path: string,
  env: PartialAppCeilings,
  problems: string[],
): AppConfig[] | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    // Only the errno code: never the fs message (#36 security C3).
    const shown = shownText(path);
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      problems.push(`${shown}: config file not found (set SYNC_CONFIG_PATH)`);
    } else {
      problems.push(
        `${shown}: cannot read config file (${code ?? 'unknown error'}; check that the server user can read it)`,
      );
    }
    return undefined;
  }
  return collectAppsConfig(text, env, path, problems);
}

/** Reads and parses the apps registry file at `path`; throws one ConfigError. */
export function loadAppsConfigFile(path: string, env: AppCeilings): AppConfig[] {
  const problems: string[] = [];
  const apps = collectAppsConfigFile(path, env, problems);
  if (problems.length > 0 || apps === undefined) throw new ConfigError(problems);
  return apps;
}
