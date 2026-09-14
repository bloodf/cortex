# Selectable services

The authoritative machine-readable catalog is `catalog/services.json`. The installer expands explicit dependencies and shows the resulting selection before approval. Selecting an agent selects its runtime and authenticated memory dependencies; selecting a development environment selects Incus. No personal agent profiles, conversation history, model files, plugin configuration, or external credentials are copied from another installation. Selected recipes disclose their model and plugin defaults: Whisper may download its configured speech model, and agent runtimes install their documented memory integrations.

## Secret contract

The operator manifest contains no secrets. Per-service files live at `/etc/cortex/secrets/ID.env`, owned by root with mode 0600 in a mode-0700 directory. The literal format is `KEY=value` without shell quoting, `export`, substitutions, or multiline values. Never paste these files into chat or commit them. `generated_secrets` are cryptographically random and generated once; reapplying never rotates an existing credential. `required_secrets` must be supplied locally before installation can proceed. Database initial passwords cannot be changed by editing an environment file: use the database's authenticated password-change procedure, then update its clients.

Container recipes provide registry-verified immutable defaults. An operator can override a `*_IMAGE` setting with another complete `repository@sha256:...` reference from the linked upstream registry; floating tags are rejected. A digest is an integrity pin, not a security review: inspect publisher, architecture, release notes, vulnerabilities, and configuration before approval. Review newer security releases before production use. Package-managed Caddy/Tailscale follow signed Ubuntu/vendor repositories rather than fabricated version pins.

## Core databases and ingress

| ID | Local endpoint | Credentials | Persistent data |
| --- | --- | --- | --- |
| dashboard | `http://127.0.0.1:3080` | Installer provisions database runtime role and session master key; login uses the operator account | PostgreSQL and selected application state |
| postgresql | `127.0.0.1:5432` | `POSTGRES_USER=cortex`, `POSTGRES_DB=cortex`, generated `POSTGRES_PASSWORD` | `data_root/postgresql` |
| redis | `127.0.0.1:6379` | Generated `REDIS_PASSWORD` | `data_root/redis` |
| mongodb | `127.0.0.1:27017` | `MONGO_INITDB_ROOT_USERNAME=cortex`, generated `MONGO_INITDB_ROOT_PASSWORD` | `data_root/mongodb` |
| mysql | `127.0.0.1:3306` | Generated `MYSQL_ROOT_PASSWORD`; `MYSQL_ROOT_HOST=%` permits authenticated private-network administration/exporting | `data_root/mysql` |
| caddy | `http://127.0.0.1:8080` | No separate credentials; forwards only the authenticated dashboard | `/etc/caddy/Caddyfile` |
| tailscale | Operator's HTTPS MagicDNS URL | Operator `TAILSCALE_AUTHKEY` for first enrollment; no fabricated identity | `/var/lib/tailscale` |

Compose services share the `cortex-private` bridge for authenticated database connections using `cortex-ID` DNS names. Published ports bind IPv4 loopback only. This bridge is not a tenant-isolation boundary: selected applications can reach one another. The baseline database administrator is a provisioning identity; use dedicated minimum-privilege roles for additional applications. The dashboard runtime receives a separate nonsuperuser PostgreSQL role.

Caddy deliberately does not expose unauthenticated database or AI APIs. Tailscale Serve forwards only the authenticated dashboard, never enables Funnel, and checks the configured URL against the enrolled node's actual MagicDNS hostname. Set tailnet ACLs appropriate to the operator group. Selecting Tailscale in local mode enrolls networking but does not create a dashboard Serve route. Access other loopback UIs with an SSH tunnel, for example `ssh -L 3001:127.0.0.1:3001 operator@example.com`; SSH host/user are examples, not defaults. Complete each application's first-run administrator setup before forwarding it to additional users.

The terminal sidecar is an authenticated dashboard companion, not an open shell service. No blanket Docker-group membership is granted to agents or the operator by these recipes.

## Lifecycle

After reviewing `cortex plan`, the base installer invokes:

```sh
sudo python3 /opt/cortex/installer/services.py apply --manifest /etc/cortex/install.json --approved
sudo python3 /opt/cortex/installer/services.py verify --manifest /etc/cortex/install.json
```

The same entry point supports `start`, `stop`, `restart`, and `update`, with `--approved` for mutations and optional `--only ID`. An `--only` operation never installs unselected services or silently adds missing dependencies; initialize dependencies through the normal installer. Stops reverse dependency order. `update` pulls the reviewed pinned images and recreates containers, retaining bind-mounted data; it does not follow floating latest tags. Change pins only after reviewing compatibility, taking a backup, and planning rollback. Package-managed runtime upgrades follow their configured repositories. Removing a manifest selection does not erase its old data. Destructive uninstall and disk repartitioning are not inferred from apply.

Verification checks the expected number of containers, running state, every declared container healthcheck, and the recipe's HTTP/TCP/command probe. Application-specific onboarding, external provider inference, IMAP authorization, and human-scanned WhatsApp pairing remain explicit operator checks documented in the family guides. A missing required credential, failed readiness probe, or failed kernel-isolation probe aborts the operation; it is never reported as installed successfully.

## Recipe families

- [Applications, AI, media, and automation](services-apps.md)
- [Monitoring, exporters, and database administration](services-observability.md)
- [Agents, sandboxes, and development environments](services-agents.md)
- [Authenticated per-agent memory](services-memory.md)

These guides enumerate every family entry's dependencies, secret keys, image source, resource requirements, initialization procedure, and verification scope. This repository has not been validated on the existing host: it must pass the fresh Ubuntu 26.04 disposable-guest gate before release or deployment.

## Backups and scheduled updates

When enabled in the installation manifest, daily `cortex-backup.timer` and weekly `cortex-update.timer` are installed. The update job first takes a backup when backups are enabled, then applies configured immutable runtime pins and runs service verification. It never invents a new version or migrates between database majors. The install manifest is ownership-locked: to pause a schedule after installation, explicitly run `sudo systemctl disable --now cortex-backup.timer` or `cortex-update.timer`; editing the manifest is not an approved reconfiguration procedure.

```sh
sudo python3 /opt/cortex/scripts/operations.py backup --manifest /etc/cortex/install.json --approved
sudo python3 /opt/cortex/scripts/operations.py update --manifest /etc/cortex/install.json --approved
```

Backups are cold snapshots: selected running Compose containers, Cortex units, development guests, and the Incus daemon are stopped; only the previously running objects are restarted afterward, even on archive failure. The archive includes `data_root`, `/etc/cortex`, and selected Incus/Tailscale/Caddy state. GNU tar retains ACLs, xattrs, sparse files, and numeric ownership. Every member is read back before the `.partial` archive is promoted and its receipt written. Any read/write error or failure to resume a stopped workload fails the command. No automatic retention deletion occurs. Destination must be private and outside `data_root`; choose a separate disk and maintain an encrypted off-host copy. Archives contain credentials and must never be uploaded to a public issue or repository.

An archive receipt proves readable cold capture, not successful disaster recovery. Before relying on it, perform a restore rehearsal on a separate fresh Ubuntu 26.04 guest: inspect archive paths, recreate the same install root and service versions, stop all restored workloads, restore the archived paths with GNU tar ownership/ACL/xattr preservation, regenerate installed units with the reviewed manifest, and run `cortex verify`. Incus daemon metadata and its storage pool must be restored together. Do not extract over a running host or overwrite a newer installation. This installer does not infer destructive restore approval or delete a target to make it fit.

## Database image provenance

Registry metadata used for the included integrity pins:

- [PostgreSQL 17.6 Bookworm](https://hub.docker.com/v2/repositories/library/postgres/tags/17.6-bookworm)
- [Redis 8.2.1 Alpine](https://hub.docker.com/v2/repositories/library/redis/tags/8.2.1-alpine)
- [MongoDB 8.0.13](https://hub.docker.com/v2/repositories/library/mongo/tags/8.0.13)
- [MySQL 8.4.6](https://hub.docker.com/v2/repositories/library/mysql/tags/8.4.6)
- [Tailscale Ubuntu packages](https://pkgs.tailscale.com/stable/#ubuntu)

All recipe execution is restricted to the approved installed Ubuntu 26.04 target. Configuration fields are not evidence of kernel enforcement; agent confinement uses runtime probes and fails closed where enforcement is missing.
