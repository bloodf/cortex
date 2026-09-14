"""Pinned multi-file gVisor distribution; sidecars must remain beside runsc."""
import hashlib
import os
from pathlib import Path
import platform
import tarfile
import tempfile
import urllib.request
from common import save

VERSION = '20260907.0'
DIGESTS = {'x86_64': '81416511897ab8abd4e723d66823c5b0461a2ee3311cfa70d152404ef9b860cf',
           'aarch64': '2b162adb35860f598ab2f89b9d752bff2c7ee6175c05d9cc532174a336cfb38c'}


def install(action, manifest):
    arch = platform.machine()
    if arch not in DIGESTS:
        raise RuntimeError('gVisor supports x86_64 and aarch64 targets only')
    target = Path(manifest['root']) / 'runtimes/gvisor' / VERSION
    binary = target / 'runsc'
    if action in ('apply', 'update') and not (target / '.cortex-installed').exists():
        target.mkdir(parents=True, exist_ok=True)
        url = f'https://github.com/google/gvisor/releases/download/release-{VERSION}/gvisor-{arch}.tar.bz2'
        with tempfile.TemporaryDirectory() as staging:
            archive = Path(staging) / 'gvisor.tar.bz2'
            with urllib.request.urlopen(url, timeout=120) as response, archive.open('wb') as file:
                while chunk := response.read(1048576):
                    file.write(chunk)
            with archive.open('rb') as file:
                if hashlib.file_digest(file, 'sha256').hexdigest() != DIGESTS[arch]:
                    raise RuntimeError('gVisor distribution checksum mismatch')
            with tarfile.open(archive) as bundle:
                bundle.extractall(target, filter='data')
        if not binary.is_file() or not (target / 'gvisor-bin').is_dir():
            raise RuntimeError('gVisor archive lacks required binary/sidecar layout')
        save(target / '.cortex-installed', DIGESTS[arch] + '\n', 0o644)
    if not binary.is_file() or not (target / '.cortex-installed').exists():
        raise RuntimeError('gVisor has not been completely installed')
    return binary
