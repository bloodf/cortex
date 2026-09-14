#!/usr/bin/env python3
"""Approved Cortex cold backups and pinned update policy; never deletes source data."""
import argparse
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import pwd
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'installer'))
from manifest import load, selected
from services import read_env, write_private


def run(*argv, capture=False):
    result = subprocess.run([str(a) for a in argv], check=True, text=True,
                            stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.PIPE if capture else None)
    return result.stdout or ''


def service_running(unit):
    return subprocess.run(['systemctl', 'is-active', '--quiet', unit],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def backup(manifest, manifest_path):
    if not manifest['backups']['enabled']:
        raise ValueError('Backups are not enabled in the approved manifest')
    destination = Path(manifest['backups']['destination'])
    data = Path(manifest['data_root'])
    if destination == data or data in destination.parents:
        raise ValueError('Backup destination must be outside data_root')
    # No runtime/user-controlled ancestor may redirect root's archive writes.
    for component in reversed([destination, *destination.parents]):
        if component.is_symlink():
            raise ValueError('Backup path contains a symlink')
        if component.exists():
            state = component.stat()
            if state.st_uid != 0 or state.st_mode & 0o022:
                raise ValueError('Backup path ancestors must be root-owned and not group/world writable')
        else:
            component.mkdir(mode=0o700)
    if destination.stat().st_mode & 0o077:
        raise ValueError('Backup destination must have mode 0700')
    ids = selected(manifest)
    active_containers = []
    for id in ids:
        found = run('docker', 'ps', '--quiet', '--filter', f'label=com.docker.compose.project=cortex-{id}', capture=True)
        active_containers.extend(found.split())
    active_units = run('systemctl', 'list-units', '--type=service', '--state=running', '--no-legend', '--plain', 'cortex-*.service', capture=True)
    units = [line.split()[0] for line in active_units.splitlines() if line.strip()]
    units = [u for u in units if u not in ('cortex-backup.service', 'cortex-update.service')]
    for id, unit in [('caddy', 'caddy.service'), ('tailscale', 'tailscaled.service')]:
        if id in ids and service_running(unit):
            units.append(unit)
    incus_instances = []
    if 'incus' in ids:
        for development in manifest['development']:
            project = 'cortex-dev-' + development['name']
            rows = json.loads(run('incus', 'list', '--project', project, '--format=json', capture=True))
            for row in rows:
                if row['status'] == 'Running':
                    incus_instances.append((project, row['name']))
    incus_units = [unit for unit in ('incus.socket', 'incus.service') if 'incus' in ids and service_running(unit)]
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    archive = destination / ('cortex-' + stamp + '.tar.gz')
    partial = archive.with_suffix('.partial')
    receipt = destination / ('cortex-' + stamp + '.json')
    stopped_units, stopped_containers, stopped_instances, stopped_incus = [], [], [], []
    try:
        for unit in units:
            run('systemctl', 'stop', unit)
            stopped_units.append(unit)
        for project, instance in incus_instances:
            run('incus', 'stop', instance, '--project', project, '--timeout=120')
            stopped_instances.append((project, instance))
        for container in active_containers:
            run('docker', 'stop', '--time=120', container)
            stopped_containers.append(container)
        for unit in incus_units:
            run('systemctl', 'stop', unit)
            stopped_incus.append(unit)
        paths = [data, Path('/etc/cortex')]
        if 'incus' in ids:
            paths.append(Path('/var/lib/incus'))
        if 'tailscale' in ids:
            paths.append(Path('/var/lib/tailscale'))
        if 'caddy' in ids:
            paths.extend([Path('/etc/caddy'), Path('/var/lib/caddy')])
        # GNU tar preserves xattrs, ACLs, sparse allocation and numeric ownership.
        # A changed/unreadable file makes tar nonzero and the backup is not promoted.
        run('tar', '--create', '--gzip', '--file', partial, '--acls', '--xattrs', '--sparse',
            '--numeric-owner', *[str(p) for p in paths if p.exists()])
        os.chmod(partial, 0o600)
        # Stream every member before marking the archive usable; this checks gzip CRC too.
        with tarfile.open(partial, 'r|gz') as check:
            for member in check:
                if member.isfile():
                    stream = check.extractfile(member)
                    while stream.read(1024 * 1024):
                        pass
        os.replace(partial, archive)
        identities = [
            {'name': account.pw_name, 'uid': account.pw_uid, 'gid': account.pw_gid}
            for account in pwd.getpwall()
            if account.pw_name == manifest['admin_user']
            or account.pw_name.startswith(('cortex', 'cx-'))
        ]
        write_private(receipt, json.dumps({'schema_version': 1, 'archive': str(archive),
            'created_utc': stamp, 'manifest': str(manifest_path), 'services': ids,
            'paths': [str(p) for p in paths], 'identities': identities,
            'state': 'verified-cold-archive'}, indent=2) + '\n')
        print(str(archive))
    finally:
        # Restart only objects that were running before this backup.
        failures = []
        for unit in reversed(stopped_incus):
            try:
                run('systemctl', 'start', unit)
            except subprocess.CalledProcessError:
                failures.append(unit)
        for container in reversed(stopped_containers):
            try:
                run('docker', 'start', container)
            except subprocess.CalledProcessError:
                failures.append(container)
        for project, instance in stopped_instances:
            try:
                run('incus', 'start', instance, '--project', project)
            except subprocess.CalledProcessError:
                failures.append(project + '/' + instance)
        for unit in reversed(stopped_units):
            try:
                run('systemctl', 'start', unit)
            except subprocess.CalledProcessError:
                failures.append(unit)
        if failures:
            raise RuntimeError('Backup resume failed for: ' + ', '.join(failures))


def install_policy(manifest, manifest_path):
    root = manifest['root']
    for name, enabled, schedule, action in [
            ('backup', manifest['backups']['enabled'], 'daily', 'backup'),
            ('update', manifest['updates']['automatic'], 'weekly', 'update')]:
        service = Path('/etc/systemd/system') / f'cortex-{name}.service'
        timer = Path('/etc/systemd/system') / f'cortex-{name}.timer'
        if not enabled:
            if timer.exists():
                run('systemctl', 'disable', '--now', timer.name)
            continue
        # Paths validated by installer; systemd argument quoting preserves spaces.
        command = json.dumps(str(Path(root) / 'scripts/operations.py'))
        manifest_arg = json.dumps(str(manifest_path))
        service.write_text('[Unit]\nDescription=Cortex ' + name + '\nAfter=docker.service\n'
            '[Service]\nType=oneshot\nUser=root\nUMask=0077\n'
            f'ExecStart=/usr/bin/python3 {command} {action} --manifest {manifest_arg} --approved\n'
            'TimeoutStartSec=infinity\n')
        timer.write_text('[Unit]\nDescription=Cortex ' + name + ' schedule\n[Timer]\n'
            f'OnCalendar={schedule}\nPersistent=true\nRandomizedDelaySec=30m\n'
            '[Install]\nWantedBy=timers.target\n')
        run('systemctl', 'daemon-reload')
        run('systemctl', 'enable', '--now', timer.name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['install-policy', 'backup', 'update'])
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--approved', action='store_true')
    args = parser.parse_args()
    if os.geteuid() or not args.approved:
        raise ValueError('Operations require root and --approved')
    os.umask(0o077)
    if not Path('/etc/cortex/ownership.json').is_file():
        raise ValueError('No Cortex ownership marker')
    manifest = load(Path(args.manifest))
    from provision import ownership, secure_file
    owner = Path('/etc/cortex/ownership.json')
    secure_file(owner)
    if json.loads(owner.read_text()) != ownership(manifest):
        raise ValueError('Manifest does not own this Cortex installation')
    if args.action == 'install-policy':
        install_policy(manifest, Path(args.manifest).resolve())
        return
    with Path('/etc/cortex/operations.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.action == 'backup':
            with Path('/etc/cortex/services.lock').open('a') as services_lock:
                fcntl.flock(services_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                backup(manifest, args.manifest)
        else:
            if manifest['backups']['enabled']:
                with Path('/etc/cortex/services.lock').open('a') as services_lock:
                    fcntl.flock(services_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    backup(manifest, args.manifest)
            run('python3', ROOT / 'installer/services.py', 'update', '--manifest', args.manifest, '--approved')
            run('python3', ROOT / 'installer/services.py', 'verify', '--manifest', args.manifest)

if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print(f'Cortex operations failed: {error}', file=sys.stderr)
        raise SystemExit(1)
