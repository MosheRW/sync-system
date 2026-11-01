/** Maximum nesting depth of a whole inbound frame (M4). */
export const MAX_JSON_DEPTH = 64;

/** Length of a server-generated group ID (32 random bytes, base64url). */
export const GROUP_ID_LENGTH = 43;

/** Exact format of a real group ID. */
export const GROUP_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Longest `groupId` the schema accepts; longer gives INVALID_MESSAGE (L3). */
export const MAX_GROUP_ID_INPUT_LENGTH = 256;

/** Longest API key accepted, checked before hashing (L2). */
export const MAX_API_KEY_LENGTH = 256;

/** Longest app version that is parsed as semver (L2). */
export const MAX_APP_VERSION_LENGTH = 64;

/**
 * Longest `appVersion` the schema accepts. Values longer than
 * MAX_APP_VERSION_LENGTH but within this bound get INVALID_APP_VERSION
 * from the handshake, without being parsed.
 */
export const MAX_APP_VERSION_INPUT_LENGTH = 256;

/** Longest `reqId` accepted. */
export const MAX_REQ_ID_LENGTH = 64;

/** Longest token accepted anywhere, checked before any parsing (#5 AC7). */
export const MAX_TOKEN_LENGTH = 2048;

/** Most tokens in one `tokens.check` (#5 AC14). */
export const MAX_TOKENS_PER_CHECK = 20;

/** Most participant IDs in a group's block list (#5 AC24). */
export const MAX_BLOCK_LIST_SIZE = 256;

/** A group-scoped participant ID: a lowercase random UUID (v4). */
export const PARTICIPANT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** An app namespace (also the token audience and part of the client storage key). */
export const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
