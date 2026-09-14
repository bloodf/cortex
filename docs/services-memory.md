# Agent memory and Hindsight administration

Cortex gives each explicitly named agent an independent random bearer credential and the exact bank `agent-NAME`. Agent credentials never authorize a bank list, another bank, server configuration, webhooks, file uploads, MCP, or the native control plane. No personal bank or inherited profile is created.

## Runtime boundary

| Listener | Purpose | Access |
| --- | --- | --- |
| Host `127.0.0.1:8888` | Cortex memory broker | Per-agent bearer; anonymous sanitized `/health` only |
| Host `127.0.0.1:19888` | Native Hindsight API | Independent upstream bearer, withheld from agents |
| Host `127.0.0.1:9999` | Complete native Hindsight UI | HTTP Basic, username `admin`, independent random operator password |
| Container loopback `127.0.0.1:9999` | Native UI backend | Not bound to bridge interfaces |
| Container `:19999` | Nginx UI guard in Hindsight’s network namespace | Basic authentication on every route, including UI API and assets |

The full native UI remains available: bank configuration, graphs, entities, documents, retain/recall/reflect, and the other controls shipped by the pinned Hindsight release. Cortex does not replace it with a reduced console. Nginx strips operator Authorization before forwarding; native UI server-side calls authenticate to the native API using `HINDSIGHT_CP_DATAPLANE_API_KEY`. The shared namespace must not be granted to untrusted containers. Docker administration itself is root-equivalent and outside the agent credential boundary.

Docker’s internal network and loopback publication are not the authorization boundary for the API: host agents can reach bridge addresses. The native `ApiKeyTenantExtension` requires the independent upstream key. For the UI, binding the backend to container loopback and authenticating the only bridge-facing listener prevents bypass from host agents and ordinary untrusted containers.

## Credentials and preparation

Before applying Hindsight, supply the fresh installation’s extraction provider configuration in root-owned mode-0600 `/etc/cortex/secrets/hindsight.env`:

- `HINDSIGHT_API_LLM_API_KEY`
- `HINDSIGHT_API_LLM_MODEL`
- `HINDSIGHT_API_LLM_BASE_URL` reachable from the Hindsight container
- Provider settings required by the service catalog, normally `HINDSIGHT_API_LLM_PROVIDER=openai`

Do not copy another installation’s keys, banks, profiles, or data. Do not use an unselected personal model as a default. Provider routing and embedding model availability must be operational for the extraction verification to pass.

The service engine invokes these root-only commands with the actual installation manifest:

```sh
python3 ROOT/scripts/memory/memoryctl.py prepare --manifest MANIFEST
# Compose starts the native API and its authenticated native UI guard.
python3 ROOT/scripts/memory/memoryctl.py install --manifest MANIFEST
python3 ROOT/scripts/memory/memoryctl.py verify --manifest MANIFEST
```

`prepare` generates independent upstream/operator credentials and all manifest agent credentials. It preserves provider/channel fields in each `agent-NAME.env`, adds `HINDSIGHT_API_URL=http://127.0.0.1:8888`, `HINDSIGHT_BANK_ID=agent-NAME`, and `HINDSIGHT_API_KEY`, and removes authorization mappings for agents absent from the manifest. Agent management runs only after preparation. Incremental provisioning uses `provision --manifest MANIFEST --agent NAME`; the name must already be in the manifest. Re-running preparation retains existing credentials.

Private broker state is `/etc/cortex/secrets/memory-broker.json`, root-owned mode 0600. The independent operator password is `CORTEX_MEMORY_ADMIN_KEY` in the protected Hindsight environment file. The native API key is `HINDSIGHT_API_TENANT_API_KEY`; neither belongs in an agent environment. The guard’s salted random-password hash lives in `DATA_ROOT/hindsight-ui-auth/htpasswd`, mode 0600, readable only by the guard UID 101. Its parent is root-owned mode 0755, so the runtime cannot replace files. Secret ancestors are traversed with `O_NOFOLLOW`; ownership changes operate only on newly created pinned file descriptors, never a runtime symlink target. Secret values are not put in command arguments or emitted by these hooks.

`install` writes `cortex-memory-broker.service`, performs native authentication and UI reachability checks, and starts the broker. The broker repeats native denial/authenticated UI checks before binding its listener on every start. `start`, `stop`, and `restart` operate the companion unit; the service engine stops the broker before stopping Compose and starts it after starting Compose. Updates repeat prepare, Compose recreation, and install.

## Agent API contract

The broker accepts exactly these data operations for the authenticated identity’s bank:

- `POST /v1/default/banks/agent-NAME/memories`: text items, synchronous or asynchronous retain. Client-supplied async operation UUIDs are deterministically namespaced by bank before reaching the shared upstream operation namespace.
- `POST /v1/default/banks/agent-NAME/memories/recall`.
- `POST /v1/default/banks/agent-NAME/reflect`.
- Authenticated `GET /version`, for pinned client capability discovery.
- `GET /health`, which queries native health and returns only a sanitized availability status.

Unknown paths, percent-encoded alternate paths, query-string bank overrides, bank listing/configuration, and cross-bank requests are rejected before upstream access. Only supported JSON fields are forwarded. Multipart/remote attachment ingestion and arbitrary transport headers are not supported. Native API error bodies are not disclosed; success responses stream incrementally with upstream framing, cookies, redirects, and authentication headers stripped. Request bodies and simultaneous connections are bounded.

Hermes uses the external Hindsight provider with synchronous retain. The pinned OpenClaw integration requires authenticated health/version capability discovery and asynchronous retain; the broker supports those exact calls, including append update mode and recall score options. Do not configure client-side bank missions/defaults that need forbidden bank control-plane APIs.

## Operator access

Use an SSH tunnel rather than exposing Basic authentication over an unencrypted network:

```sh
ssh -N -L 9999:127.0.0.1:9999 ROOT_OPERATOR@CORTEX_HOST
```

Open `http://127.0.0.1:9999` on the operator workstation. Sign in as `admin` using the separately generated `CORTEX_MEMORY_ADMIN_KEY`, retrieved through the installation’s protected local secret workflow. Never paste it into command arguments, chat, screenshots, browser URLs, or a shared environment. Close the browser authentication session after administration. Agent keys do not open this UI. No public reverse-proxy route is installed by the memory recipe.

Back up the protected secret directory, `DATA_ROOT/hindsight`, `DATA_ROOT/hindsight-ui-auth`, and `cortex-memory-broker.service` together. Restoring a database without its identity map is not an authorization-preserving restore.

## Required guest proof

`verify` is a real acceptance hook, not a mock or static assertion. It first proves authenticated native UI API success, then requires every inspected bridge IPv4/IPv6 guard address to accept TCP on 19999 before accepting only `ECONNREFUSED` on backend port 9999. Timeouts, unreachable networks, and missing addresses fail rather than count as isolation proof. It also checks direct bridge API anonymous denial and anonymous native UI read/mutation denial.

Two temporary broker identities then exercise anonymous denial, peer-bank denial, forbidden control-plane routes, direct-upstream rejection of agent credentials, synchronous and asynchronous real extraction, recall of an extracted unique fact, and own-bank reflection. The operator credential must open the native UI API; an agent credential must not. Temporary identities are revoked before their banks are deleted, including on a failed check. Verification is serialized against preparation. Retain/recall/reflect invoke the configured real extraction models and may incur provider charges.

No runtime validation, builds, formatters, or host changes were executed while this implementation was being assembled. The parent’s isolated guest gate must run the hooks, inspect the real UI, and exercise both pinned agent plugins before deployment is accepted.

## First-party source grounding

The pinned Hindsight image’s OCI revision is `5d46f9c8c8eb4fb96f549aa63abe1191b82a7840` (version 0.10.0), as inspected by the application recipe owner. Source references:

- [Native API-key tenant authentication](https://github.com/vectorize-io/hindsight/blob/5d46f9c8c8eb4fb96f549aa63abe1191b82a7840/hindsight-api-slim/hindsight_api/extensions/builtin/tenant.py)
- [Native API retain, recall, reflect and bearer parsing](https://github.com/vectorize-io/hindsight/blob/5d46f9c8c8eb4fb96f549aa63abe1191b82a7840/hindsight-api-slim/hindsight_api/api/http.py)
- [Standalone CP loopback hostname and port switches](https://github.com/vectorize-io/hindsight/blob/5d46f9c8c8eb4fb96f549aa63abe1191b82a7840/docker/standalone/start-all.sh)
- [Native CP server-side API URL/key configuration](https://github.com/vectorize-io/hindsight/blob/5d46f9c8c8eb4fb96f549aa63abe1191b82a7840/hindsight-control-plane/src/lib/hindsight-client.ts)
- [Pinned OpenClaw retain and capability calls](https://github.com/vectorize-io/hindsight/blob/5ae43bf82e4bc414adb3a4510175676d2a0a4623/hindsight-integrations/openclaw/src/index.ts)
