/** WebSocket close codes used by the sync server. */
export const CloseCode = {
  /** Server is shutting down. */
  GOING_AWAY: 1001,
  /** Handshake rejected (bad key, versions, invalid hello, message before hello). */
  HANDSHAKE_REJECTED: 4001,
  /** No hello within the handshake timeout. */
  HANDSHAKE_TIMEOUT: 4002,
  /** The app reached its connection limit; retry later. */
  APP_CONNECTION_LIMIT: 4003,
  /** Policy violation: inbound message flood or queue overflow. */
  POLICY_VIOLATION: 4008,
} as const;

export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];
