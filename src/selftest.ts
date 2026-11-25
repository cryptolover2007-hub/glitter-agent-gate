/** caller_kind for our own test/probe scripts (User-Agent "glitter-selftest/1", see e2e/selftest-ua.mjs). */
export const SELF_TEST = "self-test";
export const SELFTEST_UA_RE = /^glitter-selftest\//i;
/** SQL predicate: rows that are NOT our self-tests (NULL caller_kind = older rows, counted as real traffic). */
export const NOT_SELF_TEST = "COALESCE(caller_kind, '') != 'self-test'";
