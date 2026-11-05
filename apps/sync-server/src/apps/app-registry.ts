import { createHash } from 'node:crypto';
import type { HandoffMode, JoinMethod } from '@sync-system/protocol';

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
  /** Join methods this app allows, canonical order, a subset of JOIN_METHODS_ALLOWED (#10 AC2). */
  readonly joinMethods: readonly JoinMethod[];
  /** QR ticket lifetime (#10 AC3). */
  readonly qrTicketSeconds: number;
  /** How long a method B join request waits for the leader (#10 AC3). */
  readonly approvalTimeoutSeconds: number;
  /** Grace period after the leader disconnects or misses a keep-alive (#13 AC1). */
  readonly disconnectGraceSeconds: number;
  /** Keep-alive countdown before the inactivity limit (#13 AC1, AC16). */
  readonly keepAliveCountdownSeconds: number;
  /** Handoff mode of a group created without one (#13 AC3). */
  readonly defaultHandoff: HandoffMode;
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
