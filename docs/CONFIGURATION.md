# Installation configuration

`bin/cortex` accepts a JSON manifest with exactly the keys below. Unknown keys, duplicate JSON keys, duplicate IDs/names, unsafe/non-normalized paths, overlapping source/data/backup paths, unsupported values, dependency cycles and selected port conflicts are rejected. Booleans are JSON booleans, not strings or integers. Credentials are forbidden; the schema intentionally has no credential fields. Keep even non-secret configuration outside Git, mode 0600.

```json
{
  "schema_version": 1,
  "root": "/opt/cortex",
  "data_root": "/var/lib/cortex",
  "admin_user": "operator",
  "hostname": "cortex",
  "timezone": "Etc/UTC",
  "network": {
    "mode": "local",
    "public_url": "http://localhost:3080"
  },
  "services": ["dashboard", "postgresql"],
  "agents": [],
  "development": [],
  "backups": {"enabled": false, "destination": null},
  "updates": {"automatic": false}
}
```

## Host and storage

- `schema_version`: integer `1` only.
- `root`: dedicated absolute application directory. Must initially be empty and separate from the source checkout. Existing owned installations may reconcile the same root.
- `data_root`: dedicated absolute persistent-data directory, not inside the application root or source checkout.
- Paths must be normalized, symlink-free, without whitespace or shell metacharacters; allowed top-level locations are `/opt`, `/srv`, `/var`, `/mnt`, `/media` and `/home`. Broad/system roots and predecessor paths are rejected. This is not authorization to adopt an existing directory; apply independently enforces fresh-host conditions.
- Existing installation-path ancestors must be root-owned and not group/world writable. `/var/cache/cortex-build` is reserved for the unprivileged build account and must not overlap application or persistent-data paths.
- `admin_user`: existing human Linux login with an unlocked local password; not `root`, `cortex` or `postgres`. Installation does not set or print this password.
- `hostname`: one lowercase DNS label, explicitly applied with `hostnamectl`.
- `timezone`: an installed IANA timezone, explicitly applied with `timedatectl`.

## Network

`mode` is `local` or `tailscale`. Local mode uses `http://localhost:3080` without Caddy or `http://localhost:8080` when Caddy is selected, with matching SSH forwarding for remote access. Validation requires the port corresponding to that selected front door; the interview updates the canonical origin after service choices. Use the manifest origin consistently for both login and Terminal rather than adding permissive aliases. Tailscale mode requires your own exact `https://DEVICE.TAILNET.ts.net` origin, without credentials, path, query, fragment or a nonstandard port. Obtain it from your intended target/tailnet; never copy the assistant host's hostname. Selecting tailnet mode adds the `tailscale` service dependency. Enrollment requires operator-controlled authentication; the manifest is not an enrollment secret store. The dashboard itself still binds loopback.

No Cloudflare account, public DNS record, bridge, disk partition or GPU driver is inferred or altered. Such changes need separately scoped operator approval outside this installer.

## Services and dependency planning

`services` is an array of catalog IDs; `dashboard` and `postgresql` are required. See [SERVICES.md](SERVICES.md) and `catalog/services.json` for the available IDs, exact dependencies, ports, upstream licenses/provenance, required secret names, endpoints and resource guidance. A service's dependencies are included in the reviewed plan even if absent from this input array. Nothing outside that closure, selected agent runtimes or selected development/network requirements is silently added.

`/etc/cortex/resolved-install.json` is generated from this input with the full service closure; it is used to seed the dashboard catalog, not as a second operator configuration source. Edit the original manifest before initial approval only.

## Agents

No agents are created by default. Each object has exactly:

```json
{
  "name": "research",
  "runtime": "hermes",
  "model": "provider/model-id",
  "channels": ["none"]
}
```

`runtime` is `hermes` or `openclaw`; its service is added to the reviewed dependency plan. `model` is a non-secret model identifier, not a URL or key. `channels` contains `telegram`, `whatsapp`, or only `none`. Names use lowercase letters, digits and hyphens, beginning with a letter; agent/development names are globally unique within the manifest. Telegram bot tokens, WhatsApp pairing and inference provider credentials are established through local protected runtime configuration, not copied personal profiles or manifest answers. Review the service's setup prerequisites before expecting end-to-end model/channel health.

Agent and development names are limited to 24 characters so generated system identities and memory-bank names remain valid. This limit does not shorten the separate hostname or administrator-login rules.

At most 100 agents are supported. The plan displays each dynamic TCP reservation: agents sorted by name receive API port `18800 + index` (zero-based); Hermes agents selecting WhatsApp additionally reserve `18900 + index`. OpenClaw's WhatsApp channel has no additional listener. Validation rejects collisions with selected service ports before approval, and fresh-host preflight checks those ports are free.

Every selected agent also requires Hindsight and its authenticated per-agent memory boundary; that dependency and its resource/account prerequisites appear in the plan before approval. Agents are not installed with unprotected cross-profile memory as a fallback.

## Development environments

No environments are created by default. Each object has exactly `name`, `kind` (`container` or `vm`) and `image` (an Incus image identifier such as `images:ubuntu/26.04`). Any environment selects Incus. Managed NAT networking is the default; the installer never rewrites a host bridge. VM creation needs working virtualization support; selecting a VM is not proof that the host enforces a sandbox boundary.

## Backup and update policy

`backups.enabled` and `updates.automatic` are booleans. Enabled backups require an absolute `backups.destination` that does not overlap application or data directories. Disabled backups require `destination: null`. Use a pre-mounted dedicated destination with sufficient free space; no mount or disk formatting is inferred. Backups include credentials and must not be published. Exact lifecycle/timer/update semantics and restoration commands belong to [SERVICES.md](SERVICES.md); these are not promises of automatic major-version database migrations or upstream account setup.

## Private state and dashboard environment

- `/etc/cortex/install.json`: canonical non-secret operator manifest, root mode 0600 after apply.
- `/etc/cortex/resolved-install.json`: effective dependency-expanded manifest, root mode 0600.
- `/etc/cortex/ownership.json`: root mode 0600 ownership identity; never treated as a successful stage marker.
- `/etc/cortex/secrets/`: root mode 0700, per-service `.env` files root mode 0600.
- `postgresql.env`: generated `POSTGRES_USER`, `POSTGRES_DB`, `POSTGRES_PASSWORD` for the database owner. Never given to dependency build scripts or the running dashboard.
- `dashboard.env`: generated `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER=dashboard`, `DB_PASSWORD`, `CORTEX_MASTER_KEY`, `CORTEX_ROOT`, `CORTEX_SECRETS_DIR`, `CORTEX_DATA_ROOT`, `CORTEX_PUBLIC_URL`, `CORTEX_ADMIN_USER`, `CORTEX_HARNESS_HOME`, `CORTEX_BACKUP_ROOT`, `HOST`, `PORT`, `NODE_ENV`. Harness home is the chosen administrator's home; the backup root follows the chosen backup destination when enabled.
- `terminal.env`: generated dashboard-runtime `DB_*` credentials plus `TERMINAL_HOST=127.0.0.1`, `TERMINAL_PORT=3081`, `TERMINAL_CWD` set to the administrator's home, `ALLOWED_ORIGIN` set to the exact chosen dashboard origin, and `NODE_ENV=production`. The core wrapper exposes `/terminal/ws` on dashboard port 3080; port 3082 is reserved for its internal HTTP worker.

Systemd consumes `dashboard.env` without putting secret values on the command line. The root dashboard process is privileged by design; mode 0600 does not isolate secrets from that process. Database migrations/bootstrap use a separate owner connection, then grant the runtime role only its required permissions, preserving append-only audit restrictions. The preserved internal PAM/group/package identifiers are implementation names, not host-specific state.

Never run `cat` on credential files through a logging coding agent. Use a local editor or the documented interactive provider setup, verify ownership/mode without printing values, and share only redacted failure summaries.
