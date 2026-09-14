# Cortex Mail Guardian

Cortex-owned IMAP spam guardian. It watches configured inboxes, classifies new
messages through an OpenAI-compatible chat endpoint, moves high-confidence spam
to Trash, and asks the owner through the Cortex Telegram bot when confidence is
not high enough.

Passwords are loaded from base64-encoded environment variables so shell env
parsing is safe. Base64 is encoding, not encryption; keep the env file mode
`0600`.

## Commands

```bash
cortex-mail-guardian smoke
cortex-mail-guardian sweep
cortex-mail-guardian listen
cortex-mail-guardian telegram-discover-owner
```

`listen` starts IMAP IDLE loops and Telegram callback polling. `sweep` performs
a one-shot reconciliation pass for missed messages.

## Deployment

Build with `pnpm --filter @cortexos/mail-guardian build`, then run
`node "${CORTEX_ROOT:-/opt/cortex}/packages/cortex-mail-guardian/dist/index.js" listen`.
The worker has no HTTP listener; supervise it as a long-running process.
It requires the dashboard's PostgreSQL schema and configured IMAP accounts.

The CLI loads `MAIL_GUARDIAN_ENV_PATH` when set; otherwise it loads
`${CORTEX_SECRETS_DIR:-/etc/cortex/secrets}/mail-guardian.env`.
Keep credentials outside the checkout and restrict the file to mode `0600`.
Set `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `MAIL_GUARDIAN_MODEL`, and
`MAIL_GUARDIAN_FALLBACK_MODEL` for your chosen OpenAI-compatible provider.
Database configuration uses `DATABASE_URL` or `PG_DSN`, or the individual
`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` variables.
Set `MAIL_GUARDIAN_SCHEMA_MANAGED=true` for the installed least-privileged
database role. The dashboard migration owner creates the shared schema; the
worker checks required tables and columns without attempting DDL. Missing
migrations or access grants fail startup. Standalone deployments without this
setting retain the package's existing schema bootstrap.

DNS lookup uses only the operating system resolver by default. An unset or empty
`MAIL_GUARDIAN_DNS_SERVERS` never retries failed mailbox hostnames with another
resolver. To opt in to fallback DNS, set a comma-separated list of resolver IP
addresses. Failed system lookups will then send the mailbox hostname to those
resolvers; public resolvers can learn private mailbox hostnames. Prefer your
trusted local DNS and leave this setting empty unless fallback is intentional.

Accounts may be managed in the dashboard or supplied with
`MAIL_GUARDIAN_ACCOUNT_COUNT` and numbered `MAIL_GUARDIAN_ACCOUNT_N_` variables:
`SLUG`, `ADDRESS`, `HOST`, `USERNAME`, and `PASSWORD_B64` are required.
Optional fields are `PORT` (993), `SECURE` (true), `INBOX` (`INBOX`),
`REVIEW_MAILBOX`, and `TRASH_MAILBOX`.
Telegram review requires both `TELEGRAM_BOT_TOKEN` and
`MAIL_GUARDIAN_TELEGRAM_OWNER_CHAT_ID`. No account or bot is preconfigured.
Use `MAIL_GUARDIAN_DRY_RUN=true` while reviewing a new configuration.

Maintenance scripts are manual tools, not installation steps. In particular,
`drain-stale-review-backlog.ts` retains a historical pre-fix cutoff and must not
be run on a fresh installation. Review its predicate and dry-run output before
any explicit `--execute` operation.
