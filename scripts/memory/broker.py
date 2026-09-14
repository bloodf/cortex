#!/usr/bin/env python3
"""Fail-closed Hindsight data-plane broker. No agent credential reaches upstream."""
import hmac
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import threading
import uuid

CONFIG = Path('/etc/cortex/secrets/memory-broker.json')
UPSTREAM = ('127.0.0.1', 19888)
BANK = re.compile(r'agent-[a-z][a-z0-9-]{0,23}')
ROUTE = re.compile(r'/v1/default/banks/(agent-[a-z][a-z0-9-]{0,23})/(memories|memories/recall|reflect)')
LIMIT = 1024 * 1024


def load_config():
    from memoryctl import read_private
    value = json.loads(read_private(CONFIG))
    if not all(isinstance(value.get(k), str) and len(value[k]) >= 40 for k in ('upstream_key', 'admin_key')):
        raise ValueError('Invalid broker credentials')
    seen = {value['upstream_key'], value['admin_key']}
    for name, identity in value['agents'].items():
        if not re.fullmatch(r'[a-z][a-z0-9-]{0,23}', name) or identity['bank'] != 'agent-' + name:
            raise ValueError('Invalid bank identity')
        token = identity['token']
        if not isinstance(token, str) or len(token) < 40 or token in seen:
            raise ValueError('Non-unique identity credential')
        seen.add(token)
    return value


def request(method, path, key=None, body=None, timeout=300):
    connection = http.client.HTTPConnection(*UPSTREAM, timeout=timeout)
    headers = {'Accept': 'application/json'}
    if key:
        headers['Authorization'] = 'Bearer ' + key
    if body is not None:
        body = json.dumps(body).encode()
        headers['Content-Type'] = 'application/json'
    try:
        connection.request(method, path, body, headers)
        response = connection.getresponse()
        return response.status, response.read(LIMIT * 8)
    finally:
        connection.close()


def upstream_gate(config):
    """A reachable health endpoint is NOT proof of native authorization."""
    paths = [('GET', '/v1/default/banks', None),
             ('POST', '/v1/default/banks/cortex-auth-probe/memories/recall', {'query': 'authorization probe'}),
             ('POST', '/v1/default/banks/cortex-auth-probe/reflect', {'query': 'authorization probe'})]
    for method, path, body in paths:
        for key in (None, 'cortex-invalid-token'):
            status, _ = request(method, path, key, body, timeout=15)
            if status not in (401, 403):
                raise RuntimeError('Hindsight native authentication denied-proof failed; broker remains closed')
    status, _ = request('GET', '/v1/default/banks', config['upstream_key'], timeout=15)
    if status != 200:
        raise RuntimeError('Hindsight independent upstream credential rejected')
    from memoryctl import broker_request
    if broker_request('GET', '/api/banks', port=9999)[0] != 401:
        raise RuntimeError('Native control-plane guard did not deny anonymous access')
    status, _ = broker_request('GET', '/api/banks', config['admin_key'], basic=True, port=9999)
    if status in (502, 503, 504):
        raise ConnectionError('Native control plane is not ready')
    if status != 200:
        raise RuntimeError('Native control-plane authenticated API failed')


def payload(route, value):
    if not isinstance(value, dict):
        raise ValueError('Expected JSON object')
    if route == 'memories':
        if set(value) - {'items', 'async', 'document_tags', 'operation_id'} or type(value.get('async', False)) is not bool:
            raise ValueError('Unsupported retain request')
        if value.get('operation_id') is not None:
            uuid.UUID(value['operation_id'])
        items = value.get('items')
        if not isinstance(items, list) or not 1 <= len(items) <= 100:
            raise ValueError('Expected 1 to 100 memory items')
        for item in items:
            if not isinstance(item, dict) or set(item) - {'content', 'context', 'timestamp', 'document_id', 'metadata', 'tags', 'update_mode'}:
                raise ValueError('Unsupported memory item')
            if not isinstance(item.get('content'), str) or not item['content'].strip():
                raise ValueError('Memory content must be text')
    else:
        allowed = {'query', 'budget', 'max_tokens', 'tags', 'tags_match', 'tag_groups', 'include'}
        allowed |= {'types', 'query_timestamp', 'trace', 'prefer_observations', 'min_scores'} if route == 'memories/recall' else {'context', 'response_schema'}
        if set(value) - allowed or not isinstance(value.get('query'), str) or not value['query'].strip():
            raise ValueError('Unsupported query payload')
        if 'max_tokens' in value and (type(value['max_tokens']) is not int or not 1 <= value['max_tokens'] <= 32768):
            raise ValueError('Invalid max_tokens')
    return value


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 32
    slots = threading.BoundedSemaphore(32)

    def process_request(self, request_socket, address):
        if not self.slots.acquire(blocking=False):
            request_socket.close()
            return
        try:
            super().process_request(request_socket, address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request_socket, address):
        try:
            super().process_request_thread(request_socket, address)
        finally:
            self.slots.release()

    def handle_error(self, request_socket, client_address):
        pass  # Never log headers, request bodies, tokens, or upstream exception text.


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'CortexMemory'
    sys_version = ''

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def log_message(self, *args):
        pass

    def reply(self, status, data, content_type='application/json; charset=utf-8', challenge=False):
        if not isinstance(data, bytes):
            data = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
        self.send_header('Connection', 'close')
        if challenge:
            self.send_header('WWW-Authenticate', 'Basic realm="Cortex memory operator", charset="UTF-8"')
        self.end_headers()
        self.close_connection = True
        self.wfile.write(data)

    def body(self):
        lengths = self.headers.get_all('Content-Length', [])
        if self.headers.get('Transfer-Encoding') or len(lengths) != 1 or not lengths[0].isdigit():
            raise ValueError('A single Content-Length is required')
        length = int(lengths[0])
        if not 0 < length <= LIMIT:
            raise ValueError('Request exceeds body limit')
        data = self.rfile.read(length)
        if len(data) != length:
            raise ValueError('Incomplete request')
        return data

    def dispatch(self):
        config = load_config()  # Atomic provisioning/revocation is effective next request.
        if len(self.headers.get_all('Host', [])) != 1 or self.headers['Host'] not in ('127.0.0.1:8888', 'localhost:8888'):
            return self.reply(403, {'error': 'Host not permitted'})
        if self.command == 'GET' and self.path == '/health':
            status, _ = request('GET', '/health', timeout=10)
            return self.reply(200 if status == 200 else 503, {'status': 'ok' if status == 200 else 'unavailable'})
        if len(self.headers.get_all('Authorization', [])) != 1:
            return self.reply(401, {'error': 'Authentication required'})
        authorization = self.headers['Authorization']
        if not authorization.startswith('Bearer '):
            return self.reply(401, {'error': 'Bearer authentication required'})
        token = authorization[7:]
        identity = None
        for candidate in config['agents'].values():
            if hmac.compare_digest(token, candidate['token']):
                identity = candidate
        if identity is None:
            return self.reply(401, {'error': 'Invalid identity'})
        if self.command == 'GET' and self.path == '/version':
            status, data = request('GET', self.path, config['upstream_key'], timeout=15)
            return self.reply(status, data)
        match = ROUTE.fullmatch(self.path)
        if not match or self.command != 'POST':
            return self.reply(403, {'error': 'Endpoint not permitted'})
        bank, operation = match.groups()
        if bank != identity['bank']:
            return self.reply(403, {'error': 'Bank not permitted'})
        if self.headers.get_content_type() != 'application/json':
            raise ValueError('Expected application/json')
        value = payload(operation, json.loads(self.body()))
        if operation == 'memories' and value.get('operation_id'):
            # Native operation IDs share an upstream namespace. Derive a stable,
            # bank-specific UUID so another identity cannot collide or replay it.
            value['operation_id'] = str(uuid.uuid5(uuid.NAMESPACE_URL, identity['bank'] + ':' + value['operation_id']))
        self.proxy(config, '/v1/default/banks/' + identity['bank'] + '/' + operation, value)

    def proxy(self, config, path, value):
        connection = http.client.HTTPConnection(*UPSTREAM, timeout=300)
        started = False
        try:
            connection.request('POST', path, json.dumps(value).encode(),
                               {'Authorization': 'Bearer ' + config['upstream_key'], 'Content-Type': 'application/json', 'Accept': 'application/json'})
            response = connection.getresponse()
            if not 200 <= response.status < 300:
                response.read(LIMIT)
                return self.reply(response.status if 400 <= response.status < 500 else 502,
                                  {'error': 'Upstream rejected request' if response.status < 500 else 'Memory processing failed'})
            self.send_response(response.status)
            self.send_header('Content-Type', response.getheader('Content-Type', 'application/json'))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Connection', 'close')
            self.end_headers()
            started = True
            self.close_connection = True
            # Decoded HTTP chunks are forwarded incrementally; no upstream cookies,
            # redirects, credentials, framing headers, or compression are forwarded.
            while chunk := response.read1(65536):
                self.wfile.write(chunk)
                self.wfile.flush()
        except (OSError, http.client.HTTPException):
            if not started:
                self.reply(502, {'error': 'Memory upstream unavailable'})
            self.close_connection = True
        finally:
            connection.close()


    def handle_request(self):
        try:
            self.dispatch()
        except (ValueError, UnicodeError, KeyError):
            self.reply(400, {'error': 'Invalid memory request'})
        except (OSError, http.client.HTTPException):
            self.reply(503, {'error': 'Memory service unavailable'})

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_HEAD = handle_request


def serve():
    config = load_config()
    upstream_gate(config)
    Server(('127.0.0.1', 8888), Handler).serve_forever()


if __name__ == '__main__':
    try:
        serve()
    except Exception:
        raise SystemExit('Memory broker refused startup; inspect protected configuration and native authentication') from None
