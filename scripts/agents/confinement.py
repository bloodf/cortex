"""ExecStartPre guard, executed under exactly the runtime UID and systemd sandbox."""
import argparse
import errno
from pathlib import Path
import socket


def probe(port, allowed):
    for family, address in ((socket.AF_INET, '127.0.0.2'), (socket.AF_INET6, '::1')):
        for kind in (socket.SOCK_STREAM, socket.SOCK_DGRAM):
            expected = allowed and kind == socket.SOCK_STREAM
            with socket.socket(family, kind) as sock:
                try:
                    sock.bind((address, port))
                except OSError as error:
                    if expected or error.errno not in (errno.EPERM, errno.EACCES):
                        raise RuntimeError(f'Confinement probe failed: address={address} port={port} type={kind} errno={error.errno}; occupied ports are not proof') from None
                else:
                    if not expected:
                        raise RuntimeError(f'Confinement unenforced: address={address} port={port} type={kind} unexpectedly bound')

def egress_probe(unit, allowed_port):
    # IPv4 ICMP admin-prohibited legitimately maps to EHOSTUNREACH. An errno
    # alone cannot distinguish our firewall from an absent destination.
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from egress_proof import verify_attestation
    verify_attestation(unit)
    for family, address in ((socket.AF_INET, '127.0.0.1'), (socket.AF_INET6, '::1')):
        with socket.socket(family, socket.SOCK_STREAM) as server:
            server.bind((address, allowed_port))
            server.listen(1)
            with socket.socket(family, socket.SOCK_STREAM) as client:
                client.settimeout(2)
                client.connect((address, allowed_port))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--unit', required=True)
    parser.add_argument('--port', type=int, action='append', required=True)
    args = parser.parse_args()
    declared = Path(args.unit).read_text().splitlines()
    if 'SocketBindDeny=any' not in declared:
        raise RuntimeError('Missing exact deny declaration')
    if [line for line in declared if line.startswith('SocketBindAllow=')] != [f'SocketBindAllow=tcp:{port}' for port in args.port]:
        raise RuntimeError('Unexpected bind exception in runtime unit')
    for port in args.port:
        probe(port, True)
    for port in (1, 3080, 5432, 65534):
        probe(port, False)
    egress_probe(args.unit, args.port[0])
    # Recheck the authenticated inference exception at every boot/start, not only provisioning.
    import json
    import os
    if os.environ.get('OPENAI_BASE_URL', '').rstrip('/') == 'http://127.0.0.1:20128/v1':
        # -I intentionally excludes the script directory; add only this root-owned code directory.
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from firewall import gateway_access
        if os.environ.get('HERMES_HOME'):
            config = json.loads((Path(os.environ['HERMES_HOME']) / 'config.yaml').read_text())
            model = config['model']['default']
        else:
            config = json.loads(Path(os.environ['OPENCLAW_CONFIG_PATH']).read_text())
            model = config['models']['providers']['cortex']['models'][0]['id']
        gateway_access(os.environ, model)


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as error:
        raise SystemExit(str(error)) from None
