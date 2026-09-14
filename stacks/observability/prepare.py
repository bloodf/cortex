#!/usr/bin/env python3
"""Prepare selected observability services; never start containers or echo secrets."""
import argparse
import json
import os
from pathlib import Path
import re
import tempfile
from urllib.parse import quote

EXPORTERS = {
    "cadvisor": 8080, "node-exporter": 9100, "pg-exporter": 9187,
    "redis-exporter": 9121, "mongo-exporter": 9216, "mysql-exporter": 9104,
}
DATA = {"prometheus": 65534, "grafana": 472, "loki": 10001,
        "fluent-bit": 0, "pgadmin": 5050, "redisinsight": 1000}


def directory(path, uid=0, mode=0o750):
    if path.is_symlink():
        raise ValueError("Refusing symlinked service directory")
    path.mkdir(parents=True, exist_ok=True, mode=mode)
    os.chown(path, uid, uid)
    os.chmod(path, mode)


def atomic(path, content, mode=0o644):
    fd, temporary = tempfile.mkstemp(prefix=".cortex-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(content)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def document(path, value):
    atomic(path, json.dumps(value, indent=2) + "\n")


def required(key):
    value = os.environ.get(key, "")
    if not value:
        raise ValueError("Missing protected environment key: " + key)
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["apply"])
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    selected = set(os.environ.get("CORTEX_SELECTED_SERVICES", "").split(",")) - {""}
    if not selected:
        selected = set(manifest["services"])
    data = Path(manifest["data_root"])
    if not data.is_absolute():
        raise ValueError("data_root must be absolute")
    catalog = json.loads((Path(__file__).resolve().parents[2] / "catalog/observability.json").read_text())
    current = required("CORTEX_SERVICE_ID")
    if current not in selected or current not in {entry["id"] for entry in catalog["services"]}:
        raise ValueError("Preparation requires a selected observability service")
    image = required(current.upper().replace("-", "_") + "_IMAGE")
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._/:\-]*@sha256:[a-f0-9]{64}", image):
        raise ValueError("Service requires an immutable repository@sha256 image reference")
    if current == "redisinsight" and required("RI_ACCEPT_TERMS_AND_CONDITIONS").lower() != "true":
        raise ValueError("Redis Insight requires explicit operator terms acceptance")
    if current == "redisinsight":
        proxy_image = required("REDISINSIGHT_PROXY_IMAGE")
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._/:\-]*@sha256:[a-f0-9]{64}", proxy_image):
            raise ValueError("Gateway requires an immutable image reference")
        password = required("REDISINSIGHT_PROXY_PASSWORD")
        if not re.fullmatch(r"[a-f0-9]{64}", password):
            raise ValueError("Gateway password must be 64 lowercase hexadecimal characters")
        directory(data / "redisinsight-gateway", mode=0o700)
        atomic(data / "redisinsight-gateway/haproxy.cfg", f"""global
    maxconn 256

defaults
    timeout connect 5s
    timeout client 60s
    timeout server 60s

userlist cortex_admin
    user admin insecure-password {password}

frontend authenticated_http
    bind :5541
    mode http
    http-request auth realm Cortex-RedisInsight unless {{ http_auth(cortex_admin) }}
    http-request deny deny_status 403 if {{ req.hdr(Sec-Fetch-Site) -m str cross-site }}
    http-request deny deny_status 403 if {{ req.hdr(Origin) -m found }} !{{ req.hdr(Origin) -m str http://127.0.0.1:5540 http://localhost:5540 }}
    http-request del-header Authorization
    default_backend redisinsight_http

backend redisinsight_http
    mode http
    server app 127.0.0.1:5540 check
""", 0o600)
    if current in DATA:
        directory(data / current, DATA[current])
    if current == "prometheus":
        directory(data / "prometheus-config", mode=0o755)
        document(data / "prometheus-config/selected.json", [
            {"targets": [f"cortex-{sid}:{port}"], "labels": {"job": sid}}
            for sid, port in EXPORTERS.items() if sid in selected
        ])
    if current == "grafana":
        directory(data / "grafana-provisioning", mode=0o755)
        sources = []
        for sid, port in (("prometheus", 9090), ("loki", 3100)):
            if sid in selected:
                sources.append({"name": sid.title(), "uid": "cortex-" + sid,
                                "type": sid, "access": "proxy", "url": f"http://cortex-{sid}:{port}",
                                "isDefault": sid == "prometheus", "editable": False})
        document(data / "grafana-provisioning/cortex.yaml", {
            "apiVersion": 1, "prune": True, "datasources": sources,
            "deleteDatasources": [{"name": sid.title(), "orgId": 1}
                                  for sid in ("prometheus", "loki") if sid not in selected],
        })
    if current == "pgadmin":
        directory(data / "pgadmin-config", mode=0o755)
        document(data / "pgadmin-config/servers.json", {"Servers": {"1": {
            "Name": "Cortex PostgreSQL", "Group": "Cortex", "Host": "cortex-postgresql",
            "Port": 5432, "MaintenanceDB": required("POSTGRES_DB"),
            "Username": required("POSTGRES_USER"), "SSLMode": "prefer",
        }}})
    if current == "mongo-express":
        directory(data / "mongo-express-config", mode=0o700)
        user = quote(required("MONGO_INITDB_ROOT_USERNAME"), safe="")
        password = quote(required("MONGO_INITDB_ROOT_PASSWORD"), safe="")
        atomic(data / "mongo-express-config/mongodb-url",
               f"mongodb://{user}:{password}@cortex-mongodb:27017/?authSource=admin", 0o600)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError) as error:
        # No exception values from credentials, parsed manifests, or subprocesses.
        raise SystemExit("Observability preparation failed: " + type(error).__name__)
