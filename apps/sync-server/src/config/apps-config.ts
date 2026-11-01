import { readFileSync } from 'node:fs';
import semver from 'semver';
import { z } from 'zod';
import { MAX_API_KEY_LENGTH, MAX_APP_VERSION_LENGTH } from '@sync-system/protocol';
import { type AppConfig, hashApiKey } from '../apps/app-registry.js';
import { ConfigError } from './config-error.js';
import type { ServerEnv } from './env.js';

export const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const MIN_API_KEY_LENGTH = 32;

const BOM = String.fromCharCode(0xfeff);

export const APP_DEFAULTS = {
  maxGroupSize: 30,
  maxLeaderUpdatesPerSecond: 5,
  maxMessageBytes: 4096,
  maxConnections: 1000,
} as const;

type Ceilings = Pick<
  ServerEnv,
  | 'maxGroupSizeCeiling'
  | 'maxLeaderUpdateRateCeiling'
  | 'maxMessageSizeCeiling'
  | 'maxAppConnectionsCeiling'
>;

interface LimitField {
  field: keyof typeof APP_DEFAULTS;
  min: number;
  ceilingName: string;
  ceiling: (env: Ceilings) => number;
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
});

const FIELD_RULES: Record<string, string> = {
  namespace: 'must match ^[a-z0-9][a-z0-9_-]{0,62}$',
  apiKey: `must be a string of ${MIN_API_KEY_LENGTH}-${MAX_API_KEY_LENGTH} characters`,
  minAppVersion: `must be a semver string of at most ${MAX_APP_VERSION_LENGTH} characters`,
};

/**
 * Describes one zod issue using only the field name and the rule. The
 * received value is never included, so an API key can never be printed.
 */
function describeIssue(issue: z.core.$ZodIssue, entry: Record<string, unknown>): string {
  if (issue.code === 'unrecognized_keys') {
    return `unknown field(s): ${issue.keys.join(', ')}`;
  }
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

function label(index: number, namespace: unknown): string {
  return typeof namespace === 'string' && NAMESPACE_PATTERN.test(namespace)
    ? `apps[${index}] (namespace "${namespace}")`
    : `apps[${index}]`;
}

/**
 * Parses and validates the apps registry. `source` (usually the file path)
 * prefixes every error. Values above an env ceiling are startup errors and
 * are never clamped (AC5). Omitted limits use min(default, ceiling).
 */
export function parseAppsConfig(text: string, env: Ceilings, source = 'apps config'): AppConfig[] {
  let data: unknown;
  try {
    data = JSON.parse(text.startsWith(BOM) ? text.slice(1) : text);
  } catch (err) {
    throw new ConfigError(`${source}: ${describeJsonSyntaxError(err, text)}`);
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ConfigError(`${source}: must be a JSON object with an "apps" array`);
  }
  const apps = (data as Record<string, unknown>).apps;
  if (!Array.isArray(apps) || apps.length === 0) {
    throw new ConfigError(`${source}: "apps" must be a non-empty array`);
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
    for (const spec of LIMIT_FIELDS) {
      const ceiling = spec.ceiling(env);
      const value = app[spec.field];
      if (value === undefined) {
        limits[spec.field] = Math.min(APP_DEFAULTS[spec.field], ceiling);
        continue;
      }
      if (value < spec.min) {
        errors.push(`${where}: ${spec.field} must be an integer >= ${spec.min}`);
        entryOk = false;
      } else if (value > ceiling) {
        errors.push(`${where}: ${spec.field} ${value} exceeds ${spec.ceilingName} ${ceiling}`);
        entryOk = false;
      }
      limits[spec.field] = value;
    }

    const firstWithNamespace = seenNamespaces.get(app.namespace);
    if (firstWithNamespace !== undefined) {
      errors.push(
        `apps[${index}] has the same namespace "${app.namespace}" as apps[${firstWithNamespace}]`,
      );
      entryOk = false;
    } else {
      seenNamespaces.set(app.namespace, index);
    }

    const apiKeyHash = hashApiKey(app.apiKey);
    const firstWithKey = seenKeys.get(apiKeyHash);
    if (firstWithKey !== undefined) {
      errors.push(
        `apps[${index}] (namespace "${app.namespace}") has the same apiKey as apps[${firstWithKey.index}] (namespace "${firstWithKey.namespace}")`,
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
      });
    }
  });

  if (errors.length > 0) {
    throw new ConfigError(errors.map((e) => `${source}: ${e}`).join('\n'));
  }
  return result;
}

/** Reads and parses the apps registry file at `path`. */
export function loadAppsConfigFile(path: string, env: Ceilings): AppConfig[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new ConfigError(`${path}: config file not found (set SYNC_CONFIG_PATH)`);
    }
    throw new ConfigError(`${path}: cannot read config file (${code ?? 'unknown error'})`);
  }
  return parseAppsConfig(text, env, path);
}
