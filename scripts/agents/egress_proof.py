"""Prove per-UID nft denial against live listeners, without trusting an errno alone."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import selectors
import socket
import stat
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import directory, run, save

BASELINE = Path('/etc/cortex/agents-policy.json')
ATTESTATIONS = Path('/run/cortex-agent-attestations')


def normalized(value):
    if isinstance(value, dict):
        return {key: normalized(item) for key, item in value.items()
                if key not in {'metainfo', 'handle', 'packets', 'bytes'}}
    if isinstance(value, list):
        return [normalized(item) for item in value if not (isinstance(item, dict) and 'metainfo' in item)]
    return value


def active_policy():
    return normalized(json.loads(run('nft', '--json', 'list', 'table', 'inet', 'cortex_agents')))


def secure_text(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor) as stream:
        info = os.fstat(stream.fileno())
        if info.st_uid != 0 or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o022 or info.st_nlink != 1:
            raise RuntimeError('Egress proof input is not a protected root-owned regular file')
        return stream.read()


def policy_matches():
    expected = json.loads(secure_text(BASELINE))
    actual = active_policy()
    if actual != expected:
        raise RuntimeError('Active agent nft policy differs from the installed exact policy; refusing startup')
    return hashlib.sha256(json.dumps(actual, sort_keys=True).encode()).hexdigest()


def count(uid):
    value = json.loads(run('nft', '--json', 'list', 'counter', 'inet', 'cortex_agents', f'denied_{uid}'))
    counters = [row['counter'] for row in value['nftables'] if 'counter' in row]
    if len(counters) != 1:
        raise RuntimeError('Missing per-UID egress denial counter')
    return counters[0]['packets']


def listener(metadata):
    sockets = []
    try:
        with selectors.DefaultSelector() as selector:
            for family, address in ((socket.AF_INET, '127.0.0.1'), (socket.AF_INET6, '::1')):
                server = socket.socket(family, socket.SOCK_STREAM)
                sockets.append(server)
                if family == socket.AF_INET6:
                    server.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
                server.bind((address, 0))
                server.listen(4)
                selector.register(server, selectors.EVENT_READ)
            save(metadata, json.dumps([list(server.getsockname()[:2]) for server in sockets]))
            while True:
                for key, _ in selector.select():
                    with key.fileobj.accept()[0] as client:
                        client.sendall(b'cortex-egress-proof\n')
    finally:
        for server in sockets:
            server.close()


def negative():
    results = []
    for address, port in json.load(sys.stdin):
        with socket.socket(socket.AF_INET6 if ':' in address else socket.AF_INET, socket.SOCK_STREAM) as client:
            client.settimeout(3)
            try:
                client.connect((address, port))
                results.append({'address': address, 'port': port, 'errno': 0})
            except OSError as error:
                results.append({'address': address, 'port': port, 'errno': error.errno})
    print(json.dumps(results))


def attest(unit):
    if os.geteuid() != 0:
        raise RuntimeError('Egress attestation requires root')
    unit = Path(unit)
    content = secure_text(unit)
    users = [line.partition('=')[2] for line in content.splitlines() if line.startswith('User=')]
    if len(users) != 1 or not users[0].startswith('cx-'):
        raise RuntimeError('Unexpected agent runtime identity')
    account = pwd.getpwnam(users[0])
    if not 0 < account.pw_uid < 1000 or account.pw_shell != '/usr/sbin/nologin':
        raise RuntimeError('Unexpected agent account privileges')
    policy_hash = policy_matches()
    # The listener must be in a separate root unit: the agent cgroup correctly
    # denies explicit ephemeral binds even for its privileged pre-start command.
    import secrets
    identity = 'cortex-egress-proof-' + secrets.token_hex(8)
    metadata = Path('/run/cortex-agent-proofs') / (identity + '.json')
    descriptor = directory(ATTESTATIONS, (0, 0), 0o755)
    os.close(descriptor)
    attestation = ATTESTATIONS / (unit.name + '.json')
    attestation.unlink(missing_ok=True)
    try:
        run('systemd-run', '--quiet', '--collect', '--unit=' + identity,
            '--property=Type=exec', '--property=RuntimeMaxSec=20', '--property=UMask=0077',
            '/usr/bin/python3', '-I', Path(__file__).resolve(), '--listener', metadata)
        for attempt in range(100):
            if metadata.exists():
                break
            time.sleep(0.05)
        else:
            raise RuntimeError('Controlled egress listener did not become ready')
        targets = json.loads(secure_text(metadata))
        for address, port in targets:
            with socket.create_connection((address, port), timeout=3) as client:
                if client.recv(64) != b'cortex-egress-proof\n':
                    raise RuntimeError('Root egress positive control did not reach the owned live listener')
        before = count(account.pw_uid)
        invocation_id = os.environ.get('INVOCATION_ID')
        if not invocation_id:
            raise RuntimeError('Missing systemd invocation identity for egress proof')
        def drop_identity():
            os.setgroups([])
            os.setgid(account.pw_gid)
            os.setuid(account.pw_uid)
        child = subprocess.run(['/usr/bin/python3', '-I', str(Path(__file__).resolve()), '--negative'],
            input=json.dumps(targets), text=True, capture_output=True, timeout=10,
            env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}, preexec_fn=drop_identity)
        if child.returncode:
            raise RuntimeError('Same-cgroup agent-UID egress probe failed to execute')
        results = json.loads(child.stdout)
        after = count(account.pw_uid)
        if len(results) != len(targets) or any(row['errno'] not in (1, 13, 113) for row in results) or after - before < len(targets):
            raise RuntimeError('Live-target egress denial and per-UID nft counter increment were not both proven')
        if policy_matches() != policy_hash:
            raise RuntimeError('Agent nft policy changed during the controlled egress proof')
        save(attestation, json.dumps({'uid': account.pw_uid, 'unit_sha256': hashlib.sha256(content.encode()).hexdigest(),
            'policy_sha256': policy_hash, 'boot_id': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
            'invocation_id': invocation_id,
            'monotonic': time.monotonic(), 'cgroup': Path('/proc/self/cgroup').read_text(),
            'counter_before': before, 'counter_after': after, 'results': results}) + '\n', 0o644)
    finally:
        subprocess.run(['systemctl', 'stop', identity + '.service'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        metadata.unlink(missing_ok=True)


def verify_attestation(unit):
    unit = Path(unit)
    value = json.loads(secure_text(ATTESTATIONS / (unit.name + '.json')))
    age = time.monotonic() - value['monotonic']
    if (value['uid'] != os.getuid() or value['unit_sha256'] != hashlib.sha256(secure_text(unit).encode()).hexdigest()
            or value['boot_id'] != Path('/proc/sys/kernel/random/boot_id').read_text().strip()
            or not os.environ.get('INVOCATION_ID') or value['invocation_id'] != os.environ['INVOCATION_ID']
            or not 0 <= age <= 30 or value['cgroup'] != Path('/proc/self/cgroup').read_text()
            or value['counter_after'] - value['counter_before'] < 2):
        raise RuntimeError('Missing, stale or mismatched live-target egress attestation')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--attest-unit')
    mode.add_argument('--listener')
    mode.add_argument('--negative', action='store_true')
    arguments = parser.parse_args()
    try:
        if arguments.attest_unit:
            attest(arguments.attest_unit)
        elif arguments.listener:
            listener(arguments.listener)
        else:
            negative()
    except (OSError, ValueError, RuntimeError) as error:
        raise SystemExit(str(error)) from None
