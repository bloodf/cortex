"""Root-only provisioning helpers; subprocess output may contain secrets and is not echoed."""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess

SECRETS = Path('/etc/cortex/secrets')
BASE_ENV = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            'HOME': '/root', 'LANG': 'C.UTF-8'}

def run(*args, input=None):
    result = subprocess.run([str(a) for a in args], input=input, text=True, capture_output=True, env=BASE_ENV)
    if result.returncode:
        raise RuntimeError(f'{args[0]} failed (exit {result.returncode}); inspect protected local service logs')
    return result.stdout.strip()

def wait_port(port):
    import socket
    import time
    for attempt in range(60):
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=2):
                return
        except OSError:
            if attempt == 59:
                raise RuntimeError(f'Loopback port {port} did not become ready') from None
            time.sleep(2)

def load():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['apply', 'verify', 'start', 'stop', 'restart', 'update'])
    parser.add_argument('--manifest', required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError('Run as root on the approved target only')
    # Code distributions must be executable by runtime UIDs; private state uses explicit 0600/0700.
    os.umask(0o022)
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from installer.manifest import load as load_manifest, selected
    canonical = load_manifest(args.manifest)
    manifest = dict(canonical, services=selected(canonical))
    for key in ('root', 'data_root'):
        if not re.fullmatch(r'/[A-Za-z0-9_./-]+', manifest[key]) or '..' in Path(manifest[key]).parts:
            raise ValueError(f'Unsafe {key}')
    return args.action, manifest

def secret(name):
    path = SECRETS / (name + '.env')
    parent = directory(path.parent)
    try:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
    finally:
        os.close(parent)
    with os.fdopen(fd) as stream:
        st = os.fstat(stream.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or stat.S_IMODE(st.st_mode) != 0o600:
            raise RuntimeError(f'{path} must be a root-owned regular file mode 0600')
        contents = stream.read()
    values = {}
    for line in contents.splitlines():
        if not line or line.startswith('#'):
            continue
        key, sep, value = line.partition('=')
        if not sep or not re.fullmatch('[A-Z][A-Z0-9_]*', key):
            raise ValueError(f'Invalid environment syntax in {path}; use literal KEY=value')
        values[key] = value
    return values

def require(values, *keys):
    for key in keys:
        if not values.get(key):
            raise RuntimeError(f'Operator must supply {key} in the protected environment file')

def directory(path, owner=None, mode=0o700):
    """Open every path component without following symlinks; mutate only pinned fds."""
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('Expected an absolute safe directory')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in path.parts[1:]:
            try:
                child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                os.mkdir(component, 0o755, dir_fd=fd)
                child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        if owner is not None:
            os.fchown(fd, *owner)
            os.fchmod(fd, mode)
        return fd
    except BaseException:
        os.close(fd)
        raise

def save(path, text, mode=0o600, owner=None):
    import secrets
    path = Path(path)
    parent = directory(path.parent)
    temporary = '.cortex-' + secrets.token_hex(16)
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=parent)
        with os.fdopen(fd, 'w') as stream:
            if owner is not None:
                os.fchown(stream.fileno(), *owner)
            os.fchmod(stream.fileno(), mode)
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path.name, src_dir_fd=parent, dst_dir_fd=parent)
    finally:
        try:
            os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError:
            pass
        os.close(parent)

def name(value):
    if not re.fullmatch('[a-z][a-z0-9-]{0,23}', value):
        raise ValueError('Agent/development name must be 1–24 lowercase letters, digits or hyphens, starting with a letter')
    return value

def runtime(service, action, manifest):
    from runtime_install import install
    return install(service, action, manifest)

def _grant_traverse(fd, uid):
    """Grant one UID search permission without unmasking other ACL entries."""
    status = os.fstat(fd)
    if status.st_uid != 0 or status.st_mode & 0o022:
        raise RuntimeError('Managed runtime ancestors must be root-owned and not writable by peers')
    if status.st_mode & stat.S_IXOTH:
        return
    path = f'/proc/self/fd/{fd}'
    result = subprocess.run(
        ['getfacl', '--access', '--numeric', '--omit-header', path],
        text=True, capture_output=True, check=True, pass_fds=(fd,), env=BASE_ENV)
    entries = [line.split('#', 1)[0].strip().split(':')
               for line in result.stdout.splitlines() if line and not line.startswith('#')]
    bits = lambda value: sum(bit for character, bit in zip(value, (4, 2, 1)) if character != '-')
    permissions = lambda value: ''.join(character if value & bit else '-'
                                        for character, bit in zip('rwx', (4, 2, 1)))
    old_mask = next((bits(value) for kind, name, value in entries if kind == 'mask'),
                    next(bits(value) for kind, name, value in entries if kind == 'group' and not name))
    updated = []
    for kind, name, value in entries:
        if kind == 'mask' or (kind == 'user' and name == str(uid)):
            continue
        if kind == 'group' or (kind == 'user' and name):
            value = permissions(bits(value) & old_mask)
        updated.append(f'{kind}:{name}:{value}')
    updated.extend((f'user:{uid}:--x', f'mask::{permissions(old_mask | 1)}'))
    subprocess.run(
        ['setfacl', '--no-mask', '--set-file=-', path],
        input='\n'.join(updated) + '\n', text=True, capture_output=True, check=True,
        pass_fds=(fd,), env=BASE_ENV)


def account(user, home, data_root):
    import pwd
    import shutil
    home, data_root = Path(home), Path(data_root)
    if (not data_root.is_absolute() or data_root == Path('/') or
            data_root == Path('/etc') or Path('/etc') in data_root.parents or
            not home.is_relative_to(data_root) or home == data_root or
            '..' in home.parts or '..' in data_root.parts):
        raise ValueError('Runtime home must be beneath the approved non-system data root')
    if not shutil.which('getfacl') or not shutil.which('setfacl'):
        run('apt-get', 'install', '-y', '--no-install-recommends', 'acl')
    try:
        entry = pwd.getpwnam(user)
        if entry.pw_dir != str(home) or entry.pw_shell != '/usr/sbin/nologin':
            raise RuntimeError('Existing account does not match Cortex ownership contract')
    except KeyError:
        run('useradd', '--system', '--user-group', '--home-dir', home, '--shell', '/usr/sbin/nologin', user)
        entry = pwd.getpwnam(user)
    if entry.pw_uid == 0 or entry.pw_gid == 0:
        raise RuntimeError('Native runtime accounts must not use root UID or GID')
    fd = directory(home, (entry.pw_uid, entry.pw_gid))
    os.close(fd)
    # Only approved managed ancestors receive x-only ACLs. Never traverse-grant
    # outside data_root, and keep the runtime home itself private (0700).
    fd = directory(data_root)
    try:
        _grant_traverse(fd, entry.pw_uid)
        for component in home.relative_to(data_root).parts[:-1]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            _grant_traverse(fd, entry.pw_uid)
    finally:
        os.close(fd)
    return entry

def unit_path(identity):
    return Path('/etc/systemd/system') / (identity + '.service')

def service_action(identity, action):
    if action in ('apply', 'update'):
        run('systemctl', 'daemon-reload')
        run('systemctl', 'enable', identity)
        run('systemctl', 'restart', identity)
    elif action in ('start', 'stop', 'restart'):
        run('systemctl', action, identity)
    if action != 'stop':
        run('systemctl', 'is-active', '--quiet', identity)

def finish(fn):
    try:
        action, manifest = load()
        fn(action, manifest)
    except (OSError, ValueError, RuntimeError, KeyError) as error:
        raise SystemExit(str(error)) from None
