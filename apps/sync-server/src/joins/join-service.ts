import {
  ErrorCode,
  type JoinCodesPayload,
  type JoinMethod,
  type ServerMessage,
} from '@sync-system/protocol';
import type { AppConfig } from '../apps/app-registry.js';
import type { GroupRecord, GroupStore } from '../groups/group-store.js';
import type { Logger } from '../logging/logger.js';
import type { Scheduler } from '../time/scheduler.js';
import type { CodesBlobService } from '../tokens/codes-blob.js';
import type { QrTicketService } from '../tokens/qr-tickets.js';
import { errorMessage } from '../ws/error-messages.js';
import { CodeIndex } from './code-index.js';
import { type GroupCodes, type RandomInt, cryptoRandomInt, issueCodeSet } from './codes.js';
import { resolveGroupMethods } from './join-methods.js';

export interface JoinServiceDeps {
  store: GroupStore;
  logger: Logger;
  scheduler: Scheduler;
  /** Signs and verifies QR tickets (#10 AC23-AC26). */
  qrTickets: QrTicketService;
  /** Signs and verifies codes blobs (#10 AC32, AC33). */
  codesBlobs: CodesBlobService;
  /** CSPRNG integer source; injected by tests to force code collisions. */
  random?: RandomInt;
}

export type InitialCodesResult =
  { ok: true; methods: JoinMethod[]; codes: GroupCodes } | { ok: false; error: ServerMessage };

/**
 * Every join and join-code flow (#10 architecture 1). `GroupService` stays
 * the facade: it owns the group lock, the store and the lifecycle, and calls
 * in here. Codes are group state (`GroupRecord.codes`); the code -> group
 * lookup is the process-local `CodeIndex`. Nothing here logs a code, door
 * code, ticket, blob, display name or request ID.
 */
export class JoinService {
  /** Code -> group lookup per app. */
  readonly index = new CodeIndex();
  private readonly random: RandomInt;

  constructor(private readonly deps: JoinServiceDeps) {
    this.random = deps.random ?? cryptoRandomInt;
  }

  private now(): number {
    return this.deps.scheduler.now();
  }

  /**
   * The methods and a claimed code set for a new group (#10 AC5-AC9).
   * JOIN_METHOD_NOT_ALLOWED for a bad method set, CODES_EXHAUSTED when no
   * free code was found; nothing is claimed in either case.
   */
  initialCodes(app: AppConfig, groupId: string, requested?: JoinMethod[]): InitialCodesResult {
    const resolved = resolveGroupMethods(app.joinMethods, requested);
    if (!resolved.ok) return { ok: false, error: errorMessage(ErrorCode.JOIN_METHOD_NOT_ALLOWED) };
    const codes = issueCodeSet(
      this.index,
      app.namespace,
      groupId,
      resolved.methods,
      0,
      this.now(),
      this.random,
    );
    if (codes === 'exhausted') return { ok: false, error: errorMessage(ErrorCode.CODES_EXHAUSTED) };
    return { ok: true, methods: resolved.methods, codes };
  }

  /** The leader-only codes payload with a freshly signed blob (#10 AC6, AC32). */
  payload(
    record: Pick<GroupRecord, 'appNamespace' | 'id' | 'joinMethods' | 'codes'>,
  ): JoinCodesPayload {
    const { codes } = record;
    const payload: JoinCodesPayload = {
      generation: codes.generation,
      blob: this.deps.codesBlobs.sign(record.appNamespace, record.id, record.joinMethods, codes),
    };
    if (codes.groupCode !== undefined) payload.groupCode = codes.groupCode;
    if (codes.doorCode !== undefined) payload.doorCode = codes.doorCode;
    if (codes.alphaCode !== undefined) payload.alphaCode = codes.alphaCode;
    return payload;
  }

  /** Frees a claimed code set that was never stored (a failed create). */
  releaseCodes(namespace: string, groupId: string, codes: GroupCodes): void {
    this.index.release(namespace, groupId, codes);
  }

  /**
   * The group ended or left memory (#10 AC11, R14): its codes are freed at
   * once and can resolve to a new group later. Runs under the group lock.
   */
  onGroupGone(namespace: string, groupId: string, record: GroupRecord | undefined): void {
    if (record !== undefined) this.index.release(namespace, groupId, record.codes);
  }

  /** Server shutdown: forgets every code (AC31). */
  close(): void {
    this.index.clear();
  }
}
