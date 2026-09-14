"""Restricted Incus projects and NAT-enabled development environments."""
import json
import os
from pathlib import Path
import re
import subprocess
import time
from common import BASE_ENV, directory, finish, name, require, run, save, secret

RESTRICTIONS = {'restricted': 'true', 'restricted.containers.privilege': 'unprivileged',
                'restricted.containers.nesting': 'block', 'restricted.containers.lowlevel': 'block',
                'restricted.virtual-machines.lowlevel': 'block', 'restricted.devices.disk': 'managed',
                'restricted.devices.nic': 'block', 'restricted.devices.proxy': 'block',
                'restricted.devices.unix-char': 'block', 'restricted.devices.unix-block': 'block',
                'restricted.devices.gpu': 'block', 'restricted.devices.pci': 'block',
                'restricted.devices.usb': 'block', 'features.profiles': 'true',
                'features.images': 'true', 'features.storage.volumes': 'true'}
DEVELOPMENT_RESTRICTIONS = dict(RESTRICTIONS, **{
    'restricted.devices.nic': 'managed', 'restricted.networks.access': 'cortexdev0',
    'features.networks': 'false'})


def query(path):
    return json.loads(run('incus', 'query', path))


def project(project_name, action, restrictions=RESTRICTIONS):
    existing = query('/1.0/projects?recursion=1')
    matching = [item for item in existing if item['name'] == project_name]
    if not matching:
        if action not in ('apply', 'update'):
            raise RuntimeError('Missing restricted Incus project ' + project_name)
        args = ['incus', 'project', 'create', project_name, '-c', 'user.cortex.managed=true']
        for key, value in restrictions.items():
            args += ['-c', key + '=' + value]
        run(*args)
    else:
        cfg = matching[0]['config']
        if cfg.get('user.cortex.managed') != 'true':
            raise RuntimeError('Refusing to adopt an existing unmanaged Incus project')
        if any(cfg.get(k) != v for k, v in restrictions.items()):
            raise RuntimeError('Incus project restrictions drifted; refusing unsafe reconciliation')


def main(action, manifest):
    values = {'INCUS_VERSION': '6.0.5-8'}
    if not re.fullmatch('[A-Za-z0-9.+:~_-]+', values['INCUS_VERSION']):
        raise ValueError('INCUS_VERSION must be an exact apt version')
    if action in ('apply', 'update'):
        vm_requested = any(item['kind'] == 'vm' for item in manifest.get('development', []))
        vm_packages = ['ovmf=2025.11-3ubuntu7', 'qemu-system-x86=1:10.2.1+ds-1ubuntu3.2',
                       'qemu-utils=1:10.2.1+ds-1ubuntu3.2',
                       'qemu-system-modules-spice=1:10.2.1+ds-1ubuntu3.2'] if vm_requested else []
        run('apt-get', 'install', '-y', '--no-install-recommends', 'incus=' + values['INCUS_VERSION'],
            'incus-client=' + values['INCUS_VERSION'], 'dnsmasq-base', 'kmod', *vm_packages)
        run('modprobe', 'br_netfilter')
        save('/etc/modules-load.d/cortex-incus.conf', 'br_netfilter\n', 0o644)
        mapping_rows = [Path(path).read_text().splitlines() if Path(path).exists() else []
                        for path in ('/etc/subuid', '/etc/subgid')]
        mappings = [[line.split(':') for line in rows if line and not line.startswith('#')] for rows in mapping_rows]
        if not all(any(parts[0] == 'root' and int(parts[2]) >= 10000000 for parts in rows) for rows in mappings):
            start = max([1000000] + [int(parts[1]) + int(parts[2]) for rows in mappings for parts in rows])
            if start + 10000000 >= 4294967295:
                raise RuntimeError('No safe contiguous subordinate ID range remains for Incus')
            run('usermod', '--add-subuids', f'{start}-{start + 9999999}',
                '--add-subgids', f'{start}-{start + 9999999}', 'root')
        run('systemctl', 'enable', '--now', 'incus')
        if vm_requested and 'qemu' not in query('/1.0')['environment']['driver'].replace('|', ' ').split():
            # A running daemon may have cached unavailable VM support before firmware installation.
            run('systemctl', 'restart', 'incus')
        pools = query('/1.0/storage-pools?recursion=1')
        found = [p for p in pools if p['name'] == 'cortex']
        source = str(Path(manifest['data_root']) / 'incus-pool')
        if not found:
            source_fd = directory(source)
            os.close(source_fd)
            run('incus', 'storage', 'create', 'cortex', 'dir', 'source=' + source, 'user.cortex.managed=true')
        elif found[0]['driver'] != 'dir' or found[0]['config'].get('source') != source:
            raise RuntimeError('Existing cortex storage pool does not match requested directory')
    elif action in ('start', 'stop', 'restart'):
        run('systemctl', action, 'incus')
        return
    installed = run('dpkg-query', '-W', '-f=${Version}', 'incus')
    if installed != values['INCUS_VERSION']:
        raise RuntimeError('Incus package version differs from operator pin')
    if query('/1.0').get('config', {}).get('core.https_address'):
        raise RuntimeError('Incus network API must remain disabled; use the local root-owned socket')
    project('cortex-development', action)
    project('cortex-agents', action)


def development(action, manifest, spec):
    instance = name(spec['name'])
    project_name = 'cortex-dev-' + instance
    kind = spec['kind']
    if kind not in ('vm', 'container'):
        raise ValueError('Development kind must be vm or container')
    from development_image import resolve
    image, fingerprint = resolve(instance, kind, spec['image'], action)
    if kind == 'vm' and not Path('/dev/kvm').exists():
        raise RuntimeError('VM development requires /dev/kvm on the target host')
    project(project_name, action, DEVELOPMENT_RESTRICTIONS)
    if action in ('apply', 'update'):
        images = query('/1.0/images?recursion=1&project=' + project_name)
        if not any(item.get('fingerprint') == fingerprint for item in images):
            run('incus', 'image', 'copy', image, 'local:', '--project', 'default', '--target-project', project_name)
    rows = query('/1.0/instances?recursion=1&project=' + project_name)
    found = [row for row in rows if row['name'] == instance]
    if not found:
        if action not in ('apply', 'update'):
            raise RuntimeError('Development instance is not installed')
        args = ['incus', 'init', fingerprint, instance, '--project', project_name, '--no-profiles',
                '--storage', 'cortex', '-c', 'user.cortex.managed=true', '-c', 'user.cortex.image=' + image,
                '-c', 'limits.cpu=2', '-c', 'limits.memory=4GiB', '-c', 'boot.autostart=true',
                '--network', 'cortexdev0']
        if kind == 'vm':
            args += ['--vm']
        else:
            args += ['-c', 'security.privileged=false', '-c', 'security.nesting=false']
        run(*args)
        run('incus', 'config', 'device', 'set', instance, 'eth0',
            'security.mac_filtering=true', 'security.ipv4_filtering=true', 'security.ipv6_filtering=true',
            '--project', project_name)
        found = query('/1.0/instances?recursion=1&project=' + project_name)
    row = found[0]
    cfg = row['expanded_config']
    if (cfg.get('user.cortex.managed') != 'true' or cfg.get('user.cortex.image') != image
            or cfg.get('volatile.base_image') != fingerprint):
        raise RuntimeError('Instance ownership/image drift; export and explicitly replace it instead of destroying data')
    if row['type'] != ('virtual-machine' if kind == 'vm' else 'container'):
        raise RuntimeError('Instance kind differs from manifest; no destructive conversion is performed')
    if cfg.get('security.privileged', 'false') != 'false' or cfg.get('security.nesting', 'false') != 'false':
        raise RuntimeError('Unsafe development container security configuration')
    devices = row['expanded_devices']
    if len(devices) != 2 or not any(d.get('type') == 'disk' and d.get('path') == '/' and d.get('pool') == 'cortex'
                                    for d in devices.values()):
        raise RuntimeError('Unexpected development root disk or host attachment')
    nic = devices.get('eth0', {})
    if nic.get('type') != 'nic' or nic.get('network') != 'cortexdev0' or any(
            nic.get(k) != 'true' for k in ('security.mac_filtering', 'security.ipv4_filtering', 'security.ipv6_filtering')):
        raise RuntimeError('Development NIC/network anti-spoof policy drift')
    if nic.get('ipv6.address'):
        raise RuntimeError('Development NIC must not override the bridge-disabled IPv6 configuration')
    if action == 'stop':
        if row['status'] == 'Running':
            run('incus', 'stop', instance, '--project', project_name, '--timeout', '60')
        return
    if action == 'restart' and row['status'] == 'Running':
        run('incus', 'restart', instance, '--project', project_name, '--timeout', '60')
    if action in ('apply', 'update', 'start', 'restart') and row['status'] != 'Running':
        run('incus', 'start', instance, '--project', project_name)
    current = query('/1.0/instances/' + instance + '/state?project=' + project_name)
    if current['status'] != 'Running':
        raise RuntimeError('Development instance is not running')
    # Guest exec proves guest readiness, not just a hypervisor process. Image must supply /bin/true and incus-agent for VMs.
    command = ['incus', 'exec', instance, '--project', project_name, '--', '/bin/true']
    if kind == 'vm':
        deadline = time.monotonic() + 180
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError('Incus VM agent did not become ready within 180 seconds')
            result = subprocess.run(command, capture_output=True, text=True, env=BASE_ENV, timeout=min(30, remaining))
            if result.returncode == 0:
                break
            if result.returncode != 255 or result.stderr.strip() != "Error: VM agent isn't currently running":
                raise RuntimeError('Incus VM guest readiness command failed (exit ' + str(result.returncode) + ')')
            time.sleep(min(1, max(0, deadline - time.monotonic())))
    else:
        run(*command)
    if action in ('apply', 'update'):
        from development_tools import provision
        provision(instance, project_name)
    from development_verify import verify
    verify(instance, project_name, manifest)


if __name__ == '__main__':
    finish(main)
