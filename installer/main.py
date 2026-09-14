#!/usr/bin/env python3
"""Cortex's tool-neutral installer: interview, validate, plan, apply, verify."""
import argparse
import getpass
import hashlib
import json
import os
import sys
from pathlib import Path

from manifest import SOURCE, Invalid, agent_ports, catalog, load, require, selected, validate


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def make_plan(m):
    rows = catalog()
    ids = selected(m, rows)
    plan = {'manifest': m, 'services': ids, 'catalog': [rows[i] for i in ids],
            'agent_ports': agent_ports(m),
            'operations': ['Refuse existing deployments and unrelated workloads',
                           'Require 16 GiB-class build capacity: at least 15 GiB reported RAM+swap and 12 GiB currently available; never create swap automatically',
                           'Install Ubuntu build prerequisites, Docker, Node and pinned pnpm',
                           'Apply the explicitly chosen hostname and IANA timezone',
                           'Copy reviewed source; create protected local credentials',
                           'Create PostgreSQL owner and separate dashboard runtime role',
                           'Build dashboard, run migrations and seed selected catalog',
                           'Configure PAM administration and root dashboard service on loopback',
                           'Apply selected service recipes, agent profiles and development environments',
                           'Verify real service health; never trust completion markers']}
    # Approval binds the non-secret manifest, recipe catalog, and shipped implementation.
    digest = hashlib.sha256(canonical(plan))
    for relative in source_files():
        digest.update(relative.as_posix().encode() + b'\0')
        digest.update(hashlib.sha256((SOURCE / relative).read_bytes()).digest())
    plan['approval'] = digest.hexdigest()
    return plan


def source_files():
    allowed = {'installer', 'bin', 'packages', 'catalog', 'templates', 'stacks', 'scripts', 'docs', 'prompts', '.github'}
    excluded = {'.git', 'node_modules', '.next', '.output', 'dist', 'coverage', '__pycache__', '.cache', '.secrets', '.env'}
    files = []
    for base, dirs, names in os.walk(SOURCE, followlinks=False):
        relative = Path(base).relative_to(SOURCE)
        dirs[:] = sorted(d for d in dirs if d not in excluded and not (Path(base) / d).is_symlink() and (relative.parts or d in allowed))
        for name in sorted(names):
            p = Path(base) / name
            if p.is_symlink() or name.startswith('.env') or name.endswith(('.pyc', '.log', '.sqlite', '.db')):
                continue
            if not relative.parts and name not in {'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'eslint.config.js', 'eslint.config.mjs', '.prettierrc', '.prettierrc.json', 'README.md', 'LICENSE', '.npmrc', '.gitignore'}:
                continue
            files.append(p.relative_to(SOURCE))
    return sorted(files)


def private_write(filename, content):
    target = Path(filename)
    require(target.is_absolute() and not target.resolve().is_relative_to(SOURCE), 'answer/state file must be outside the checkout')
    for p in (target, *target.parents):
        require(not p.is_symlink(), 'private path must not contain symlinks')
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(target.parent.stat().st_mode & 0o022 == 0, 'private file parent must not be group/world writable')
    import tempfile
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=target.parent, prefix='.cortex-', delete=False) as f:
            temporary = Path(f.name)
            os.fchmod(f.fileno(), 0o600)
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, target)
        directory = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def ask(question, default=None, choices=None):
    while True:
        suffix = f' [{default}]' if default is not None else ''
        value = input(question + suffix + ': ').strip() or default
        if value is not None and (choices is None or value in choices):
            return value
        print('Choose one of: ' + ', '.join(choices) if choices else 'An answer is required.')


def yes(question, default=False):
    return ask(question, 'no' if not default else 'yes', {'yes', 'no'}) == 'yes'


def interview(filename):
    require(sys.stdin.isatty(), 'interview needs an interactive terminal; use a reviewed JSON manifest for automation')
    print('Cortex fresh Ubuntu 26.04 installation. No secrets belong in these answers. Nothing is installed during the interview.')
    print('Choose dedicated directories; this installer never formats disks or migrates an existing server.')
    m = {'schema_version': 1}
    m['root'] = ask('Application directory', '/opt/cortex')
    m['data_root'] = ask('Persistent data directory (existing mounted storage is supported)', '/var/lib/cortex')
    m['admin_user'] = ask('Existing human Linux login with a local password for PAM authentication', os.environ.get('SUDO_USER') or getpass.getuser())
    m['hostname'] = ask('Single-label hostname for this new server (explicitly applied)', 'cortex')
    m['timezone'] = ask('IANA timezone', 'Etc/UTC')
    mode = ask('Dashboard access: local uses an SSH tunnel; tailscale needs your own tailnet', 'local', {'local', 'tailscale'})
    public = 'http://localhost:3080' if mode == 'local' else ask('Exact HTTPS device origin from your tailnet, without credentials')
    m['network'] = {'mode': mode, 'public_url': public}
    rows = catalog()
    m['services'] = ['dashboard', 'postgresql']
    print('Dashboard and PostgreSQL are required. Optional dependencies are shown in the plan before approval.')
    for name, row in rows.items():
        if name in {'dashboard', 'postgresql'}:
            continue
        print(f"\n{name}: {row.get('description', row.get('title', name))}")
        print('Dependencies: ' + ', '.join(row.get('depends_on', [])))
        for key in ('resources', 'resource_guidance', 'license', 'security_notes'):
            if row.get(key):
                print(f'{key}: {row[key]}')
        if yes('Select ' + name + '?'):
            m['services'].append(name)
    if mode == 'local' and 'caddy' in m['services']:
        m['network']['public_url'] = 'http://localhost:8080'
        print('Selected Caddy: canonical local dashboard origin is http://localhost:8080. Use that origin consistently for login and Terminal.')
    m['agents'] = []
    print('\nAgents use your chosen inference model. GPU drivers are not installed or altered; see service resource guidance.')
    print('Every agent requires Hindsight with authenticated per-agent memory; its service dependencies and provider setup will appear in the approval plan.')
    vendors = set()
    for vendor_file in Path('/sys/class/drm').glob('card*/device/vendor'):
        try:
            vendor_id = vendor_file.read_text().strip()
            vendors.add({'0x10de': 'NVIDIA', '0x1002': 'AMD', '0x8086': 'Intel'}.get(vendor_id, 'other graphics hardware'))
        except OSError:
            continue
    print('Read-only graphics detection: ' + (', '.join(sorted(vendors)) if vendors else 'none exposed through DRM') + '. This does not prove inference acceleration or supported drivers.')
    while yes('Create an agent profile?'):
        agent = {'name': ask('Agent name (lowercase letters, digits, hyphens)'),
                 'runtime': ask('Runtime', choices={'hermes', 'openclaw'}),
                 'model': ask('Model identifier (not an API key or endpoint URL)')}
        channels = ask('Channels, comma-separated: telegram, whatsapp; or none', 'none')
        agent['channels'] = [c.strip() for c in channels.split(',')]
        m['agents'].append(agent)
    m['development'] = []
    while yes('Create an Incus development environment (managed NAT only)?'):
        m['development'].append({'name': ask('Environment name'), 'kind': ask('Environment kind', 'container', {'container', 'vm'}), 'image': ask('Incus image identifier', 'images:ubuntu/26.04')})
    backups = yes('Enable local scheduled backups? Separate mounted storage is recommended')
    m['backups'] = {'enabled': backups, 'destination': ask('Backup destination, outside application/data directories') if backups else None}
    m['updates'] = {'automatic': yes('Enable the catalog-documented automatic update policy?')}
    validate(m)
    require(not Path(filename).exists(), 'manifest already exists; use an editor or a new --manifest path, never overwrite silently')
    private_write(filename, json.dumps(m, indent=2) + '\n')
    print(f'Non-secret answers saved with mode 0600 to {filename}. Next: bin/cortex plan --manifest {filename}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['interview', 'validate', 'plan', 'apply', 'verify'])
    parser.add_argument('--manifest', default='/etc/cortex/install.json')
    parser.add_argument('--approve', help='Exact SHA-256 approval value from the reviewed plan; never inferred')
    args = parser.parse_args()
    try:
        if args.command == 'interview':
            interview(args.manifest)
            return 0
        m = load(args.manifest)
        if args.command == 'validate':
            print('Manifest valid. Effective services: ' + ', '.join(selected(m)))
        elif args.command == 'plan':
            print(json.dumps(make_plan(m), indent=2))
        else:
            from provision import apply, verify
            if args.command == 'apply':
                plan = make_plan(m)
                require(args.approve == plan['approval'], 'apply requires --approve with the exact current plan approval hash')
                apply(m, args.manifest, plan)
            else:
                verify(m)
        return 0
    except (Invalid, OSError, ValueError) as exc:
        # Validation errors deliberately exclude supplied values and command output.
        print(f'Cortex: {exc}', file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print('Interrupted. Rerun the same approved manifest to reconcile actual state.', file=sys.stderr)
        return 130


if __name__ == '__main__':
    sys.exit(main())
