/** A JSON primitive as produced by `JSON.parse`. */
export type JsonPrimitive = string | number | boolean | null;

/** Any value `JSON.parse` can return. */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** A JSON object (not an array, not null). */
export type JsonObject = { [key: string]: JsonValue };
