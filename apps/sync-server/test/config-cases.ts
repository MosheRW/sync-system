/**
 * Invalid-config case tables of the sync server (#36 AC37, AC37a, AC38).
 * Used by `config-matrix.test.ts` (every case through `run()`) and by
 * `startup-errors-doc.test.ts` (every printed line must be listed in
 * docs/startup-errors.md). All values are test-only, never real.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEV_REDIS_PASSWORD } from '../src/config/redis.js';
import { DEV_TOKEN_SECRET, PUBLIC_EXAMPLE_SECRETS } from '../src/config/token-secret.js';
import { DEV_API_KEYS } from '../src/config/dev-key.js';
import type { ServerVariable } from '../src/config/known-vars.js';

/** A strong-looking test token secret, and a second one. Never real. */
export const STRONG = 'SENTINEL-TOKEN-q9Zt2Lx7Vb4Nm1Rt6Yw0Ue5Io3AaKd8Fj2Hs7Gp1Wc';
export const STRONG_2 = 'SENTINEL-TOKEN2-Xr4Tn8Qm2Vk6Bz0Pc9Ls3Hd7Jf1Gw5Ye8Ua2Ii6Oo';

/** The API key of the base apps file: never printed by any case. */
export const BASE_API_KEY = 'SENTINEL-APIKEY-base-0123456789-0123456789';
export const OTHER_API_KEY = 'SENTINEL-APIKEY-other-0123456789-0123456789';

/** Sentinels that no case may ever print, on top of the case's own. */
export const GLOBAL_SENTINELS: readonly string[] = [STRONG, STRONG_2, BASE_API_KEY, OTHER_API_KEY];

export function baseApp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { namespace: 'matrix-app', apiKey: BASE_API_KEY, minAppVersion: '1.0.0', ...overrides };
}

/** The apps file of a case: an object written as JSON, raw text, or a special path. */
export type AppsFile =
  | { kind: 'json'; value: unknown }
  | { kind: 'text'; text: string }
  | { kind: 'missing' }
  | { kind: 'directory' };

export interface ConfigCase {
  /** Unique label. */
  id: string;
  /** The env variable or apps field (or file-level element) the case targets. */
  target: string;
  /** Env on top of the base env (`SYNC_CONFIG_PATH`, `NODE_ENV=test`, `TOKEN_SECRET`). */
  env?: Record<string, string>;
  /** Env names removed from the base env. */
  unset?: string[];
  /** Apps file; defaults to one valid app. */
  apps?: AppsFile;
  /** Text that must not appear in stderr or the logs. */
  sentinels: string[];
  /**
   * The exact problem lines, without the `Config error: ` prefix. `<path>`
   * stands for the apps file path.
   */
  problems: string[];
}

const json = (value: unknown): AppsFile => ({ kind: 'json', value });
const oneApp = (overrides: Record<string, unknown>): AppsFile =>
  json({ apps: [baseApp(overrides)] });

const POSITIVE = (name: string) => `${name} must be a positive integer`;

/** Numeric variables that accept any positive integer (bounds apart). */
const NUMERIC: readonly ServerVariable[] = [
  'PORT',
  'MAX_GROUP_SIZE_CEILING',
  'MAX_LEADER_UPDATE_RATE_CEILING',
  'MAX_MESSAGE_SIZE_CEILING',
  'MAX_APP_CONNECTIONS_CEILING',
  'MAX_CONNECTIONS',
  'MAX_PENDING_HANDSHAKES',
  'MAX_INBOUND_MESSAGES_PER_SECOND',
  'MAX_INBOUND_BURST',
  'MAX_BUFFERED_BYTES',
  'MAX_SESSION_MINUTES_CEILING',
  'INACTIVITY_LIMIT_MINUTES_CEILING',
  'TOKEN_REFRESH_ACTIVITIES',
  'TOKEN_REFRESH_MIN_SECONDS',
  'TOKEN_REFRESH_MAX_SECONDS',
  'QR_TICKET_SECONDS_CEILING',
  'APPROVAL_TIMEOUT_SECONDS_CEILING',
  'DISCONNECT_GRACE_SECONDS_CEILING',
  'KEEP_ALIVE_COUNTDOWN_SECONDS_CEILING',
  'MAX_GROUP_CREATES_PER_CONNECTION_PER_MINUTE',
  'MAX_GROUP_CREATE_BURST_PER_APP',
  'MAX_GROUP_CREATES_PER_APP_PER_MINUTE',
  'MAX_LIVE_GROUPS_PER_APP',
];

const GENERATE = 'use `openssl rand -base64 32`';
const JOIN_METHODS_RULE =
  'JOIN_METHODS_ALLOWED must be a non-empty comma-separated list of distinct methods A, B, C, D';
const INVALID_REDIS_URL = 'REDIS_URL is not a valid redis:// or rediss:// URL';

/** Redis URL parts, each its own sentinel (#36 security C3). Hosts are lower case in URLs. */
const R_USER = 'SENTINELRUSER';
const R_PASS = 'SENTINELRPASS';
const R_HOST = 'sentinel-redis-host';
const REDIS_PARTS = [R_USER, R_PASS, R_HOST];

/** One case per variable with an invalid value (AC37), plus bounds. NODE_ENV has no invalid value. */
export const ENV_CASES: readonly ConfigCase[] = [
  ...NUMERIC.map((name): ConfigCase => ({
    id: `${name} not a number`,
    target: name,
    env: { [name]: `SENTINEL-${name}` },
    sentinels: [`SENTINEL-${name}`],
    problems: [POSITIVE(name)],
  })),
  {
    id: 'PORT above 65535',
    target: 'PORT',
    env: { PORT: '65536' },
    sentinels: [],
    problems: ['PORT must be between 1 and 65535'],
  },
  {
    id: 'QR_TICKET_SECONDS_CEILING below 30',
    target: 'QR_TICKET_SECONDS_CEILING',
    env: { QR_TICKET_SECONDS_CEILING: '29' },
    sentinels: [],
    problems: ['QR_TICKET_SECONDS_CEILING must be between 30 and 86400'],
  },
  {
    id: 'APPROVAL_TIMEOUT_SECONDS_CEILING above 3600',
    target: 'APPROVAL_TIMEOUT_SECONDS_CEILING',
    env: { APPROVAL_TIMEOUT_SECONDS_CEILING: '3601' },
    sentinels: [],
    problems: ['APPROVAL_TIMEOUT_SECONDS_CEILING must be between 15 and 3600'],
  },
  {
    id: 'MAX_CONNECTIONS with a leading zero',
    target: 'MAX_CONNECTIONS',
    env: { MAX_CONNECTIONS: '010000' },
    sentinels: [],
    problems: [POSITIVE('MAX_CONNECTIONS')],
  },
  {
    id: 'HOST empty',
    target: 'HOST',
    env: { HOST: '  ' },
    sentinels: [],
    problems: ['HOST must not be empty'],
  },
  {
    id: 'LOG_LEVEL unknown',
    target: 'LOG_LEVEL',
    env: { LOG_LEVEL: 'SENTINEL-level' },
    sentinels: ['SENTINEL-level'],
    problems: ['LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent'],
  },
  {
    id: 'SYNC_CONFIG_PATH empty',
    target: 'SYNC_CONFIG_PATH',
    env: { SYNC_CONFIG_PATH: ' ' },
    sentinels: [],
    problems: ['SYNC_CONFIG_PATH must not be empty'],
  },
  {
    id: 'JOIN_METHODS_ALLOWED unknown method',
    target: 'JOIN_METHODS_ALLOWED',
    env: { JOIN_METHODS_ALLOWED: 'A,SENTINELJ' },
    sentinels: ['SENTINELJ'],
    problems: [JOIN_METHODS_RULE],
  },
  {
    id: 'JOIN_METHODS_ALLOWED duplicate',
    target: 'JOIN_METHODS_ALLOWED',
    env: { JOIN_METHODS_ALLOWED: 'A,A' },
    sentinels: [],
    problems: [JOIN_METHODS_RULE],
  },
  {
    id: 'TOKEN_SECRET short',
    target: 'TOKEN_SECRET',
    env: { TOKEN_SECRET: 'SENTINEL-short' },
    sentinels: ['SENTINEL-short'],
    problems: [`TOKEN_SECRET must be at least 32 bytes (${GENERATE})`],
  },
  {
    id: 'TOKEN_SECRET_PREVIOUS short',
    target: 'TOKEN_SECRET_PREVIOUS',
    env: { TOKEN_SECRET_PREVIOUS: 'SENTINEL-prev' },
    sentinels: ['SENTINEL-prev'],
    problems: [`TOKEN_SECRET_PREVIOUS must be at least 32 bytes (${GENERATE})`],
  },
  {
    id: 'REDIS_URL bad port',
    target: 'REDIS_URL',
    env: { REDIS_URL: `redis://${R_USER}:${R_PASS}@${R_HOST}:99999/0` },
    sentinels: REDIS_PARTS,
    problems: [INVALID_REDIS_URL],
  },
  {
    id: 'REDIS_URL wrong scheme',
    target: 'REDIS_URL',
    env: { REDIS_URL: `http://${R_USER}:${R_PASS}@${R_HOST}:6379` },
    sentinels: REDIS_PARTS,
    problems: [INVALID_REDIS_URL],
  },
  {
    id: 'REDIS_URL empty',
    target: 'REDIS_URL',
    env: { REDIS_URL: '' },
    sentinels: [],
    problems: ['REDIS_URL must not be empty'],
  },
  {
    id: 'REDIS_URL with a query',
    target: 'REDIS_URL',
    env: { REDIS_URL: `redis://${R_USER}:${R_PASS}@${R_HOST}:6379/?tls=1` },
    sentinels: REDIS_PARTS,
    problems: ['REDIS_URL must not have a query string or fragment'],
  },
  {
    id: 'REDIS_URL port 0',
    target: 'REDIS_URL',
    env: { REDIS_URL: `redis://${R_USER}:${R_PASS}@${R_HOST}:0` },
    sentinels: REDIS_PARTS,
    problems: ['REDIS_URL port must be between 1 and 65535'],
  },
  {
    id: 'REDIS_URL database 16',
    target: 'REDIS_URL',
    env: { REDIS_URL: `redis://${R_USER}:${R_PASS}@${R_HOST}:6379/16` },
    sentinels: REDIS_PARTS,
    problems: ['REDIS_URL database must be a number from 0 to 15'],
  },
  {
    id: 'REDIS_URL dev password in production',
    target: 'REDIS_URL',
    env: {
      NODE_ENV: 'production',
      REDIS_URL: `redis://${R_USER}:${DEV_REDIS_PASSWORD}@${R_HOST}:6379`,
    },
    sentinels: [R_USER, R_HOST, DEV_REDIS_PASSWORD],
    problems: [
      'REDIS_URL uses the public development Redis password; it is only accepted when NODE_ENV is development or test',
    ],
  },
  {
    id: 'REDIS_KEY_PREFIX with a colon',
    target: 'REDIS_KEY_PREFIX',
    env: { REDIS_KEY_PREFIX: 'SENTINEL:prefix' },
    sentinels: ['SENTINEL:prefix'],
    problems: [
      'REDIS_KEY_PREFIX must be 1-32 characters of a-z, 0-9, _ and -, starting with a letter or digit',
    ],
  },
  {
    id: 'REDIS_CONNECT_TIMEOUT_SECONDS not a number',
    target: 'REDIS_CONNECT_TIMEOUT_SECONDS',
    env: { REDIS_CONNECT_TIMEOUT_SECONDS: 'SENTINEL-ct' },
    sentinels: ['SENTINEL-ct'],
    problems: ['REDIS_CONNECT_TIMEOUT_SECONDS must be an integer between 1 and 120'],
  },
  {
    id: 'REDIS_COMMAND_TIMEOUT_MS out of range',
    target: 'REDIS_COMMAND_TIMEOUT_MS',
    env: { REDIS_COMMAND_TIMEOUT_MS: '99' },
    sentinels: [],
    problems: ['REDIS_COMMAND_TIMEOUT_MS must be an integer between 100 and 30000'],
  },
];

/** Rules that span fields (AC38), each with the message that says what to change. */
export const CROSS_FIELD_CASES: readonly ConfigCase[] = [
  {
    id: 'MAX_APP_CONNECTIONS_CEILING above MAX_CONNECTIONS',
    target: 'MAX_APP_CONNECTIONS_CEILING',
    env: { MAX_APP_CONNECTIONS_CEILING: '20000' },
    sentinels: [],
    problems: ['MAX_APP_CONNECTIONS_CEILING (20000) must be <= MAX_CONNECTIONS (10000)'],
  },
  {
    id: 'MAX_PENDING_HANDSHAKES above MAX_CONNECTIONS',
    target: 'MAX_PENDING_HANDSHAKES',
    env: { MAX_PENDING_HANDSHAKES: '20000' },
    sentinels: [],
    problems: ['MAX_PENDING_HANDSHAKES (20000) must be <= MAX_CONNECTIONS (10000)'],
  },
  {
    id: 'MAX_INBOUND_MESSAGES_PER_SECOND not above the leader rate',
    target: 'MAX_INBOUND_MESSAGES_PER_SECOND',
    env: { MAX_INBOUND_MESSAGES_PER_SECOND: '10' },
    sentinels: [],
    problems: [
      'MAX_INBOUND_MESSAGES_PER_SECOND (10) must be > MAX_LEADER_UPDATE_RATE_CEILING (10)',
    ],
  },
  {
    id: 'MAX_INBOUND_BURST below the rate',
    target: 'MAX_INBOUND_BURST',
    env: { MAX_INBOUND_BURST: '19' },
    sentinels: [],
    problems: ['MAX_INBOUND_BURST (19) must be >= MAX_INBOUND_MESSAGES_PER_SECOND (20)'],
  },
  {
    id: 'MAX_BUFFERED_BYTES below 4 messages',
    target: 'MAX_BUFFERED_BYTES',
    env: { MAX_MESSAGE_SIZE_CEILING: '100000', MAX_BUFFERED_BYTES: '262144' },
    sentinels: [],
    problems: ['MAX_BUFFERED_BYTES (262144) must be >= 4 * MAX_MESSAGE_SIZE_CEILING (400000)'],
  },
  {
    id: 'MAX_BUFFERED_BYTES below the tokens.result frame',
    target: 'MAX_BUFFERED_BYTES',
    env: {
      MAX_MESSAGE_SIZE_CEILING: '1024',
      MAX_GROUP_SIZE_CEILING: '10',
      MAX_BUFFERED_BYTES: '45055',
    },
    sentinels: [],
    problems: ['MAX_BUFFERED_BYTES (45055) must be >= the largest tokens.result frame (45056)'],
  },
  {
    id: 'MAX_BUFFERED_BYTES below the roster snapshot',
    target: 'MAX_BUFFERED_BYTES',
    env: { MAX_BUFFERED_BYTES: '97663' },
    sentinels: [],
    problems: [
      'MAX_BUFFERED_BYTES (97663) must be >= the largest roster snapshot plus headroom (97664) for MAX_GROUP_SIZE_CEILING (100)',
    ],
  },
  {
    id: 'MAX_LIVE_GROUPS_PER_APP not above twice the burst',
    target: 'MAX_LIVE_GROUPS_PER_APP',
    env: { MAX_LIVE_GROUPS_PER_APP: '240' },
    sentinels: [],
    problems: ['MAX_LIVE_GROUPS_PER_APP (240) must be > 2 * MAX_GROUP_CREATE_BURST_PER_APP (240)'],
  },
  {
    id: 'MAX_GROUP_CREATES_PER_CONNECTION_PER_MINUTE above 600',
    target: 'MAX_GROUP_CREATES_PER_CONNECTION_PER_MINUTE',
    env: { MAX_GROUP_CREATES_PER_CONNECTION_PER_MINUTE: '601' },
    sentinels: [],
    problems: ['MAX_GROUP_CREATES_PER_CONNECTION_PER_MINUTE must be between 1 and 600'],
  },
  {
    id: 'TOKEN_REFRESH_MIN_SECONDS above the max',
    target: 'TOKEN_REFRESH_MIN_SECONDS',
    env: { TOKEN_REFRESH_MIN_SECONDS: '301' },
    sentinels: [],
    problems: ['TOKEN_REFRESH_MIN_SECONDS (301) must be <= TOKEN_REFRESH_MAX_SECONDS (300)'],
  },
  {
    id: 'TOKEN_SECRET missing in production',
    target: 'TOKEN_SECRET',
    env: { NODE_ENV: 'production' },
    unset: ['TOKEN_SECRET'],
    sentinels: [],
    problems: [`TOKEN_SECRET is required (${GENERATE})`],
  },
  {
    id: 'TOKEN_SECRET with whitespace',
    target: 'TOKEN_SECRET',
    env: { TOKEN_SECRET: ` ${STRONG_2}` },
    sentinels: [],
    problems: ['TOKEN_SECRET must not start or end with whitespace'],
  },
  {
    id: 'TOKEN_SECRET example from the docs',
    target: 'TOKEN_SECRET',
    env: { TOKEN_SECRET: PUBLIC_EXAMPLE_SECRETS[0]! },
    sentinels: [PUBLIC_EXAMPLE_SECRETS[0]!],
    problems: [`TOKEN_SECRET is an example value from the docs; ${GENERATE}`],
  },
  {
    id: 'TOKEN_SECRET dev secret in production',
    target: 'TOKEN_SECRET',
    env: { NODE_ENV: 'production', TOKEN_SECRET: DEV_TOKEN_SECRET },
    sentinels: [DEV_TOKEN_SECRET],
    problems: [`TOKEN_SECRET is the public development secret; ${GENERATE}`],
  },
  {
    id: 'TOKEN_SECRET weak',
    target: 'TOKEN_SECRET',
    env: { TOKEN_SECRET: 'SENTINELab'.repeat(4) },
    sentinels: ['SENTINELab'],
    problems: [`TOKEN_SECRET looks weak; ${GENERATE}`],
  },
  {
    id: 'TOKEN_SECRET_PREVIOUS equal to TOKEN_SECRET',
    target: 'TOKEN_SECRET_PREVIOUS',
    env: { TOKEN_SECRET_PREVIOUS: STRONG },
    sentinels: [],
    problems: ['TOKEN_SECRET_PREVIOUS must differ from TOKEN_SECRET'],
  },
  {
    id: 'app value above its ceiling',
    target: 'maxGroupSize',
    apps: oneApp({ maxGroupSize: 500 }),
    sentinels: [],
    problems: [
      '<path>: apps[0] (namespace "matrix-app"): maxGroupSize 500 exceeds MAX_GROUP_SIZE_CEILING 100 (lower maxGroupSize or raise MAX_GROUP_SIZE_CEILING)',
    ],
  },
  {
    id: 'keep-alive not below the inactivity limit',
    target: 'keepAliveCountdownSeconds',
    env: { KEEP_ALIVE_COUNTDOWN_SECONDS_CEILING: '3600' },
    apps: oneApp({ inactivityLimitMinutes: 1, keepAliveCountdownSeconds: 60 }),
    sentinels: [],
    problems: [
      '<path>: apps[0] (namespace "matrix-app"): keepAliveCountdownSeconds 60 must be less than inactivityLimitMinutes in seconds (60)',
    ],
  },
  {
    id: 'join method not in JOIN_METHODS_ALLOWED',
    target: 'joinMethods',
    env: { JOIN_METHODS_ALLOWED: 'A,D' },
    apps: oneApp({ joinMethods: ['A', 'B'] }),
    sentinels: [],
    problems: [
      '<path>: apps[0] (namespace "matrix-app"): joinMethods "B" is not in JOIN_METHODS_ALLOWED',
    ],
  },
  {
    id: 'joinMethods required without A or D',
    target: 'joinMethods',
    env: { JOIN_METHODS_ALLOWED: 'B,C' },
    sentinels: [],
    problems: [
      '<path>: apps[0] (namespace "matrix-app"): joinMethods is required because JOIN_METHODS_ALLOWED does not include A or D',
    ],
  },
  {
    id: 'dev API key outside development',
    target: 'apiKey',
    env: { NODE_ENV: 'production' },
    apps: oneApp({ apiKey: DEV_API_KEYS[0] }),
    sentinels: [DEV_API_KEYS[0]!],
    problems: [
      'apps[0] (namespace "matrix-app") uses the public development API key; set a real key',
    ],
  },
  {
    id: 'duplicate namespace',
    target: 'namespace',
    apps: json({ apps: [baseApp(), baseApp({ apiKey: OTHER_API_KEY })] }),
    sentinels: [],
    problems: [
      '<path>: apps[1] has the same namespace "matrix-app" as apps[0] (each app needs its own namespace)',
    ],
  },
  {
    id: 'duplicate API key',
    target: 'apiKey',
    apps: json({ apps: [baseApp(), baseApp({ namespace: 'other-app' })] }),
    sentinels: [],
    problems: [
      '<path>: apps[1] (namespace "other-app") has the same apiKey as apps[0] (namespace "matrix-app") (each app needs its own key)',
    ],
  },
  {
    id: 'unreadable apps file',
    target: 'file',
    apps: { kind: 'directory' },
    sentinels: [],
    problems: ['<path>: cannot read config file (EISDIR; check that the server user can read it)'],
  },
  {
    id: 'apps file not valid JSON',
    target: 'file',
    apps: { kind: 'text', text: `{"apps":[{"apiKey":"${BASE_API_KEY}" SENTINEL-json}]}` },
    sentinels: ['SENTINEL-json'],
    problems: ['<path>: not valid JSON (line 1, column 65)'],
  },
];

/** One case per apps entry field (AC37) plus the file structure. */
export const APPS_CASES: readonly ConfigCase[] = [
  {
    id: 'namespace pattern',
    target: 'namespace',
    apps: oneApp({ namespace: 'SENTINEL NS' }),
    sentinels: ['SENTINEL NS'],
    problems: ['<path>: apps[0]: namespace must match ^[a-z0-9][a-z0-9_-]{0,62}$'],
  },
  {
    id: 'namespace required',
    target: 'namespace',
    apps: json({ apps: [{ apiKey: BASE_API_KEY, minAppVersion: '1.0.0' }] }),
    sentinels: [],
    problems: ['<path>: apps[0]: namespace is required'],
  },
  {
    id: 'apiKey too short',
    target: 'apiKey',
    apps: oneApp({ apiKey: 'SENTINEL-key' }),
    sentinels: ['SENTINEL-key'],
    problems: [
      '<path>: apps[0] (namespace "matrix-app"): apiKey must be a string of 32-256 characters',
    ],
  },
  {
    id: 'minAppVersion not semver',
    target: 'minAppVersion',
    apps: oneApp({ minAppVersion: 'SENTINEL-ver' }),
    sentinels: ['SENTINEL-ver'],
    problems: [
      '<path>: apps[0] (namespace "matrix-app"): minAppVersion must be a semver string of at most 64 characters',
    ],
  },
  ...(
    [
      ['maxGroupSize', 2],
      ['maxLeaderUpdatesPerSecond', 1],
      ['maxMessageBytes', 1],
      ['maxConnections', 1],
      ['maxSessionMinutes', 1],
      ['inactivityLimitMinutes', 1],
      ['qrTicketSeconds', 30],
      ['approvalTimeoutSeconds', 15],
      ['disconnectGraceSeconds', 1],
      ['keepAliveCountdownSeconds', 1],
    ] as const
  ).flatMap(([field, min]): ConfigCase[] => [
    {
      id: `${field} not an integer`,
      target: field,
      apps: oneApp({ [field]: `SENTINEL-${field}` }),
      sentinels: [`SENTINEL-${field}`],
      problems: [`<path>: apps[0] (namespace "matrix-app"): ${field} must be an integer`],
    },
    {
      id: `${field} below its minimum`,
      target: field,
      apps: oneApp({ [field]: min - 1 }),
      sentinels: [],
      problems: [`<path>: apps[0] (namespace "matrix-app"): ${field} must be an integer >= ${min}`],
    },
  ]),
  {
    id: 'defaultHandoff unknown',
    target: 'defaultHandoff',
    apps: oneApp({ defaultHandoff: 'SENTINEL-handoff' }),
    sentinels: ['SENTINEL-handoff'],
    problems: [
      '<path>: apps[0] (namespace "matrix-app"): defaultHandoff must be "auto" or "frozen"',
    ],
  },
  {
    id: 'joinMethods unknown method',
    target: 'joinMethods',
    apps: oneApp({ joinMethods: ['SENTINEL-method'] }),
    sentinels: ['SENTINEL-method'],
    problems: [
      '<path>: apps[0] (namespace "matrix-app"): joinMethods must be a non-empty array of distinct methods "A", "B", "C", "D"',
    ],
  },
  {
    id: 'unknown field',
    target: 'file',
    apps: oneApp({ maxGroupsize: 10 }),
    sentinels: [],
    problems: [
      '<path>: apps[0] (namespace "matrix-app"): unknown field(s): maxGroupsize (remove them or fix their names)',
    ],
  },
  {
    id: 'apps file missing',
    target: 'file',
    apps: { kind: 'missing' },
    sentinels: [],
    problems: ['<path>: config file not found (set SYNC_CONFIG_PATH)'],
  },
  {
    id: 'apps file empty',
    target: 'file',
    apps: { kind: 'text', text: '' },
    sentinels: [],
    problems: ['<path>: not valid JSON'],
  },
  {
    id: 'apps file not an object',
    target: 'file',
    apps: json([baseApp()]),
    sentinels: [],
    problems: ['<path>: must be a JSON object with an "apps" array'],
  },
  {
    id: 'apps array empty',
    target: 'file',
    apps: json({ apps: [] }),
    sentinels: [],
    problems: ['<path>: "apps" must be a non-empty array'],
  },
  {
    id: 'apps entry not an object',
    target: 'file',
    apps: json({ apps: ['SENTINEL-entry'] }),
    sentinels: ['SENTINEL-entry'],
    problems: ['<path>: apps[0] must be an object'],
  },
];

/** Unknown look-alike variables (AC37a, ADR 0015). */
export const UNKNOWN_CASES: readonly ConfigCase[] = [
  {
    id: 'typo with a suggestion',
    target: 'unknown',
    env: { MAX_GROUP_SIZE_CIELING: 'SENTINEL-typo' },
    sentinels: ['SENTINEL-typo'],
    problems: [
      'MAX_GROUP_SIZE_CIELING is not a sync server variable; did you mean MAX_GROUP_SIZE_CEILING?',
    ],
  },
  {
    id: 'look-alike without a suggestion',
    target: 'unknown',
    env: { REDIS_PASSWORD: 'SENTINEL-redis-password' },
    sentinels: ['SENTINEL-redis-password'],
    problems: [
      'REDIS_PASSWORD is not a sync server variable; remove it or fix the name (see "Environment variables" in README.md)',
    ],
  },
];

export const ALL_CASES: readonly ConfigCase[] = [
  ...ENV_CASES,
  ...CROSS_FIELD_CASES,
  ...APPS_CASES,
  ...UNKNOWN_CASES,
];

/** A documented default and a valid non-default value for every known variable (AC41). */
export const VALID_VALUES: Readonly<Record<ServerVariable, readonly string[]>> = {
  PORT: ['8080', '9090'],
  HOST: ['0.0.0.0', '127.0.0.1'],
  LOG_LEVEL: ['info', 'debug'],
  NODE_ENV: ['test', 'development', 'production'],
  SYNC_CONFIG_PATH: [],
  MAX_GROUP_SIZE_CEILING: ['100', '50'],
  MAX_LEADER_UPDATE_RATE_CEILING: ['10', '5'],
  MAX_MESSAGE_SIZE_CEILING: ['16384', '8192'],
  MAX_APP_CONNECTIONS_CEILING: ['10000', '5000'],
  MAX_CONNECTIONS: ['10000', '20000'],
  MAX_PENDING_HANDSHAKES: ['1000', '500'],
  MAX_INBOUND_MESSAGES_PER_SECOND: ['20', '30'],
  MAX_INBOUND_BURST: ['40', '80'],
  MAX_BUFFERED_BYTES: ['262144', '524288'],
  MAX_SESSION_MINUTES_CEILING: ['480', '240'],
  INACTIVITY_LIMIT_MINUTES_CEILING: ['60', '30'],
  TOKEN_REFRESH_ACTIVITIES: ['10', '20'],
  TOKEN_REFRESH_MIN_SECONDS: ['60', '30'],
  TOKEN_REFRESH_MAX_SECONDS: ['300', '600'],
  JOIN_METHODS_ALLOWED: ['A,B,C,D', 'A, D'],
  QR_TICKET_SECONDS_CEILING: ['3600', '600'],
  APPROVAL_TIMEOUT_SECONDS_CEILING: ['600', '300'],
  DISCONNECT_GRACE_SECONDS_CEILING: ['120', '60'],
  KEEP_ALIVE_COUNTDOWN_SECONDS_CEILING: ['120', '90'],
  MAX_GROUP_CREATES_PER_CONNECTION_PER_MINUTE: ['6', '600'],
  MAX_GROUP_CREATE_BURST_PER_APP: ['120', '1'],
  MAX_GROUP_CREATES_PER_APP_PER_MINUTE: ['120', '60000'],
  MAX_LIVE_GROUPS_PER_APP: ['10000', '100000'],
  TOKEN_SECRET: [STRONG, STRONG_2],
  TOKEN_SECRET_PREVIOUS: [STRONG_2],
  REDIS_URL: ['redis://localhost:6379', 'rediss://user:pw@redis.internal:6380/2'],
  REDIS_KEY_PREFIX: ['sync', 'tenant-a'],
  REDIS_CONNECT_TIMEOUT_SECONDS: ['10', '30'],
  REDIS_COMMAND_TIMEOUT_MS: ['2000', '500'],
};

/** The env (and apps file path) of a case, with the apps file written to a temp dir. */
export function materialize(c: ConfigCase): { env: Record<string, string>; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sync-matrix-'));
  const apps = c.apps ?? json({ apps: [baseApp()] });
  let path = join(dir, 'apps.json');
  if (apps.kind === 'json') writeFileSync(path, JSON.stringify(apps.value));
  else if (apps.kind === 'text') writeFileSync(path, apps.text);
  else if (apps.kind === 'directory') path = dir;
  const env: Record<string, string> = {
    SYNC_CONFIG_PATH: path,
    NODE_ENV: 'test',
    TOKEN_SECRET: STRONG,
    HOST: '127.0.0.1',
    ...c.env,
  };
  for (const name of c.unset ?? []) delete env[name];
  return { env, path };
}

/** The expected problem lines of a case, with `<path>` filled in. */
export function expectedProblems(c: ConfigCase, path: string): string[] {
  return c.problems.map((problem) => problem.replaceAll('<path>', path));
}
