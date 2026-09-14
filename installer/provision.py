"""Fail-closed, resumable fresh-host operations. Never invoked by plan/validate."""
import fcntl
import hashlib
import json
import os
import pwd
import secrets
import shutil
import socket
import stat
import subprocess
import time
import urllib.request
from pathlib import Path

from manifest import SOURCE, Invalid, require, selected, catalog
from main import canonical, private_write, source_files

STATE = Path('/etc/cortex')
SECRETS = STATE / 'secrets'


def run(argv, *, env=None, cwd=None, input=None, capture=False, label=None):
    import selectors
    base_env = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                'HOME': '/root', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8'}
    process = subprocess.Popen([str(a) for a in argv], cwd=cwd, env=env or base_env,
                               stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    tail, output = bytearray(), bytearray()
    try:
        if input is not None:
            process.stdin.write(input.encode())
            process.stdin.close()
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ, 'stdout')
            selector.register(process.stderr, selectors.EVENT_READ, 'stderr')
            while selector.get_map():
                for key, _ in selector.select():
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        key.fileobj.close()
                        continue
                    tail.extend(chunk)
                    del tail[:-262144]
                    if capture and key.data == 'stdout':
                        output.extend(chunk)
                        del output[:-1048576]
        code = process.wait()
    except BaseException:
        import signal
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
        raise
    if code:
        diagnostic = STATE / 'last-failure.log'
        private_write(diagnostic, tail.decode(errors='ignore'))
        raise Invalid(f"operation failed: {label or Path(str(argv[0])).name} (exit {code}); bounded private diagnostic: {diagnostic}. Inspect locally; never paste raw contents.")
    return output.decode(errors='replace') if capture else None


def secure_file(p):
    require(p.is_file() and not p.is_symlink(), 'expected protected regular file')
    s = p.stat()
    require(s.st_uid == 0 and stat.S_IMODE(s.st_mode) == 0o600 and s.st_nlink == 1, 'state and secret files must be root-owned mode 0600 with one link')


def environment(p):
    secure_file(p)
    result = {}
    for line in p.read_text().splitlines():
        if not line or line.startswith('#'):
            continue
        key, sep, value = line.partition('=')
        require(sep and key.replace('_', '').isalnum() and '\x00' not in value, 'invalid protected environment file')
        result[key] = value
    return result


def check_platform(m):
    require(os.geteuid() == 0, 'apply and verify require root on the target server')
    release = dict(line.split('=', 1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
    require(release.get('ID', '').strip('"') == 'ubuntu' and release.get('VERSION_ID', '').strip('"') == '26.04', 'only fresh Ubuntu 26.04 LTS is supported')
    require(Path('/run/systemd/system').is_dir(), 'systemd must be PID 1 on the target')
    require(not Path('/opt/cortexos').exists(), 'existing predecessor deployment detected; migration is not supported')
    try:
        account = pwd.getpwnam(m['admin_user'])
    except KeyError:
        raise Invalid('admin_user must already exist; create a human account with a local password before installation') from None
    require(account.pw_uid >= 1000 and account.pw_shell not in {'/usr/sbin/nologin', '/bin/false'}, 'admin_user must be a human login')
    status = run(['passwd', '-S', m['admin_user']], capture=True, label='checking local PAM password').split()
    require(len(status) > 1 and status[1] == 'P', 'admin_user requires an unlocked local password; set it directly using passwd, never in chat')


def ownership(m):
    return {'schema_version': 1, 'root': m['root'], 'manifest_sha256': hashlib.sha256(canonical(m)).hexdigest()}


def build_identity():
    import grp
    account = pwd.getpwnam('cortex')
    require(0 < account.pw_uid < 1000 and account.pw_shell == '/usr/sbin/nologin'
            and account.pw_dir == '/var/cache/cortex-build'
            and grp.getgrgid(account.pw_gid).gr_name == 'cortex'
            and not any(g.gr_name != 'cortex' and 'cortex' in g.gr_mem for g in grp.getgrall()),
            'build account has unexpected identity or supplementary privileges')
    return account


def check_build_resources():
    memory = {}
    for line in Path('/proc/meminfo').read_text().splitlines():
        key, _, value = line.partition(':')
        memory[key] = int(value.split()[0])
    capacity = memory.get('MemTotal', 0) + memory.get('SwapTotal', 0)
    available = memory.get('MemAvailable', 0) + memory.get('SwapFree', 0)
    require(capacity >= 15 * 1024 * 1024 and available >= 12 * 1024 * 1024,
            'dashboard build requires a 16 GiB-class RAM/swap allocation (at least 15 GiB reported total and 12 GiB currently available). An 8 GiB guest OOM-killed the real build; increase capacity or free memory before retrying. No swap is created automatically.')


def preflight(m):
    check_platform(m)
    check_build_resources()
    for p in (STATE, SECRETS):
        require(not p.is_symlink(), 'private state directory is a symlink')
        if p.exists():
            require(p.stat().st_uid == 0 and not p.stat().st_mode & 0o022, 'private state directory must be root-owned and not writable by others')
    marker = STATE / 'ownership.json'
    build_uid = None
    if marker.exists():
        secure_file(marker)
        require(json.loads(marker.read_text()) == ownership(m), 'existing Cortex installation belongs to another manifest')
        try:
            build_uid = build_identity().pw_uid
        except KeyError:
            pass
    cache = Path('/var/cache/cortex-build')
    require(not cache.is_symlink(), 'build cache must not be a symlink')
    for directory in (Path(m['root']), Path(m['data_root'])):
        require(not directory.is_relative_to(cache) and not cache.is_relative_to(directory), 'build cache must not overlap application or persistent data')
    for directory in (Path(m['root']), Path(m['data_root'])):
        for ancestor in (directory, *directory.parents):
            require(not ancestor.is_symlink(), 'installation path contains a symlink')
            if ancestor.exists():
                recoverable_root = ancestor == Path(m['root']) and build_uid is not None and ancestor.stat().st_uid in {0, build_uid}
                require(ancestor.is_dir() and (recoverable_root or (ancestor.stat().st_uid == 0 and not ancestor.stat().st_mode & 0o022)),
                        'installation path ownership is unsafe and not attributable to this owned interrupted build')
    rows = catalog()
    permitted = {name + '.env': set(rows[name].get('secret_keys', [])) for name in selected(m)}
    agent_files = {'agent-' + agent['name'] + '.env': agent for agent in m['agents']}
    development_files = {'development-' + development['name'] + '.env' for development in m['development']}
    marker = STATE / 'ownership.json'
    if SECRETS.exists():
        for entry in SECRETS.iterdir():
            secure_file(entry)
            if not marker.exists():
                require((entry.name in permitted or entry.name in agent_files or entry.name in development_files)
                        and entry.name not in {'postgresql.env', 'dashboard.env'},
                        'only declared service, agent or development credential files may precede fresh installation')
                values = environment(entry)
                if entry.name in agent_files:
                    import re
                    require(all(re.fullmatch(r'[A-Z][A-Z0-9_]*', key) for key in values), 'agent credential keys must be uppercase environment names')
                    agent = agent_files[entry.name]
                    for channel in ('telegram', 'whatsapp'):
                        require(channel in agent['channels'] or not any(key.startswith(channel.upper() + '_') for key in values),
                                'agent credential file enables an unselected channel')
                elif entry.name in development_files:
                    require(set(values) <= {'SSH_PUBLIC_KEY', 'EXTRA_PACKAGES'}, 'development file contains undeclared keys')
                else:
                    import re
                    patterns = rows[entry.stem].get('secret_key_patterns', [])
                    require(all(key in permitted[entry.name] or any(re.fullmatch(pattern, key) for pattern in patterns)
                                for key in values), 'credential file contains undeclared keys')
    marker = STATE / 'ownership.json'
    if marker.exists():
        secure_file(marker)
        require(json.loads(marker.read_text()) == ownership(m), 'existing Cortex installation belongs to another manifest; update/migration is not an install rerun')
        return
    require(not any(account.pw_name == 'cortex' for account in pwd.getpwall()), 'pre-existing cortex account conflicts with fresh installation')
    require(not cache.exists() or (cache.is_dir() and not any(cache.iterdir())), 'pre-existing build cache conflicts with fresh installation')
    for directory in (Path(m['root']), Path(m['data_root'])):
        require(not directory.exists() or (directory.is_dir() and not any(directory.iterdir())), 'installation requires empty dedicated root and data directories')
    for unit in ('cortex-dashboard.service', 'cortex-terminal.service', 'cortexos-dashboard.service', 'postgresql.service'):
        result = subprocess.run(['systemctl', 'show', unit, '--property=LoadState', '--value'], text=True, capture_output=True)
        require(result.stdout.strip() in {'not-found', ''}, 'existing dashboard or database unit conflicts with fresh install')
    if shutil.which('docker'):
        result = subprocess.run(['docker', 'ps', '-aq'], text=True, capture_output=True)
        require(result.returncode == 0 and not result.stdout.strip(), 'Docker must be reachable and have no pre-existing containers')
    from manifest import agent_ports
    host_ports = [port for name in selected(m) for port in rows[name].get('ports', [])]
    host_ports.extend(allocation['port'] for allocation in agent_ports(m))
    for port in host_ports:
        for family, address in ((socket.AF_INET, '0.0.0.0'), (socket.AF_INET6, '::')):
            try:
                with socket.socket(family) as sock:
                    if family == socket.AF_INET6:
                        sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
                    sock.bind((address, port))
            except OSError as exc:
                if family == socket.AF_INET6 and exc.errno in {97, 99}:
                    continue
                raise Invalid(f'required port {port} is already occupied or unavailable') from None
    require(not Path('/etc/pam.d/cortexos-dashboard').exists(), 'existing PAM service conflicts with fresh installation')


def credentials(m):
    SECRETS.mkdir(mode=0o700, exist_ok=True)
    os.chmod(SECRETS, 0o700)
    pg = SECRETS / 'postgresql.env'
    if not pg.exists():
        private_write(pg, 'POSTGRES_USER=cortex\nPOSTGRES_DB=cortex\nPOSTGRES_PASSWORD=' + secrets.token_hex(32) + '\n')
    owner = environment(pg)
    require(owner.get('POSTGRES_USER') == 'cortex' and owner.get('POSTGRES_DB') == 'cortex', 'unexpected owned PostgreSQL configuration')
    dash = SECRETS / 'dashboard.env'
    if not dash.exists():
        values = {'DB_HOST': '127.0.0.1', 'DB_PORT': '5432', 'DB_NAME': 'cortex', 'DB_USER': 'dashboard',
                  'DB_PASSWORD': secrets.token_hex(32), 'CORTEX_MASTER_KEY': secrets.token_hex(32),
                  'CORTEX_ROOT': m['root'], 'CORTEX_SECRETS_DIR': str(SECRETS), 'CORTEX_DATA_ROOT': m['data_root'],
                  'CORTEX_PUBLIC_URL': m['network']['public_url'], 'CORTEX_ADMIN_USER': m['admin_user'],
                  'CORTEX_HARNESS_HOME': pwd.getpwnam(m['admin_user']).pw_dir,
                  'CORTEX_BACKUP_ROOT': m['backups']['destination'] if m['backups']['enabled'] else str(Path(m['data_root']) / 'backups'),
                  'HOST': '127.0.0.1', 'PORT': '3080', 'NODE_ENV': 'production'}
        private_write(dash, ''.join(f'{k}={v}\n' for k, v in values.items()))
    runtime = environment(dash)
    terminal = {key: runtime[key] for key in ('DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD')}
    terminal.update(TERMINAL_HOST='127.0.0.1', TERMINAL_PORT='3081',
                    TERMINAL_CWD=pwd.getpwnam(m['admin_user']).pw_dir,
                    ALLOWED_ORIGIN=m['network']['public_url'].rstrip('/'), NODE_ENV='production')
    private_write(SECRETS / 'terminal.env', ''.join(f'{key}={value}\n' for key, value in terminal.items()))
    return owner, runtime


def install_source(m):
    root = Path(m['root'])
    root.mkdir(parents=True, exist_ok=True)
    if root == SOURCE:
        return
    for relative in source_files():
        src, dest = SOURCE / relative, root / relative
        require(not dest.is_symlink(), 'installed source contains a symlink conflict')
        for ancestor in dest.parents:
            if ancestor == root:
                break
            require(not ancestor.is_symlink(), 'installed source parent is a symlink')
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not dest.exists() or dest.read_bytes() != src.read_bytes():
            import tempfile
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(dir=dest.parent, prefix='.cortex-source-', delete=False) as stream:
                    temporary = Path(stream.name)
                    stream.write(src.read_bytes())
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, dest)
                parent = os.open(dest.parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(parent)
                finally:
                    os.close(parent)
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
        os.chmod(dest, 0o755 if relative.parts[0] == 'bin' or src.stat().st_mode & 0o111 else 0o644)


def wait_database():
    for _ in range(60):
        result = subprocess.run(['docker', 'exec', 'cortex-postgresql', 'pg_isready', '-U', 'cortex', '-d', 'cortex'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if result.returncode == 0:
            return
        time.sleep(2)
    raise Invalid('PostgreSQL did not become ready within 120 seconds')


def service_cli(m, command, only=None):
    argv = ['python3', Path(m['root']) / 'installer/services.py', command, '--manifest', STATE / 'install.json']
    if command == 'apply':
        argv += ['--approved']
    if only:
        argv += ['--only', only]
    run(argv, label=f'selected service {command}')


def protect_tree(root):
    """Remove write/set-ID privileges before any installed code executes as root."""
    bad_links = False
    for base, dirs, files in os.walk(root, followlinks=False):
        for target in (Path(base), *(Path(base) / name for name in dirs + files)):
            if target.is_symlink():
                bad_links |= not target.resolve().is_relative_to(root)
                os.chown(target, 0, 0, follow_symlinks=False)
                continue
            mode = target.stat().st_mode
            require(stat.S_ISDIR(mode) or stat.S_ISREG(mode), 'build emitted a non-regular application artifact')
            os.chown(target, 0, 0)
            os.chmod(target, 0o755 if stat.S_ISDIR(mode) or mode & 0o111 else 0o644)
    require(not bad_links, 'build emitted a symlink outside the owned application tree')


def recover_owned_build(m):
    """Quiesce only the verified install's build UID before repairing its tree."""
    try:
        account = build_identity()
    except KeyError:
        return
    import signal
    for unit in ('cortex-dashboard.service', 'cortex-terminal.service'):
        if subprocess.run(['systemctl', 'is-active', '--quiet', unit]).returncode == 0:
            run(['systemctl', 'stop', unit])
    for attempt in range(50):
        active = False
        for process in Path('/proc').iterdir():
            if not process.name.isdecimal():
                continue
            descriptor = None
            try:
                descriptor = os.pidfd_open(int(process.name))
                status = dict(line.split(':', 1) for line in (process / 'status').read_text().splitlines() if ':' in line)
                if int(status['Uid'].split()[0]) != account.pw_uid or status['State'].strip().startswith('Z'):
                    continue
                active = True
                signal.pidfd_send_signal(descriptor, signal.SIGKILL)
            except (ProcessLookupError, FileNotFoundError):
                continue
            finally:
                if descriptor is not None:
                    os.close(descriptor)
        if not active:
            break
        time.sleep(0.1)
    else:
        raise Invalid('owned build processes did not quiesce; refusing to repair a live writable tree')
    root = Path(m['root'])
    interrupted = not root.exists()
    for base, dirs, files in os.walk(root, followlinks=False):
        for target in (Path(base), *(Path(base) / name for name in dirs + files)):
            info = target.lstat()
            interrupted |= info.st_uid != 0 or (not stat.S_ISLNK(info.st_mode) and bool(info.st_mode & 0o022))
    if interrupted:
        require(SOURCE != root, 'resume an interrupted writable build using the original reviewed source checkout outside the install root; no manual ownership repair is required')
        suffix = '.interrupted-' + secrets.token_hex(6)
        for directory in (root, Path('/var/cache/cortex-build')):
            if not directory.exists():
                continue
            destination = directory.with_name(directory.name + suffix)
            require(not destination.exists(), 'recovery quarantine path already exists')
            os.chown(directory, 0, 0)
            os.chmod(directory, 0o700)
            directory.rename(destination)
            descriptor = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            print(f'Preserved interrupted build in root-only quarantine: {destination}')
        root.mkdir(mode=0o755)
    else:
        protect_tree(root)


def build_dashboard(m, owner, dash):
    root = Path(m['root'])
    package = json.loads((root / 'package.json').read_text())
    manager = package['packageManager']
    require(manager == 'pnpm@10.12.1', 'review changed package manager version before installing')
    version = run(['node', '--version'], capture=True).strip().lstrip('v')
    require(int(version.split('.')[0]) >= 22, 'Ubuntu Node package must satisfy Node >=22; unsupported package source, stop rather than piping remote scripts')
    prefix = root / '.toolchain'
    pnpm = prefix / 'bin/pnpm'
    if not pnpm.exists() or run([pnpm, '--version'], capture=True).strip() != '10.12.1':
        run(['npm', 'install', '--ignore-scripts', '--global', '--prefix', prefix, manager], label='installing pinned pnpm')
    try:
        pwd.getpwnam('cortex')
    except KeyError:
        run(['useradd', '--system', '--user-group', '--home-dir', '/var/cache/cortex-build', '--create-home', '--shell', '/usr/sbin/nologin', 'cortex'])
    build_identity()
    for unit in ('cortex-dashboard.service', 'cortex-terminal.service'):
        if subprocess.run(['systemctl', 'is-active', '--quiet', unit]).returncode == 0:
            run(['systemctl', 'stop', unit])
    home = Path('/var/cache/cortex-build')
    home.mkdir(parents=True, exist_ok=True)
    run(['chown', '-R', 'cortex:cortex', home])
    env = {'HOME': str(home), 'PATH': str(prefix / 'bin') + ':/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
           'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'NODE_OPTIONS': '--max-old-space-size=8192'}
    try:
        run(['chown', '-R', 'cortex:cortex', root], label='preparing unprivileged build workspace')
        run(['runuser', '-u', 'cortex', '--', pnpm, 'install', '--frozen-lockfile'], cwd=root, env=env, label='installing workspace dependencies')
        run(['runuser', '-u', 'cortex', '--', pnpm, 'build'], cwd=root, env=env, label='building dashboard and shared packages')
    finally:
        protect_tree(root)
    # Passwords generated as hex; SQL goes through stdin, never process arguments/logs.
    password = dash['DB_PASSWORD']
    require(len(password) == 64 and all(c in '0123456789abcdef' for c in password), 'invalid generated database password')
    sql = "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='dashboard') THEN CREATE ROLE dashboard LOGIN; END IF; END $$;\nALTER ROLE dashboard NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '" + password + "';\n"
    run(['docker', 'exec', '-i', 'cortex-postgresql', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'cortex', '-d', 'cortex'], input=sql, label='provisioning non-owner dashboard role')
    migration_env = dict(dash, PATH='/usr/local/bin:/usr/bin:/bin', HOME='/root', LANG='C.UTF-8', LC_ALL='C.UTF-8')
    migration_env.update(DB_USER='cortex', DB_PASSWORD=owner['POSTGRES_PASSWORD'], CORTEX_DB_APP_ROLE='dashboard')
    cwd = root / 'packages/dashboard-next'
    run(['node', 'scripts/migrate-cli.js'], cwd=cwd, env=migration_env, label='running database migrations')
    run(['node', 'scripts/bootstrap-catalog.mjs', '--manifest', STATE / 'resolved-install.json'], cwd=cwd, env=migration_env, label='seeding selected service catalog and grants')


def dashboard_unit(m):
    root = m['root']
    unit = f'''[Unit]
Description=Cortex dashboard and privileged administration
After=network.target docker.service cortex-terminal.service
Requires=docker.service cortex-terminal.service

[Service]
Type=simple
User=root
WorkingDirectory={root}/packages/dashboard-next
EnvironmentFile=/etc/cortex/secrets/dashboard.env
ExecStart=/usr/bin/node {root}/packages/dashboard-next/scripts/server.mjs
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=multi-user.target
'''
    target = Path('/etc/systemd/system/cortex-dashboard.service')
    require(not target.is_symlink(), 'dashboard unit path is a symlink')
    target.write_text(unit)
    os.chmod(target, 0o644)
    terminal = f'''[Unit]
Description=Cortex authenticated terminal sidecar
After=network.target docker.service
Requires=docker.service
PartOf=cortex-dashboard.service

[Service]
Type=simple
User=root
WorkingDirectory={root}/packages/cortex-terminal
EnvironmentFile=/etc/cortex/secrets/terminal.env
ExecStart=/usr/bin/node {root}/packages/cortex-terminal/src/server.js
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=multi-user.target
'''
    terminal_target = Path('/etc/systemd/system/cortex-terminal.service')
    require(not terminal_target.is_symlink(), 'terminal unit path is a symlink')
    terminal_target.write_text(terminal)
    os.chmod(terminal_target, 0o644)
    run(['groupadd', '-f', 'cortexos-admin'])
    run(['usermod', '-aG', 'cortexos-admin', m['admin_user']])
    pam = Path('/etc/pam.d/cortexos-dashboard')
    require(not pam.is_symlink(), 'PAM service path is a symlink')
    pam.write_text('@include common-auth\n@include common-account\n')
    os.chmod(pam, 0o644)
    run(['systemctl', 'daemon-reload'])
    run(['systemctl', 'enable', '--now', 'cortex-terminal.service'])
    run(['systemctl', 'enable', '--now', 'cortex-dashboard.service'])
    run(['systemctl', 'restart', 'cortex-dashboard.service'])


def apply(m, manifest_path, plan):
    preflight(m)
    STATE.mkdir(mode=0o700, exist_ok=True)
    lockpath = STATE / 'install.lock'
    fd = os.open(lockpath, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Invalid('another Cortex installer owns the installation lock') from None
        preflight(m)
        private_write(STATE / 'ownership.json', json.dumps(ownership(m)) + '\n')
        private_write(STATE / 'install.json', json.dumps(m, indent=2) + '\n')
        private_write(STATE / 'resolved-install.json', json.dumps(dict(m, services=selected(m)), indent=2) + '\n')
        Path(m['data_root']).mkdir(mode=0o750, parents=True, exist_ok=True)
        recover_owned_build(m)
        install_source(m)
        print('Installing approved base prerequisites; command output is suppressed to protect credentials.')
        env = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root',
               'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'DEBIAN_FRONTEND': 'noninteractive'}
        run(['apt-get', 'update'], env=env)
        run(['apt-get', 'install', '-y', '--no-install-recommends', 'ca-certificates', 'curl', 'git', 'build-essential', 'libpam0g-dev', 'python3', 'python3-venv', 'nodejs', 'npm', 'docker.io', 'docker-compose-v2', 'tzdata'], env=env, label='installing Ubuntu prerequisites')
        run(['systemctl', 'enable', '--now', 'docker.service'])
        run(['hostnamectl', 'set-hostname', m['hostname']])
        run(['timedatectl', 'set-timezone', m['timezone']])
        owner, dash = credentials(m)
        service_cli(m, 'apply', 'postgresql')
        wait_database()
        build_dashboard(m, owner, dash)
        dashboard_unit(m)
        service_cli(m, 'apply')
        verify(m)


def verify(m):
    check_platform(m)
    secure_file(STATE / 'ownership.json')
    require(json.loads((STATE / 'ownership.json').read_text()) == ownership(m), 'manifest does not own this installation')
    secure_file(STATE / 'install.json')
    require(json.loads((STATE / 'install.json').read_text()) == m, 'installed manifest differs')
    environment(SECRETS / 'dashboard.env')
    environment(SECRETS / 'postgresql.env')
    environment(SECRETS / 'terminal.env')
    require(Path(m['root'], 'packages/dashboard-next/scripts/server.mjs').is_file(), 'dashboard proxy entrypoint is missing')
    run(['systemctl', 'is-active', '--quiet', 'cortex-terminal.service'])
    require(Path(m['root'], 'packages/dashboard-next/.output/server/index.mjs').is_file(), 'dashboard build artifact is missing')
    run(['systemctl', 'is-active', '--quiet', 'cortex-dashboard.service'])
    wait_database()
    for attempt in range(30):
        try:
            with urllib.request.urlopen('http://127.0.0.1:3080/', timeout=5) as response:
                require(response.status == 200, 'dashboard root did not return HTTP 200')
            break
        except (OSError, Invalid):
            if attempt == 29:
                raise Invalid('dashboard did not serve its login surface within the readiness window') from None
            time.sleep(2)
    for attempt in range(30):
        try:
            with urllib.request.urlopen('http://127.0.0.1:3081/healthz', timeout=5) as response:
                require(response.status == 200, 'terminal health endpoint failed')
            break
        except (OSError, Invalid):
            if attempt == 29:
                raise Invalid('terminal sidecar did not become ready') from None
            time.sleep(2)
    import http.client
    for origin, expected in ((m['network']['public_url'].rstrip('/'), 401), ('https://invalid.example', 403)):
        connection = http.client.HTTPConnection('127.0.0.1', 3080, timeout=5)
        try:
            connection.request('GET', '/terminal/ws', headers={
                'Connection': 'Upgrade', 'Upgrade': 'websocket', 'Sec-WebSocket-Version': '13',
                'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Origin': origin})
            require(connection.getresponse().status == expected, 'terminal proxy failed unauthenticated/origin rejection verification')
        finally:
            connection.close()
    service_cli(m, 'verify')
    print('Verified: private state, PostgreSQL readiness, dashboard/terminal units and HTTP, same-origin terminal proxy rejects missing sessions and cross-origin upgrades, selected services. Authenticate with your Linux account and exercise the real PTY and integrations; readiness/rejection checks are not authenticated end-to-end proof.')
