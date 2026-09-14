"""Automatic upstream runtime installation; pins reviewed from primary release metadata."""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import urllib.request
from common import run, save

HERMES_SHA = '345cd2b057a452236de401d3534b8502a7465e8d'
OPENCLAW_VERSION = '2026.9.4'
OPENCLAW_INTEGRITY = 'lTQpEEe1Xm3u2PCHaPEr+vP8paGk1vLdHuzdItsNToaLI6hAqRVvgJYg+GxukJhETJp4tPy/S1Gftl4KuB8n7A=='


def install(service, action, manifest):
    root = Path(manifest['root']) / 'runtimes'
    revision = HERMES_SHA if service == 'hermes' else OPENCLAW_VERSION
    target = root / service / revision
    binary = target / ('venv/bin/hermes' if service == 'hermes' else 'node_modules/.bin/openclaw')
    from node_install import install as install_node
    node_bin = install_node(action, manifest)
    runtime_path = str(node_bin) + ':/usr/local/bin:/usr/bin:/bin'
    if action in ('apply', 'update'):
        target.mkdir(parents=True, exist_ok=True)
        if service == 'hermes':
            run('apt-get', 'install', '-y', '--no-install-recommends', 'git', 'python3-venv', 'build-essential', 'ffmpeg', 'ripgrep')
            uv_home = root / 'uv-0.12.13'
            if not (uv_home / 'bin/uv').exists():
                run('python3', '-m', 'venv', uv_home)
                run(uv_home / 'bin/pip', 'install', '--disable-pip-version-check', 'uv==0.12.13')
            source = target / 'source'
            if not (source / '.git').exists():
                run('git', 'init', source)
                run('git', '-C', source, 'remote', 'add', 'origin', 'https://github.com/NousResearch/hermes-agent.git')
            run('git', '-C', source, 'fetch', '--depth', '1', 'origin', HERMES_SHA)
            run('git', '-C', source, 'checkout', '--detach', HERMES_SHA)
            if run('git', '-C', source, 'rev-parse', 'HEAD') != HERMES_SHA:
                raise RuntimeError('Hermes source revision mismatch')
            from common import BASE_ENV
            uv_env = dict(BASE_ENV, UV_PROJECT_ENVIRONMENT=str(target / 'venv'),
                          UV_PYTHON_INSTALL_DIR=str(root / 'python'), UV_CACHE_DIR=str(root / 'uv-cache'), PATH=runtime_path)
            result = subprocess.run([str(uv_home / 'bin/uv'), 'sync', '--project', str(source), '--frozen', '--no-dev',
                                     '--python', '3.13.9', '--extra', 'messaging', '--extra', 'anthropic', '--extra', 'mcp', '--extra', 'hindsight'],
                                    env=uv_env, capture_output=True)
            if result.returncode:
                raise RuntimeError('Hermes frozen dependency installation failed')
            # Install only the chosen WhatsApp bridge, from this same immutable source tree and its lockfile.
            if any(a['runtime'] == 'hermes' and 'whatsapp' in a['channels'] for a in manifest.get('agents', [])):
                bridge = source / 'scripts/whatsapp-bridge'
                if not (bridge / 'package-lock.json').is_file():
                    raise RuntimeError('Pinned Hermes source has no WhatsApp bridge lockfile at scripts/whatsapp-bridge')
                run('env', 'PATH=' + runtime_path, node_bin / 'npm', 'ci', '--prefix', bridge, '--omit=dev')
        else:
            artifacts = target / 'artifacts'
            artifacts.mkdir(exist_ok=True)
            packages = [
                ('openclaw.tgz', f'https://registry.npmjs.org/openclaw/-/openclaw-{OPENCLAW_VERSION}.tgz', OPENCLAW_INTEGRITY),
                ('hindsight-openclaw.tgz', 'https://registry.npmjs.org/@vectorize-io/hindsight-openclaw/-/hindsight-openclaw-0.12.0.tgz',
                 'Mfsm7GDBhTdFAP+y90JRd1I0Gl+SuFNykBHif5js4EBoSlxtqWtbteOeWy+aOPmcguV2xFurNsap5N7pDR7KUQ==')]
            archives = []
            for filename, url, expected_hash in packages:
                archive = artifacts / filename
                with urllib.request.urlopen(url, timeout=120) as response, archive.open('wb') as file:
                    while chunk := response.read(1048576):
                        file.write(chunk)
                with archive.open('rb') as file:
                    actual = base64.b64encode(hashlib.file_digest(file, 'sha512').digest()).decode()
                if actual != expected_hash:
                    raise RuntimeError('npm runtime artifact integrity mismatch')
                archives.append(str(archive))
            save(target / 'package.json', json.dumps({'name': 'cortex-openclaw-runtime', 'private': True}), 0o644)
            run('env', 'PATH=' + runtime_path, node_bin / 'npm', 'install', '--prefix', target, '--omit=dev',
                '--no-audit', '--no-fund', *archives)
        save(target / '.cortex-installed', revision + '\n', 0o644)
    if not binary.is_file() or not (target / '.cortex-installed').is_file():
        raise RuntimeError('Selected runtime has not been installed successfully')
    if action not in ('start', 'stop', 'restart'):
        with tempfile.TemporaryDirectory() as home:
            version_text = run('env', 'PATH=' + runtime_path, 'HOME=' + home, 'HERMES_HOME=' + home,
                               'OPENCLAW_STATE_DIR=' + home, binary, '--version')
        expected = '0.21.3' if service == 'hermes' else OPENCLAW_VERSION
        if expected not in version_text:
            raise RuntimeError('Installed runtime reports an unexpected version')
    return binary
