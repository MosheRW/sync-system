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
