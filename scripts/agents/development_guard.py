"""Attribute real development-network denials using temporary non-verdict packet observers."""
import errno
import ipaddress
import json
import select
import subprocess
import uuid
from common import BASE_ENV, run

CLIENT = '''import json,socket,sys
v=json.loads(sys.stdin.readline())
with socket.socket(socket.AF_INET,socket.SOCK_STREAM) as s:
 s.settimeout(3); s.bind(('0.0.0.0',0))
 print(json.dumps({'source_port':s.getsockname()[1]}),flush=True)
 if sys.stdin.readline().strip()!='deny': raise RuntimeError('Missing root proof coordinator')
 try:
  s.connect((v['address'],v['port']))
  print(json.dumps({'denied':False}),flush=True)
 except OSError as e:
  print(json.dumps({'denied':True,'errno':e.errno}),flush=True)
'''


def rules(family, table, chain):
    data = json.loads(run('nft', '-j', '-a', 'list', 'chain', family, table, chain))
    return [item['rule'] for item in data['nftables'] if 'rule' in item]


def packets(rule):
    counters = [expr['counter']['packets'] for expr in rule['expr'] if 'counter' in expr]
    if len(counters) != 1:
        raise RuntimeError('Owned development deny rule lacks exactly one counter')
    return counters[0]


def owned_rule(family, table, chain, target):
    rows = rules(family, table, chain)
    if (family, table, chain) == ('ip', 'raw', 'PREROUTING'):
        wanted = {'match': {'op': '==', 'left': {'payload': {'protocol': 'ip', 'field': 'daddr'}}, 'right': target}}
        for rule in rows:
            expr = [item for item in rule['expr'] if 'counter' not in item]
            if len(expr) != 3 or expr[0] != wanted or expr[-1] != {'drop': None}:
                continue
            interface = expr[1].get('match', {})
            if interface.get('op') == '!=' and interface.get('left') == {'meta': {'key': 'iifname'}} and interface.get('right') != 'cortexdev0':
                packets(rule)
                return rule
        raise RuntimeError('Native Docker private-address deny predicate is absent')
    if len(rows) != (1 if family == 'bridge' else 4):
        raise RuntimeError('Development firewall rule layout drifted before proof')
    rule = rows[-1] if chain == 'input' else rows[0]
    expr = [item for item in rule['expr'] if 'counter' not in item]
    key = 'ibrname' if family == 'bridge' else 'iifname'
    expected_match = {'match': {'op': '==', 'left': {'meta': {'key': key}}, 'right': 'cortexdev0'}}
    if expr[0] != expected_match:
        raise RuntimeError('Owned development deny interface predicate is absent')
    expected_verdict = {'drop': None} if family == 'bridge' else {'reject': {'type': 'icmpx', 'expr': 'admin-prohibited'}}
    if expr[-1] != expected_verdict:
        raise RuntimeError('Owned development deny verdict is absent')
    if family == 'inet' and chain == 'forward':
        if len(expr) != 3:
            raise RuntimeError('Owned private destination rule has unexpected predicates')
        match = expr[1].get('match', {})
        if match.get('left') != {'payload': {'protocol': 'ip', 'field': 'daddr'}} or match.get('op') != '==':
            raise RuntimeError('Owned private destination predicate drifted')
        nets = [ipaddress.ip_network(str(item['prefix']['addr']) + '/' + str(item['prefix']['len']))
                for item in match.get('right', {}).get('set', [])]
        if not any(ipaddress.ip_address(target) in net for net in nets):
            raise RuntimeError('Protected proof target is not covered by the owned deny rule')
    elif len(expr) != 2:
        raise RuntimeError('Owned development deny expression drifted')
    packets(rule)
    return rule


def controlled_deny(prefix, source, target, port, family, table, chain):
    source, target = str(ipaddress.IPv4Address(source)), str(ipaddress.IPv4Address(target))
    if not 0 < port < 65536:
        raise ValueError('Invalid controlled listener port')
    original = owned_rule(family, table, chain, target)
    marker = 'cortexproof' + uuid.uuid4().hex
    process = subprocess.Popen(prefix + ['python3', '-u', '-c', CLIENT], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=BASE_ENV)
    def send(value):
        process.stdin.write(value + '\n'); process.stdin.flush()
    def receive():
        if not select.select([process.stdout], [], [], 15)[0]:
            raise RuntimeError('Guest proof coordinator timed out')
        value = process.stdout.readline()
        if not value:
            raise RuntimeError('Guest proof client exited before expected evidence: ' + process.stderr.read(4096))
        return json.loads(value)
    def add(args, suffix):
        run('nft', 'insert', 'rule', family, table, chain, *args, 'comment', marker + suffix)
    def remove():
        for row in rules(family, table, chain):
            comment = row.get('comment', '')
            if comment.startswith(marker):
                run('nft', 'delete', 'rule', family, table, chain, 'handle', str(row['handle']))
    try:
        send(json.dumps({'address': target, 'port': port}))
        source_port = receive()['source_port']
        if not isinstance(source_port, int) or not 0 < source_port < 65536:
            raise RuntimeError('Guest returned an invalid proof source port')
        match = ['meta', 'ibrname', 'cortexdev0', 'ether', 'type', 'ip'] if family == 'bridge' else ['iifname', 'cortexdev0']
        flow = match + ['ip', 'saddr', source, 'ip', 'daddr', target, 'tcp', 'sport', str(source_port), 'tcp', 'dport', str(port)]
        add(flow + ([] if family == 'ip' else ['ct', 'state', 'new']) + ['counter'], 'observe')
        if family == 'bridge':
            add(['meta', 'ibrname', 'cortexdev0', 'ether', 'type', 'arp', 'arp', 'saddr', 'ip', source,
                 'arp', 'daddr', 'ip', target, 'counter'], 'arpobserve')
        before = next(row for row in rules(family, table, chain) if row['handle'] == original['handle'])
        send('deny')
        result = receive()
        after = rules(family, table, chain)
        observed = [row for row in after if row.get('comment') in (marker + 'observe', marker + 'arpobserve')]
        verdict = next(row for row in after if row['handle'] == original['handle'])
        count = sum(packets(row) for row in observed)
        if (not result.get('denied') or result.get('errno') not in (None, errno.EACCES, errno.EPERM, errno.EHOSTUNREACH)
                or count < 1 or packets(verdict) - packets(before) < count):
            raise RuntimeError('Owned deny rule did not account for the exact guest probe flow')
        print('Development denial proved by ' + family + '/' + table + '/' + chain + ': exact-flow packets=' + str(count))
    finally:
        try:
            remove()
            if any(row.get('comment', '').startswith(marker) for row in rules(family, table, chain)):
                raise RuntimeError('Temporary development packet observer remains installed')
        finally:
            process.stdin.close()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait()
            process.stdout.close(); process.stderr.close()
