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
  /**
   * The leader removed this participant (#13 AC32, Gate 2 Q-A). Sent right
   * after `group.ended {reason: 'removed'}`. Terminal: a client must not
   * reconnect for that group.
   */
  REMOVED: 4004,
  /** Policy violation: inbound message flood or queue overflow. */
  POLICY_VIOLATION: 4008,
} as const;

export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];
