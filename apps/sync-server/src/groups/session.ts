import type {
  BlockListSetMessage,
  CodesRotateMessage,
  GroupCreateMessage,
  GroupEndMessage,
  GroupJoinMessage,
  GroupJoinByCodeMessage,
  GroupLeaveMessage,
  GroupResumeMessage,
  PositionUpdateMessage,
  TokensCheckMessage,
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
  /**
   * Set while this session waits for its leader to recreate a group (#5
   * AC25). Managed by the ParkingLot only. A parked session counts as "in a
   * group" for ALREADY_IN_GROUP.
   */
  parked?:
    | { readonly groupKey: string; readonly groupId: string; readonly participantId: string }
    | undefined;
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
  /** Join by group code (+ door code) or alphanumeric code (#10 AC12-AC18). */
  joinByCode(session: Session, message: GroupJoinByCodeMessage): Promise<ServerMessage>;
  update(session: Session, message: PositionUpdateMessage): Promise<ServerMessage>;
  /** Rejoin or recover a group with a participant token (#5 AC17-AC28). */
  resume(session: Session, message: GroupResumeMessage): Promise<ServerMessage>;
  /** Status of up to 20 stored tokens (#5 AC14-AC16). */
  checkTokens(session: Session, message: TokensCheckMessage): Promise<ServerMessage>;
  /** Leader replaces the block list (#5 AC26). */
  setBlockList(session: Session, message: BlockListSetMessage): Promise<ServerMessage>;
  /** Leader ends the group (#5 AC29). */
  end(session: Session, message: GroupEndMessage): Promise<ServerMessage>;
  /** Member leaves the group (#5 AC30). */
  leave(session: Session, message: GroupLeaveMessage): Promise<ServerMessage>;
  /** Leader replaces every join code of its group (#10 AC30). */
  rotateCodes(session: Session, message: CodesRotateMessage): Promise<ServerMessage>;
  /** Runs the disconnect rules (member removal, group end). */
  disconnect(session: Session): Promise<void>;
}
