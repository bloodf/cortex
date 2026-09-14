# Agents, development environments and execution services

These recipes target a fresh Ubuntu 26.04 host. They do not inspect or import another installation, create a default agent, choose a model, enable a personal plugin, or obtain externally issued credentials. Source acquisition is automatic; operators do not need to build runtime archives.

## What selecting each service installs

| Catalog ID | Installation | Runtime verification |
| --- | --- | --- |
| `incus` | Ubuntu `incus` and `incus-client` 6.0.5-8; directory-backed `cortex` pool in `data_root/incus-pool`; restricted base projects | Exact package version, local API availability, no HTTPS API listener, project restrictions; selected guests must execute `/bin/true` |
| `hermes` | Upstream source commit `345cd2b057a452236de401d3534b8502a7465e8d` (0.21.3), uv 0.12.13, Python 3.13.9 and frozen upstream dependencies | Installed CLI version; named gateways additionally require successful confinement guard and authenticated `/v1/models` |
| `openclaw` | npm 2026.9.4, verified against the upstream SHA-512 integrity, with private Node 24.16.0 | Installed CLI version; named gateways additionally require successful confinement guard and loopback `/healthz` |
| `sandbox-runner` | Ubuntu Podman 5.7.0+ds2-3build1; gVisor 20260907.0 including required sidecar binaries; rootless `cx-sandbox` user | Execute `/bin/true` through the authenticated API using rootless Podman and the explicitly selected `runsc`, with no network |
| `kernel-browser` | Browserless Chromium OCI digest, authenticated, Docker project/container `cortex-kernel-browser` | Actually render a synthetic HTML page to a PDF; check the returned PDF signature |

No privileged containers, Docker socket mounts or fallback from gVisor to a weaker OCI runtime are used. `kernel-browser` is the existing service name for Browserless Chromium, not an installation of a hosted Kernel account.

The runtime installers download only pinned revisions. Hermes uses its upstream `uv.lock` with `--frozen`; OpenClaw verifies the package tarball before npm installs it and records npm dependency integrity in its generated lockfile. Optional provider SDKs installed alongside Hermes do not enable external integrations. Only a selected WhatsApp channel installs the bridge's upstream lockfile dependencies. Node is private to `root/runtimes/node`, never a replacement for the dashboard's Node. Downloaded upstream distributions retain their license files.

## Manifest-driven agents

An agent object has `name`, `runtime`, `model`, and `channels`. `runtime` must also be selected in `services`. Names are lowercase letters, digits and hyphens, start with a letter, and are at most 24 characters. Model identifiers must be explicitly supplied. Channels are `telegram`, `whatsapp`, or `none`; `none` cannot be mixed with another channel.

The service engine runs this dispatcher once after installing the selected recipes:

```text
python3 /opt/cortex/scripts/agents/manage.py apply --manifest /etc/cortex/install.json
python3 /opt/cortex/scripts/agents/manage.py verify --manifest /etc/cortex/install.json
```

Substitute the chosen install root. Each script also supports `start`, `stop`, `restart` and `update`. Dispatcher lifecycle actions apply to every agent/development entry in that manifest. Individual agents are controlled with `systemctl start|stop|restart cortex-agent-NAME.service`. Removing a manifest entry does not erase its files, account or old unit; explicitly stop and disable it before removing the entry. No automatic data deletion is performed.

For each named agent:

- Linux account `cx-NAME`, private mode-0700 home `data_root/agents/NAME` and workspace beneath it.
- One systemd unit `cortex-agent-NAME.service`, not separate CLI/API/channel services.
- Agents sorted by name use loopback API ports 18800–18899. A Hermes WhatsApp bridge uses the corresponding 18900–18999 port. Changing the selected name set can shift ports; apply restarts the named services and rewrites the registry. Reserve both ranges from other services.
- Hermes config is JSON-compatible YAML at `home/config.yaml`, with canonical `model.default`, `model.provider` and selected `platforms`. No model environment override is emitted. Optional reasoning belongs in `agent.reasoning_effort`; model-specific overrides can take precedence.
- OpenClaw config is `home/openclaw.json`, with `agents.defaults.model.primary`, loopback gateway binding and the OpenAI-compatible chat endpoint enabled.
- Dashboard discovery registry: `data_root/hermes/profiles.json`, object `profiles` array with `profile`, `home`, `apiPort`, `model`, `runtime`, `unitName`, `secretPath`, `hindsightBank` and empty `apps`. The only memory bank permitted for that agent is `agent-NAME`; no reasoning setting is invented.

### Credentials and channel setup

Before apply, write `/etc/cortex/secrets/agent-NAME.env` as root, mode 0600, with literal `KEY=value` lines. Do not put credentials in the manifest, repository, shell history or chat. Do not add shell quoting, `export`, variable substitution or multiline values.

`MODEL_PROVIDER` is required. Supply the provider's actual issued credential under its native environment variable. Supported keys are:

- `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`;
- `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`;
- `GROQ_API_KEY`, `XAI_API_KEY`, `MISTRAL_API_KEY`, `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`;
- `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `ZAI_API_KEY`, `GLM_API_KEY`, `KIMI_API_KEY`;
- `HF_TOKEN`, `COPILOT_GITHUB_TOKEN`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.

Choose a model identifier compatible with the selected runtime/provider. An explicit `OPENAI_BASE_URL` automatically registers that exact model as the OpenClaw `cortex` custom provider using its OpenAI-completions API and issued `OPENAI_API_KEY`. The upstream model ID remains the manifest value; the internal OpenClaw reference is `cortex/MODEL`. No unverified capability limits or pricing are invented. Other custom provider protocols must use their native documented runtime configuration.

Telegram additionally requires `TELEGRAM_BOT_TOKEN` and a comma-separated `TELEGRAM_ALLOWED_USERS`. WhatsApp requires `WHATSAPP_ALLOWED_USERS` and interactive pairing using the runtime's own CLI in that agent's home. These are operator identities, never generated guesses. Unselected channel credentials and unsupported environment switches are rejected. OpenClaw uses allowlisted DMs with groups disabled; Hermes WhatsApp likewise uses allowlist/disabled policies. No public inbound webhook is configured.

The installer generates only local gateway authentication, storing its authoritative value in root-owned `/etc/cortex/secrets/agent-NAME-local.env`. The effective root-only `agent-NAME-runtime.env` contains the native runtime key plus `HERMES_API_KEY` for the dashboard adapter. Tokens are never read from an agent-writable file. Root provisioning walks directories with no-follow directory descriptors and applies ownership through descriptors, rather than following agent-created symlinks.

Pair WhatsApp using the pinned runtime's `hermes whatsapp` or `openclaw channels login` flow as that agent account, with its private HOME/config environment and private Node on PATH. Stop its systemd unit during standalone pairing to avoid session lock contention, then restart it. QR/pairing output is sensitive and belongs only on the operator's terminal. A healthy local API is **not** proof that a channel is paired or that a model subscription works: perform a real message round trip on every selected channel, and a dashboard chat against the chosen model, before accepting the installation. These external acceptance checks are reported separately, not fabricated by the installer.

### Mandatory bank-scoped memory

Every named agent requires Hindsight selected in the manifest. Before this dispatcher runs, the memory controller provisions `agent-NAME` and adds only its scoped `HINDSIGHT_API_KEY`, fixed `HINDSIGHT_API_URL=http://127.0.0.1:8888`, and `HINDSIGHT_BANK_ID=agent-NAME` to that agent's root-only input environment. The agent never receives Hindsight's administrator key. The broker, not a cooperative prompt or client setting, authorizes bank scope.

Hermes installs the upstream frozen `hindsight-client==0.6.1` extra, sets `memory.provider=hindsight`, and writes `home/hindsight/config.json` for `local_external` mode, automatic retain/recall, hybrid tools, and synchronous retention. OpenClaw automatically installs integrity-verified `@vectorize-io/hindsight-openclaw` 0.12.0 into the root-owned runtime, loads that exact path, selects its memory slot, resolves the scoped token through an environment SecretRef, and disables dynamic bank naming. No embedded daemon or fallback bank is configured. Native plugin behavior against the broker's allowlisted operations remains part of fresh-target acceptance.

## Confinement boundary

Each agent runs as its own unprivileged user, with a read-only host filesystem, only its own home writable, private temporary files/devices, no capabilities, no privilege escalation, and blocked namespace creation. The unit denies all explicit socket binds except its own exact TCP listener ports. The same-UID `ExecStartPre` guard first checks the declared allow/deny rules, then actually attempts IPv4 and IPv6 TCP/UDP binds. Allowed TCP ports must bind; protected ports and UDP must fail with `EPERM` or `EACCES`. An occupied port, unsupported IPv6, or missing kernel/systemd enforcement fails startup; none is accepted as proof of confinement. This is necessary even on Ubuntu 26.04: a directive being accepted is not behavioral evidence.

Outbound isolation is a separate per-UID nftables boundary. `cortex-agent-firewall.service`, required by every agent unit, rejects private, loopback, link-local, carrier-grade NAT and multicast destinations, plus every Docker bridge IPAM subnet, including globally addressed Docker ranges. Exceptions are only that UID's API and selected WhatsApp bridge TCP ports, broker TCP 8888, and systemd-resolved stub 127.0.0.53:53. Explicit provider URLs must be HTTPS with a hostname resolving only to globally routable addresses, without embedded credentials, query or fragment; runtime firewall denial also prevents private-address DNS rebinding.

The sole local inference exception is `OPENAI_BASE_URL=http://127.0.0.1:20128/v1` (an optional final slash is accepted), with `durindoor` selected and its issued `OPENAI_API_KEY`. Before allowing that UID to connect to IPv4 loopback TCP 20128, each refresh proves the same chat request is rejected without credentials (401/403) and returns an actual authenticated completion for the selected model. This makes a small inference request and can incur provider usage. A public model list, refusal, timeout or bad-key failure is not proof. Configure selected DurinDoor's provider/model route and issue its key through its own authenticated setup. Direct keyless Ollama, arbitrary local ports, LAN and Tailscale endpoints are not permitted for agents; route them through authenticated DurinDoor or choose a public HTTPS provider. Selecting Ollama alone does not grant agent network access to it. No separate proxy must be invented by the operator.

Apply/update stop named old units before sorted-port reallocation and rewrite the nft policy. Start/restart refresh the policy before agents start. Service-only network changes must call `python3 ROOT/scripts/agents/firewall.py apply --manifest PATH` before restarting agents. The same runtime `ExecStartPre` actively attempts TCP connections to every Docker bridge gateway and both loopbacks on protected port 3080; only `EPERM`/`EACCES` is accepted as denial, never refused connections, timeout or missing routes. It then connects successfully to its own IPv4/IPv6 listener. Failed or ambiguous enforcement prevents startup. Policy and probe metadata are root-owned and persistent across boots.

Runtime filesystem/account isolation is not equivalent to a VM security boundary. Do not install agents into Docker or Incus administrator groups. Optional tools needing namespaces, device access, private-network access or additional listeners fail rather than silently weakening the boundary.

## Development containers and VMs

Every `development` item produces project `cortex-dev-NAME` and instance `NAME`. The manifest's `kind` controls container versus VM. `image` accepts an operator-selected Incus alias such as `images:ubuntu/26.04` or an immutable fingerprint. On first apply, `incus image info` resolves the alias with `--vm` when appropriate, checks the reported type, and pins the full fingerprint in root-owned mode-0600 `/etc/cortex/development-NAME-image.json`. The image is copied into that project's image store and the instance is created from the fingerprint, not a moving alias. Reruns retain the recorded resolution and compare `volatile.base_image` with it; changing the original image choice or kind requires explicit export/replacement, never destructive automatic conversion. No image or personal development language is chosen for the operator. Containers are unprivileged, nesting is disabled, and projects forbid low-level configuration, host mounts and proxy devices. Each guest has 2 CPUs and 4 GiB memory.

Each instance has an `eth0` NIC on the new, explicitly Cortex-owned `cortexdev0` managed bridge, with automatic private IPv4 allocation and NAT internet access. IPv6 is disabled on that bridge. MAC/IPv4/IPv6 anti-spoofing is enabled. Per-project policy allows only this managed network; a pre-existing unowned bridge with that name is never adopted or rewritten. Persistent nftables rules permit DHCP/DNS to the bridge but deny other host access, private/link-local/Docker destinations and bridge-layer guest-to-guest forwarding. Docker forwarding coexistence is restored after daemon restarts without changing Docker's own bridge configuration. This supports package downloads and public source repositories while keeping the development network away from host administration and sibling application backends.

Choose a Linux image with `/bin/sh` and a supported package manager: Debian/Ubuntu (`apt-get`), Fedora-family (`dnf`) or Alpine (`apk`). Apply installs generic Git, curl, CA certificates, a C/C++ compiler, make and Python 3 using that image's repositories. Unsupported images fail explicitly instead of claiming tools were provisioned. Images and guest package repositories remain operator choices, rather than a personal toolchain baked into the installer.

VM images must include a working Incus guest agent and the host must expose KVM. Selecting a VM on the supported Ubuntu 26.04 x86-64 target installs explicit OVMF `2025.11-3ubuntu7` and QEMU system/utilities/SPICE-module `1:10.2.1+ds-1ubuntu3.2` packages; required dependencies are not left to apt recommendations. If a running Incus daemon cached unavailable VM support before firmware installation, apply restarts that daemon to refresh its drivers. Guest readiness waits at most 180 seconds for the exact Incus agent-not-running startup condition; other command failures are not retried. Verification identifies the managed guest interface by its assigned MAC address, so a VM interface such as `enp5s0` need not be named `eth0`.

Optional root-owned mode-0600 `/etc/cortex/secrets/development-NAME.env` accepts exactly:

- `EXTRA_PACKAGES`: whitespace-separated package names appropriate to the chosen image; letters/digits and `.+:_-` are permitted, never flags or shell expressions.
- `SSH_PUBLIC_KEY`: one operator-supplied OpenSSH ed25519, RSA or ECDSA public key without `authorized_keys` options. No private key or personal identity is generated or imported.

When a key is supplied, the recipe installs the guest's OpenSSH server and enables a dedicated `cortex-ssh` service using `/etc/cortex-sshd.conf`. Only root public-key login is enabled; password/interactive authentication, forwarding, tunnels and X11 are disabled. SSH listens on guest IPv4 port 22, never a published host port. Use `incus list --project cortex-dev-NAME` to obtain the guest address and SSH from the Cortex host using the matching private key. Removing the public-key setting and reapplying disables the managed SSH service without destroying guest files. Without a key, the installer does not install or enable its SSH service; the real project-aware terminal below remains available.

Key-only SSH explicitly makes the guest root account eligible: locked/empty shadow entries receive a hash of a freshly generated, undisclosed password that is immediately discarded; account/password expiry is removed, and a disabled login shell becomes `/bin/sh`. No login password is printed or distributed, and SSH password/keyboard-interactive authentication remains disabled. This is necessary because OpenSSH with `UsePAM=no` rejects a locked account even when its authorized public key is valid. The recipe checks account eligibility separately from `sshd -T`; neither check substitutes for an actual operator-key login.

Operator lifecycle examples (run as root, substitute the selected name):

```text
incus exec NAME --project cortex-dev-NAME -- /bin/sh
incus start NAME --project cortex-dev-NAME
incus stop NAME --project cortex-dev-NAME --timeout 60
incus restart NAME --project cortex-dev-NAME --timeout 60
incus file push LOCAL_FILE NAME/root/LOCAL_FILE --project cortex-dev-NAME
incus file pull NAME/root/RESULT LOCAL_RESULT --project cortex-dev-NAME
incus export NAME /PROTECTED_BACKUP/NAME.tar.gz --project cortex-dev-NAME
```

A guest image must provide the requested shell/path. `incus exec` supplies an actual interactive terminal without distributing an Incus administrator socket or credential to the guest. Dashboard instance controls must include both project and instance identity. Additional host mounts, unmanaged NICs and a privileged/nested container mode are not part of this recipe. Export and explicitly replace a guest to change image or kind. A successful local SSH configuration check is not proof of possession of the operator's private key; complete one actual SSH login before accepting that optional integration.

Development `verify` reruns actual Git/compiler/Python commands and public DNS plus HTTPS from inside the guest. The host first proves a temporary development-gateway listener and actual core PostgreSQL TCP 5432 reachable. The guest then attempts those destinations while temporary non-verdict nftables observers identify its exact source/destination address and TCP-port tuple. Denial requires both a matching observer count and an increase in the actual blocking rule's counter; a timeout, refusal, or missing route alone cannot pass. Docker's native raw-prerouting private-address DROP precedes Cortex's forward hook, so PostgreSQL evidence is attributed to that real earlier guard while the Cortex private-destination rule is also checked. Running selected peers receive bounded temporary listeners; bridge verification accounts for exact-address ARP requests as well as TCP when neighbor discovery itself is blocked. Normal verification adds no ACCEPT exception and does not disable any firewall rule. Listeners and observers are removed in `finally` paths. Firewall refresh uses an atomic nftables reload when already active, avoiding a dependency restart that could stop agents or Incus.

An authorized disposable Ubuntu 26.04 proof on 2026-09-14 installed a fresh unprivileged development container, generic tools, and optional key-only SSH. Actual SSH public-key login and a PTY session succeeded; a password/keyboard-interactive attempt was rejected with public-key authentication as the sole offered method. The parent system's passwd, shadow, and canonical manifest remained byte-identical to their pre-SSH snapshots. Normal verification exercised public DNS/HTTPS and counter-backed host/PostgreSQL denial. A separate disposable experiment opened only a root-owned ephemeral listener inside the PostgreSQL network namespace: the same guest TCP tuple connected with narrowly scoped temporary exceptions, then was rejected by the actual Cortex forward rule after its exception was removed. All exceptions were removed afterward; PostgreSQL 5432 and other administrative ports were never exempted. That policy-mutating experiment is not part of normal verification.

The same disposable target subsequently booted an actual Ubuntu 26.04 VM and completed its first generic-tool installation. A cold boot exercised 35 agent-not-ready responses before the bounded readiness check succeeded. Final-source verification passed against both the preserved container and the new VM: each performed public DNS/HTTPS, gateway denial (one matching packet), actual PostgreSQL denial (three matching packets), and bidirectional selected-peer bridge denial (three matching packets per direction). Both guests also compiled and executed a C program and performed real Git object hashing through Python. Final SSH login succeeded, the parent account/manifest snapshots were unchanged, the dashboard returned HTTP 200, and no temporary observer or exception remained. Legacy generated DHCP state was repaired only in the disposable fixture; no cache patch or legacy migration is shipped.

## Sandbox and browser APIs

Sandbox endpoint: `http://127.0.0.1:8091/exec`, authenticated with `CORTEX_SANDBOX_API_TOKEN` from `sandbox-runner.env`. JSON accepts `cmd` argv, optional `env`, `stdin`, `timeoutSec`, `cpuMillis`, `memMB`, `networkMode`, `image`, and `role`. Only `networkMode=none` and the configured immutable image are accepted. At most two jobs run concurrently, with bounded request/output sizes, 120-second maximum duration, 2 CPUs, 2 GiB RAM, 128 PIDs, no capabilities, an unprivileged guest UID, read-only root and temporary scratch storage. Timeouts force-remove the named job container. The API never accepts host mounts or arbitrary Podman flags. `role` is informational, not an authorization policy. The broker is an ordinary rootless account with subordinate UID/GID mappings; it is not the same systemd sandbox as an agent because Podman needs namespaces and uidmap helpers. An Ubuntu AppArmor/user-namespace or cgroup failure stops installation; there is no privileged fallback.

Browser endpoint: `http://127.0.0.1:3333`, authenticated with `TOKEN` from `kernel-browser.env`, including CDP/HTTP request authentication according to Browserless docs. Browserless file URLs and CORS are disabled, private-address blocklisting remains enabled, and concurrency is limited. Containers join `cortex-private` and publish only on 127.0.0.1. Browser sessions are transient; no shared personal browser profile is imported.

## Updates and backup

`update` installs the same checked-in immutable references until a reviewed recipe change updates them. It is not an uncontrolled latest-version updater. Runtime downloads remain under `root/runtimes`; secrets/config remain under `/etc/cortex` and data under `data_root`. Keep downloaded runtime artifacts or a reproducible artifact mirror for disaster recovery. Missing old apt versions fail clearly instead of silently substituting newer versions.

Quiesce selected agent units and `cortex-sandbox-runner.service` before backing up data. For Incus, stop selected running instances, stop `incus.service` and `incus.socket`, and back up **both `/var/lib/incus` (daemon metadata) and `data_root/incus-pool`**. Saving only the pool is insufficient. Capture exact prior running states and restore only those states after backup. Instance exports are an alternative per-instance recovery path. Never restore a live Incus database or remove unselected instances. Browser sessions are disposable.

## Primary source provenance and remaining acceptance

Pins were obtained from primary metadata, not from the source host's running state:

- [Hermes immutable commit](https://github.com/NousResearch/hermes-agent/commit/345cd2b057a452236de401d3534b8502a7465e8d), [environment contract](https://hermes-agent.nousresearch.com/docs/reference/environment-variables), [CLI commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands).
- [OpenClaw 2026.9.4 npm metadata](https://registry.npmjs.org/openclaw/2026.9.4), [OpenAI HTTP API](https://docs.openclaw.ai/gateway/openai-http-api), [configuration reference](https://docs.openclaw.ai/gateway/configuration-reference).
- [Pinned Hermes Hindsight contract](https://github.com/NousResearch/hermes-agent/blob/345cd2b057a452236de401d3534b8502a7465e8d/plugins/memory/hindsight/README.md), [Hindsight OpenClaw 0.12.0 npm integrity](https://registry.npmjs.org/@vectorize-io%2Fhindsight-openclaw/0.12.0), [OpenClaw memory integration](https://github.com/vectorize-io/hindsight/blob/5ae43bf82e4bc414adb3a4510175676d2a0a4623/hindsight-integrations/openclaw/README.md).
- [Node 24.16.0 checksums](https://nodejs.org/dist/v24.16.0/SHASUMS256.txt), [uv 0.12.13](https://pypi.org/project/uv/0.12.13/).
- [Incus Ubuntu package](https://packages.ubuntu.com/resolute/incus), [project restrictions](https://linuxcontainers.org/incus/docs/main/reference/projects/), [confined project access](https://linuxcontainers.org/incus/docs/main/howto/projects_confine/).
- [Ubuntu OVMF firmware](https://packages.ubuntu.com/resolute/ovmf); QEMU package pins were checked against the disposable Ubuntu 26.04 target's signed Ubuntu archive metadata, not the source host.
- [Managed Incus NICs and anti-spoof options](https://linuxcontainers.org/incus/docs/main/reference/devices_nic/), [nftables bridge filtering](https://wiki.nftables.org/wiki-nftables/index.php/Bridge_filtering).
- [Podman Ubuntu package](https://packages.ubuntu.com/resolute/podman), [gVisor 20260907.0 release](https://github.com/google/gvisor/releases/tag/release-20260907.0), [multi-file gVisor installation](https://gvisor.dev/docs/user_guide/install/).
- [Browserless Docker configuration](https://docs.browserless.io/enterprise/docker/config). Browserless image index digest `sha256:ae07025606e03c9b263620aaf4d09c52728f71a104ac7d471a68c23dec72c05f` was resolved through GHCR's manifest API. Alpine 3.22 index digest `sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce` was resolved through Docker Hub's manifest API.

Implementation-phase validation was explicitly skipped; later authorized disposable-target development proofs are described above. The source installation remained read-only and its running services were not changed. Do not extend those development results to unexercised integrations: native Hermes/OpenClaw APIs, provider inference, external channel round trips, rootless gVisor execution, browser PDF rendering, and full dashboard integration require their own approved-target acceptance evidence.
