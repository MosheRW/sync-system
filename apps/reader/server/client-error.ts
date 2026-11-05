import type { Duplex } from 'node:stream';

/** What `node:http` passes to `clientError`: the error code plus the raw socket. */
type ClientSocket = Duplex & { bytesRead?: number };

function rawResponse(status: string, headers: Record<string, string>): string {
  const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
  return [`HTTP/1.1 ${status}`, 'Connection: close', 'Content-Length: 0', ...lines, '', ''].join(
    '\r\n',
  );
}

/**
 * The server's `clientError` listener (security C1). Unparseable requests get
 * `400` with the security headers. A request timeout gets `408`, as with
 * Node's default handler, so browsers retry it instead of showing an error
 * page; a connection that timed out without sending a byte (a browser's
 * preconnected spare socket) is closed silently. Never throws.
 */
export function createClientErrorHandler(
  headers: Record<string, string>,
): (err: NodeJS.ErrnoException, socket: ClientSocket) => void {
  const badRequest = rawResponse('400 Bad Request', headers);
  const requestTimeout = rawResponse('408 Request Timeout', headers);
  return (err, socket) => {
    try {
      if (!socket.writable) {
        socket.destroy();
        return;
      }
      if (err.code === 'ERR_HTTP_REQUEST_TIMEOUT') {
        if (!socket.bytesRead) socket.destroy();
        else socket.end(requestTimeout);
        return;
      }
      socket.end(badRequest);
    } catch {
      socket.destroy();
    }
  };
}
