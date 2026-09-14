# Application services

Select application IDs in the private install manifest. This family contains the 11 IDs named in the assignment: `ollama`, `whisper`, `hindsight`, `durindoor`, `jellyfin`, `home-assistant`, `mail-guardian`, `firecrawl`, `postiz`, `dockhand`, and `langfuse`. The assignment's count of 12 did not name an additional application.

## Installation contract

Recipes live in `stacks/apps/*.json`; Docker Compose accepts JSON. Use the Cortex installer rather than running these templates directly: the engine renders `@ROOT@`, `@DATA_ROOT@`, and `@SECRETS_DIR@`, supplies the service's secret file for Compose interpolation, and selects project `cortex-ID`. Primary apps join external network `cortex-private`, except Dockhand: it shares its authenticated proxy's network namespace and binds only that namespace's loopback address. Dedicated databases and queue services use project-local backend networks without host ports. Firecrawl's browser network permits outbound web access. Loopback publishing prevents direct remote host access; it does not isolate services from trusted containers on shared networks.

Put operator configuration in `/etc/cortex/secrets/ID.env`, owned by root with mode 0600. Keep credentials out of the manifest, repository, terminal transcripts and chat. The catalog lists required keys and locally generated secrets. Cortex supplies all 27 application and support-image defaults as immutable registry digests in `secret_defaults`; you do not need to research or supply image references to install. `stacks/apps/image-sources.json` records registry manifest URLs, source tags and digests retrieved on 2026-09-14, including shared proxy-image provenance. Runtime pulls use recorded digests. Registry metadata establishes artifact identity, not successful installation.

The per-service image instructions below describe optional overrides and their compatibility constraints. To override a default, set its `*_IMAGE` key to `registry/repository@sha256:<64 lowercase hexadecimal characters>` in the protected service env file. Tags, including version tags, are not immutable references. For multi-container applications, choose mutually compatible release images; do not independently select the newest image for each component.

Generated values remain stable across apply/update. Do not regenerate encryption keys or database passwords on an existing installation. Rotating those values needs the application's credential migration procedure, not just an env-file edit. Preserve `ENCRYPTION_KEY` as exactly 32 bytes encoded in 64 hexadecimal characters for Langfuse.

All persistent state uses bind mounts below the selected `data_root`. `prepare-storage.py` uses the engine's expanded service selection to initialize non-root Hindsight, Elasticsearch, ClickHouse and MinIO directories. For Hindsight, Elasticsearch and ClickHouse, it reads user IDs using read-only containers with no network, mounts, capabilities or secret environment. It changes ownership only on empty directories and refuses a populated directory with a different owner. Those images must contain users `hindsight`, `elasticsearch` and `clickhouse`, respectively. MinIO runs explicitly as 65532:65532, matching the pinned image's OCI user metadata; preparation creates its bucket on the host without executing helper tools inside that image. Review ownership before a release that changes these users. The database mount paths require the indicated PostgreSQL major versions; PostgreSQL 18's changed data layout is not interchangeable with these recipes.

The engine supplies apply, verify, start, stop, restart and update. Apply/update pull the selected immutable references and run Compose with health waiting. Verification checks container state plus the catalog HTTP or command check. First-time model downloads and database initialization can exceed the default wait window; keep persistent data and retry apply after resolving startup errors. Do not bypass a failed verification.

## Endpoints and capacity

These figures are planning guidance, not measured usage. Leave additional RAM and disk for Docker, the dashboard, downloaded models, media and application workload.

| ID | Loopback ports | Verification | Suggested RAM / initial disk |
| --- | --- | --- | --- |
| ollama | 11434 | `GET /api/tags` | 8 GiB / 30 GiB plus models |
| whisper | 9000 | `GET /openapi.json` | 4 GiB / 10 GiB |
| hindsight | 8888 authenticated broker, 19888 protected API, 9999 authenticated native UI | Native authentication, UI/direct-IP denials, scoped retain/recall | 8 GiB / 30 GiB |
| durindoor | 20128 | HTTP dashboard entry point | 2 GiB / 10 GiB |
| jellyfin | 8096 | `GET /health` | 2 GiB / 20 GiB plus media |
| home-assistant | 8123 | HTTP frontend | 2 GiB / 10 GiB |
| mail-guardian | none | Read-only DB, model and IMAP command | 512 MiB / 2 GiB plus dashboard DB |
| firecrawl | 3002 | HTTP API entry point, healthy queue dependencies | 14 GiB / 30 GiB; 6 CPU cores recommended |
| postiz | 4007 | HTTP frontend, healthy Temporal/DB/Redis | 6 GiB / 30 GiB |
| dockhand | 3420 authenticated proxy | Unauthenticated GET/POST denied; authenticated frontend succeeds | 512 MiB / 5 GiB |
| langfuse | 3035 web, 9095 object API | `GET :3035/api/public/health` and dependency health | 8 GiB / 50 GiB |

Health checks do not establish successful inference, transcription, publishing, automation, media playback or trace ingestion. Complete the service-specific operator checks below with synthetic data after installation. No validation, builds, formatters, tests, Docker pulls or runtime smoke checks were run while authoring these recipes, as requested. Source evidence includes registry metadata and one 7,813-byte immutable Dockhand source layer read in memory, without extraction to disk or execution.

## Ollama and Whisper

First-party setup: [Ollama Docker](https://docs.ollama.com/docker), [Whisper ASR webservice](https://github.com/ahmetoner/whisper-asr-webservice).

- Set `OLLAMA_IMAGE` to a digest from `ollama/ollama`. State and downloaded models live in `data_root/ollama`. No model downloads or GPU assignment happen during install. Select a model under its license, pull it through Ollama, then send a synthetic generation request. An empty `/api/tags` response is a working unconfigured server, not an inference proof.
- Set `WHISPER_IMAGE` to the CPU image from `onerahmet/openai-whisper-asr-webservice`. Upstream README describes release 1.10.0 and its engine versions. Defaults are `ASR_ENGINE=openai_whisper`, `ASR_MODEL=base`, `ASR_DEVICE=cpu`. Cache persists at `data_root/whisper`. The server downloads the selected model on first use/start. Use the Swagger interface to transcribe a synthetic audio file through `/asr`. The OpenAPI health check establishes only that the API is serving.
- GPU use requires a separately reviewed device/runtime configuration appropriate to the fresh host. These recipes make no GPU acceleration claim and do not expose host devices.

## Hindsight

First-party setup: [Hindsight quick start](https://github.com/vectorize-io/hindsight), [installation](https://hindsight.vectorize.io/developer/installation).

`HINDSIGHT_IMAGE` defaults to the standard all-in-one image, version 0.10.0, with OCI source revision `5d46f9c8c8eb4fb96f549aa63abe1191b82a7840` recorded in `image-sources.json`. Required `HINDSIGHT_API_LLM_API_KEY`, `HINDSIGHT_API_LLM_MODEL`, and `HINDSIGHT_API_LLM_BASE_URL` select an OpenAI-compatible inference endpoint. The provider defaults to `openai`. A selected local DurinDoor endpoint can use `http://cortex-durindoor:20128/v1`, with an actual gateway key and routable model; Hindsight does not silently install that gateway.

The database persists at `data_root/hindsight`, mounted to `/home/hindsight/.pg0`. The native API publishes host loopback 19888 and uses `ApiKeyTenantExtension`, including MCP authentication. Memory preparation generates independent native and operator administration secrets in root-only local state. The identity-scoped broker listens on 8888; agents receive scoped credentials rather than the native backend key. The complete native control plane remains available through an authenticated nginx guard at loopback 9999, rather than replacing its features with the broker's administration page.

The native control plane binds `127.0.0.1:9999` inside Hindsight's network namespace using the pinned runtime's `HINDSIGHT_CP_HOSTNAME` and `HINDSIGHT_CP_PORT` settings. The UI guard shares that namespace and listens on 19999; the host maps 9999 to the guard, not to the native control plane. Its rootless read-only nginx container mounts `templates/memory/ui-nginx.conf` and the mode-0600 hash in `data_root/hindsight-ui-auth`. Server-side control-plane API calls use the independent native API key; browsers and agents do not receive that key. The memory preparer supplies `HINDSIGHT_CP_DATAPLANE_API_KEY` and the loopback API URL. Review memory broker documentation for UI authentication and allowed origins.

Preparation runs `scripts/memory/memoryctl.py prepare` before Compose startup. The post-apply hook runs `memoryctl.py install` after the backend and UI guard start; the engine manages broker start/stop/restart alongside Compose. Verification delegates to the memory controller's native/UI authentication denial probes, direct-container-address bypass checks, agent identity separation and actual retain/recall extraction. These operations require the configured inference endpoint and may incur inference charges. Do not treat API liveness as evidence of extraction or isolation. No runtime verification was executed during implementation.

## DurinDoor

First-party setup: [upstream Compose](https://github.com/bloodf/durindoor/blob/main/docker-compose.yml), [environment contract](https://github.com/bloodf/durindoor/blob/main/.env.example).

Set `DURINDOOR_IMAGE` to a `ghcr.io/bloodf/durindoor` digest. The runtime follows the upstream container entry point, listens internally on 20128 and stores SQLite plus provider configuration in `data_root/durindoor`. Cortex generates `JWT_SECRET`, `INITIAL_PASSWORD`, `API_KEY_SECRET`, and `MACHINE_ID_SALT`. Read the initial password locally from the protected file; never paste it in chat. Finish provider onboarding in the dashboard and perform an actual synthetic completion against a provider you chose. The gateway can serve its dashboard before any model is configured.

Loopback defaults use `BASE_URL` and `NEXT_PUBLIC_BASE_URL` set to `http://localhost:20128`, with `AUTH_COOKIE_SECURE=false`. For authenticated TLS ingress, set both URLs to the browser-visible origin and enable secure cookies. Provider OAuth callbacks must use that origin. The recipe does not opt into DurinDoor's PostgreSQL migration or copy provider sessions from another installation.

## Jellyfin and Home Assistant

First-party setup: [Jellyfin containers](https://jellyfin.org/docs/general/installation/container/), [Home Assistant Container](https://www.home-assistant.io/installation/linux#install-home-assistant-container).

Jellyfin requires `JELLYFIN_IMAGE` from `jellyfin/jellyfin` or `ghcr.io/jellyfin/jellyfin`. Config, cache and media directories live under `data_root/jellyfin`; the container sees media read-only at `/media`. Complete the first-run administrator wizard and add a library using your own media. Verify playback with a permitted sample. No NAS mounts, IPTV credentials or libraries carry over. CPU transcoding is the default; no device or discovery UDP ports are published.

Home Assistant requires `HOME_ASSISTANT_IMAGE` from `ghcr.io/home-assistant/home-assistant`. Its config and SQLite state persist at `data_root/home-assistant`. The recipe gives shutdown 60 seconds. Unlike upstream's host-network/privileged example, this recipe keeps a bridge network, one loopback TCP port and no privileged devices. Manually configure reachable network integrations. Broadcast discovery, Bluetooth, USB radios and host-network-only integrations require a separately reviewed configuration; they are not promised by this recipe. Complete onboarding, add a synthetic helper and verify a manual state change. Home Assistant Container does not include the Supervisor or its managed apps.

## Mail Guardian

Source: the included `packages/cortex-mail-guardian` package, particularly `package.json`, `src/index.ts`, `src/config.ts`, and `src/imap.ts`. The dashboard build owner supplies this package and shared database migrations.

This is a Node worker, not an HTTP app. Install/build the workspace with its lockfile, including `pnpm --filter @cortexos/mail-guardian build`, before applying the service. Set `MAIL_GUARDIAN_NODE_IMAGE` to an official Debian-based `node` image digest matching the installer's Node major (at least 22). The container mounts the installed workspace read-only at the same absolute root so pnpm dependency symlinks resolve, then runs `node dist/index.js listen`. Do not use an Alpine/musl runtime against glibc-built native dependencies.

Required external keys are `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `MAIL_GUARDIAN_MODEL`, and `MAIL_GUARDIAN_FALLBACK_MODEL`. `OPENAI_BASE_URL` must include the provider's API prefix, usually `/v1`. Configure available primary and fallback models. The installer generates `MAIL_GUARDIAN_DB_PASSWORD`; `prepare-mail-guardian.py` reads the installed core database name from protected `postgresql.env`, provisions a separate `mail_guardian` login, and atomically writes its derived `DATABASE_URL` into protected `mail-guardian.env`. The role receives access only to mail tables/sequences and INSERT access to dashboard alerts. It does not use the dashboard runtime password or hold schema-owner privileges. SQL and passwords travel over psql stdin, not command arguments. Dashboard migrations own the schema; the worker runs with `MAIL_GUARDIAN_SCHEMA_MANAGED=true`, which checks the installed schema instead of issuing DDL.

Before applying the worker, add at least one enabled account through dashboard Mail settings, or set `MAIL_GUARDIAN_ACCOUNT_COUNT` and complete indexed account fields in the protected env file. Preparation refuses to start an unconfigured worker. For UI onboarding, install/start the dashboard first, add the account locally, then apply Mail Guardian. Environment accounts use indices 1 through 100: `MAIL_GUARDIAN_ACCOUNT_N_SLUG`, `_ADDRESS`, `_HOST`, `_USERNAME`, `_PASSWORD_B64`; optional suffixes are `_PORT` (993), `_SECURE` (true), `_INBOX`, `_REVIEW_MAILBOX` and `_TRASH_MAILBOX`. The catalog's anchored `secret_key_patterns` admits these indexed keys. Base64 encodes a password; it does not encrypt it. Use TLS with certificate verification. Optional `TELEGRAM_BOT_TOKEN` and `MAIL_GUARDIAN_TELEGRAM_OWNER_CHAT_ID` enable review messaging after explicit account-owner approval. No account or recipient ships by default.

`MAIL_GUARDIAN_DRY_RUN=true` is the initial safety setting. Review the installed package's dry-run behavior and classification results before permitting mailbox actions. Set it to false only after the mailbox owner authorizes those actions. The custom verification command reads the migrated DB/account configuration, checks both model IDs at `/models`, and performs IMAP authentication without selecting, fetching, moving or deleting mail. It does not send Telegram messages or run a classification sweep. It emits no account identities or remote error bodies. Persistent records live in the dashboard DB; `data_root/mail-guardian` provides a worker state location without copying host data.

## Firecrawl

First-party setup: [upstream Compose](https://github.com/firecrawl/firecrawl/blob/main/docker-compose.yaml). The existing source recipe also uses the bundled harness and NUQ PostgreSQL extension image.

Image keys with bundled immutable defaults (operator overrides are optional):

| Key | Upstream repository / compatibility |
| --- | --- |
| `FIRECRAWL_IMAGE` | `ghcr.io/firecrawl/firecrawl`, with `dist/src/harness.js --start-docker` |
| `FIRECRAWL_PLAYWRIGHT_IMAGE` | `ghcr.io/firecrawl/playwright-service`, matching the API release |
| `FIRECRAWL_POSTGRES_IMAGE` | `ghcr.io/firecrawl/nuq-postgres`, matching the API release and pg_cron database setting |
| `FIRECRAWL_REDIS_IMAGE` | `redis`, compatible with upstream's Redis recipe |
| `FIRECRAWL_RABBITMQ_IMAGE` | `rabbitmq`, upstream 3-management release family |

Cortex generates PostgreSQL and RabbitMQ credentials plus the Bull queue administration key. All workers start through the upstream harness. Redis, PostgreSQL and RabbitMQ data persist below `data_root/firecrawl`; browser temporary state is disposable. This deployment uses the NUQ PostgreSQL queue, not the experimental FoundationDB backend. The scraper requires Internet egress. Shared `cortex-redis` is intentionally not used: a project-local hostname prevents DNS ambiguity and separates queue state and authentication.

`USE_DB_AUTHENTICATION=false` matches self-hosted upstream setup. Treat the API as private and trusted; do not expose it publicly without an authenticated ingress boundary. Optional extraction/model/search/proxy settings can go in its protected env file according to the selected release. Scrape `https://example.com` through the documented API to prove browser and queue execution; the landing endpoint alone is not that proof. The API has an 8 GiB memory limit and browser 4 GiB, so choose adequate host capacity.

## Postiz

First-party setup: [installation](https://docs.postiz.com/self-host/installation/docker-compose), [canonical Compose](https://github.com/gitroomhq/postiz-docker-compose/blob/main/docker-compose.yaml).

Set `POSTIZ_IMAGE` from `ghcr.io/gitroomhq/postiz-app`, `POSTIZ_POSTGRES_IMAGE` from PostgreSQL 17, `POSTIZ_REDIS_IMAGE` from Redis 7.2, `POSTIZ_TEMPORAL_IMAGE` from `temporalio/auto-setup` compatible with upstream 1.28.1, `POSTIZ_TEMPORAL_POSTGRES_IMAGE` from PostgreSQL 16, and `POSTIZ_ELASTICSEARCH_IMAGE` from Elasticsearch 7.17.27. Supply digests, not these mutable tags. Read the Postiz migration guide before upgrading across 2.11.2 to 2.12.0 or later: the current application requires Temporal.

The recipe includes dedicated Postiz PostgreSQL/Redis and Temporal PostgreSQL/Elasticsearch. Temporal auto-setup initializes its own durable databases and default namespace. It uses the image's bundled dynamic configuration; no host development config or debug/admin UI is required. State lives below `data_root/postiz`, including uploads and config. This deployment omits optional Spotlight and Temporal administration UIs, not the workflow server.

Set `MAIN_URL`, `FRONTEND_URL` and `NEXT_PUBLIC_BACKEND_URL` consistently for the origin you use. Local defaults are `http://localhost:4007` and `/api`. Complete initial registration through a trusted local session, then set `DISABLE_REGISTRATION=true` and update the service. Social networks require your own OAuth applications and callback URLs; write those provider keys locally using the upstream configuration reference. Verify a draft with synthetic content before authorizing any real publishing. Do not treat the frontend health check as proof that provider credentials or scheduled publishing work.

## Dockhand

First-party setup: [Dockhand manual](https://dockhand.pro/manual/), [upstream project and license](https://github.com/Finsys/dockhand).

The previous host recipe named Dockge as `dockhand`. This recipe installs the actual Dockhand application from `fnsys/dockhand`; `DOCKHAND_IMAGE` has a bundled immutable default. It persists `DATA_DIR` at the same `data_root/dockhand` path inside and outside the container so relative stack mounts resolve correctly. The installer discovers `DOCKER_GID` from the target host's Docker socket group; an explicit local override remains optional. No group identity comes from the source host.

**Selecting Dockhand authorizes host-root-equivalent Docker administration for authenticated administrators.** Before starting any published listener, preparation creates a mode-0600 nginx password hash from the generated 256-bit `DOCKHAND_PROXY_PASSWORD`. The proxy runs as UID 101 with no capabilities, a read-only root filesystem and writable temporary filesystem. It protects every path, including websocket upgrades, and forwards no proxy Authorization header to Dockhand. Only that proxy publishes loopback 3420. Dockhand uses `network_mode: service:proxy` with forced `HOST=127.0.0.1` and `PORT=3000`; nginx forwards to that private namespace loopback. The source [server wrapper](https://github.com/Finsys/dockhand/blob/main/server.js) reads `HOST` and calls `server.listen(PORT, HOST)`. This design avoids relying on an unpublished bridge port, which host processes could still reach directly.

For the exact pinned Dockhand image, `image-sources.json` records the immutable layer containing `app/server.js`: line 35 reads `process.env.HOST`, and line 785 passes `HOST` to `server.listen`. This establishes the bind setting in the selected artifact, beyond inspecting the moving upstream branch. The shipped runtime denial checks are still necessary before claiming actual host isolation.

Use username `admin` and the generated password from the protected file, read locally without copying it into chat. First-run native Dockhand authentication stays behind this boundary; you may enable it as an additional layer. The proxy denies cross-origin and browser cross-site requests. Keep access local or use an SSH tunnel. Remote TLS ingress requires a reviewed origin/proxy configuration; do not bypass authentication to make an origin mismatch disappear. Dockhand retains network egress through the shared namespace; only its frontend listener is loopback-bound. Docker image operations through its host socket remain privileged.

`dockhand-auth.py verify` first requires authenticated frontend HTTP 200, so a stopped backend cannot count as isolated. It checks shared namespace identity, establishes TCP reachability to proxy port 8080 on every available IPv4/IPv6 address, then requires backend port 3000 on the same address to fail specifically with connection refused. Timeouts and unreachable addresses fail as inconclusive. It also requires HTTP 401 for unauthenticated reads and a POST to a non-existent container restart path. The non-existent identifier prevents a real mutation if an operator misroutes the request. These checks ship with the recipe but were not executed under the no-validation instruction. The password uses nginx's documented salted RFC2307 SSHA encoding with a random 256-bit input. See the [nginx auth module](https://nginx.org/en/docs/http/ngx_http_auth_basic_module.html) and [official image user definitions](https://github.com/nginx/docker-nginx/blob/master/stable/alpine-slim/Dockerfile). Review Dockhand's Business Source License before offering any hosted service.

## Langfuse

First-party setup: [canonical Langfuse Compose](https://github.com/langfuse/langfuse/blob/main/docker-compose.yml).

Bundled immutable defaults cover matched Langfuse web and worker family 4, PostgreSQL 17, ClickHouse 25.12, Redis 7 and Chainguard MinIO. For overrides, retain that release compatibility. The pinned MinIO OCI config names `/usr/bin/minio` as entry point and user 65532; `image-sources.json` records the exact config and platform-manifest digests. Its recipe runs the native server directly and assumes no shell, `id`, `mkdir` or `mc` in the image. Host-side Python prepares storage and checks `/minio/health/ready` on loopback 9095 together with Langfuse's web health endpoint. Other storage image probes still require the documented `id` utility and named users.

Cortex includes web and background worker, dedicated PostgreSQL, ClickHouse, authenticated Redis and MinIO. Host-side storage preparation creates the `langfuse` bucket directory before the native MinIO server starts. PostgreSQL, queues, ClickHouse data/logs and object data persist under `data_root/langfuse`. Database migrations run through upstream application startup. Generated secrets cover DB/Redis/object authentication, session signing, SALT and the encryption key. Back up those keys with the databases; losing them can make stored credentials unreadable.

`NEXTAUTH_URL` defaults to `http://localhost:3035`. `LANGFUSE_MEDIA_URL` defaults to `http://localhost:9095` for browser-visible presigned media requests. Remote ingress needs both a reachable web origin and an object-storage origin; set both values deliberately and keep internal object traffic on `cortex-langfuse-minio:9000`. The recipe does not publish MinIO's management console or the worker port. Complete first-user onboarding, create a project/API key, and ingest a synthetic trace. Confirm it reaches the UI after the worker processes it. A healthy web process alone is not a trace-ingestion proof.

## Backups, upgrades and removal

Use the Cortex quiesced backup workflow for the selected services. Preserve the entire selected `data_root` tree and `/etc/cortex`, including secret files, together. Mail Guardian also requires the dashboard database. For app-specific hot backups, follow the database/vendor procedure instead of copying live SQLite/WAL or PostgreSQL data files. Restore into an isolated fresh environment with the same image digests before testing an upgrade.

Updates are explicit image digest changes followed by Cortex update. Review each application's schema migration and downgrade policy first. A previous image alone cannot undo a database migration. Keep the previous protected configuration and consistent backup until you have completed the service-specific functional checks. Stopping a service retains its data. No recipe prunes volumes, deletes accounts, wipes databases or copies state from the source host.
