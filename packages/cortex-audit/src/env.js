/**
 * Centralised environment-variable accessors for @cortexos/audit.
 *
 * Per MP-020, all process.env reads live in this single file so the rest of
 * the package can lint under `n/no-process-env`. The defaults and validation
 * remain at the call sites to preserve exact runtime behaviour.
 */

export function dbPassword() {
  return process.env.DB_PASSWORD;
}

export function dbHost() {
  return process.env.DB_HOST;
}

export function dbPort() {
  return process.env.DB_PORT;
}

export function dbName() {
  return process.env.DB_NAME;
}

export function dbUser() {
  return process.env.DB_USER;
}

export function rekorUrl() {
  return process.env.CORTEX_REKOR_URL;
}
