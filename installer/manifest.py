"""Non-secret manifest validation and deterministic dependency planning."""
import json
import re
from pathlib import Path
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

SOURCE = Path(__file__).resolve().parents[1]
NAME = re.compile(r"[a-z][a-z0-9-]{0,23}")
USER = re.compile(r"[a-z_][a-z0-9_-]{0,30}")


class Invalid(ValueError):
    pass


def require(ok, message):
    if not ok:
        raise Invalid(message)


def keys(value, expected, context):
    require(type(value) is dict and set(value) == set(expected.split()), f"{context}: exact keys required: {expected}")


def text(value, context, maximum=200):
    require(type(value) is str and 0 < len(value) <= maximum and not any(ord(c) < 32 for c in value), f"{context}: invalid text")
    return value


def path(value, context):
    text(value, context, 512)
    p = Path(value)
    require(p.is_absolute() and str(p) == value and '..' not in p.parts and re.fullmatch(r'/[A-Za-z0-9_./-]+', value), f"{context}: use a normalized absolute path without whitespace")
    require(len(p.parts) >= 3 and p.parts[1] in {'opt', 'srv', 'var', 'mnt', 'media', 'home'}, f"{context}: use a dedicated directory beneath /opt, /srv, /var, /mnt, /media or /home")
    require(value not in {'/var/lib', '/var/cache', '/var/log', '/opt/cortexos'} and not p.is_relative_to('/opt/cortexos'), f"{context}: protected path")
    require(context == 'root' or not p.is_relative_to(SOURCE), f"{context}: private paths must be outside the source checkout")
    for ancestor in (p, *p.parents):
        require(not ancestor.is_symlink(), f"{context}: symlinks forbidden")
    return p

def distinct_paths(a, b):
    return a != b and not a.is_relative_to(b) and not b.is_relative_to(a)


def unique_list(value, context):
    require(type(value) is list and all(type(v) is str for v in value), f"{context}: string array required")
    require(len(value) == len(set(value)), f"{context}: duplicates forbidden")


def catalog():
    data = json.loads((SOURCE / 'catalog/services.json').read_text())
    require(data['schema_version'] == 1, 'unsupported service catalog')
    rows = data['services']
    result = {row['id']: row for row in rows}
    require(len(result) == len(rows), 'duplicate catalog ID')
    return result


def load(filename):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'duplicate JSON key')
            result[key] = value
        return result
    return validate(json.loads(Path(filename).read_text(), object_pairs_hook=pairs))


def validate(m):
    keys(m, 'schema_version root data_root admin_user hostname timezone network services agents development backups updates', 'manifest')
    require(type(m['schema_version']) is int and m['schema_version'] == 1, 'schema_version must be integer 1')
    root, data = path(m['root'], 'root'), path(m['data_root'], 'data_root')
    require(distinct_paths(root, data), 'root and data_root must not overlap')
    require(USER.fullmatch(text(m['admin_user'], 'admin_user')) and m['admin_user'] not in {'root', 'cortex', 'postgres'}, 'admin_user must be a non-system Linux login')
    require(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', text(m['hostname'], 'hostname')), 'hostname must be one lowercase DNS label')
    tz = text(m['timezone'], 'timezone')
    require(not tz.startswith('/') and '..' not in tz.split('/'), 'invalid timezone')
    try:
        ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        raise Invalid('timezone must be a known IANA zone') from None
    unique_list(m['services'], 'services')
    keys(m['network'], 'mode public_url', 'network')
    require(type(m['network']['mode']) is str and m['network']['mode'] in {'local', 'tailscale'}, 'network mode must be local or tailscale')
    u = urlsplit(text(m['network']['public_url'], 'public_url'))
    try:
        port = u.port
    except ValueError:
        raise Invalid('invalid public URL port') from None
    require(u.scheme in {'http', 'https'} and u.hostname and not u.username and not u.password and not u.query and not u.fragment and u.path in {'', '/'}, 'public_url must be an HTTP(S) origin without credentials')
    require(re.fullmatch(r'[a-zA-Z0-9.:-]+', u.hostname), 'invalid public URL host')
    if m['network']['mode'] == 'local':
        local_port = 8080 if 'caddy' in m['services'] else 3080
        require(u.hostname in {'localhost', '127.0.0.1', '::1'} and u.scheme == 'http' and port == local_port,
                f'local mode uses the canonical http://localhost:{local_port} origin for the selected front door')
    else:
        require(u.hostname.endswith('.ts.net') and u.scheme == 'https' and port in {None, 443}, 'tailscale mode requires an operator-supplied https://NAME.TAILNET.ts.net origin')
    rows = catalog()
    require(set(m['services']) <= rows.keys(), 'unknown service ID')
    require({'dashboard', 'postgresql'} <= set(m['services']), 'dashboard and postgresql are required')
    names = set()
    require(type(m['agents']) is list, 'agents must be an array')
    require(len(m['agents']) <= 100, 'at most 100 agent profiles are supported')
    for agent in m['agents']:
        keys(agent, 'name runtime model channels', 'agent')
        name = text(agent['name'], 'agent name')
        require(NAME.fullmatch(name) and name not in names, 'invalid or duplicate agent name')
        names.add(name)
        require(type(agent['runtime']) is str and agent['runtime'] in {'hermes', 'openclaw'}, 'unsupported agent runtime')
        require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_./:@+-]{0,199}', text(agent['model'], 'model')) and '://' not in agent['model'], 'model must be a model identifier, not credentials or a URL')
        unique_list(agent['channels'], 'channels')
        require(agent['channels'] and set(agent['channels']) <= {'telegram', 'whatsapp', 'none'} and ('none' not in agent['channels'] or len(agent['channels']) == 1), 'choose channels or none, not both')
    require(type(m['development']) is list, 'development must be an array')
    for dev in m['development']:
        keys(dev, 'name kind image', 'development')
        name = text(dev['name'], 'development name')
        require(NAME.fullmatch(name) and name not in names, 'invalid or duplicate environment name')
        names.add(name)
        require(type(dev['kind']) is str and dev['kind'] in {'container', 'vm'}, 'development kind must be container or vm')
        require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_./:@+-]{0,199}', text(dev['image'], 'image')) and '://' not in dev['image'], 'invalid image identifier')
    keys(m['backups'], 'enabled destination', 'backups')
    require(type(m['backups']['enabled']) is bool, 'backups.enabled must be boolean')
    if m['backups']['enabled']:
        dest = path(m['backups']['destination'], 'backup destination')
        require(distinct_paths(root, dest) and distinct_paths(data, dest), 'backup destination must not overlap source or data')
    else:
        require(m['backups']['destination'] is None, 'disabled backups require null destination')
    keys(m['updates'], 'automatic', 'updates')
    require(type(m['updates']['automatic']) is bool, 'updates.automatic must be boolean')
    selected(m, rows)
    return m


def agent_ports(m):
    """Match runtime/firewall allocation: one global name-sorted agent index."""
    require(len(m['agents']) <= 100, 'at most 100 agent profiles are supported')
    result = []
    for index, agent in enumerate(sorted(m['agents'], key=lambda row: row['name'])):
        result.append({'agent': agent['name'], 'purpose': 'api', 'port': 18800 + index, 'protocol': 'tcp'})
        if agent['runtime'] == 'hermes' and 'whatsapp' in agent['channels']:
            result.append({'agent': agent['name'], 'purpose': 'whatsapp', 'port': 18900 + index, 'protocol': 'tcp'})
    return result


def selected(m, rows=None):
    rows = rows or catalog()
    requested = set(m['services']) | {a['runtime'] for a in m['agents']}
    if m['agents']:
        requested.add('hindsight')
    if m['development']:
        requested.add('incus')
    if m['network']['mode'] == 'tailscale':
        requested.add('tailscale')
    visiting, finished, ordered = set(), set(), []
    def visit(name):
        require(name in rows, 'catalog dependency does not exist')
        require(name not in visiting, 'catalog dependency cycle')
        if name in finished:
            return
        visiting.add(name)
        for dep in sorted(rows[name].get('depends_on', [])):
            visit(dep)
        visiting.remove(name)
        finished.add(name)
        ordered.append(name)
    for name in sorted(requested):
        visit(name)
    ports = {}
    for name in ordered:
        row = rows[name]
        require(not (set(row.get('conflicts', [])) & finished), f'{name}: selected services conflict')
        for item in row.get('ports', []):
            if type(item) is int:
                port, protocol = item, 'tcp'
            elif type(item) is dict:
                port, protocol = item.get('host', item.get('port')), item.get('protocol', 'tcp')
            else:
                raise Invalid('catalog ports must be integer or object')
            require(type(port) is int and 1 <= port <= 65535 and protocol in {'tcp', 'udp'}, 'invalid catalog port')
            key = (port, protocol)
            require(key not in ports or ports[key] == name, f'port conflict: {name} and {ports.get(key)} on {port}/{protocol}')
            ports[key] = name
    for allocation in agent_ports(m):
        key = (allocation['port'], allocation['protocol'])
        require(key not in ports, f"port conflict: agent {allocation['agent']} and {ports.get(key)} on {key[0]}/{key[1]}")
        ports[key] = 'agent:' + allocation['agent']
    return ordered
