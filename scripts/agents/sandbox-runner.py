"""Install a rootless sandbox broker; never relax user namespace or gVisor failures."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import urllib.request
from common import account, finish, require, run, save, secret, service_action, unit_path
from common import wait_port


def main(action, manifest):
    identity = 'cortex-sandbox-runner'
    if action in ('start', 'stop', 'restart'):
        service_action(identity, action)
        return
    values = secret('sandbox-runner')
    values.setdefault('PODMAN_VERSION', '5.7.0+ds2-3build1')
    values.setdefault('SANDBOX_IMAGE', 'docker.io/library/alpine@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce')
    require(values, 'CORTEX_SANDBOX_API_TOKEN')
    if not re.fullmatch(r'[A-Za-z0-9.+:~_-]+', values['PODMAN_VERSION']):
        raise ValueError('PODMAN_VERSION must be an exact apt version')
    if not re.fullmatch(r'[^\s]+@sha256:[a-f0-9]{64}', values['SANDBOX_IMAGE']):
        raise ValueError('SANDBOX_IMAGE must be immutable')
    home = Path(manifest['data_root']) / 'sandbox-runner'
    from gvisor_install import install as install_gvisor
    binary = install_gvisor(action, manifest)
    if action in ('apply', 'update'):
        run('apt-get', 'install', '-y', '--no-install-recommends', 'podman=' + values['PODMAN_VERSION'], 'uidmap')
        account('cx-sandbox', home, manifest['data_root'])
        # Allocate one free range in both maps; never overwrite existing mappings.
        maps = [Path('/etc/subuid'), Path('/etc/subgid')]
        rows = [p.read_text().splitlines() if p.exists() else [] for p in maps]
        assigned = [[line for line in lines if line.startswith('cx-sandbox:')] for lines in rows]
        if not any(assigned):
            ranges = [(int(parts[1]), int(parts[2])) for lines in rows for line in lines if len(parts := line.split(':')) == 3]
            start = 100000
            while any(start < begin + count and begin < start + 65536 for begin, count in ranges):
                start += 65536
            run('usermod', '--add-subuids', f'{start}-{start + 65535}', '--add-subgids', f'{start}-{start + 65535}', 'cx-sandbox')
        elif not all(assigned):
            raise RuntimeError('Incomplete sandbox subordinate ID mappings')
        runtime_dir = '/run/cortex-sandbox-runner'
        storage_root = home / 'containers'
        runroot = runtime_dir + '/storage'
        effective = dict(values, RUNSC_BIN=str(binary), HOME=str(home), XDG_RUNTIME_DIR=runtime_dir,
                         PODMAN_ROOT=str(storage_root), PODMAN_RUNROOT=runroot)
        env_file = Path('/etc/cortex/secrets/sandbox-runner-runtime.env')
        save(env_file, ''.join(k + '=' + json.dumps(v) + '\n' for k, v in effective.items()))
        # Rootless Podman requires user namespaces and setuid uidmap helpers. Do not use the stricter agent unit.
        unit = f'''[Unit]
Description=Cortex rootless gVisor sandbox broker
After=network-online.target
[Service]
User=cx-sandbox
Group=cx-sandbox
EnvironmentFile={env_file}
WorkingDirectory={home}
RuntimeDirectory=cortex-sandbox-runner
RuntimeDirectoryMode=0700
# The API initializes rootless namespaces in this executor before binding.
ExecStart=/usr/bin/python3 -I {manifest['root']}/scripts/agents/sandbox_api.py
Restart=on-failure
RestartSec=10
UMask=0077
Delegate=yes
DelegateSubgroup=supervisor
ProtectControlGroups=private
MemoryMax=5G
TasksMax=1024
[Install]
WantedBy=multi-user.target
'''
        save(unit_path(identity), unit, 0o644)
    if run('dpkg-query', '-W', '-f=${Version}', 'podman') != values['PODMAN_VERSION']:
        raise RuntimeError('Podman version drifted')
    service_action(identity, action)
    wait_port(8091)
    request = urllib.request.Request('http://127.0.0.1:8091/exec',
        data=json.dumps({'cmd': ['/usr/bin/id', '-u'], 'networkMode': 'none'}).encode(),
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + values['CORTEX_SANDBOX_API_TOKEN']})
    with urllib.request.urlopen(request, timeout=150) as response:
        result = json.load(response)
        if result.get('exitCode') != 0 or result.get('stdout') != '65534\n' or result.get('stats', {}).get('timedOut'):
            raise RuntimeError('Rootless gVisor execution probe failed; no privileged/runtime fallback is allowed')


if __name__ == '__main__':
    finish(main)
