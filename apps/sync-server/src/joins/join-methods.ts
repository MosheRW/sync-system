import { JOIN_METHODS, type JoinMethod } from '@mosherw/sync-system-protocol';

/** Methods an app gets when it omits `joinMethods`, before the env intersection (#10 Q1.1). */
export const DEFAULT_APP_JOIN_METHODS: readonly JoinMethod[] = ['A', 'D'];

/** `methods` deduplicated in canonical order A, B, C, D. */
export function canonicalMethods(methods: readonly JoinMethod[]): JoinMethod[] {
  return JOIN_METHODS.filter((method) => methods.includes(method));
}

/** The app default `["A", "D"]` intersected with JOIN_METHODS_ALLOWED; may be empty. */
export function defaultAppMethods(envAllowed: readonly JoinMethod[]): JoinMethod[] {
  return canonicalMethods(DEFAULT_APP_JOIN_METHODS.filter((m) => envAllowed.includes(m)));
}

/** The methods a group gets when the leader omits them: the app's, minus B when A is there. */
export function defaultGroupMethods(appMethods: readonly JoinMethod[]): JoinMethod[] {
  const methods = canonicalMethods(appMethods);
  return methods.includes('A') ? methods.filter((method) => method !== 'B') : methods;
}

/** True for a usable group method set: non-empty and never A together with B (#10 AC5). */
export function isValidGroupMethodSet(methods: readonly JoinMethod[]): boolean {
  return methods.length > 0 && !(methods.includes('A') && methods.includes('B'));
}

export type GroupMethodsResult = { ok: true; methods: JoinMethod[] } | { ok: false };

/**
 * The group's methods at `group.create` (#10 AC5). A requested set must be
 * non-empty, distinct, a subset of the app's methods and must not contain
 * both A and B; anything else is `{ ok: false }` (JOIN_METHOD_NOT_ALLOWED).
 * Omitted: the app's methods minus B when A is allowed.
 */
export function resolveGroupMethods(
  appMethods: readonly JoinMethod[],
  requested?: readonly JoinMethod[],
): GroupMethodsResult {
  if (requested === undefined) {
    const methods = defaultGroupMethods(appMethods);
    return isValidGroupMethodSet(methods) ? { ok: true, methods } : { ok: false };
  }
  if (new Set(requested).size !== requested.length) return { ok: false };
  if (requested.some((method) => !appMethods.includes(method))) return { ok: false };
  const methods = canonicalMethods(requested);
  return isValidGroupMethodSet(methods) ? { ok: true, methods } : { ok: false };
}

/** True when the group uses a 6-digit group code (method A or B). */
export function usesGroupCode(methods: readonly JoinMethod[]): boolean {
  return methods.includes('A') || methods.includes('B');
}
