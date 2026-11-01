import type {
  GroupCreateMessage,
  GroupJoinMessage,
  PositionUpdateMessage,
  Role,
  ServerMessage,
} from '@sync-system/protocol';
import type { AppConfig } from '../apps/app-registry.js';

/**
 * An authenticated connection as the group layer sees it. Created on
 * `hello.ok`. Connection-local only: never stored in the GroupStore.
 */
export interface Session {
  readonly participantId: string;
  readonly app: AppConfig;
  groupId: string | undefined;
  role: Role | undefined;
  /** Sends an already serialized frame to this participant. */
  deliver(text: string): void;
  /**
   * Runs `task` after every message this participant has already sent has
   * been handled and answered, so events it triggers arrive after those
   * replies.
   */
  afterPending(task: () => void): void;
}

/** Group operations a connection dispatches to. Each returns the direct reply. */
export interface GroupActions {
  /** Called once on hello.ok, before any other action. */
  attach(session: Session): void;
  create(session: Session, message: GroupCreateMessage): Promise<ServerMessage>;
  join(session: Session, message: GroupJoinMessage): Promise<ServerMessage>;
  update(session: Session, message: PositionUpdateMessage): Promise<ServerMessage>;
  /** Runs the disconnect rules (member removal, group end). */
  disconnect(session: Session): Promise<void>;
}
