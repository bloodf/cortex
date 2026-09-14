# Observability and database administration

These fourteen services are independently selectable in the install manifest. The service engine expands only declared dependencies, prepares protected environment files, runs `stacks/observability/prepare.py apply --manifest PATH`, and starts one Compose project `cortex-ID` per selected service. Services use `cortex-private`; Redis Insight shares its gateway's network namespace but binds its backend only to that namespace's loopback address. Every published port binds **127.0.0.1 only**. Selecting Grafana does not implicitly install Prometheus or Loki. Selecting an exporter does not implicitly install Prometheus.

## Immutable runtime selection

Every service has a concrete immutable image default in the catalog's `secret_defaults`. The engine writes these defaults into `/etc/cortex/secrets/ID.env` (or the configured secrets directory); no image choice is required to install. All fourteen defaults were resolved from official Docker Hub or GHCR release metadata on 2026-09-14. `stacks/observability/runtime-sources.json` records release tags, exact digests, registry URLs, and architecture metadata. Operators may override the uppercase service-ID `_IMAGE` variable with another reviewed `repository@sha256:` reference; preparation rejects mutable tags. Changing an image remains an explicit supply-chain decision.

Configurations target Prometheus 3, Grafana with datasource pruning support, Loki 3 with TSDB v13, Fluent Bit with the built-in Loki output, current cAdvisor and Node Exporter, PostgreSQL Exporter with `DATA_SOURCE_URI`, MySQL Exporter with `MYSQLD_EXPORTER_PASSWORD`, Percona MongoDB Exporter, pgAdmin 9, Redis Insight 3, phpMyAdmin 5 Apache, and Mongo Express 1.0.2. Image overrides must preserve these interfaces and official data-directory UIDs. Mongo Express's pinned release does not support a connection-URL file natively: its Node entrypoint reads the protected file, sets `ME_CONFIG_MONGODB_URL` in process memory, and imports the upstream application without shell interpolation. Registry metadata resolution is not runtime compatibility validation.

The upstream documents below informed recipe construction. Registry metadata and successful Compose rendering do not establish application readiness; verify the selected services against their actual running endpoints and native workflows.

## Services, endpoints, and sizing

Memory and storage are initial planning guidance, not enforced quotas. Exporter storage estimates include image space, not persistent databases. CPU guidance is one core per service; actual consumption depends on ingestion and database size.

| ID | Loopback port | Dependencies | RAM MiB / disk GiB | Image override variable | Official repository | Installation HTTP check |
| --- | ---: | --- | ---: | --- | --- | --- |
| prometheus | 9090 | none | 2048 / 20 | PROMETHEUS_IMAGE | prom/prometheus | /-/ready |
| grafana | 3000 | none | 512 / 2 | GRAFANA_IMAGE | grafana/grafana | /api/health |
| loki | 3100 | none | 1024 / 20 | LOKI_IMAGE | grafana/loki | /ready |
| fluent-bit | 2020 | loki | 256 / 2 | FLUENT_BIT_IMAGE | fluent/fluent-bit | /api/v1/health |
| cadvisor | 8085 | none | 512 / 1 | CADVISOR_IMAGE | ghcr.io/google/cadvisor | /healthz |
| node-exporter | 9100 | none | 128 / 1 | NODE_EXPORTER_IMAGE | prom/node-exporter | /metrics |
| pg-exporter | 9187 | postgresql | 128 / 1 | PG_EXPORTER_IMAGE | prometheuscommunity/postgres-exporter | /metrics |
| redis-exporter | 9121 | redis | 128 / 1 | REDIS_EXPORTER_IMAGE | oliver006/redis_exporter | /metrics |
| mongo-exporter | 9216 | mongodb | 256 / 1 | MONGO_EXPORTER_IMAGE | percona/mongodb_exporter | /metrics |
| mysql-exporter | 9104 | mysql | 128 / 1 | MYSQL_EXPORTER_IMAGE | prom/mysqld-exporter | /metrics |
| pgadmin | 5050 | postgresql | 512 / 2 | PGADMIN_IMAGE | dpage/pgadmin4 | /misc/ping |
| redisinsight | 5540 | redis | 576 / 2 | REDISINSIGHT_IMAGE, REDISINSIGHT_PROXY_IMAGE | redis/redisinsight, haproxy | anonymous 401 + authenticated /api/health/ 200 |
| phpmyadmin | 8086 | mysql | 512 / 1 | PHPMYADMIN_IMAGE | phpmyadmin (Apache variant) | / |
| mongo-express | 8087 | mongodb | 256 / 1 | MONGO_EXPRESS_IMAGE | mongo-express | /status |

A successful exporter HTTP response alone does not establish working database access. The four database exporter catalog checks additionally require `pg_up`, `redis_up`, `mongodb_up`, or `mysql_up` to have value 1 using the engine's multiline `body_pattern` match; labels are permitted without accepting zero-valued health metrics. Also check Prometheus targets for scrape errors after installation. UI health checks do not assert that an interactive database query succeeded. Confirm a login and read-only query through each chosen administration UI before considering database administration ready.

Startup readiness checks normally have a 120-second window. A recipe may declare `startup_timeout_seconds` as an integer from 1 through 600; invalid values are rejected before lifecycle mutation. Grafana and pgAdmin use 600 seconds because their initial database migrations can be slow on HDD-backed storage. Independent empty-data-directory replays in an isolated Ubuntu 26.04 VM completed real apply/readiness checks in 492.238 seconds for Grafana and 295.49 seconds for pgAdmin on 2026-09-14. The original failed-start directories were preserved separately, not reused for those measurements. Connection resets during startup remain transient only within this bounded window; explicit `verify` does not retry or weaken its checks.

## Secrets and shared database contract

Environment files are root-owned mode 0600; never paste values into a manifest, command line, chat, or source file. Use the installer's protected-file workflow. Image references are prefilled from pinned catalog defaults and are not confidential. Generated passwords are random hex and remain stable across reapply; do not regenerate existing credentials when upgrading.

| Consumer | Source protected file | Exact keys / behavior |
| --- | --- | --- |
| pg-exporter, pgadmin | postgresql.env | POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB; network host cortex-postgresql:5432 |
| redis-exporter, redisinsight | redis.env | REDIS_PASSWORD; host cortex-redis:6379 |
| mongo-exporter, mongo-express | mongodb.env | MONGO_INITDB_ROOT_USERNAME, MONGO_INITDB_ROOT_PASSWORD; host cortex-mongodb:27017, authentication database admin |
| mysql-exporter, phpmyadmin | mysql.env | MYSQL_ROOT_PASSWORD; host cortex-mysql:3306; database initializer must allow remote root access with MYSQL_ROOT_HOST=% |

Compose `env_file` supplies the referenced target file directly; the engine supplies only the current service and its declared dependency credentials to Compose interpolation and preparation, plus non-secret selected image references. `DATA_SOURCE_USER`/`DATA_SOURCE_PASS`, `MYSQLD_EXPORTER_PASSWORD`, `MONGODB_USER`/`MONGODB_PASSWORD`, and `RI_REDIS_PASSWORD` are mapped from those canonical values, not independently generated passwords. Shared superuser use is deliberate for a functioning fresh-host installation, **not least-privilege database isolation**. Limit access to `cortex-private` and trusted local operators. For hardened installations provision exporter-specific accounts with upstream-documented grants, then change both the target account and consumer configuration together.

Additional per-service keys:

- **Grafana:** generated `GF_SECURITY_ADMIN_PASSWORD` and `GF_SECURITY_SECRET_KEY`; initial login `admin`. Anonymous access and user self-registration are disabled. Once its database exists, rotate the admin password through Grafana, not by editing the bootstrap variable alone.
- **pgAdmin:** required operator `PGADMIN_DEFAULT_EMAIL`; generated `PGADMIN_DEFAULT_PASSWORD`. Log in with these application credentials. The PostgreSQL connection is pre-registered; supply the target database password from the protected PostgreSQL file in pgAdmin's connection prompt. No password is embedded in `servers.json`, and there is no anonymous database auto-login. The registration is imported on first initialization; existing user registrations are preserved.
- **Redis Insight:** generated `RI_ENCRYPTION_KEY` and `REDISINSIGHT_PROXY_PASSWORD`. The gateway login is `admin` with the generated 64-character hexadecimal password. Required `RI_ACCEPT_TERMS_AND_CONDITIONS=true` explicitly records operator licensing acceptance. The backend has no published port and uses `network_mode: service:redisinsight-gateway` with `RI_APP_HOST=127.0.0.1`. It listens only on namespace-loopback port 5540; HAProxy authenticates every HTTP path and method on port 5541, mapped to host-loopback 5540. This prevents direct host access via a Docker bridge IP, which an internal bridge alone would not prevent. Redis connects directly to `cortex-redis` from the shared namespace; no Redis relay exists. The backend receives its encryption key, licensing setting and database password, not gateway credentials. Root-only mode-0600 HAProxy configuration resides in a root-only directory mounted as a directory, so atomic replacements remain visible. The gateway uses a read-only filesystem, all capabilities dropped and no-new-privileges. It rejects cross-site browser fetches and Origins other than `http://localhost:5540` and `http://127.0.0.1:5540`; alternate origins require an explicit configuration change. Readiness checks namespace sharing, refusal of backend TCP connections on all gateway bridge IPv4/IPv6 addresses, anonymous GET/POST401, invalid-password401, authenticated health200, and authenticated cross-origin403.
  Isolation verification runs only after authenticated backend readiness succeeds. For every configured gateway bridge IPv4/IPv6 address, it first requires a successful TCP connection to authenticated proxy port 5541, then requires backend port 5540 to return **ECONNREFUSED** specifically. Timeouts, unreachable routes, and other socket errors fail with a sanitized reason; an unavailable network or not-yet-ready backend cannot count as proof of isolation.
- **phpMyAdmin:** no generated application password; normal cookie-auth login requires a MySQL account/password from the protected database configuration. `PMA_USER` and `PMA_PASSWORD` are deliberately not set because doing so would enable credential-based automatic login. Arbitrary database-server connections are disabled.
- **Mongo Express:** generated `ME_CONFIG_BASICAUTH_PASSWORD`, `ME_CONFIG_SITE_COOKIESECRET`, `ME_CONFIG_SITE_SESSIONSECRET`; default application username `admin` in `ME_CONFIG_BASICAUTH_USERNAME`. Basic authentication is explicitly enabled using the pinned release's `ME_CONFIG_BASICAUTH` interface. Preparation percent-encodes shared database credentials into a root-only mode-0600 connection file; the Node entrypoint reads it before loading the application. The container runs as root to read that protected file without making it world-readable. This gives database administrator access after web authentication; do not expose the service without TLS and an authenticated private ingress.

Do not use `docker compose config` or print container environments in shared logs: interpolation can disclose database credentials. Members of the Docker group already have root-equivalent access and can inspect container environment variables.

## Metrics and logs

`prepare.py` requires `CORTEX_SERVICE_ID` and prepares only that current service, using only its own and declared dependency credentials. It reads `CORTEX_SELECTED_SERVICES` from the engine (or the manifest service list when invoked directly) exclusively to constrain the current service's discovery and datasource configuration. It creates only the current service's data/configuration directories and checks only that service's immutable image reference and required settings. The engine must load the current service and dependency environment before preparation, and rerun preparation on application/update so revised selections replace discovery data.

Prometheus always scrapes itself. Its second job uses `file_sd_configs` pointing at `DATA_ROOT/prometheus-config/selected.json`. Preparation atomically generates targets only for the six selected exporters; no unselected hostname, exporter, or database is installed or scraped. The directory, rather than an individual file inode, is mounted so atomic updates remain visible to Prometheus's file watcher. Retention is bounded to 15 days and 15 GB. No remote-write destination or public API is enabled.

Grafana's provisioning directory is generated from the selection: Prometheus and Loki datasources are added only if those services are present. Deselected provisioned datasources are pruned on the next Grafana startup. Grafana can run alone for manually configured sources.

Loki uses single-node filesystem storage, TSDB v13, seven-day compactor retention, and disabled usage reporting. It is intentionally single-tenant (`auth_enabled: false`); Loki's tenant header is not authentication. **All trusted containers on cortex-private can read/write Loki and read monitoring endpoints.** This is not a multi-tenant security boundary. For untrusted workloads use separate networks and an authenticated ingestion/query gateway before granting access.

Fluent Bit tails `/var/lib/docker/containers/*/*-json.log`, persists tail offsets and filesystem buffers under `DATA_ROOT/fluent-bit`, and sends to Loki's built-in push endpoint. It starts at the end of existing logs to avoid importing unrelated historical data, follows rotation, skips oversized records, and bounds queued output to 1 GB. At the queue limit old chunks can be discarded; this is operational telemetry, not an audit-grade lossless archive. This recipe assumes Docker's standard data root and `json-file` logging; Docker `local`, journald, or a relocated Docker root require an explicit input/mount adjustment. Each family recipe selects rotating json-file logs. Container logs may contain application secrets or user content: review producers and apply retention/access controls; no global redaction guarantee is made.

cAdvisor follows upstream's privileged deployment, with read-only root, Docker state, sysfs and device mounts plus `/dev/kmsg`. A read-only Docker socket mount does **not** restrict API operations. Select cAdvisor only if granting it host-root-equivalent trust is acceptable. Node Exporter uses host PID and read-only host proc/sys/root mounts with an explicit collector allowlist. Network-namespace collectors are omitted rather than incorrectly reporting the container's network as host metrics. Neither service is a sandbox.

## Access, lifecycle, backups, and upgrades

Use an SSH local port forward to access these loopback endpoints remotely, or an independently configured authenticated private reverse proxy. Never widen Compose publications to `0.0.0.0`. Grafana/pgAdmin/Mongo Express have application login; Redis Insight has an always-on authenticated gateway. Metrics, Loki, and Fluent Bit health still rely on the trusted local/private network boundary. Native TLS is not configured between trusted containers; use SSH forwarding or TLS termination when transporting gateway Basic credentials remotely.

Use the service engine for apply, verify, stop, start, and update. Reapply reuses existing persistent data and credentials. Compose projects and container names are always `cortex-ID`; there are no cross-project Compose `depends_on` references. The engine orders catalog dependencies before starting consumers. Stopping an exporter does not stop its database. Removal or deselection does not authorize deleting persistent data.

Persistent bind directories: `DATA_ROOT/prometheus`, `grafana`, `loki`, `fluent-bit`, `pgadmin`, and `redisinsight`. Preparation creates their top-level ownership as 65534, 472, 10001, 0, 5050, and 1000 respectively; it never recursively changes existing data. Generated non-secret discovery/provisioning directories are readable by their containers. Mongo Express's generated connection directory remains root-only.

For a consistent backup, stop the relevant UI/collector before copying its SQLite database, tail state, or storage tree; back up Loki data including compactor state, and Prometheus data while stopped or with an operator-created supported snapshot. Include `/etc/cortex/secrets` in the encrypted backup, especially Grafana's secret key and Redis Insight's encryption key. Backups of administration tools can contain saved credentials and query history. Target database backups belong to their database service; an admin UI volume is not a database backup.

Updates require a new reviewed immutable image reference in the service's protected environment file, then the engine update/apply path and endpoint checks. Read upstream migration notes before changing major versions. Keep the previous image digest and a pre-upgrade consistent backup. Rolling back a digest alone cannot undo database or on-disk schema migrations; restore the matching backup when required. Never run Compose `down -v` as an update procedure.

Redis Insight declares `recreate_on_apply=true`: the engine must force recreation of both its gateway and backend after preparation, including ordinary apply, so a changed gateway password or generated configuration becomes active and the shared network namespace stays consistent. To rotate, update `REDISINSIGHT_PROXY_PASSWORD` to a newly generated 64-character lowercase hexadecimal value in its protected environment file, run the engine apply/update path, and require the compound verification to succeed with the new credential. Merely replacing the configuration file does not reload a running HAProxy process. Recreating both containers preserves the Redis Insight data bind.

## Upstream evidence

- [Prometheus image deployment](https://github.com/prometheus/prometheus/blob/main/README.md) and [file-based service discovery/configuration](https://prometheus.io/docs/prometheus/latest/configuration/configuration/).
- [Grafana official images, paths, and environment configuration](https://grafana.com/docs/grafana/latest/setup-grafana/configure-docker/).
- [Loki upstream local filesystem configuration](https://github.com/grafana/loki/blob/main/cmd/loki/loki-local-config.yaml).
- [Fluent Bit official container images](https://docs.fluentbit.io/manual/installation/downloads/docker) and [built-in Loki output](https://docs.fluentbit.io/manual/data-pipeline/outputs/loki).
- [cAdvisor official privileged Docker deployment](https://github.com/google/cadvisor/blob/master/README.md).
- [Node Exporter host mounts and collector options](https://github.com/prometheus/node_exporter/blob/master/README.md).
- [PostgreSQL Exporter Docker and credential interfaces](https://github.com/prometheus-community/postgres_exporter/blob/master/README.md).
- [Redis Exporter authentication and metrics](https://github.com/oliver006/redis_exporter/blob/master/README.md).
- [Percona MongoDB Exporter images and separate authentication variables](https://github.com/percona/mongodb_exporter/blob/main/README.md).
- [MySQL Exporter Docker, password environment, and grants](https://github.com/prometheus/mysqld_exporter/blob/main/README.md).
- [pgAdmin container images, login, UIDs, server definitions](https://www.pgadmin.org/docs/pgadmin4/latest/container_deployment.html).
- [Redis Insight official Docker deployment and health endpoint](https://redis.io/docs/latest/operate/redisinsight/install/install-on-docker/) and [connection/environment settings](https://redis.io/docs/latest/operate/redisinsight/configuration/).
- [HAProxy 3.2 authentication, HTTP request rules, DNS resolvers and TCP backends](https://docs.haproxy.org/3.2/configuration.html) and [official gateway image digest metadata](https://hub.docker.com/v2/repositories/library/haproxy/tags/3.2-alpine).
- [phpMyAdmin official Docker environment and cookie-auth behavior](https://github.com/phpmyadmin/docker/blob/master/README.md).
- [Mongo Express Docker, authentication, connection-file and health settings](https://github.com/mongo-express/mongo-express/blob/master/README.md).

## Default release pins

Official registry metadata was retrieved on 2026-09-14. Full sha256 digests, source URLs, and architecture metadata are recorded in `stacks/observability/runtime-sources.json` and each catalog entry.

| Service | Default release |
| --- | --- |
| prometheus | v3.13.3 |
| grafana | 13.0.8 |
| loki | 3.7.7 |
| fluent-bit | 5.1.2 |
| cadvisor | 0.55.1 |
| node-exporter | v1.12.1 |
| pg-exporter | v0.20.1 |
| redis-exporter | v1.91.1 |
| mongo-exporter | 0.53.0 |
| mysql-exporter | v0.20.0 |
| pgadmin | 9.17 |
| redisinsight | 3.8.0 |
| redisinsight-gateway | 3.2-alpine, pinned sha256 registry manifest |
| phpmyadmin | 5.2.3-apache |
| mongo-express | 1.0.2-20-alpine3.19 |

Mongo Express uses the official Docker library's published release, which packages an older Node/Alpine base than current upstream development. The digest is a reproducibility pin, not an assertion of vulnerability-free dependencies. Review upstream security advisories before exposure; this service remains authenticated and loopback-only. Its connection handling follows the [pinned configuration source](https://github.com/mongo-express/mongo-express/blob/v1.0.2/config.default.js) and [pinned entry module](https://github.com/mongo-express/mongo-express/blob/v1.0.2/app.js), rather than assuming the development branch's newer environment interfaces.

## Disposable native administration evidence

On 2026-09-14, the four administration services were exercised inside a disposable Ubuntu guest using the actual installed recipes, generated local credentials and synthetic databases. The following checks used native HTTP authentication and database-administration APIs, not mocked responses or health-only probes. They do not constitute visual/browser accessibility verification.

| Service | Refusal evidence | Authenticated database interaction |
| --- | --- | --- |
| Mongo Express | Anonymous and incorrect-password requests returned 401. | Native database list returned 200 and included `admin`; `/db/admin` returned 200 and listed the real `system.version` collection. |
| phpMyAdmin | Anonymous database access and incorrect-password submission retained the login form; upstream returns 200 for these refusals. | Native CSRF/cookie login succeeded; MySQL database structure returned 200 and listed `mysql.tables_priv`. |
| pgAdmin | Anonymous server API returned 401; incorrect-password submission retained the native login page. | Native `/authenticate/login` succeeded, the PostgreSQL server connection API returned success, and database enumeration contained a returned node whose `label` equalled `cortex`. This workflow was repeated successfully after the separately recorded empty-directory startup replay. |
| Redis Insight | Anonymous and incorrect gateway-password database-list requests returned 401. | The authenticated native API listed one configured database, created a CLI client, executed read-only `PING`, and returned status `success` with response exactly `PONG`; the temporary CLI client was deleted afterward. |

No target database content was modified by these workflows. Application login sessions and pgAdmin's connection state are ordinary native administration state. Credentials stayed in the guest's protected files and were not included in evidence output. Throwaway proof scripts and detailed run artifacts remain outside the publishable source tree.

The first real Mongo Express launch exposed a recipe defect: Node's `-e` mode omitted `process.argv[1]`, while the pinned upstream Commander parser required a script path. The launcher now sets `[process.execPath, process.cwd() + '/app.js']` before importing the upstream application. A subsequent actual engine apply and the authentication/database checks above passed. No warning suppression or upstream-source patch was used.

## Disposable monitoring data evidence

The integration run in the same disposable guest also exercised the real monitoring data paths:

- Prometheus reported `up=1` for all six selected exporter jobs: cAdvisor, Node Exporter, PostgreSQL Exporter, Redis Exporter, MongoDB Exporter and MySQL Exporter.
- Missing and incorrect Grafana authentication returned 401. Authenticated queries through Grafana's datasource proxy returned `up=1` for each of those six jobs, confirming the provisioned datasource reached Prometheus rather than merely rendering a healthy Grafana endpoint.
- A synthetic event emitted to container stdout travelled through Fluent Bit into Loki. Exactly one returned record had a decoded `log` field equal to the event and `stream` equal to `stdout`; log entries that merely echoed the query were excluded.

These observations establish the exercised data paths only. They do not substitute for the separate final combined installation, lifecycle and strict-verification results.
