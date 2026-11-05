import { run } from './run.js';

// Entry point of the reader image: `node dist-server/server/main.js`.
const result = await run(process.env);
if (!result.ok) {
  process.exitCode = result.exitCode;
} else {
  const stop = () => {
    void result.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
