"""Private Node for OpenClaw/agent bridge, never changes the dashboard's Node."""
import hashlib
from pathlib import Path
import platform
import tarfile
import tempfile
import urllib.request

VERSION = '24.16.0'
PINS = {'x86_64': ('x64', 'd804845d34eddc21dc1092b519d643ef40b1f58ec5dec5c22b1f4bd8fabde6c9'),
        'aarch64': ('arm64', '524659219d6a207a7400f2bde15d19ba060ffbe0d32a8643319ad67e3bb64c78')}


def install(action, manifest):
    if platform.machine() not in PINS:
        raise RuntimeError('Private agent Node supports x86_64 and aarch64 targets only')
    arch, digest = PINS[platform.machine()]
    name = f'node-v{VERSION}-linux-{arch}'
    parent = Path(manifest['root']) / 'runtimes/node'
    target = parent / name
    if action in ('apply', 'update') and not (target / 'bin/node').is_file():
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as staging:
            archive = Path(staging) / 'node.tar.xz'
            with urllib.request.urlopen(f'https://nodejs.org/dist/v{VERSION}/{name}.tar.xz', timeout=120) as response, archive.open('wb') as file:
                while chunk := response.read(1048576):
                    file.write(chunk)
            with archive.open('rb') as file:
                if hashlib.file_digest(file, 'sha256').hexdigest() != digest:
                    raise RuntimeError('Node distribution checksum mismatch')
            with tarfile.open(archive) as bundle:
                bundle.extractall(staging, filter='data')
            (Path(staging) / name).rename(target)
    if not (target / 'bin/node').is_file():
        raise RuntimeError('Private agent Node is not installed')
    return target / 'bin'
