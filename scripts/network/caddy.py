#!/usr/bin/env python3
"""Loopback-only reverse proxy. Public ingress is never inferred from a URL."""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['apply', 'verify', 'start', 'stop', 'restart', 'update'])
    parser.add_argument('--manifest', required=True)
    args = parser.parse_args()
    if os.geteuid():
        raise SystemExit('Root required')
    def run(*argv):
        subprocess.run(argv, check=True)
    if args.action in ('apply', 'update'):
        # Prevent the distro package from starting its public default configuration.
        run('systemctl', 'mask', 'caddy.service')
        run('apt-get', 'install', '-y', 'caddy')
        Path('/etc/caddy/Caddyfile').write_text('''{
    admin off
    auto_https off
}
http://127.0.0.1:8080 {
    bind 127.0.0.1
    reverse_proxy 127.0.0.1:3080
}
''')
        run('caddy', 'validate', '--config', '/etc/caddy/Caddyfile')
        run('systemctl', 'unmask', 'caddy.service')
        run('systemctl', 'enable', '--now', 'caddy.service')
        run('systemctl', 'restart', 'caddy.service')
    elif args.action != 'verify':
        run('systemctl', args.action, 'caddy.service')
    if args.action != 'stop':
        run('systemctl', 'is-active', '--quiet', 'caddy.service')
        with urllib.request.urlopen('http://127.0.0.1:8080/', timeout=10) as response:
            if response.status != 200:
                raise SystemExit('Caddy did not return dashboard page')

if __name__ == '__main__':
    main()
