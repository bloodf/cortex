"""Per-UID nftables output policy. Docker isolation alone is not an agent boundary."""
import ipaddress
import json
from pathlib import Path
import socket
import urllib.error
import urllib.request
from urllib.parse import urlparse
from common import account, name, run, save, secret

PRIVATE4 = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/4']
PRIVATE6 = ['::/128', '::1/128', 'fc00::/7', 'fe80::/10', 'ff00::/8']


def gateway_access(values, model):
    token = values.get('OPENAI_API_KEY')
    if not token:
        raise ValueError('Local DurinDoor inference requires its issued OPENAI_API_KEY')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    payload = json.dumps({'model': model, 'messages': [{'role': 'user', 'content': 'Reply OK.'}],
                          'max_tokens': 16, 'stream': False}).encode()
    endpoint = 'http://127.0.0.1:20128/v1/chat/completions'
    request = urllib.request.Request(endpoint, data=payload, headers={'Content-Type': 'application/json'})
    try:
        with opener.open(request, timeout=120):
            raise RuntimeError('DurinDoor permits unauthenticated inference; refusing private-network exception')
    except urllib.error.HTTPError as error:
        if error.code not in (401, 403):
            raise RuntimeError('DurinDoor unauthenticated inference denial was not proven') from None
    request.add_header('Authorization', 'Bearer ' + token)
    try:
        with opener.open(request, timeout=120) as response:
            if response.status != 200:
                raise RuntimeError('DurinDoor authenticated inference failed')
            result = json.loads(response.read(1048577))
            if not isinstance(result, dict) or not isinstance(result.get('choices'), list) or not result['choices']:
                raise RuntimeError('DurinDoor did not return a chat completion')
    except (urllib.error.URLError, ValueError) as error:
        raise RuntimeError('DurinDoor authenticated inference failed; inspect protected gateway logs') from None


def apply(manifest):
    specs = sorted(manifest.get('agents', []), key=lambda item: item['name'])
    if not specs:
        return
    run('apt-get', 'install', '-y', '--no-install-recommends', 'nftables')
    networks = run('docker', 'network', 'ls', '--filter', 'driver=bridge', '--format', '{{.ID}}').splitlines()
    blocked4, blocked6 = set(PRIVATE4), set(PRIVATE6)
    if networks:
        for network in json.loads(run('docker', 'network', 'inspect', *networks)):
            for config in network.get('IPAM', {}).get('Config', []):
                if config.get('Subnet'):
                    subnet = ipaddress.ip_network(config['Subnet'], strict=False)
                    (blocked4 if subnet.version == 4 else blocked6).add(str(subnet))
    blocked4 = {str(net) for net in ipaddress.collapse_addresses(ipaddress.ip_network(value) for value in blocked4)}
    blocked6 = {str(net) for net in ipaddress.collapse_addresses(ipaddress.ip_network(value) for value in blocked6)}
    lines = ['destroy table inet cortex_agents', 'table inet cortex_agents {',
             'chain output { type filter hook output priority -10; policy accept;']
    for index, spec in enumerate(specs):
        agent_name = name(spec['name'])
        entry = account('cx-' + agent_name, Path(manifest['data_root']) / 'agents' / agent_name, manifest['data_root'])
        uid = str(entry.pw_uid)
        lines.insert(2, f'counter denied_{uid} {{ }}')
        ports = {18800 + index, 8888}
        if 'whatsapp' in spec['channels'] and spec['runtime'] == 'hermes':
            ports.add(18900 + index)
        values = secret('agent-' + agent_name)
        local_gateway = False
        for key, value in values.items():
            if not key.endswith('_BASE_URL'):
                continue
            url = urlparse(value)
            if not url.hostname or url.username or url.password or url.query or url.fragment:
                raise ValueError('Provider URL must have a host and no embedded credentials, query or fragment')
            if value.rstrip('/') == 'http://127.0.0.1:20128/v1':
                if key != 'OPENAI_BASE_URL' or 'durindoor' not in manifest['services']:
                    raise ValueError('The sole local provider exception requires selected DurinDoor and OPENAI_BASE_URL')
                gateway_access(values, spec['model'])
                local_gateway = True
                continue
            if url.scheme != 'https':
                raise ValueError('Providers require public HTTPS or the exact authenticated local DurinDoor /v1 endpoint')
            addresses = socket.getaddrinfo(url.hostname, url.port or 443, type=socket.SOCK_STREAM)
            if not addresses or any(not ipaddress.ip_address(row[4][0]).is_global for row in addresses):
                raise ValueError('Direct private, loopback, Tailscale and keyless Ollama providers are prohibited; route through authenticated DurinDoor')
        if local_gateway:
            lines.append(f'meta skuid {uid} ip daddr 127.0.0.1 tcp dport 20128 accept')
        port_set = '{ ' + ', '.join(str(port) for port in sorted(ports)) + ' }'
        lines += [f'meta skuid {uid} ct state established,related accept',
                  f'meta skuid {uid} ip daddr 127.0.0.1 tcp dport {port_set} accept',
                  f'meta skuid {uid} ip6 daddr ::1 tcp dport {port_set} accept',
                  f'meta skuid {uid} ip daddr 127.0.0.53 udp dport 53 accept',
                  f'meta skuid {uid} ip daddr 127.0.0.53 tcp dport 53 accept',
                  f'meta skuid {uid} ip daddr {{ ' + ', '.join(sorted(blocked4)) + f' }} counter name denied_{uid} reject with icmpx type admin-prohibited',
                  f'meta skuid {uid} ip6 daddr {{ ' + ', '.join(sorted(blocked6)) + f' }} counter name denied_{uid} reject with icmpx type admin-prohibited']
    lines += ['}', '}']
    policy = Path('/etc/cortex/agents.nft')
    save(policy, '\n'.join(lines) + '\n')
    save('/etc/systemd/system/cortex-agent-firewall.service', '''[Unit]
Description=Cortex per-agent egress boundary
Before=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/sbin/nft -f /etc/cortex/agents.nft
ExecReload=/usr/sbin/nft -f /etc/cortex/agents.nft
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
''', 0o644)
    run('systemctl', 'daemon-reload')
    run('systemctl', 'enable', 'cortex-agent-firewall.service')
    state = run('systemctl', 'show', '-p', 'ActiveState', '--value', 'cortex-agent-firewall.service')
    run('systemctl', 'reload' if state == 'active' else 'start', 'cortex-agent-firewall.service')
    from egress_proof import active_policy
    save('/etc/cortex/agents-policy.json', json.dumps(active_policy(), sort_keys=True) + '\n')


if __name__ == '__main__':
    from common import finish
    def dispatch(action, manifest):
        if action in ('apply', 'update', 'start', 'restart'):
            apply(manifest)
        elif action == 'verify':
            run('nft', 'list', 'table', 'inet', 'cortex_agents')
        else:
            raise RuntimeError('Firewall may not be disabled while agents exist')
    finish(dispatch)
