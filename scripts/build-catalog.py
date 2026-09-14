#!/usr/bin/env python3
"""Regenerate the public catalog from the four owned recipe families."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATEGORIES = {'core': 'infrastructure', 'apps': 'applications',
              'observability': 'observability', 'agents': 'agents'}


def main():
    services = []
    for family, category in CATEGORIES.items():
        rows = json.loads((ROOT / 'catalog' / (family + '.json')).read_text())['services']
        for row in rows:
            id = row['id']
            row['secret_keys'] = list(dict.fromkeys([*row.get('secret_keys', []),
                *row.get('secret_defaults', {}), *row.get('generated_secrets', []),
                *row.get('required_secrets', [])]))
            row.setdefault('conflicts', [])
            endpoint = row.get('endpoint') or '#'
            endpoint = endpoint if endpoint.startswith(('http://', 'https://')) else '#'
            probe = row.get('verify', {})
            containers = []
            if row['kind'] == 'compose':
                recipe = json.loads((ROOT / row['recipe']).read_text())
                containers = [service['container_name'] for service in recipe['services'].values()
                              if service.get('container_name')]
            unit = {'dashboard': 'cortex-dashboard.service', 'caddy': 'caddy.service',
                    'tailscale': 'tailscaled.service', 'incus': 'incus.service',
                    'sandbox-runner': 'cortex-sandbox-runner.service'}.get(id)
            if id == 'kernel-browser':
                containers = ['cortex-kernel-browser']
            dashboard = {
                'health_type': 'http' if probe.get('type') == 'http' else
                    ('tcp' if probe.get('type') == 'tcp' else 'none'),
                'health_url': ('tcp://127.0.0.1:' + str(probe['port'])) if probe.get('type') == 'tcp' else probe.get('url', '#'),
                'open_url': endpoint,
                'has_webui': endpoint != '#',
                'unit_name': unit,
                'container_names': containers,
                'category': category,
                'env_file': id + '.env',
            }
            dashboard.update(row.get('dashboard', {}))
            row['dashboard'] = dashboard
            if id in ('hermes', 'openclaw'):
                row['dashboard']['health_type'] = 'none'
                row['dashboard']['health_url'] = '#'
            services.append(row)
    (ROOT / 'catalog/services.json').write_text(json.dumps({'schema_version': 1, 'services': services}, indent=2) + '\n')


if __name__ == '__main__':
    main()
