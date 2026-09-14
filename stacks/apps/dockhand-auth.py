"""Create a fail-closed proxy password file and verify its HTTP boundary."""
import argparse
import base64
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import tempfile
import socket
import subprocess
import urllib.error
import urllib.request


def password():
    value = os.environ.get('DOCKHAND_PROXY_PASSWORD', '')
    if not re.fullmatch(r'[a-f0-9]{64}', value):
        raise ValueError('Expected generated Dockhand proxy password')
    return value


def apply(manifest_path):
    manifest = json.loads(Path(manifest_path).read_text())
    directory = Path(manifest['data_root']) / 'dockhand-auth'
    if not directory.is_absolute() or directory.resolve() != directory:
        raise ValueError('Refusing symlinked authentication directory')
    directory.mkdir(parents=True, exist_ok=True, mode=0o755)
    os.chown(directory, 0, 0)
    os.chmod(directory, 0o755)
    salt = secrets.token_bytes(32)
    # RFC2307 SSHA is natively supported by ngx_http_auth_basic_module.
    # Input is a generated 256-bit random value, never a human password.
    digest = hashlib.sha1(password().encode() + salt).digest()
    encoded = '{SSHA}' + base64.b64encode(digest + salt).decode()
    descriptor, temporary = tempfile.mkstemp(prefix='.auth-', dir=directory)
    try:
        os.fchmod(descriptor, 0o600)
        os.fchown(descriptor, 101, 101)
        with os.fdopen(descriptor, 'w') as stream:
            stream.write('admin:' + encoded + '\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, directory / 'htpasswd')
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print('Dockhand authenticated frontend prepared')


def verify():
    authorization = base64.b64encode(('admin:' + password()).encode()).decode()
    request = urllib.request.Request('http://127.0.0.1:3420/', headers={'Authorization': 'Basic ' + authorization})
    with urllib.request.urlopen(request, timeout=10) as response:
        if response.status != 200:
            raise ValueError('Authenticated frontend unavailable')
    networks = json.loads(subprocess.check_output([
        'docker', 'inspect', '--format', '{{json .NetworkSettings.Networks}}',
        'cortex-dockhand-proxy'], text=True))
    addresses = [network[key] for network in networks.values()
                 for key in ('IPAddress', 'GlobalIPv6Address') if network.get(key)]
    if not addresses:
        raise ValueError('Cannot establish proxy namespace address')
    proxy_id = subprocess.check_output([
        'docker', 'inspect', '--format', '{{.Id}}', 'cortex-dockhand-proxy'],
        text=True).strip()
    network_mode = subprocess.check_output([
        'docker', 'inspect', '--format', '{{.HostConfig.NetworkMode}}',
        'cortex-dockhand'], text=True).strip()
    if network_mode != 'container:' + proxy_id:
        raise ValueError('Dockhand does not share the protected proxy namespace')
    for address in addresses:
        # Establish reachability on the same address before interpreting refusal.
        with socket.create_connection((address, 8080), timeout=3):
            pass
        try:
            connection = socket.create_connection((address, 3000), timeout=3)
        except OSError as error:
            if error.errno == errno.ECONNREFUSED:
                continue
            raise ValueError('Backend denial is inconclusive: bridge address unreachable') from None
        connection.close()
        raise ValueError('Host can bypass proxy through backend container address')
    # The non-existent identifier prevents a destructive operation even if
    # somebody replaces the expected proxy with an unprotected backend.
    for method, path in [('GET', '/'), ('POST', '/api/containers/cortex-auth-probe-never-exists/restart')]:
        request = urllib.request.Request('http://127.0.0.1:3420' + path, method=method)
        try:
            with urllib.request.urlopen(request, timeout=10):
                raise ValueError('Unauthenticated request reached application')
        except urllib.error.HTTPError as error:
            if error.code != 401:
                raise ValueError('Expected authentication challenge') from None
    print('Dockhand denies unauthenticated reads/mutations and serves authenticated frontend')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['apply', 'verify'])
    parser.add_argument('--manifest', default=os.environ.get('CORTEX_MANIFEST'))
    args = parser.parse_args()
    try:
        if args.action == 'apply':
            if not args.manifest:
                raise ValueError('Manifest required')
            apply(args.manifest)
        else:
            verify()
    except (OSError, ValueError, subprocess.SubprocessError):
        raise SystemExit('Dockhand authentication preparation or verification failed')
