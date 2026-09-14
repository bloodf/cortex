#!/usr/bin/env python3
"""Enroll an operator-owned tailnet and serve only the authenticated dashboard."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request


def run(*argv, capture=False):
    result = subprocess.run(argv, check=True, text=True, stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.PIPE if capture else None)
    return result.stdout


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['apply', 'verify', 'start', 'stop', 'restart', 'update'])
    parser.add_argument('--manifest', required=True)
    args = parser.parse_args()
    manifest = json.loads(Path(args.manifest).read_text())
    if os.geteuid():
        raise SystemExit('Root required')
    if args.action in ('apply', 'update'):
        key = urllib.request.urlopen('https://pkgs.tailscale.com/stable/ubuntu/resolute.noarmor.gpg', timeout=30).read()
        Path('/usr/share/keyrings/tailscale-archive-keyring.gpg').write_bytes(key)
        Path('/etc/apt/sources.list.d/tailscale.list').write_text('deb [signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/ubuntu resolute main\n')
        run('apt-get', 'update')
        run('apt-get', 'install', '-y', 'tailscale')
        run('systemctl', 'enable', '--now', 'tailscaled.service')
        state = json.loads(run('tailscale', 'status', '--json', capture=True))
        if state.get('BackendState') != 'Running':
            token = os.environ.get('TAILSCALE_AUTHKEY')
            if not token:
                raise SystemExit('Set TAILSCALE_AUTHKEY in /etc/cortex/secrets/tailscale.env; token is never generated')
            with tempfile.NamedTemporaryFile(mode='w', dir='/run', prefix='cortex-tailnet-') as secret:
                os.chmod(secret.name, 0o600)
                secret.write(token)
                secret.flush()
                run('tailscale', 'up', '--auth-key=file:' + secret.name,
                    '--hostname=' + manifest['hostname'], '--ssh=false', '--accept-routes=false')
        if manifest['network']['mode'] == 'tailscale':
            run('tailscale', 'serve', '--bg', '--https=443', 'http://127.0.0.1:3080')
    elif args.action != 'verify':
        run('systemctl', args.action, 'tailscaled.service')
    if args.action != 'stop':
        state = json.loads(run('tailscale', 'status', '--json', capture=True))
        if state.get('BackendState') != 'Running':
            raise SystemExit('Tailscale is not authenticated and running')
        if manifest['network']['mode'] == 'tailscale':
            hostname = state.get('Self', {}).get('DNSName', '').rstrip('.')
            selected = urllib.parse.urlparse(manifest['network']['public_url'])
            if selected.scheme != 'https' or selected.hostname != hostname or selected.port not in (None, 443):
                raise SystemExit('network.public_url must match this node HTTPS MagicDNS hostname; update the manifest explicitly')
            with urllib.request.urlopen(manifest['network']['public_url'], timeout=15) as response:
                if response.status != 200:
                    raise SystemExit('Tailnet dashboard endpoint did not return HTTP 200')

if __name__ == '__main__':
    main()
