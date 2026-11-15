import type { DestinationStream } from 'pino';
import { AppRegistry } from './apps/app-registry.js';
import { ConfigError } from './config/config-error.js';
import { warnDevKeys } from './config/dev-key.js';
import type { EnvSource } from './config/env.js';
import { loadConfig } from './config/load.js';
import { warnAboutSecrets } from './config/token-secret.js';
import { type Logger, createLogger } from './logging/logger.js';
import { type SyncServer, createSyncServer } from './server.js';
import { StorageStartError, storageStartMessage } from './storage/errors.js';
import type { Storage } from './storage/storage.js';
import { realScheduler } from './time/scheduler.js';
import { VersionError, readServerVersion } from './version.js';

export interface RunIO {
  /** Where startup errors go; defaults to process.stderr. */
  stderr?: (text: string) => void;
  /** Log destination; defaults to stdout. */
  destination?: DestinationStream;
  /** The server's package.json; tests only. Never taken from env (#36 security C8). */
  versionUrl?: URL;
}

export type RunResult =
  { ok: true; server: SyncServer; logger: Logger } | { ok: false; exitCode: number };

/**
 * Loads the whole config (env, token secrets, apps file, dev keys), creates
 * the logger and starts the server. Every configuration problem prints one
 * `Config error: <problem>` line and the run returns exit code 1; no line
 * contains a key or secret value (AC6, #36 AC37, AC38).
 */
export async function run(env: EnvSource, io: RunIO = {}): Promise<RunResult> {
  const stderr =
    io.stderr ??
    ((text: string) => {
      process.stderr.write(text);
    });

  let server: SyncServer;
  let logger: Logger;
  try {
    // First, before anything that depends on config (#36 security C1).
    const config = loadConfig(env);
    const serverEnv = config.env;
    const { apps, tokenSecrets, redis } = config;
    // A packaging fault, not a config fault: after the config, before Redis.
    let version: string;
    try {
      version =
        io.versionUrl === undefined ? readServerVersion() : readServerVersion(io.versionUrl);
    } catch (err) {
      if (!(err instanceof VersionError)) throw err;
      stderr(`Startup error: ${err.message}
`);
      return { ok: false, exitCode: 1 };
    }
    logger = createLogger({
      level: serverEnv.logLevel,
      ...(io.destination ? { destination: io.destination } : {}),
    });
    warnDevKeys(apps, logger);
    warnAboutSecrets(tokenSecrets, logger);
    const registry = new AppRegistry(apps);
    let storage: Storage | undefined;
    if (redis !== undefined) {
      const { connectRedis } = await import('./storage/redis/connect.js');
      const connected = await connectRedis(redis, { logger, nodeEnv: serverEnv.nodeEnv });
      if (!connected.ok) {
        stderr(`Startup error: ${connected.message}
`);
        return { ok: false, exitCode: 1 };
      }
      const { redisStorage } = await import('./storage/redis/redis-storage.js');
      const byNamespace = new Map(apps.map((app) => [app.namespace, app]));
      storage = redisStorage({
        link: connected.link,
        keyPrefix: redis.keyPrefix,
        scheduler: realScheduler(),
        logger,
        appOf: (namespace) => byNamespace.get(namespace),
      });
    }
    server = createSyncServer({
      env: serverEnv,
      registry,
      logger,
      tokenSecrets,
      version,
      ...(storage === undefined ? {} : { storage }),
    });

    try {
      const port = await server.listen(serverEnv.port, serverEnv.host);
      // The port and version only: never the host or any address (AC24).
      logger.info(
        { event: 'server_listening', port, apps: apps.length, version },
        'sync server listening',
      );
    } catch (err) {
      if (err instanceof StorageStartError) {
        // Epoch, past-due timers or sweep failed (#35 AC4, architecture 3 step 7).
        stderr(`Startup error: ${storageStartMessage(err)}\n`);
      } else {
        const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
        stderr(`Startup error: cannot listen on port ${serverEnv.port} (${code})\n`);
      }
      // Closes the Redis connection too, so nothing keeps the process alive.
      await server.close().catch(() => undefined);
      return { ok: false, exitCode: 1 };
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      // One prefixed line per problem (#36 AC38).
      stderr(err.problems.map((problem) => `Config error: ${problem}\n`).join(''));
      return { ok: false, exitCode: 1 };
    }
    throw err;
  }

  return { ok: true, server, logger };
}
