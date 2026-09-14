"""Configure only named manifest agents and development instances, after service recipes."""
import json
import os
from pathlib import Path
import secrets
import urllib.request
from common import account, finish, name, require, run, runtime, save, secret, service_action, unit_path
from common import directory


def render_unit(manifest, identity, user, home, env, port, command, bridge=False):
    template = (Path(manifest['root']) / 'templates/agents/runtime.service').read_text()
    fields = {'ROOT': manifest['root'], 'IDENTITY': identity, 'USER': user, 'HOME': str(home),
              'ENV': str(env), 'PORT': str(port), 'COMMAND': command}
    for key, value in fields.items():
        if '\n' in value or '\r' in value or '%' in value:
            raise ValueError('Unsafe systemd template value')
        template = template.replace('@' + key + '@', value)
    ports = [port, port + 100] if bridge else [port]
    template = template.replace('@PROBE_PORTS@', ' '.join('--port ' + str(p) for p in ports))
    template = template.replace('@BIND_ALLOWS@', '\n'.join('SocketBindAllow=tcp:' + str(p) for p in ports))
    save(unit_path(identity), template, 0o644)


def agent(action, manifest, spec, port):
    agent_name = name(spec['name'])
    kind = spec['runtime']
    if kind not in ('hermes', 'openclaw') or kind not in manifest['services']:
        raise ValueError('Agent runtime must be explicitly selected as a service')
    channels = set(spec['channels'])
    if not channels <= {'none', 'telegram', 'whatsapp'} or ('none' in channels and len(channels) != 1):
        raise ValueError('Invalid agent channels')
    if not spec['model'] or any(c in spec['model'] for c in '\r\n'):
        raise ValueError('An explicit model is required')
    identity = 'cortex-agent-' + agent_name
    home = Path(manifest['data_root']) / 'agents' / agent_name
    if action in ('stop', 'start', 'restart'):
        service_action(identity, action)
        return
    values = secret('agent-' + agent_name)
    require(values, 'MODEL_PROVIDER')
    require(values, 'HINDSIGHT_API_KEY', 'HINDSIGHT_API_URL', 'HINDSIGHT_BANK_ID')
    if values['HINDSIGHT_API_URL'] != 'http://127.0.0.1:8888' or values['HINDSIGHT_BANK_ID'] != 'agent-' + agent_name:
        raise ValueError('Agent memory must use its own broker bank and the authenticated loopback broker')
    allowed = {'MODEL_PROVIDER', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
               'OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
               'GROQ_API_KEY', 'XAI_API_KEY', 'MISTRAL_API_KEY', 'MINIMAX_API_KEY', 'MINIMAX_BASE_URL',
               'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'ZAI_API_KEY', 'GLM_API_KEY', 'KIMI_API_KEY',
               'HF_TOKEN', 'COPILOT_GITHUB_TOKEN', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'}
    if 'telegram' in channels:
        allowed.update({'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USERS'})
    if 'hindsight' in manifest['services']:
        allowed.update({'HINDSIGHT_API_KEY', 'HINDSIGHT_API_URL', 'HINDSIGHT_BANK_ID'})
    if 'whatsapp' in channels:
        allowed.add('WHATSAPP_ALLOWED_USERS')
    if set(values) - allowed:
        raise ValueError('Agent environment contains unsupported provider or unselected channel settings')
    if values.get('GATEWAY_ALLOW_ALL_USERS', '').lower() in ('true', '1'):
        raise ValueError('Open channel access is forbidden')
    if 'telegram' in channels:
        require(values, 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USERS')
    if 'whatsapp' in channels:
        require(values, 'WHATSAPP_ALLOWED_USERS')
    executable = runtime(kind, 'verify', manifest)
    if action in ('apply', 'update'):
        entry = account('cx-' + agent_name, home, manifest['data_root'])
        # A private generated local gateway token is not an external provider credential.
        token_file = Path('/etc/cortex/secrets') / ('agent-' + agent_name + '-local.env')
        if not token_file.exists():
            save(token_file, 'HERMES_API_KEY=' + secrets.token_hex(32) + '\n')
        token = secret('agent-' + agent_name + '-local')['HERMES_API_KEY']
        runtime_env = dict(values)
        runtime_env.pop('MODEL_PROVIDER', None)
        if 'telegram' not in channels:
            runtime_env.pop('TELEGRAM_BOT_TOKEN', None)
        if 'whatsapp' not in channels:
            runtime_env['WHATSAPP_ENABLED'] = 'false'
        else:
            runtime_env['WHATSAPP_ENABLED'] = 'true'
        runtime_env['GATEWAY_ALLOW_ALL_USERS'] = 'false'
        if kind == 'hermes':
            config = {'model': {'default': spec['model'], 'provider': values['MODEL_PROVIDER']},
                      'memory': {'provider': 'hindsight'},
                      'terminal': {'backend': 'local', 'cwd': str(home / 'workspace')},
                      'platforms': {'api_server': {'enabled': True, 'extra': {'direct_model_requests': True}},
                                    'telegram': {'enabled': 'telegram' in channels},
                                    'whatsapp': {'enabled': 'whatsapp' in channels, 'bridge_port': port + 100,
                                                 'dm_policy': 'allowlist', 'group_policy': 'disabled'}}}
            if values.get('OPENAI_BASE_URL'):
                config['model']['base_url'] = values['OPENAI_BASE_URL']
            # JSON is valid YAML; no interpolation or YAML parser is required in the installer.
            config_path = home / 'config.yaml'
            memory_fd = directory(home / 'hindsight', (entry.pw_uid, entry.pw_gid))
            os.close(memory_fd)
            save(home / 'hindsight/config.json', json.dumps({'mode': 'local_external',
                 'api_url': values['HINDSIGHT_API_URL'], 'bank_id': values['HINDSIGHT_BANK_ID'],
                 'memory_mode': 'hybrid', 'auto_retain': True, 'auto_recall': True, 'retain_async': False}),
                 owner=(entry.pw_uid, entry.pw_gid))
            runtime_env.update(HERMES_HOME=str(home), API_SERVER_ENABLED='true',
                               API_SERVER_HOST='127.0.0.1', API_SERVER_PORT=str(port), API_SERVER_KEY=token)
            command = str(executable) + ' gateway run'
        else:
            config = {'agents': {'defaults': {'model': {'primary': spec['model']}, 'workspace': str(home / 'workspace')}},
                      'plugins': {'slots': {'memory': 'hindsight-openclaw'},
                                  'load': {'paths': [str(executable.parent.parent / '@vectorize-io/hindsight-openclaw')]},
                                  'entries': {'hindsight-openclaw': {'enabled': True, 'config': {
                                      'hindsightApiUrl': values['HINDSIGHT_API_URL'],
                                      'hindsightApiToken': {'source': 'env', 'provider': 'default', 'id': 'HINDSIGHT_API_KEY'},
                                      'bankId': values['HINDSIGHT_BANK_ID'], 'dynamicBankId': False,
                                      'autoRecall': True, 'autoRetain': True}}}},
                      'gateway': {'mode': 'local', 'bind': 'loopback', 'port': port,
                                  'auth': {'mode': 'token', 'token': '${OPENCLAW_GATEWAY_TOKEN}'},
                                  'http': {'endpoints': {'chatCompletions': {'enabled': True}}}},
                      'channels': {}, 'update': {'checkOnStart': False},
                      'discovery': {'mdns': {'mode': 'off'}}}
            if 'telegram' in channels:
                config['channels']['telegram'] = {'enabled': True, 'botToken': '${TELEGRAM_BOT_TOKEN}',
                    'dmPolicy': 'allowlist', 'allowFrom': values['TELEGRAM_ALLOWED_USERS'].split(','), 'groupPolicy': 'disabled'}
            if 'whatsapp' in channels:
                config['channels']['whatsapp'] = {'dmPolicy': 'allowlist',
                    'allowFrom': values['WHATSAPP_ALLOWED_USERS'].split(','), 'groupPolicy': 'disabled'}
            config_path = home / 'openclaw.json'
            runtime_env.update(OPENCLAW_CONFIG_PATH=str(config_path), OPENCLAW_STATE_DIR=str(home), OPENCLAW_GATEWAY_TOKEN=token)
            command = str(executable) + ' gateway run'
            if values.get('OPENAI_BASE_URL'):
                require(values, 'OPENAI_API_KEY')
                config['models'] = {'mode': 'merge', 'providers': {'cortex': {
                    'baseUrl': values['OPENAI_BASE_URL'], 'apiKey': '${OPENAI_API_KEY}',
                    'api': 'openai-completions', 'models': [{'id': spec['model'], 'name': spec['model']}]}}}
                config['agents']['defaults']['model']['primary'] = 'cortex/' + spec['model']
        save(config_path, json.dumps(config, indent=2) + '\n', owner=(entry.pw_uid, entry.pw_gid))
        workspace_fd = directory(home / 'workspace', (entry.pw_uid, entry.pw_gid))
        os.close(workspace_fd)
        # systemd environment values are quoted, never interpreted as shell statements.
        effective_env = Path('/etc/cortex/secrets') / ('agent-' + agent_name + '-runtime.env')
        runtime_env['HERMES_API_KEY'] = token
        from node_install import install as install_node
        runtime_env['PATH'] = str(install_node('verify', manifest)) + ':/usr/local/bin:/usr/bin:/bin'
        save(effective_env, ''.join(k + '=' + json.dumps(v) + '\n' for k, v in runtime_env.items()))
        render_unit(manifest, identity, 'cx-' + agent_name, home, effective_env, port, command,
                    bridge=kind == 'hermes' and 'whatsapp' in channels)
    service_action(identity, action)
    # ExecStartPre ran under the exact runtime UID and policy on the latest start.
    pre = run('systemctl', 'show', identity, '--property=ExecStartPre', '--value')
    if 'status=0' not in pre:
        raise RuntimeError('Runtime confinement preflight did not succeed')
    import time
    token = secret('agent-' + agent_name + '-local')['HERMES_API_KEY']
    health_path = '/v1/models' if kind == 'hermes' else '/healthz'
    req = urllib.request.Request(f'http://127.0.0.1:{port}{health_path}', headers={'Authorization': 'Bearer ' + token})
    for attempt in range(30):
        try:
            with urllib.request.urlopen(req, timeout=5) as response:
                if response.status != 200:
                    raise RuntimeError('Runtime HTTP health failed')
            break
        except OSError:
            if attempt == 29:
                raise RuntimeError('Runtime HTTP readiness did not succeed') from None
            time.sleep(2)
    if channels - {'none'}:
        print(f'{identity}: runtime healthy; external channel pairing and real message delivery remain operator acceptance checks')


def main(action, manifest):
    specs = sorted(manifest.get('agents', []), key=lambda item: item['name'])
    if len(specs) > 100:
        raise ValueError('At most 100 agents are supported (loopback ports 18800–18899)')
    if specs and 'hindsight' not in manifest['services']:
        raise ValueError('Every named agent requires selected Hindsight and a bank-scoped broker credential')
    registry = {'profiles': [
        {'profile': spec['name'], 'home': str(Path(manifest['data_root']) / 'agents' / spec['name']),
         'apiPort': 18800 + index, 'model': spec['model'], 'runtime': spec['runtime'],
         'unitName': 'cortex-agent-' + spec['name'] + '.service',
         'hindsightBank': 'agent-' + spec['name'],
         'secretPath': '/etc/cortex/secrets/agent-' + spec['name'] + '-runtime.env', 'apps': []}
        for index, spec in enumerate(specs)]}
    if action in ('apply', 'update'):
        # Stop selected old units before reallocating sorted ports or changing egress rules.
        existing = {line.split()[0] for line in run('systemctl', 'list-unit-files', '--type=service', '--no-legend', '--no-pager').splitlines() if line.split()}
        for spec in specs:
            identity = 'cortex-agent-' + name(spec['name']) + '.service'
            if identity in existing:
                run('systemctl', 'stop', identity)
        from firewall import apply as apply_firewall
        apply_firewall(manifest)
        save(Path(manifest['data_root']) / 'hermes/profiles.json', json.dumps(registry, indent=2) + '\n', 0o644)
    elif action in ('start', 'restart'):
        from firewall import apply as apply_firewall
        apply_firewall(manifest)
    for index, spec in enumerate(specs):
        agent(action, manifest, spec, 18800 + index)
    if manifest.get('development'):
        if 'incus' not in manifest['services']:
            raise ValueError('Development instances require explicitly selected incus')
        if action in ('apply', 'update', 'start', 'restart'):
            from development_network import apply as apply_development_network
            apply_development_network(manifest)
        from incus import development
        for spec in manifest['development']:
            development(action, manifest, spec)


if __name__ == '__main__':
    finish(main)
