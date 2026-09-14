"""Browserless Chromium, digest-pinned and only loopback-published."""
import json
from pathlib import Path
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from common import finish, require, run, save, secret


def main(action, manifest):
    values = secret('kernel-browser')
    require(values, 'KERNEL_BROWSER_IMAGE', 'TOKEN')
    image = values['KERNEL_BROWSER_IMAGE']
    if not re.fullmatch(r'ghcr\.io/browserless/chromium@sha256:[a-f0-9]{64}', image):
        raise ValueError('KERNEL_BROWSER_IMAGE must pin ghcr.io/browserless/chromium by SHA-256 digest')
    target = Path(manifest['data_root']) / 'recipes/kernel-browser.json'
    if action in ('apply', 'update'):
        compose = {'services': {'kernel-browser': {'image': image, 'container_name': 'cortex-kernel-browser',
            'restart': 'unless-stopped', 'env_file': [{'path': '/etc/cortex/secrets/kernel-browser.env', 'format': 'raw'}],
            'environment': {'CONCURRENT': '2', 'QUEUED': '4', 'TIMEOUT': '60000', 'ALLOW_FILE_PROTOCOL': 'false',
                            'DISABLE_BLOCKLIST': 'false', 'CORS': 'false', 'DEBUG': '-*', 'LOG_LEVEL': 'error'},
            'ports': ['127.0.0.1:3333:3000'], 'networks': ['cortex-private'],
            'security_opt': ['no-new-privileges:true'], 'cap_drop': ['ALL'], 'shm_size': '512m',
            'mem_limit': '2g', 'cpus': 2, 'pids_limit': 512}},
            'networks': {'cortex-private': {'external': True}}}
        save(target, json.dumps(compose, indent=2))
    base = ['docker', 'compose', '--project-name', 'cortex-kernel-browser', '-f', str(target)]
    if action in ('apply', 'update'):
        run(*base, 'up', '-d', '--pull', 'always')
    elif action in ('start', 'stop', 'restart'):
        run(*base, action)
    if action == 'stop':
        return
    state = json.loads(run('docker', 'inspect', 'cortex-kernel-browser'))[0]
    if not state['State']['Running'] or state['Config']['Image'] != image:
        raise RuntimeError('Browser runtime stopped or image drifted')
    bindings = state['HostConfig']['PortBindings']
    if bindings != {'3000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '3333'}]} or state['HostConfig']['Privileged']:
        raise RuntimeError('Browser isolation/published ports drifted')
    # Actual browser work, not merely a listener: render a synthetic HTML document as PDF.
    url = 'http://127.0.0.1:3333/pdf?token=' + urllib.parse.quote(values['TOKEN'], safe='')
    request = urllib.request.Request(url, data=json.dumps({'html': '<html><body>Cortex browser probe</body></html>'}).encode(),
                                     headers={'Content-Type': 'application/json'})
    # A Docker-published TCP socket can accept while the HTTP worker still
    # resets connections. Wait on the actual idempotent browser operation,
    # never accept a listener or an authentication/configuration error as ready.
    deadline = time.monotonic() + 120
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError('Browser HTTP/PDF endpoint did not become ready') from None
        try:
            with urllib.request.urlopen(request, timeout=min(90, remaining)) as response:
                if response.status != 200 or not response.read(5).startswith(b'%PDF-'):
                    raise RuntimeError('Browser PDF execution probe failed')
            break
        except urllib.error.HTTPError as error:
            if error.code not in (502, 503, 504):
                raise
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            pass
        time.sleep(min(1, max(0, deadline - time.monotonic())))


if __name__ == '__main__':
    finish(main)
