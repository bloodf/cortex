#!/usr/bin/env python3
"""Root-only memory prepare/install/provision/verify hooks; never print credentials."""
import argparse
import base64
import fcntl
import errno
import hashlib
import ipaddress
import socket
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import time

SECRETS = Path('/etc/cortex/secrets')
CONFIG = SECRETS / 'memory-broker.json'
BASE_ENV = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'}


def directory(path):
    """Pin each trusted ancestor without following symlinks; never chown runtime paths."""
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('Unsafe absolute path')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                os.mkdir(part, 0o700, dir_fd=fd)
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            st = os.fstat(fd)
            if st.st_uid != 0 or st.st_mode & 0o022:
                raise RuntimeError('Memory configuration requires root-owned, non-writable ancestors')
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_private(path):
    path = Path(path)
    parent = directory(path.parent)
    try:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
    finally:
        os.close(parent)
    with os.fdopen(fd) as stream:
        st = os.fstat(stream.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or stat.S_IMODE(st.st_mode) != 0o600 or st.st_nlink != 1:
            raise RuntimeError('Memory secret must be a root-owned single-link regular file mode 0600')
        return stream.read()


def save(path, text, mode=0o600, owner=(0, 0)):
    path = Path(path)
    parent = directory(path.parent)
    temp = '.memory-' + secrets.token_hex(16)
    try:
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=parent)
        with os.fdopen(fd, 'w') as stream:
            os.fchown(stream.fileno(), *owner)
            os.fchmod(stream.fileno(), mode)
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path.name, src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
    finally:
        try:
            os.unlink(temp, dir_fd=parent)
        except FileNotFoundError:
            pass
        os.close(parent)


def environment(path, optional=False):
    try:
        text = read_private(path)
    except FileNotFoundError:
        if optional:
            return {}
        raise
    result = {}
    for line in text.splitlines():
        if not line or line.startswith('#'):
            continue
        key, sep, value = line.partition('=')
        if not sep or not re.fullmatch(r'[A-Z][A-Z0-9_]*', key) or key in result or any(c in value for c in '\r\n\x00'):
            raise ValueError('Invalid literal environment file')
        result[key] = value
    return result


def save_env(path, values):
    save(path, ''.join(key + '=' + value + '\n' for key, value in sorted(values.items())))


def provision(config, name):
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,23}', name):
        raise ValueError('Invalid agent identity')
    identity = config['agents'].setdefault(name, {'bank': 'agent-' + name, 'token': secrets.token_urlsafe(48)})
    path = SECRETS / ('agent-' + name + '.env')
    values = environment(path, optional=True)
    values.update(HINDSIGHT_API_URL='http://127.0.0.1:8888', HINDSIGHT_API_KEY=identity['token'], HINDSIGHT_BANK_ID=identity['bank'])
    save_env(path, values)


def prepare(manifest, agent=None):
    if 'hindsight' not in manifest['services']:
        raise ValueError('Every memory-enabled agent requires selected Hindsight service')
    parent = directory(SECRETS)
    try:
        lock = os.open('.memory.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    finally:
        os.close(parent)
    with os.fdopen(lock, 'w') as stream:
        st = os.fstat(stream.fileno())
        if st.st_uid != 0 or st.st_nlink != 1 or not stat.S_ISREG(st.st_mode) or stat.S_IMODE(st.st_mode) != 0o600:
            raise RuntimeError('Unsafe memory lock')
        fcntl.flock(stream, fcntl.LOCK_EX)
        try:
            config = json.loads(read_private(CONFIG))
        except FileNotFoundError:
            config = {'upstream_key': secrets.token_urlsafe(48), 'admin_key': secrets.token_urlsafe(48), 'agents': {}}
        values = environment(SECRETS / 'hindsight.env')
        for key in ('HINDSIGHT_API_LLM_API_KEY', 'HINDSIGHT_API_LLM_MODEL', 'HINDSIGHT_API_LLM_BASE_URL'):
            if not values.get(key):
                raise ValueError('Hindsight requires explicit extraction provider credentials, model and URL')
        values.update(HINDSIGHT_API_TENANT_API_KEY=config['upstream_key'], CORTEX_MEMORY_ADMIN_KEY=config['admin_key'],
                      HINDSIGHT_API_TENANT_EXTENSION='hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension',
                      HINDSIGHT_API_TENANT_MCP_AUTH_DISABLED='false', HINDSIGHT_ENABLE_CP='true',
                      HINDSIGHT_CP_HOSTNAME='127.0.0.1', HINDSIGHT_CP_PORT='9999',
                      HINDSIGHT_CP_DATAPLANE_API_URL='http://127.0.0.1:8888',
                      HINDSIGHT_CP_DATAPLANE_API_KEY=config['upstream_key'])
        save_env(SECRETS / 'hindsight.env', values)
        auth_dir = Path(manifest['data_root']) / 'hindsight-ui-auth'
        auth_fd = directory(auth_dir)
        try:
            os.fchmod(auth_fd, 0o755)
        finally:
            os.close(auth_fd)
        salt = secrets.token_bytes(32)
        digest = hashlib.sha1(config['admin_key'].encode() + salt).digest()
        encoded = '{SSHA}' + base64.b64encode(digest + salt).decode()
        save(auth_dir / 'htpasswd', 'admin:' + encoded + '\n', owner=(101, 101))
        names = [spec['name'] for spec in manifest.get('agents', [])]
        if len(names) != len(set(names)):
            raise ValueError('Duplicate agent names')
        if agent is not None and agent not in names:
            raise ValueError('Agent must exist in the explicit manifest')
        # Remove authorization for identities no longer in the manifest.
        config['agents'] = {k: v for k, v in config['agents'].items() if k in names}
        for name in ([agent] if agent is not None else names):
            provision(config, name)
        save(CONFIG, json.dumps(config, indent=2) + '\n')


def run(*args):
    result = subprocess.run(args, env=BASE_ENV, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError('Memory service command failed; inspect protected service state')
    return result.stdout


def guard_gate(config):
    networks = json.loads(run('docker', 'inspect', '--format', '{{json .NetworkSettings.Networks}}', 'cortex-hindsight'))
    addresses = [v[key] for v in networks.values() for key in ('IPAddress', 'GlobalIPv6Address') if v.get(key)]
    if not addresses:
        raise RuntimeError('Hindsight namespace has no inspectable bridge address')
    status, body = broker_request('GET', '/api/banks', config['admin_key'], basic=True, port=9999)
    if status != 200:
        raise RuntimeError('Authenticated native control-plane API failed')
    json.loads(body)
    for address in addresses:
        ipaddress.ip_address(address)
        with socket.create_connection((address, 19999), timeout=3):
            pass
        family = socket.AF_INET6 if ipaddress.ip_address(address).version == 6 else socket.AF_INET
        with socket.socket(family) as probe:
            probe.settimeout(3)
            if probe.connect_ex((address, 9999)) != errno.ECONNREFUSED:
                raise RuntimeError('Native control-plane bridge denial was not ECONNREFUSED')
        connection = http.client.HTTPConnection(address, 8888, timeout=15)
        try:
            connection.request('GET', '/v1/default/banks')
            response = connection.getresponse()
            if response.status not in (401, 403):
                raise RuntimeError('Native bridge API anonymous bypass')
            response.read()
        finally:
            connection.close()
    for method, path in (('GET', '/'), ('GET', '/api/banks'), ('POST', '/api/banks')):
        status, _ = broker_request(method, path, port=9999)
        if status != 401:
            raise RuntimeError('Native console guard did not deny anonymous access')


def install(manifest):
    root = manifest['root']
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+', root) or '..' in Path(root).parts:
        raise ValueError('Unsafe installation root')
    from broker import load_config, upstream_gate
    # Wait for API initialization but do not publish broker on an auth failure.
    for attempt in range(120):
        try:
            upstream_gate(load_config())
            break
        except (OSError, http.client.HTTPException):
            if attempt == 119:
                raise RuntimeError('Native Hindsight did not become ready') from None
            time.sleep(5)
    guard_gate(load_config())
    template = (Path(root) / 'templates/memory/broker.service').read_text()
    save('/etc/systemd/system/cortex-memory-broker.service', template.replace('@ROOT@', root), 0o644)
    run('systemctl', 'daemon-reload')
    run('systemctl', 'enable', '--now', 'cortex-memory-broker.service')
    run('systemctl', 'restart', 'cortex-memory-broker.service')
    run('systemctl', 'is-active', '--quiet', 'cortex-memory-broker.service')


def broker_request(method, path, key=None, body=None, basic=False, port=8888):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=300)
    headers = {'Accept': 'application/json'}
    if key:
        headers['Authorization'] = ('Basic ' + base64.b64encode(('admin:' + key).encode()).decode()) if basic else 'Bearer ' + key
    if body is not None:
        body = json.dumps(body).encode()
        headers['Content-Type'] = 'application/json'
    try:
        connection.request(method, path, body, headers)
        response = connection.getresponse()
        return response.status, response.read(8 * 1024 * 1024)
    finally:
        connection.close()


def verify(manifest):
    from broker import load_config, request, upstream_gate
    config = load_config()
    upstream_gate(config)
    guard_gate(config)
    # Dedicated ephemeral identities exercise both directions even on zero-agent installs.
    # Never insert probe credentials into any agent environment file.
    names = ['probe-' + secrets.token_hex(6), 'probe-' + secrets.token_hex(6)]
    for name in names:
        config['agents'][name] = {'bank': 'agent-' + name, 'token': secrets.token_urlsafe(48)}
    save(CONFIG, json.dumps(config) + '\n')
    try:
        identities = [config['agents'][name] for name in names]
        for index, identity in enumerate(identities):
            own = '/v1/default/banks/' + identity['bank']
            peer = '/v1/default/banks/' + identities[1-index]['bank']
            for path in (own + '/memories/recall', peer + '/memories/recall'):
                if broker_request('POST', path, body={'query': 'probe'})[0] != 401:
                    raise RuntimeError('Anonymous memory access was not denied')
            for path in (peer + '/memories/recall', peer + '/memories', peer + '/reflect', '/v1/default/banks', '/mcp', own + '/config', own + '/webhooks', '/v1/default/chunks/probe', own + '/memories/recall?bank_id=' + identities[1-index]['bank']):
                if broker_request('POST', path, identity['token'], {'query': 'probe'})[0] != 403:
                    raise RuntimeError('Cross-bank or control-plane request was not denied')
            if request('GET', '/v1/default/banks', identity['token'])[0] not in (401, 403):
                raise RuntimeError('Agent credential bypassed native upstream boundary')
            marker = 'Cortex memory acceptance code ' + secrets.token_hex(12)
            code = marker.rsplit(' ', 1)[1]
            status, _ = broker_request('POST', own + '/memories', identity['token'], {'items': [{'content': marker + '. This exact code identifies this isolated memory bank.'}], 'async': bool(index)})
            if status not in (200, 202):
                raise RuntimeError('Own-bank extraction failed')
            for attempt in range(12):
                status, data = broker_request('POST', own + '/memories/recall', identity['token'], {'query': marker, 'budget': 'high'})
                if status == 200 and any(code in row.get('text', '') for row in json.loads(data).get('results', [])):
                    break
                time.sleep(5)
            else:
                raise RuntimeError('Own-bank extracted fact was not recalled')
            if broker_request('POST', own + '/reflect', identity['token'], {'query': 'What is the acceptance code?', 'budget': 'low'})[0] != 200:
                raise RuntimeError('Own-bank reflection failed')
            status, data = broker_request('POST', peer + '/memories/recall', identities[1-index]['token'], {'query': marker})
            if status not in (200, 404) or code in data.decode():
                raise RuntimeError('Peer bank exposed isolated fact')
        if broker_request('GET', '/api/banks', identities[0]['token'], port=9999)[0] != 401:
            raise RuntimeError('Agent credential opened operator console')
    finally:
        current = load_config()
        for name in names:
            current['agents'].pop(name, None)
        save(CONFIG, json.dumps(current) + '\n')
        for name in names:
            request('DELETE', '/v1/default/banks/agent-' + name, config['upstream_key'])
    print('Memory verification passed: native denial, anonymous denial, peer denial, extracted own-bank recall, protected operator console')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('prepare', 'provision', 'install', 'verify', 'start', 'stop', 'restart'))
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--agent')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError('Run only as root on the approved target')
    os.umask(0o077)
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'installer'))
    from manifest import load, selected
    original = load(args.manifest)
    manifest = dict(original, services=selected(original))
    if args.action in ('prepare', 'provision'):
        if args.action == 'provision' and not args.agent:
            raise ValueError('provision requires --agent')
        prepare(manifest, args.agent)
    elif args.action == 'install':
        install(manifest)
    elif args.action == 'verify':
        parent = directory(SECRETS)
        try:
            fd = os.open('.memory.lock', os.O_RDWR | os.O_NOFOLLOW, dir_fd=parent)
        finally:
            os.close(parent)
        with os.fdopen(fd, 'w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            verify(manifest)
    else:
        run('systemctl', args.action, 'cortex-memory-broker.service')
        if args.action != 'stop':
            run('systemctl', 'is-active', '--quiet', 'cortex-memory-broker.service')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('Memory operation failed; credentials and upstream errors are intentionally not logged') from None
