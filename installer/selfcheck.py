#!/usr/bin/env python3
"""Small, non-mutating regression check for manifest/path rejection boundaries."""
import copy
import tempfile
from pathlib import Path

from manifest import Invalid, path, validate


def rejected(fn):
    try:
        fn()
    except Invalid:
        return
    raise AssertionError('unsafe input was accepted')


def main():
    manifest = {'schema_version': 1, 'root': '/opt/cortex', 'data_root': '/var/lib/cortex',
                'admin_user': 'operator', 'hostname': 'cortex', 'timezone': 'Etc/UTC',
                'network': {'mode': 'local', 'public_url': 'http://localhost:3080'},
                'services': ['dashboard', 'postgresql'], 'agents': [], 'development': [],
                'backups': {'enabled': False, 'destination': None}, 'updates': {'automatic': False}}
    validate(manifest)
    bad = copy.deepcopy(manifest)
    bad['data_root'] = '/opt/cortex/data'
    rejected(lambda: validate(bad))
    bad = copy.deepcopy(manifest)
    bad['network']['public_url'] = 'http://operator:secret@localhost:3080'
    rejected(lambda: validate(bad))
    bad = copy.deepcopy(manifest)
    bad['schema_version'] = True
    rejected(lambda: validate(bad))
    bad = copy.deepcopy(manifest)
    bad['api_key'] = 'not-a-real-key'
    rejected(lambda: validate(bad))
    for field, profile in (
        ('agents', {'name': 'a' * 24, 'runtime': 'hermes', 'model': 'provider/model', 'channels': ['none']}),
        ('development', {'name': 'a' * 24, 'kind': 'container', 'image': 'images:ubuntu/26.04'}),
    ):
        boundary = copy.deepcopy(manifest)
        boundary[field] = [profile]
        validate(boundary)
        profile['name'] += 'a'
        rejected(lambda: validate(boundary))
    with tempfile.TemporaryDirectory(dir='/var/tmp', prefix='cortex-check-') as directory:
        link = Path(directory) / 'link'
        link.symlink_to('/var/lib')
        rejected(lambda: path(str(link / 'data'), 'data_root'))
    print('Manifest boundary self-check passed.')


if __name__ == '__main__':
    main()
