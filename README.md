# Cortex

A self-hosted homelab control plane with a question-driven installer for a fresh Ubuntu server.

Cortex combines a web dashboard, service management, local or remote inference, optional memory and speech services, isolated agent accounts, and development environments. Choose what to install. Supply your own identities, storage locations and provider credentials. No personal profiles, conversations, credentials or server data ship with the project.

## Start with your choices

Requirements: a dedicated fresh Ubuntu 26.04 LTS server, an existing human Linux login, root access, and enough storage and memory for selected services. No OS image, disk formatting or migration of an existing server is performed.

Clone the reviewed repository to a source directory outside the intended installation root. From that checkout:

```sh
sudo python3 bin/cortex interview --manifest /etc/cortex/install.json
sudo python3 bin/cortex plan --manifest /etc/cortex/install.json
```

The interview asks one bounded question at a time. It records non-secret choices outside Git and does not install anything. Review the plan before applying its exact approval hash; see [installation](docs/INSTALL.md). To use OMP, Claude Code, Codex or another terminal coding agent, give it [the guided installation prompt](prompts/install.md). The same CLI and approval rules apply regardless of AI tool.

Never paste credentials into the AI conversation. Enter external tokens directly into protected files on the target. Locally generated secrets stay under `/etc/cortex/secrets`.

## What is included

- Dashboard for services, containers, systemd, Incus, agents, terminals, health, audit, approvals and optional mail processing.
- PostgreSQL-backed application state with a separate runtime database role and a selected-service catalog.
- Optional inference, speech, memory, media, home automation, observability, database administration and application integrations.
- Operator-named agent profiles and development environments, rather than preconfigured personal bots.
- Explicit backup and update choices; no automatic enrollment in external accounts.

The dashboard is a privileged administration surface. Default access is loopback through an SSH tunnel; optional private networking requires your own enrollment. Read [security and privacy](SECURITY.md) before installation.

## Documentation

- [Install and verify](docs/INSTALL.md)
- [Configuration contract](docs/CONFIGURATION.md)
- [Service selection and operations](docs/SERVICES.md)
- [Security and publication privacy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## Source and license

Cortex starts a new Git history. Reused CortexOS application source retains its MIT attribution; production state and repository history are excluded. Internal package names may retain the `@cortexos` namespace. See [LICENSE](LICENSE). Optional upstream applications and models retain their own licenses.
