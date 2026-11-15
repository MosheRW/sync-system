import type { DestinationStream } from 'pino';
import { AppRegistry } from './apps/app-registry.js';
import { loadAppsConfigFile } from './config/apps-config.js';
import { ConfigError } from './config/config-error.js';
import { checkDevKeys } from './config/dev-key.js';
import { type EnvSource, parseEnv } from './config/env.js';
import { parseRedisSettings } from './config/redis.js';
import { parseTokenSecrets, warnAboutSecrets } from './config/token-secret.js';
import { type Logger, createLogger } from './logging/logger.js';
import { type SyncServer, createSyncServer } from './server.js';
import { StorageStartError, storageStartMessage } from './storage/errors.js';
import type { Storage } from './storage/storage.js';
import { realScheduler } from './time/scheduler.js';

export interface RunIO {
  /** Where startup errors go; defaults to process.stderr. */
  stderr?: (text: string) => void;
  /** Log destination; defaults to stdout. */
  destination?: DestinationStream;
}

export type RunResult =
  { ok: true; server: SyncServer; logger: Logger } | { ok: false; exitCode: number };

/**
 * Parses env, loads the app registry, checks dev keys and token secrets,
 * creates the logger and starts the server. Configuration problems print `Config error: <message>`
 * and return exit code 1; the message never contains key values (AC6).
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
    const serverEnv = parseEnv(env);
    logger = createLogger({
      level: serverEnv.logLevel,
      ...(io.destination ? { destination: io.destination } : {}),
    });
    const apps = loadAppsConfigFile(serverEnv.configPath, serverEnv);
    checkDevKeys(apps, serverEnv.nodeEnv, logger);
    // Never stored in ServerEnv and never logged (R4).
    const tokenSecrets = parseTokenSecrets(env, serverEnv.nodeEnv);
    warnAboutSecrets(tokenSecrets, logger);
    const registry = new AppRegistry(apps);
    // Never stored in ServerEnv and never logged (#35 security C9).
    const redis = parseRedisSettings(env);
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
      ...(storage === undefined ? {} : { storage }),
    });

    try {
      const port = await server.listen(serverEnv.port, serverEnv.host);
      // The port only: never the host or any address (AC24).
      logger.info({ event: 'server_listening', port, apps: apps.length }, 'sync server listening');
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
