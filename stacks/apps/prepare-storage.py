"""Initialize non-root app storage under the approved manifest data root.

Image probes run read-only, without mounts, network, capabilities or secrets.
No application container is started here. Existing populated storage is never
recursively chowned; a mismatched owner fails closed for operator review.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess


def run(argv):
    result = subprocess.run(argv, check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return result.stdout.strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['apply'])
    parser.add_argument('--manifest', required=True)
    args = parser.parse_args()
    manifest = json.loads(Path(args.manifest).read_text())
    root = Path(manifest['data_root'])
    if not root.is_absolute() or root == Path('/') or root.resolve() != root:
        raise ValueError('Expected absolute non-symlink data root')
    selected = set(os.environ.get('CORTEX_SELECTED_SERVICES', '').split(',')) - {''}
    if not selected:
        selected = set(manifest['services'])
    current = os.environ.get('CORTEX_SERVICE_ID')
    if current:
        selected.intersection_update({current})
    if 'langfuse' in selected:
        # Pinned Chainguard image config specifies UID 65532 and native minio
        # entrypoint. Prepare its bucket here without assuming shell/id/mc.
        for relative in ('langfuse/minio', 'langfuse/minio/langfuse'):
            target = root / relative
            if target.resolve() != target:
                raise ValueError('Refusing symlinked MinIO storage')
            target.mkdir(parents=True, exist_ok=True, mode=0o750)
            if target.stat().st_uid != 65532 and any(target.iterdir()):
                raise ValueError('Populated MinIO storage has unexpected owner')
            os.chown(target, 65532, 65532)
    specs = [
        ('hindsight', 'HINDSIGHT_IMAGE', 'hindsight', ['hindsight']),
        ('postiz', 'POSTIZ_ELASTICSEARCH_IMAGE', 'elasticsearch', ['postiz/elasticsearch']),
        ('langfuse', 'LANGFUSE_CLICKHOUSE_IMAGE', 'clickhouse', ['langfuse/clickhouse-data', 'langfuse/clickhouse-logs']),
    ]
    for service, key, username, paths in specs:
        if service not in selected:
            continue
        image = os.environ.get(key, '')
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/:~-]*@sha256:[a-f0-9]{64}', image):
            raise ValueError(f'{key} must be an immutable image digest')
        try:
            run(['docker', 'image', 'inspect', image])
        except subprocess.CalledProcessError:
            run(['docker', 'pull', image])
        command = ['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--entrypoint', 'id', image]
        suffix = [username] if username else []
        uid = int(run(command + ['-u'] + suffix))
        gid = int(run(command + ['-g'] + suffix))
        for relative in paths:
            target = root / relative
            if target.resolve() != target:
                raise ValueError('Refusing symlinked app data directory')
            target.mkdir(parents=True, exist_ok=True, mode=0o750)
            state = target.stat()
            if (state.st_uid, state.st_gid) != (uid, gid):
                if any(target.iterdir()):
                    raise ValueError(f'{relative}: populated storage owner differs from selected image')
                os.chown(target, uid, gid)
    if 'hindsight' in selected:
        run(['python3', str(Path(manifest['root']) / 'scripts/memory/memoryctl.py'),
             'prepare', '--manifest', str(Path(args.manifest).resolve())])
    print('Selected app storage prepared')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError):
        raise SystemExit('App storage preparation failed; inspect image user and data ownership locally')
