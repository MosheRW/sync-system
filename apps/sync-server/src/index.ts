import { safeErr } from './logging/logger.js';
import { run } from './main.js';

// Last resort only: the error guards in the server must make these
// unreachable (H4). They log the error name and frames, never the message.
function fatal(event: string, err: unknown): never {
  process.stderr.write(`${JSON.stringify({ level: 60, event, err: safeErr(err) })}\n`);
  process.exit(1);
}
process.on('unhandledRejection', (err) => fatal('unhandled_rejection', err));
process.on('uncaughtException', (err) => fatal('uncaught_exception', err));

const result = await run(process.env);

if (!result.ok) {
  process.exitCode = result.exitCode;
} else {
  const { server, logger } = result;
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ event: 'server_stopping', signal }, 'sync server stopping');
    server.close().then(
      () => {
        logger.info({ event: 'server_stopped' }, 'sync server stopped');
        logger.flush();
        process.exitCode = 0;
      },
      (err: unknown) => fatal('shutdown_failed', err),
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
