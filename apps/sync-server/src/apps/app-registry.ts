import { createHash } from 'node:crypto';

/** One registered client app. Immutable after load; the raw API key is not kept. */
export interface AppConfig {
  readonly namespace: string;
  /** sha256 hex of the API key. */
  readonly apiKeyHash: string;
  readonly minAppVersion: string;
  readonly maxGroupSize: number;
  readonly maxLeaderUpdatesPerSecond: number;
  readonly maxMessageBytes: number;
  /** Per-app concurrent socket cap (M5). */
  readonly maxConnections: number;
  /** Max session time from group creation (#5 AC4). */
  readonly maxSessionMinutes: number;
  /** Recovery window after the leader's last activity (#5 AC4). */
  readonly inactivityLimitMinutes: number;
}

export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

/** Looks up apps by API key through a map keyed by the key's sha256. */
export class AppRegistry {
  private readonly byHash = new Map<string, AppConfig>();

  constructor(apps: readonly AppConfig[]) {
    for (const app of apps) {
      this.byHash.set(app.apiKeyHash, Object.freeze({ ...app }));
    }
  }

  findByApiKey(apiKey: string): AppConfig | undefined {
    return this.byHash.get(hashApiKey(apiKey));
  }

  get size(): number {
    return this.byHash.size;
  }

  apps(): AppConfig[] {
    return [...this.byHash.values()];
  }
}
