/**
 * `process.env` narrowed to what this app reads from it.
 *
 * Next's ambient types make NODE_ENV a required property of
 * NodeJS.ProcessEnv, so a function typed against that cannot be called with a
 * small literal. Every function here that reads configuration takes this
 * instead, which is what lets the tests pass a three-key object and assert on
 * missing, blank and misspelled variables without touching the real
 * environment.
 */
export type EnvLike = Record<string, string | undefined>;
