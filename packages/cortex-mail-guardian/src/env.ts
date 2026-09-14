import { join } from 'node:path';

/**
 * Centralised environment-variable accessors for @cortexos/mail-guardian.
 *
 * Per MP-020, all process.env reads live in this single file so the rest of
 * the package can lint under `n/no-process-env`.
 */

export function getProcessEnv(): NodeJS.ProcessEnv {
  return process.env;
}

export function getMailGuardianEnvPath(): string {
  return (
    process.env.MAIL_GUARDIAN_ENV_PATH ??
    join(process.env.CORTEX_SECRETS_DIR ?? '/etc/cortex/secrets', 'mail-guardian.env')
  );
}

export function getMailGuardianDnsServers(): string {
  return process.env.MAIL_GUARDIAN_DNS_SERVERS ?? '';
}

export function isMailGuardianSchemaManaged(): boolean {
  return process.env.MAIL_GUARDIAN_SCHEMA_MANAGED === 'true';
}
