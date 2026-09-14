"""Read-only guest tools plus controlled, counter-backed network isolation checks."""
from contextlib import contextmanager
import ipaddress
import json
import select
import socket
import subprocess
from common import BASE_ENV, run
from development_guard import controlled_deny, owned_rule

PUBLIC = '''import socket, urllib.request
socket.getaddrinfo('example.com', 443, type=socket.SOCK_STREAM)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
with opener.open('https://example.com/', timeout=30) as response:
    if response.status != 200: raise RuntimeError('Public HTTPS request failed')
    response.read(1024)
'''
SERVER = '''import json,select,socket,sys
with socket.socket() as server:
 server.bind((sys.argv[1],0)); server.listen(16)
 print(json.dumps({'port':server.getsockname()[1]}),flush=True)
 select.select([sys.stdin],[],[],120)
'''


@contextmanager
def listener(prefix, address):
    process = subprocess.Popen(prefix + ['python3', '-u', '-c', SERVER, address], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=BASE_ENV)
    try:
        if not select.select([process.stdout], [], [], 15)[0]:
            raise RuntimeError('Controlled listener did not become ready')
        value = process.stdout.readline()
        if not value:
            raise RuntimeError('Controlled listener exited before readiness')
        yield int(json.loads(value)['port'])
    finally:
        process.stdin.close()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill(); process.wait()
        process.stdout.close(); process.stderr.close()


def host_reachable(address, port):
    with socket.create_connection((address, port), timeout=5):
        pass


def address(instance, project):
    expected_mac = run('incus', 'config', 'get', instance, 'volatile.eth0.hwaddr', '--project', project).lower()
    if not expected_mac:
        raise RuntimeError('Managed development NIC has no assigned MAC address')
    state = json.loads(run('incus', 'query', '/1.0/instances/' + instance + '/state?project=' + project))
    interfaces = [item for item in state.get('network', {}).values() if item.get('hwaddr', '').lower() == expected_mac]
    addresses = [item['address'] for interface in interfaces for item in interface.get('addresses', [])
                 if item.get('family') == 'inet' and item.get('scope') == 'global']
    if len(interfaces) != 1 or len(addresses) != 1:
        raise RuntimeError('Development guest requires one managed IPv4 address for isolation proof')
    return str(ipaddress.IPv4Address(addresses[0]))


def verify(instance, project, manifest):
    prefix = ['incus', 'exec', instance, '--project', project, '--']
    source = address(instance, project)
    for command in (['git', '--version'], ['cc', '--version'], ['python3', '--version']):
        run(*prefix, *command)
    run(*prefix, 'python3', '-c', PUBLIC)
    network = json.loads(run('incus', 'query', '/1.0/networks/cortexdev0'))
    gateway = str(ipaddress.ip_interface(network['config']['ipv4.address']).ip)
    with listener([], gateway) as port:
        host_reachable(gateway, port)
        controlled_deny(prefix, source, gateway, port, 'inet', 'cortex_development', 'input')
    networks = json.loads(run('docker', 'inspect', 'cortex-postgresql', '--format', '{{json .NetworkSettings.Networks}}'))
    backends = [item['IPAddress'] for item in networks.values() if item.get('IPAddress')]
    if not backends:
        raise RuntimeError('Core PostgreSQL has no private address for isolation proof')
    for backend in backends:
        host_reachable(backend, 5432)
        owned_rule('inet', 'cortex_development', 'forward', backend)
        # Docker's native raw-prerouting guard runs before our forward hook.
        # Observe its actual packet verdict; normal verification never exempts an endpoint.
        controlled_deny(prefix, source, backend, 5432, 'ip', 'raw', 'PREROUTING')
    selected = {item['name'] for item in manifest.get('development', [])}
    rows = json.loads(run('incus', 'list', '--all-projects', '--format=json'))
    peers = [row for row in rows if row['name'] in selected and row['name'] != instance
             and row.get('project') == 'cortex-dev-' + row['name'] and row['status'] == 'Running']
    for peer in peers:
        peer_prefix = ['incus', 'exec', peer['name'], '--project', peer['project'], '--']
        target = address(peer['name'], peer['project'])
        with listener(peer_prefix, '0.0.0.0') as port:
            host_reachable(target, port)
            controlled_deny(prefix, source, target, port, 'bridge', 'cortex_development_l2', 'forward')
    print('Development tools, public DNS/HTTPS and controlled counter-backed isolation passed')
