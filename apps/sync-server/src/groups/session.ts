import type {
  BlockListSetMessage,
  CodesRotateMessage,
  JoinApproveMessage,
  JoinCancelMessage,
  JoinDenyMessage,
  GroupJoinByQrMessage,
  QrIssueMessage,
  GroupCreateMessage,
  GroupEndMessage,
  GroupJoinByCodeMessage,
  GroupLeaveMessage,
  GroupResumeMessage,
  PositionUpdateMessage,
  TokensCheckMessage,
  ServerMessage,
  ViceClearMessage,
  ViceSetMessage,
  GroupLockMessage,
  GroupUnlockMessage,
  MemberRemoveMessage,
} from '@sync-system/protocol';
import type { AppConfig } from '../apps/app-registry.js';

/**
 * A session's place in a group. The participant ID is group-scoped. There is
 * deliberately no role here (#13 D1): who leads is `GroupRecord.leaderId`,
 * read under the group lock, so no code can authorize from a cached role.
 */
export interface Membership {
  readonly groupId: string;
  readonly participantId: string;
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
  /**
   * Set while this session waits for a leader to approve its method B join
   * request (#10 AC19). Managed by the ApprovalQueue only. Counts as "in a
   * group" for ALREADY_IN_GROUP; at most one per session (AC22).
   */
  pendingJoin?:
    { readonly groupKey: string; readonly groupId: string; readonly requestId: string } | undefined;
  /** False once the socket has closed (#10 R11: approve re-checks it). */
  isOpen(): boolean;
  /** Sends an already serialized frame to this participant. */
  deliver(text: string): void;
  /**
   * Closes the WebSocket with `code` (#13 Q-A: `CloseCode.REMOVED`). Call it
   * from `afterPending`, right after the last frame for the session.
   */
  close(code: number, reason: string): void;
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
  /** Join with a QR ticket (#10 AC24). */
  joinByQr(session: Session, message: GroupJoinByQrMessage): Promise<ServerMessage>;
  /** Leader asks for a QR ticket (#10 AC23). */
  issueQr(session: Session, message: QrIssueMessage): Promise<ServerMessage>;
  /** Joiner withdraws its pending request (#10 AC21). */
  cancelJoin(session: Session, message: JoinCancelMessage): Promise<ServerMessage>;
  /** Leader admits a pending joiner (#10 AC21). */
  approveJoin(session: Session, message: JoinApproveMessage): Promise<ServerMessage>;
  /** Leader refuses a pending joiner (#10 AC21). */
  denyJoin(session: Session, message: JoinDenyMessage): Promise<ServerMessage>;
  /** Leader designates the vice-leader (#13 AC10). */
  setVice(session: Session, message: ViceSetMessage): Promise<ServerMessage>;
  /** Leader clears the vice-leader (#13 AC10). */
  clearVice(session: Session, message: ViceClearMessage): Promise<ServerMessage>;
  /** Leader locks or unlocks joining (#13 AC29). */
  setLock(session: Session, message: GroupLockMessage | GroupUnlockMessage): Promise<ServerMessage>;
  /** Leader removes a participant (#13 AC32). */
  removeMember(session: Session, message: MemberRemoveMessage): Promise<ServerMessage>;
  /** Runs the disconnect rules (member removal, group end). */
  disconnect(session: Session): Promise<void>;
}
