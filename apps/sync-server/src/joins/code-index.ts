import type { JoinCodeKind } from '@sync-system/protocol';

/** The indexed codes of one group: the 6-digit group code and the 8-character code. */
export interface IndexedCodes {
  readonly groupCode?: string | undefined;
  readonly alphaCode?: string | undefined;
}

interface AppCodes {
  readonly group: Map<string, string>;
  readonly alpha: Map<string, string>;
}

/**
 * Code -> group lookup per app (#10 D1, AC9, AC13). Codes resolve only
 * within one app, so the same code value can be live in two apps at once.
 * Door codes are not indexed: they are checked against the group the group
 * code found. Every method is synchronous, so a claim is atomic in-process
 * (R14). Never logged.
 */
export class CodeIndex {
  private readonly apps = new Map<string, AppCodes>();

  private app(namespace: string): AppCodes {
    let codes = this.apps.get(namespace);
    if (codes === undefined) {
      codes = { group: new Map(), alpha: new Map() };
      this.apps.set(namespace, codes);
    }
    return codes;
  }

  /** The group ID a code belongs to in `namespace`, if any. */
  lookup(namespace: string, kind: JoinCodeKind, code: string): string | undefined {
    const codes = this.apps.get(namespace);
    if (codes === undefined) return undefined;
    return (kind === 'group' ? codes.group : codes.alpha).get(code);
  }

  /** True when no live group of `namespace` holds `code`. */
  isFree(namespace: string, kind: JoinCodeKind, code: string): boolean {
    return this.lookup(namespace, kind, code) === undefined;
  }

  /**
   * Registers every code of `codes` for `groupId`, or none of them (R14):
   * false when any code is held by another group. A code the group already
   * holds counts as free for it.
   */
  claim(namespace: string, groupId: string, codes: IndexedCodes): boolean {
    const app = this.app(namespace);
    const groupHolder = codes.groupCode === undefined ? undefined : app.group.get(codes.groupCode);
    const alphaHolder = codes.alphaCode === undefined ? undefined : app.alpha.get(codes.alphaCode);
    if (groupHolder !== undefined && groupHolder !== groupId) return false;
    if (alphaHolder !== undefined && alphaHolder !== groupId) return false;
    if (codes.groupCode !== undefined) app.group.set(codes.groupCode, groupId);
    if (codes.alphaCode !== undefined) app.alpha.set(codes.alphaCode, groupId);
    return true;
  }

  /** Frees the codes of `codes` that `groupId` still holds (AC11). */
  release(namespace: string, groupId: string, codes: IndexedCodes): void {
    const app = this.apps.get(namespace);
    if (app === undefined) return;
    if (codes.groupCode !== undefined && app.group.get(codes.groupCode) === groupId) {
      app.group.delete(codes.groupCode);
    }
    if (codes.alphaCode !== undefined && app.alpha.get(codes.alphaCode) === groupId) {
      app.alpha.delete(codes.alphaCode);
    }
    if (app.group.size === 0 && app.alpha.size === 0) this.apps.delete(namespace);
  }

  /** Number of indexed codes in every app. For tests and diagnostics only. */
  get size(): number {
    let total = 0;
    for (const app of this.apps.values()) total += app.group.size + app.alpha.size;
    return total;
  }

  /** Forgets every code (server shutdown). */
  clear(): void {
    this.apps.clear();
  }
}
