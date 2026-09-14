# Install Cortex on a fresh Ubuntu server

Cortex installs a full dashboard and the capabilities you select. It is not an OS image builder, a migration tool, or a prompt-only installer. Python's standard library drives the interview, approval, real provisioning and verification. No AI service is required; an optional tool-neutral assistant prompt is in [prompts/install.md](../prompts/install.md).

## Requirements and trust boundary

- A **fresh Ubuntu 26.04 LTS** server with systemd, an existing human login (UID 1000 or higher) and an unlocked local password. The dashboard authenticates through PAM. Set the password directly with `passwd`; do not put it in chat, a manifest, shell arguments or a pasted terminal transcript.
- Root privileges for apply/verify, network access to Ubuntu package mirrors, npm and selected upstream image/runtime sources. Python 3 is sufficient for interview/validate/plan.
- Dedicated empty application and data directories. Defaults are `/opt/cortex` and `/var/lib/cortex`. Existing mounts can be used through a dedicated child directory. The installer does not format disks, create partitions, move existing data, change host bridges or configure GPU drivers.
- Capacity for your selected services. Provision a 16 GiB-class RAM/swap allocation for dashboard builds, with at least 15 GiB reported total RAM plus swap and 12 GiB currently available before apply. A real fresh 8 GiB guest OOM-killed the build; 8 GiB is not a supported build target. The enforced floor is not proof of a completed installation or sufficient capacity for all optional workloads. The installer does not create swap automatically. Optional inference, VMs and media workloads need additional resources; review catalog guidance, upstream model requirements, image licenses and storage growth before approval.
- A reviewed Cortex source checkout **outside the intended install root** (for example `/srv/cortex-source`). Do not use this installer to adopt a pre-existing checkout or application directory. Source is copied to the empty install root; the original checkout is not chowned or built in place.

The manifest's hostname and timezone are explicit operator choices and are applied. Core PostgreSQL runs in Docker; consequently Docker is a core prerequisite, not an optional surprise. Installation uses Ubuntu's `nodejs`/`npm` packages, refuses Node below 22, and installs **pnpm 10.12.1** into the install root's private toolchain prefix. These requirements come from the shipped root `package.json` (`engines.node` and `packageManager`). `libpam0g-dev` and build tools compile the PAM binding; workspace native-build permissions are in `pnpm-workspace.yaml`. No remote shell installer is piped into a root shell.

Cortex's dashboard is a privileged host administration surface. It runs as **root**, because its existing PAM, secret, process and host-management functions require that authority. This is not an unprivileged sandbox. It listens on loopback; use SSH forwarding or the explicitly selected Tailscale integration, not a public port-forward. Third-party dependency build scripts run as the dedicated `cortex` system user. Install only source and dependencies you trust. Never add untrusted users to the Docker group.

The build user's home/cache is `/var/cache/cortex-build`, separate from private service data. On reruns the dashboard and terminal are stopped before making the build tree writable. Ordinary build cleanup restores root ownership, removes group/world write and set-ID permissions, and rejects links outside the installed tree even when the build fails. This account must not be added to Docker, Incus or administrator groups. If the installer itself was killed before cleanup, an exact ownership identity plus the expected dedicated build account allows automatic recovery: its residual processes are stopped and its writable application tree/cache are quarantined, never trusted as root-executable dependencies.

The repository's license is in [LICENSE](../LICENSE); optional services retain their own upstream licenses and usage terms. Selecting a recipe does not relicense its image or model. Review [SERVICES.md](SERVICES.md) and each catalog entry's upstream provenance before approval.

## 1. Interview, one choice at a time

From the reviewed source checkout, on the target server:

```sh
sudo python3 bin/cortex interview --manifest /etc/cortex/install.json
```

The interview asks bounded questions about storage, administrator, hostname/timezone, network origin, each optional service, agent names/model IDs/channels, development environments, backups and updates. Optional services, agents, channels and development environments are never defaulted on. Service dependencies are displayed and expanded in the plan. The interview writes only a mode-0600 non-secret manifest; it installs nothing. A pre-existing manifest is not overwritten. Edit non-secret answers locally or choose another private manifest path.

Secrets are not interview questions. Cortex generates local database credentials and encryption material under `/etc/cortex/secrets`; externally issued credentials are entered directly into protected files following the relevant recipe. Do not paste their contents into a terminal agent. Agents use the model you choose; no inference account or GPU capability is inferred from the machine running the assistant.

## 2. Validate and review the actual plan

```sh
sudo python3 bin/cortex validate --manifest /etc/cortex/install.json
sudo python3 bin/cortex plan --manifest /etc/cortex/install.json
```

Both commands are non-provisioning. The plan includes the exact manifest, ordered dependency closure, catalog details and operation categories. Read the selected images, ports, dependencies, secret key **names**, resource/security guidance and policy. Its `approval` field is a SHA-256 bound to the manifest, selected catalog and shipped source. Changing any of these requires a new reviewed plan.

For unattended installation, write the schema from [CONFIGURATION.md](CONFIGURATION.md) directly to a protected file outside Git, then use the same validation and plan steps. There is no blanket `--yes` switch.

## 3. Apply only the reviewed plan

Substitute the exact 64-character `approval` value from the plan:

```sh
sudo python3 bin/cortex apply --manifest /etc/cortex/install.json --approve APPROVAL_SHA256
```

Apply refuses a predecessor deployment, unrelated existing dashboard/PostgreSQL units, existing Docker containers, occupied selected ports, nonempty unowned install/data directories, unsafe paths, or a manifest that does not own an existing Cortex install. It serializes installers with a lock, records ownership (not a success checkpoint), installs prerequisites, creates protected credentials, provisions PostgreSQL, builds all shared packages and the dashboard, applies migrations, creates a separate non-owner database role, seeds only selected services, configures PAM and systemd, then executes selected service recipes.

The canonical manifest stays at `/etc/cortex/install.json`; a generated `/etc/cortex/resolved-install.json` contains dependency-expanded services for catalog bootstrap. State and secrets are outside the source checkout and must never enter Git. The database owner credential is used only for migration/bootstrap; the dashboard's runtime database account is not a superuser or table owner.

Subprocess output is not echoed because package tools and service failures can print credentials. Failures report the operation and exit status plus `/etc/cortex/last-failure.log`, an atomically written root-mode-0600 diagnostic retaining at most the final 256 KiB of output. That file can contain secrets: inspect it locally as an operator, never through an automatically logging agent or by uploading raw contents. An interrupted apply is not reported successful.

## 4. Verify and authenticate

```sh
sudo python3 bin/cortex verify --manifest /etc/cortex/install.json
```

Verification checks ownership and permissions, installed manifest identity, build artifact presence, active dashboard and terminal units, PostgreSQL readiness, the served login surface, terminal health, same-origin WebSocket proxy rejection of missing sessions/cross-origin requests, and selected services' real verification routines. It does not claim that these checks prove an authenticated PTY, your external provider account, message delivery, backup restore, GPU driver or VM isolation. Log in and exercise the real Terminal plus your chosen integrations.

The core native dashboard proxy listens on loopback port 3080, routes HTTP to its managed dashboard worker on 3082, and forwards only `/terminal/ws` to the authenticated sidecar on 3081 while preserving session cookies and Origin. All three ports are reserved core dependencies; Caddy is not silently installed. The sidecar enforces the configured dashboard origin and live session/administrator checks before granting a PTY.

For local access, create a tunnel from your workstation, then open `http://localhost:3080`:

```sh
ssh -L 3080:127.0.0.1:3080 operator@example.com
```

If you selected Caddy, the canonical local origin is instead `http://localhost:8080`. Forward `8080:127.0.0.1:8080` with SSH and open that exact origin. Do not alternate front-door origins: terminal Origin enforcement follows the single URL in your manifest.

Use your chosen server account instead of `operator`, and your own server address instead of `example.com`. Log in with that account's Linux password. The installer grants the existing internal `cortexos-admin` group and installs `/etc/pam.d/cortexos-dashboard`; these are implementation compatibility names, not inherited accounts or profiles.

## Resume and rerun

Keep the same source checkout and manifest, review the plan again, then rerun apply with its exact approval. Every apply reconciles real files, package versions, credentials, database roles/migrations, units and service state. It never skips work because a stage has a “done” marker. Existing generated credentials are retained, not rotated. Rebuilding can restart the dashboard; a rerun is an administration action, not a zero-downtime promise.

After an OOM or hard interruption, rerun from the original reviewed source checkout **outside** the install root once capacity is sufficient. No manual `chown`, marker deletion or secret regeneration is needed. Recovery preserves the interrupted tree and build cache as root-only sibling directories with an `.interrupted-` suffix, then copies reviewed source and installs dependencies afresh. `/etc/cortex` credentials and persistent service data remain in place. The quarantine preserves potentially changed files for operator review; it is not an installation checkpoint and is never executed. Unrelated ownership or an unexpected build identity is still refused.

A different manifest is refused once ownership exists. Do not delete ownership files to force adoption, point the installer at production, or use install as a migration command. Service lifecycle and policy commands are documented in [SERVICES.md](SERVICES.md). Backups contain secrets and must remain private; test restoration separately before relying on them.

## Maintainer checks

`python3 installer/selfcheck.py` exercises a small set of uncertain validation and symlink boundaries without applying an installation. Full installation proof requires a disposable fresh Ubuntu guest; syntax checks and mocked tests do not establish host provisioning, PAM authentication or kernel isolation correctness.
