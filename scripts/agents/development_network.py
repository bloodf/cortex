"""Cortex-owned development NAT only; never adopts or rewrites a pre-existing host bridge."""
import ipaddress
import json
from pathlib import Path
from common import finish, run, save
from firewall import PRIVATE4

BRIDGE = 'cortexdev0'


def apply(manifest):
    run('apt-get', 'install', '-y', '--no-install-recommends', 'nftables')
    networks = json.loads(run('incus', 'query', '/1.0/networks?recursion=1'))
    existing = next((network for network in networks if network['name'] == BRIDGE), None)
    if existing and (not existing.get('managed') or existing['config'].get('user.cortex.managed') != 'true'):
        raise RuntimeError('Refusing to adopt or rewrite an existing host development bridge')
    blocked = set(PRIVATE4)
    ids = run('docker', 'network', 'ls', '--filter', 'driver=bridge', '--format', '{{.ID}}').splitlines()
    if ids:
        for network in json.loads(run('docker', 'network', 'inspect', *ids)):
            for config in network.get('IPAM', {}).get('Config', []):
                subnet = config.get('Subnet')
                if subnet and ipaddress.ip_network(subnet).version == 4:
                    blocked.add(subnet)
    ranges = ', '.join(str(net) for net in ipaddress.collapse_addresses(ipaddress.ip_network(value) for value in blocked))
    policy = '''destroy table inet cortex_development
destroy table bridge cortex_development_l2
table inet cortex_development {
 chain input { type filter hook input priority -20; policy accept;
  iifname "cortexdev0" ct state established,related accept
  iifname "cortexdev0" udp dport { 53, 67 } accept
  iifname "cortexdev0" tcp dport 53 accept
  iifname "cortexdev0" counter reject with icmpx type admin-prohibited
 }
 chain forward { type filter hook forward priority -20; policy accept;
  iifname "cortexdev0" ip daddr { @RANGES@ } counter reject with icmpx type admin-prohibited
  oifname "cortexdev0" ct state established,related accept
  oifname "cortexdev0" drop
  iifname "cortexdev0" meta nfproto ipv6 drop
 }
}
table bridge cortex_development_l2 {
 chain forward { type filter hook forward priority -20; policy accept;
  meta ibrname "cortexdev0" counter drop
 }
}
'''.replace('@RANGES@', ranges)
    save('/etc/cortex/development.nft', policy)
    save('/etc/systemd/system/cortex-development-firewall.service', '''[Unit]
Description=Cortex development network boundary
Before=incus.service
[Service]
Type=oneshot
ExecStart=/usr/sbin/nft -f /etc/cortex/development.nft
ExecReload=/usr/sbin/nft -f /etc/cortex/development.nft
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
''', 0o644)
    run('systemctl', 'daemon-reload')
    run('systemctl', 'enable', 'cortex-development-firewall.service')
    state = run('systemctl', 'show', '-p', 'ActiveState', '--value', 'cortex-development-firewall.service')
    run('systemctl', 'reload' if state == 'active' else 'start', 'cortex-development-firewall.service')
    if existing is None:
        run('incus', 'network', 'create', BRIDGE, 'user.cortex.managed=true', 'ipv4.address=auto',
            'ipv4.nat=true', 'ipv6.address=none', 'dns.mode=managed')
    elif existing['config'].get('ipv4.nat') != 'true' or existing['config'].get('ipv6.address') != 'none':
        raise RuntimeError('Managed development bridge NAT/IPv6 configuration drifted')
    # Docker's iptables FORWARD policy may otherwise drop non-Docker NAT traffic.
    # Earlier nftables chains retain private/host/L2 rejection even with these accepts.
    save('/etc/systemd/system/cortex-development-forward.service',
         '[Unit]\nDescription=Cortex development Docker coexistence\n'
         'After=docker.service incus.service cortex-development-firewall.service\n'
         'PartOf=docker.service incus.service\nRequires=cortex-development-firewall.service\n'
         '[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/usr/bin/python3 ' +
         str(Path(manifest['root']) / 'scripts/agents/development_forward.py') +
         '\n[Install]\nWantedBy=multi-user.target docker.service incus.service\n', 0o644)
    save('/etc/systemd/system/incus.service.d/cortex-development.conf',
         '[Unit]\nRequires=cortex-development-firewall.service\nAfter=cortex-development-firewall.service\n', 0o644)
    run('systemctl', 'daemon-reload')
    run('systemctl', 'enable', 'cortex-development-forward.service')
    run('systemctl', 'restart', 'cortex-development-forward.service')


def dispatch(action, manifest):
    if action in ('apply', 'update', 'start', 'restart'):
        apply(manifest)
    elif action == 'verify':
        run('nft', 'list', 'table', 'inet', 'cortex_development')
        run('nft', 'list', 'table', 'bridge', 'cortex_development_l2')
    else:
        raise RuntimeError('Development firewall is not disabled while guests exist')


if __name__ == '__main__':
    finish(dispatch)
