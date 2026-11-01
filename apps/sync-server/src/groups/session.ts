import type {
  GroupCreateMessage,
  GroupJoinMessage,
  PositionUpdateMessage,
  Role,
  ServerMessage,
} from '@sync-system/protocol';
import type { AppConfig } from '../apps/app-registry.js';

/** A session's place in a group. The participant ID is group-scoped. */
export interface Membership {
  readonly groupId: string;
  readonly participantId: string;
  readonly role: Role;
}

/**
 * An authenticated connection as the group layer sees it. Created on
 * `hello.ok`. Connection-local only: never stored in the GroupStore.
 */
export interface Session {
  /** Per-connection ID (the `hello.ok` participantId). Never in tokens. */
  readonly connectionId: string;
  readonly app: AppConfig;
  /**
   * Set while this session holds a membership. Authorization never relies on
   * it alone: the notifier's attachment map says which session owns a
   * membership (M4).
   */
  membership: Membership | undefined;
  /** Sends an already serialized frame to this participant. */
  deliver(text: string): void;
  /**
   * Runs `task` after every message this participant has already sent has
   * been handled and answered, so events it triggers arrive after those
   * replies.
   */
  afterPending(task: () => void): void;
}

/**
 * Key of a membership in the notifier: namespace, group ID and group-scoped
 * participant ID. Namespaces and group IDs cannot contain ':'.
 */
export function membershipKey(namespace: string, groupId: string, participantId: string): string {
  return `${namespace}:${groupId}:${participantId}`;
}

/** Group operations a connection dispatches to. Each returns the direct reply. */
export interface GroupActions {
  create(session: Session, message: GroupCreateMessage): Promise<ServerMessage>;
  join(session: Session, message: GroupJoinMessage): Promise<ServerMessage>;
  update(session: Session, message: PositionUpdateMessage): Promise<ServerMessage>;
  /** Runs the disconnect rules (member removal, group end). */
  disconnect(session: Session): Promise<void>;
}
