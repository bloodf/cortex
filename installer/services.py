#!/usr/bin/env python3
"""Manifest-driven service lifecycle. This module never executes at import time."""
from __future__ import annotations
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import socket
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = Path(__file__).resolve().parents[1]
SECRETS = Path('/etc/cortex/secrets')


def run(argv, *, env=None, capture=False):
    from provision import run as protected_run
    from manifest import Invalid
    stage = (env or {}).get('CORTEX_SERVICE_ID', 'services')
    try:
        return protected_run(argv, env=env, capture=capture,
                             label=f'{stage}: {Path(str(argv[0])).name}') or ''
    except Invalid as error:
        raise RuntimeError(str(error)) from None


def read_env(path):
    if not path.exists():
        return {}
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise ValueError(f'{path}: must be a root-owned regular file mode 0600')
    values = {}
    for number, line in enumerate(path.read_text().splitlines(), 1):
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        key, sep, value = line.partition('=')
        if not sep or not re.fullmatch(r'[A-Z][A-Z0-9_]*', key):
            raise ValueError(f'{path}:{number}: expected KEY=value')
        if key in values:
            raise ValueError(f'{path}:{number}: duplicate key {key}')
        # This is deliberately not shell; values are literal, no quote removal.
        values[key] = value
    return values


def write_private(path, text):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink():
        raise ValueError(f'Refusing symlink {path}')
    tmp = path.with_name(path.name + '.new')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w') as output:
            output.write(text)
            output.flush()
            os.fsync(output.fileno())
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def provision_secrets(item, mutate):
    path = SECRETS / (item['id'] + '.env')
    values = read_env(path)
    changed = not path.exists()
    for key, value in item.get('secret_defaults', {}).items():
        if key not in values:
            if not mutate:
                raise ValueError(f'{path}: missing {key}')
            values[key] = str(value)
            changed = True
    for key in item.get('generated_secrets', []):
        if not values.get(key):
            if not mutate:
                raise ValueError(f'{path}: missing generated key {key}')
            values[key] = secrets.token_hex(32)
            changed = True
    if changed and mutate:
        write_private(path, ''.join(f'{key}={value}\n' for key, value in values.items()))
    for key in item.get('required_secrets', []):
        if not values.get(key):
            raise ValueError(f'{path}: operator must supply {key}; no value was generated')
    for key, value in values.items():
        if key.endswith('_IMAGE') and not re.fullmatch(r'[a-zA-Z0-9._:/-]+@sha256:[0-9a-f]{64}', value):
            raise ValueError(f'{path}: {key} requires an immutable repository@sha256:digest')
    return values


def render(value, manifest, manifest_path='/etc/cortex/install.json'):
    replacements = {'@ROOT@': manifest['root'], '@DATA_ROOT@': manifest['data_root'],
                    '@ADMIN_USER@': manifest['admin_user'], '@SECRETS_DIR@': str(SECRETS),
                    '@MANIFEST@': manifest_path}
    if isinstance(value, str):
        for old, new in replacements.items():
            value = value.replace(old, new)
        return value
    if isinstance(value, list):
        return [render(v, manifest, manifest_path) for v in value]
    if isinstance(value, dict):
        return {k: render(v, manifest, manifest_path) for k, v in value.items()}
    return value


def compose_path(item, manifest, mutate):
    path = Path('/etc/cortex/compose') / (item['id'] + '.json')
    if mutate:
        source = HERE / item['recipe']
        value = render(json.loads(source.read_text()), manifest)
        for service in value['services'].values():
            if 'env_file' in service:
                service['env_file'] = [
                    {'path': entry, 'format': 'raw'} if isinstance(entry, str)
                    else dict(entry, format='raw')
                    for entry in service['env_file']
                ]
        write_private(path, json.dumps(value, indent=2) + '\n')
    if not path.is_file():
        raise ValueError(f'{path}: service has not been installed')
    return path


def compose(item, path, args, env, capture=False):
    return run(['docker', 'compose', '--project-name', 'cortex-' + item['id'],
                '--file', path, *args], env=env, capture=capture)


def check_endpoint(check, env):
    kind = check['type']
    if kind == 'http':
        request = urllib.request.Request(check['url'])
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                if response.status not in check.get('statuses', [200, 204]):
                    raise RuntimeError(f'HTTP check returned {response.status}')
                if check.get('body_pattern'):
                    body = response.read(8 * 1024 * 1024).decode('utf-8')
                    if not re.search(check['body_pattern'], body, re.MULTILINE):
                        raise RuntimeError('HTTP readiness body did not match the required service metric')
        except urllib.error.HTTPError as error:
            if error.code not in check.get('statuses', [200, 204]):
                raise RuntimeError(f'HTTP check returned {error.code}') from None
    elif kind == 'tcp':
        with socket.create_connection(('127.0.0.1', int(check['port'])), timeout=5):
            pass
    elif kind == 'command':
        run(check['command'], env=env, capture=True)
    else:
        raise ValueError(f'Unknown verify type {kind}')


def verify_item(item, manifest, env):
    if item['kind'] == 'script':
        run(['python3', HERE / item['recipe'], 'verify', '--manifest', env['CORTEX_MANIFEST']], env=env)
        return
    if item['kind'] == 'compose':
        path = compose_path(item, manifest, False)
        ids = compose(item, path, ['ps', '--all', '--quiet'], env, True).split()
        expected = json.loads(path.read_text())['services']
        if len(ids) != len(expected):
            raise RuntimeError(f"{item['id']}: expected {len(expected)} containers, found {len(ids)}")
        for container in ids:
            state = json.loads(run(['docker', 'inspect', '--format', '{{json .State}}', container], capture=True))
            if not state.get('Running') or state.get('Health', {}).get('Status', 'healthy') != 'healthy':
                raise RuntimeError(f"{item['id']}: container not running and healthy")
    check_endpoint(render(item['verify'], manifest, env['CORTEX_MANIFEST']), env)


def apply_item(item, manifest, env, action):
    if item['kind'] == 'core':
        if action in ('start', 'stop', 'restart'):
            run(['systemctl', action, 'cortex-dashboard.service', 'cortex-terminal.service'])
        return
    if item['kind'] == 'script':
        run(['python3', HERE / item['recipe'], action, '--manifest', env['CORTEX_MANIFEST']], env=env)
        return
    if action in ('apply', 'update') and item.get('prepare'):
        run(['python3', HERE / item['prepare'], 'apply', '--manifest', env['CORTEX_MANIFEST']], env=env)
    if action == 'stop' and item.get('companion_script'):
        run(['python3', HERE / item['companion_script'], 'stop', '--manifest', env['CORTEX_MANIFEST']], env=env)
    path = compose_path(item, manifest, action in ('apply', 'update'))
    if action in ('apply', 'update'):
        compose(item, path, ['pull'], env)
        up = ['up', '-d', '--remove-orphans', '--wait', '--wait-timeout', '300']
        if item.get('recreate_on_apply'):
            up.append('--force-recreate')
        compose(item, path, up, env)
        if item.get('after_apply'):
            run(['python3', HERE / item['after_apply'], 'apply', '--manifest', env['CORTEX_MANIFEST']], env=env)
    else:
        compose(item, path, [action], env)
        if action in ('start', 'restart') and item.get('companion_script'):
            run(['python3', HERE / item['companion_script'], action, '--manifest', env['CORTEX_MANIFEST']], env=env)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['apply', 'verify', 'start', 'stop', 'restart', 'update'])
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--only', help='Operate only this selected service (dependencies must already exist)')
    parser.add_argument('--approved', action='store_true')
    args = parser.parse_args(argv)
    from manifest import load, selected
    manifest = load(Path(args.manifest))
    catalog = json.loads((HERE / 'catalog/services.json').read_text())
    lookup = {item['id']: item for item in catalog['services']}
    ids = selected(manifest)
    if args.only:
        if args.only not in ids:
            raise ValueError('--only service is not selected')
        ids = [args.only]
    for id in ids:
        timeout = lookup[id].get('startup_timeout_seconds', 120)
        if type(timeout) is not int or not 1 <= timeout <= 600:
            raise ValueError(f'{id}: startup_timeout_seconds must be an integer from 1 to 600')
    if os.geteuid() != 0:
        raise ValueError('Run as root on the approved Cortex target')
    if args.action != 'verify' and not args.approved:
        raise ValueError('Mutation requires --approved after reviewing cortex plan')
    os_release = Path('/etc/os-release').read_text()
    if not re.search(r'^ID=ubuntu$', os_release, re.M) or not re.search(r'^VERSION_ID="?26\.04"?$', os_release, re.M):
        raise ValueError('Service lifecycle requires Ubuntu 26.04')
    owner = Path('/etc/cortex/ownership.json')
    if not owner.is_file():
        raise ValueError('No Cortex ownership marker; use bin/cortex apply on a fresh target first')
    from provision import ownership, secure_file
    secure_file(owner)
    if json.loads(owner.read_text()) != ownership(manifest):
        raise ValueError('Manifest does not own this Cortex installation')
    SECRETS.mkdir(parents=True, exist_ok=True, mode=0o700)
    if SECRETS.is_symlink() or SECRETS.stat().st_uid != 0 or SECRETS.stat().st_mode & 0o077:
        raise ValueError('Secrets directory must be root-owned mode 0700 without symlinks')
    with Path('/etc/cortex/services.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        env = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
               'HOME': '/root', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8',
               'DEBIAN_FRONTEND': 'noninteractive'}
        env.update(CORTEX_ROOT=manifest['root'], CORTEX_DATA_ROOT=manifest['data_root'],
                   CORTEX_SECRETS_DIR=str(SECRETS), CORTEX_MANIFEST=str(Path(args.manifest).resolve()),
                   CORTEX_SELECTED_SERVICES=','.join(selected(manifest)))
        # Validate/provision protected files first, without exporting unrelated secrets.
        # Only immutable image names (non-secret release choices) are shared for
        # preparation helpers; each service receives its own dependency closure below.
        for id in selected(manifest):
            values = (provision_secrets(lookup[id], args.action == 'apply') if id in ids
                      else read_env(SECRETS / (id + '.env')))
            env.update({key: value for key, value in values.items() if key.endswith('_IMAGE')})
        if 'dockhand' in ids:
            docker_socket = Path('/var/run/docker.sock').stat()
            if not stat.S_ISSOCK(docker_socket.st_mode):
                raise ValueError('Dockhand requires the local Docker daemon socket')
            env['DOCKER_GID'] = str(docker_socket.st_gid)
        if any(lookup[id]['kind'] == 'compose' for id in ids):
            version = run(['docker', 'compose', 'version', '--short'], env=env, capture=True).strip()
            match = re.match(r'^v?(\d+)\.(\d+)', version)
            if not match or tuple(map(int, match.groups())) < (2, 30):
                raise ValueError('Docker Compose >=2.30 is required for literal secret-file parsing')
        if args.action == 'apply' and any(lookup[id]['kind'] == 'compose' for id in ids):
            exists = subprocess.run(['docker', 'network', 'inspect', 'cortex-private'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if exists.returncode:
                run(['docker', 'network', 'create', '--driver', 'bridge', 'cortex-private'])
        if not args.only and args.action == 'stop' and (manifest['agents'] or manifest['development']):
            run(['python3', HERE / 'scripts/agents/manage.py', 'stop', '--manifest',
                 env['CORTEX_MANIFEST']], env=env)
        ordered = list(reversed(ids)) if args.action == 'stop' else ids
        for id in ordered:
            item = lookup[id]
            print(f'{id}: {args.action} starting', flush=True)
            item_env = dict(env)
            item_env['CORTEX_SERVICE_ID'] = id
            def dependency_env(service_id):
                for dependency in lookup[service_id]['depends_on']:
                    dependency_env(dependency)
                item_env.update(read_env(SECRETS / (service_id + '.env')))
            dependency_env(id)
            if args.action != 'verify':
                apply_item(item, manifest, item_env, args.action)
            if args.action not in ('stop',) and not (args.action == 'apply' and item['kind'] == 'core'):
                deadline = time.monotonic() + (item.get('startup_timeout_seconds', 120) if args.action != 'verify' else 0)
                while True:
                    try:
                        verify_item(item, manifest, item_env)
                        break
                    except (RuntimeError, OSError, urllib.error.URLError):
                        if time.monotonic() >= deadline:
                            raise
                        time.sleep(3)
            print(f'{id}: {args.action} complete', flush=True)
        if (args.only and args.action in ('apply', 'update', 'start', 'restart')
                and manifest['agents'] and Path('/etc/cortex/agents.nft').is_file()):
            run(['python3', HERE / 'scripts/agents/firewall.py', 'apply', '--manifest',
                 env['CORTEX_MANIFEST']], env=env)
        if (args.only and args.action in ('apply', 'update', 'start', 'restart')
                and manifest['development'] and Path('/etc/cortex/development.nft').is_file()):
            run(['python3', HERE / 'scripts/agents/development_network.py', 'apply',
                 '--manifest', env['CORTEX_MANIFEST']], env=env)
        if not args.only and args.action != 'stop' and (manifest['agents'] or manifest['development']):
            run(['python3', HERE / 'scripts/agents/manage.py', args.action, '--manifest', env['CORTEX_MANIFEST']], env=env)
        if not args.only and args.action == 'apply':
            run(['python3', HERE / 'scripts/operations.py', 'install-policy', '--manifest',
                 env['CORTEX_MANIFEST'], '--approved'], env=env)
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, RuntimeError, OSError) as error:
        print(f'Cortex services: {error}', file=sys.stderr)
        raise SystemExit(1)
