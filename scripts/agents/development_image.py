"""Resolve an operator image once and persist its immutable identity outside the guest."""
import json
import os
from pathlib import Path
import re
import stat
from common import directory, run, save


def resolve(instance, kind, choice, action):
    if not isinstance(choice, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/-]*', choice):
        raise ValueError('Image must be an Incus alias or fingerprint, optionally qualified by a configured remote')
    receipt = Path('/etc/cortex') / ('development-' + instance + '-image.json')
    parent = directory(receipt.parent)
    try:
        try:
            fd = os.open(receipt.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
        except FileNotFoundError:
            fd = None
        if fd is not None:
            with os.fdopen(fd) as file:
                info = os.fstat(file.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600:
                    raise RuntimeError('Image resolution receipt must be a root-owned regular mode-0600 file')
                value = json.load(file)
            if value.get('choice') != choice or value.get('kind') != kind:
                raise RuntimeError('Image choice/kind changed; export and explicitly replace the guest and receipt')
            if not re.fullmatch(r'[a-f0-9]{64}', value.get('fingerprint', '')):
                raise RuntimeError('Invalid immutable image resolution receipt')
            fingerprint = value['fingerprint']
        else:
            if action not in ('apply', 'update'):
                raise RuntimeError('No root-owned image resolution receipt exists')
            args = ['incus', 'image', 'info', choice]
            if kind == 'vm':
                args.append('--vm')
            metadata = run(*args)
            types = re.findall(r'^Type: (container|virtual-machine)\s*$', metadata, re.MULTILINE)
            if types != ['virtual-machine' if kind == 'vm' else 'container']:
                raise RuntimeError('Resolved image type does not match the selected development kind')
            matches = re.findall(r'^Fingerprint: ([a-f0-9]{64})\s*$', metadata, re.MULTILINE)
            if len(matches) != 1:
                raise RuntimeError('Incus did not provide one full immutable image fingerprint')
            fingerprint = matches[0]
            save(receipt, json.dumps({'choice': choice, 'kind': kind, 'fingerprint': fingerprint}) + '\n')
    finally:
        os.close(parent)
    remote = choice.split(':', 1)[0] + ':' if ':' in choice else ''
    return remote + fingerprint, fingerprint
