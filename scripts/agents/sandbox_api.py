"""Authenticated networkless rootless Podman/runsc execution broker, no Docker socket."""
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import re
import selectors
import subprocess
import tempfile
import threading
import time
import uuid

LIMIT = threading.BoundedSemaphore(2)
TOKEN = os.environ['CORTEX_SANDBOX_API_TOKEN']
IMAGE = os.environ['SANDBOX_IMAGE']
RUNSC = os.environ['RUNSC_BIN']
HOME = os.environ['HOME']
RUNTIME_DIR = os.environ['XDG_RUNTIME_DIR']
PODMAN_ROOT = os.environ['PODMAN_ROOT']
PODMAN_RUNROOT = os.environ['PODMAN_RUNROOT']
if any(not os.path.isabs(path) for path in (HOME, RUNTIME_DIR, PODMAN_ROOT, PODMAN_RUNROOT)):
    raise SystemExit('Sandbox HOME, XDG_RUNTIME_DIR, PODMAN_ROOT and PODMAN_RUNROOT must be absolute paths')
if (os.path.realpath(PODMAN_ROOT) != os.path.join(os.path.realpath(HOME), 'containers')
        or os.path.realpath(PODMAN_RUNROOT) != os.path.join(os.path.realpath(RUNTIME_DIR), 'storage')):
    raise SystemExit('Sandbox Podman storage must be HOME/containers and XDG_RUNTIME_DIR/storage without external symlinks')
PODMAN = ('podman', '--root', PODMAN_ROOT, '--runroot', PODMAN_RUNROOT,
          '--cgroup-manager=cgroupfs', '--runtime', RUNSC, '--runtime-flag=network=none')


def execute(payload):
    if set(payload) - {'image', 'cmd', 'env', 'timeoutSec', 'cpuMillis', 'memMB', 'networkMode', 'role', 'stdin'}:
        raise ValueError('Unknown execution field')
    if payload.get('image', IMAGE) != IMAGE or payload.get('networkMode', 'none') != 'none':
        raise ValueError('Only the operator-pinned image and networkMode=none are permitted')
    cmd = payload.get('cmd')
    if not isinstance(cmd, list) or not cmd or len(cmd) > 128 or any(not isinstance(a, str) or '\0' in a or len(a) > 8192 for a in cmd):
        raise ValueError('cmd must be a bounded argv array')
    env = payload.get('env', {})
    if not isinstance(env, dict) or len(env) > 64 or any(not re.fullmatch('[A-Za-z_][A-Za-z0-9_]*', k) or not isinstance(v, str) or '\0' in v or '\n' in v for k, v in env.items()):
        raise ValueError('Invalid guest environment')
    timeout = payload.get('timeoutSec', 30)
    memory = payload.get('memMB', 512)
    cpu = payload.get('cpuMillis', 1000)
    if any(type(v) is not int for v in (timeout, memory, cpu)) or not (1 <= timeout <= 120 and 32 <= memory <= 2048 and 100 <= cpu <= 2000):
        raise ValueError('Execution limits outside permitted range')
    stdin = payload.get('stdin', '')
    if not isinstance(stdin, str) or len(stdin.encode()) > 65536:
        raise ValueError('stdin exceeds 64KiB')
    container = 'cortex-job-' + uuid.uuid4().hex
    args = [*PODMAN, 'run', '--name', container, '--rm', '--pull=never',
            '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
            '--user=65534:65534', '--pids-limit=128', '--memory=' + str(memory) + 'm',
            '--cpus=' + str(cpu / 1000), '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m', '-i']
    # Values travel through a private file, not process arguments or service logs.
    started = time.monotonic()
    timed_out = False
    output_limit_exceeded = False
    output_limit = 1048576
    stdout = bytearray()
    stderr = bytearray()
    deadline = started + timeout
    with tempfile.TemporaryDirectory() as temporary:
        env_file = os.path.join(temporary, 'env')
        with open(env_file, 'w') as file:
            file.write(''.join(k + '=' + v + '\n' for k, v in env.items()))
        os.chmod(env_file, 0o600)
        args += ['--env-file', env_file, IMAGE, *cmd]
        # Bound the broker's pipes, not runsc's runtime backing files.
        process = None
        with selectors.DefaultSelector() as selector:
            try:
                process = subprocess.Popen(args, stdin=subprocess.PIPE,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                for pipe, buffer in ((process.stdout, stdout), (process.stderr, stderr)):
                    os.set_blocking(pipe.fileno(), False)
                    selector.register(pipe, selectors.EVENT_READ, buffer)
                input_data = memoryview(stdin.encode())
                input_offset = 0
                if input_data:
                    os.set_blocking(process.stdin.fileno(), False)
                    selector.register(process.stdin, selectors.EVENT_WRITE)
                else:
                    process.stdin.close()
                while selector.get_map() and not output_limit_exceeded:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        timed_out = True
                        break
                    for key, _ in selector.select(remaining):
                        if time.monotonic() >= deadline:
                            timed_out = True
                            break
                        pipe = key.fileobj
                        if pipe is process.stdin:
                            try:
                                input_offset += os.write(pipe.fileno(), input_data[input_offset:])
                            except BlockingIOError:
                                continue
                            except BrokenPipeError:
                                input_offset = len(input_data)
                            if input_offset == len(input_data):
                                selector.unregister(pipe)
                                pipe.close()
                        else:
                            buffer = key.data
                            available = output_limit - len(buffer)
                            try:
                                chunk = os.read(pipe.fileno(), min(65536, available + 1))
                            except BlockingIOError:
                                continue
                            if not chunk:
                                selector.unregister(pipe)
                                pipe.close()
                            else:
                                buffer.extend(chunk[:available])
                                if len(chunk) > available:
                                    output_limit_exceeded = True
                                    break
                    if timed_out:
                        break
                if not timed_out and not output_limit_exceeded:
                    try:
                        process.wait(timeout=max(0, deadline - time.monotonic()))
                    except subprocess.TimeoutExpired:
                        timed_out = True
            finally:
                try:
                    if process is not None and process.poll() is None:
                        process.kill()
                finally:
                    try:
                        subprocess.run([*PODMAN, 'rm', '--force', '--time', '0', container],
                                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                       stderr=subprocess.DEVNULL, timeout=20)
                    finally:
                        if process is not None:
                            for pipe in (process.stdin, process.stdout, process.stderr):
                                pipe.close()
                            process.wait(timeout=5)
        return {'exitCode': process.returncode, 'stdout': stdout.decode(errors='replace'),
                'stderr': stderr.decode(errors='replace'),
                'stats': {'durationMs': round((time.monotonic() - started) * 1000),
                          'timedOut': timed_out, 'signal': None,
                          'outputLimitExceeded': output_limit_exceeded}}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.reply(200 if self.path == '/healthz' else 404, {'status': 'ready'} if self.path == '/healthz' else {'error': 'not found'})

    def do_POST(self):
        if self.path != '/exec':
            self.reply(404, {'error': 'not found'})
            return
        if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + TOKEN):
            self.reply(401, {'error': 'unauthorized'})
            return
        if not LIMIT.acquire(blocking=False):
            self.reply(429, {'error': 'busy'})
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 131072:
                raise ValueError('Request must be 1–131072 bytes')
            self.connection.settimeout(10)
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload, dict):
                raise ValueError('Request must be an object')
            self.reply(200, execute(payload))
        except (ValueError, TypeError):
            self.reply(400, {'error': 'invalid execution request'})
        except Exception:
            self.reply(503, {'error': 'sandbox execution failed'})
        finally:
            LIMIT.release()


if __name__ == '__main__':
    if len(TOKEN) < 32 or not re.fullmatch(r'[^\s]+@sha256:[a-f0-9]{64}', IMAGE):
        raise SystemExit('A strong local token and immutable SANDBOX_IMAGE are required')
    # Bootstrap in the same confined executor that owns the API. A separate
    # ExecStartPre would enable cgroup controllers before PID1 starts this
    # executor, violating the cgroup-v2 no-internal-process rule.
    subprocess.run([*PODMAN, 'run', '--rm', '--pull=missing', '--network=none',
                    '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                    '--user=65534:65534', IMAGE, '/bin/true'],
                   check=True, timeout=120, stdin=subprocess.DEVNULL)
    ThreadingHTTPServer(('127.0.0.1', 8091), Handler).serve_forever()
