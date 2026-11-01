export interface ConnectionStats {
  /** Open WebSockets, pending and authenticated. */
  total: number;
  /** Sockets still waiting for a successful hello. */
  pending: number;
  /** Authenticated sockets per app namespace. */
  perApp: Record<string, number>;
}

/**
 * Connection counts for the global, pending-handshake and per-app caps
 * (H1, M5). Each connection reports `opened` once, `authenticated` at most
 * once, and `closed` exactly once (the connection guards this).
 */
export class ConnectionCounter {
  private totalCount = 0;
  private pendingCount = 0;
  private readonly apps = new Map<string, number>();

  get total(): number {
    return this.totalCount;
  }

  get pending(): number {
    return this.pendingCount;
  }

  appCount(namespace: string): number {
    return this.apps.get(namespace) ?? 0;
  }

  opened(): void {
    this.totalCount += 1;
    this.pendingCount += 1;
  }

  /** The socket left the pending count and joined its app's count. */
  authenticated(namespace: string): void {
    this.pendingCount -= 1;
    this.apps.set(namespace, this.appCount(namespace) + 1);
  }

  /** `namespace` is the app if the socket had authenticated, else undefined. */
  closed(namespace: string | undefined): void {
    this.totalCount -= 1;
    if (namespace === undefined) {
      this.pendingCount -= 1;
      return;
    }
    const remaining = this.appCount(namespace) - 1;
    if (remaining > 0) {
      this.apps.set(namespace, remaining);
    } else {
      this.apps.delete(namespace);
    }
  }

  snapshot(): ConnectionStats {
    return {
      total: this.totalCount,
      pending: this.pendingCount,
      perApp: Object.fromEntries(this.apps),
    };
  }
}
