#!/usr/bin/env python3
"""Require authentication on Redis Insight before accepting backend readiness."""
import base64
import errno
import os
import json
import socket
import subprocess
import sys
import urllib.error
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def status(opener, method, path, authorization=None, extra_headers=None):
    headers = dict(extra_headers or {})
    if authorization:
        headers["Authorization"] = authorization
    request = urllib.request.Request("http://127.0.0.1:5540" + path, method=method, headers=headers)
    try:
        with opener.open(request, timeout=15) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code

def inspect_field(container, template):
    return subprocess.run(
        ["docker", "inspect", "--format", template, container],
        capture_output=True, text=True, check=True, timeout=15,
    ).stdout.strip()


def verify_backend_isolation():
    gateway = "cortex-redisinsight-gateway"
    gateway_id = inspect_field(gateway, "{{.Id}}")
    mode = inspect_field("cortex-redisinsight", "{{.HostConfig.NetworkMode}}")
    if mode not in ("container:" + gateway_id, "container:" + gateway):
        raise RuntimeError("Backend does not share the gateway network namespace")
    networks = json.loads(inspect_field(gateway, "{{json .NetworkSettings.Networks}}"))
    addresses = [settings[key] for settings in networks.values()
                 for key in ("IPAddress", "GlobalIPv6Address") if settings.get(key)]
    if not addresses:
        raise RuntimeError("Cannot establish backend network isolation")
    # A refused backend is meaningful only when this same bridge address is reachable.
    for address in addresses:
        try:
            with socket.create_connection((address, 5541), timeout=2):
                pass
        except OSError as error:
            raise RuntimeError("Gateway bridge connectivity unavailable: " +
                               errno.errorcode.get(error.errno, "TIMEOUT_OR_UNKNOWN")) from None
        try:
            connection = socket.create_connection((address, 5540), timeout=2)
        except OSError as error:
            if error.errno == errno.ECONNREFUSED:
                continue
            raise RuntimeError("Backend denial inconclusive: " +
                               errno.errorcode.get(error.errno, "TIMEOUT_OR_UNKNOWN")) from None
        connection.close()
        raise RuntimeError("Unauthenticated backend port reachable on a bridge address")



def main():
    password = os.environ.get("REDISINSIGHT_PROXY_PASSWORD")
    if not password:
        raise RuntimeError("Missing verification credential")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    for method in ("GET", "POST"):
        for path in ("/", "/api/databases", "/api/health/"):
            if status(opener, method, path) != 401:
                raise RuntimeError("Unauthenticated request was not rejected")
    invalid = "Basic " + base64.b64encode(b"admin:invalid-password").decode("ascii")
    if status(opener, "GET", "/api/health/", invalid) != 401:
        raise RuntimeError("Invalid credential was not rejected")
    authorization = "Basic " + base64.b64encode(("admin:" + password).encode()).decode("ascii")
    if status(opener, "GET", "/api/health/", authorization) != 200:
        raise RuntimeError("Authenticated backend health check failed")
    verify_backend_isolation()
    for headers in ({"Origin": "https://example.com"}, {"Sec-Fetch-Site": "cross-site"}):
        if status(opener, "POST", "/api/databases", authorization, headers) != 403:
            raise RuntimeError("Cross-origin browser request was not rejected")
    print("Redis Insight authentication and backend readiness confirmed")


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as error:
        # RuntimeError messages above contain only fixed descriptions and errno names.
        print("Redis Insight verification failed: " + str(error), file=sys.stderr)
        raise SystemExit(1)
    except Exception:
        # Never expose request headers, credentials, response bodies, or exception data.
        print("Redis Insight authentication/readiness verification failed", file=sys.stderr)
        raise SystemExit(1)
