import type { DestinationStream } from 'pino';
import { AppRegistry } from './apps/app-registry.js';
import { loadAppsConfigFile } from './config/apps-config.js';
import { ConfigError } from './config/config-error.js';
import { checkDevKeys } from './config/dev-key.js';
import { type EnvSource, parseEnv } from './config/env.js';
import { type Logger, createLogger } from './logging/logger.js';
import { type SyncServer, createSyncServer } from './server.js';

export interface RunIO {
  /** Where startup errors go; defaults to process.stderr. */
  stderr?: (text: string) => void;
  /** Log destination; defaults to stdout. */
  destination?: DestinationStream;
}

export type RunResult =
  { ok: true; server: SyncServer; logger: Logger } | { ok: false; exitCode: number };

/**
 * Parses env, loads the app registry, checks dev keys, creates the logger and
 * starts the server. Configuration problems print `Config error: <message>`
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
    server = createSyncServer({ env: serverEnv, registry: new AppRegistry(apps), logger });

    try {
      const port = await server.listen(serverEnv.port, serverEnv.host);
      // The port only: never the host or any address (AC24).
      logger.info({ event: 'server_listening', port, apps: apps.length }, 'sync server listening');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
      stderr(`Startup error: cannot listen on port ${serverEnv.port} (${code})\n`);
      return { ok: false, exitCode: 1 };
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      stderr(`Config error: ${err.message}\n`);
      return { ok: false, exitCode: 1 };
    }
    throw err;
  }

  return { ok: true, server, logger };
}
