"""Generic coding tools and opt-in public-key SSH inside the explicitly chosen Linux image."""
import json
import re
from common import run, secret

INSTALL = r'''set -eu
ssh_enabled="$1"; shift
if command -v apt-get >/dev/null 2>&1; then
 export DEBIAN_FRONTEND=noninteractive
 if [ "$ssh_enabled" = yes ]; then
  policy_backup=$(mktemp -d /usr/sbin/.cortex-policy.XXXXXX)
  if [ -e /usr/sbin/policy-rc.d ] || [ -L /usr/sbin/policy-rc.d ]; then
   mv /usr/sbin/policy-rc.d "$policy_backup/original"
  fi
  restore_policy() {
   rm -f /usr/sbin/policy-rc.d
   if [ -e "$policy_backup/original" ] || [ -L "$policy_backup/original" ]; then
    mv "$policy_backup/original" /usr/sbin/policy-rc.d
   fi
   rmdir "$policy_backup"
  }
  trap restore_policy EXIT
  trap 'exit 1' HUP INT TERM
  printf '#!/bin/sh\nexit 101\n' >/usr/sbin/policy-rc.d
  chmod 755 /usr/sbin/policy-rc.d
  systemctl --root=/ unmask ssh.service ssh.socket
 fi
 apt-get update
 apt-get install -y --no-install-recommends ca-certificates git curl build-essential python3 "$@"
 if [ "$ssh_enabled" = yes ]; then
  apt-get install -y --no-install-recommends openssh-server openssl passwd
 fi
elif command -v dnf >/dev/null 2>&1; then
 dnf install -y ca-certificates git curl gcc gcc-c++ make python3 "$@"
 if [ "$ssh_enabled" = yes ]; then
  systemctl mask sshd.service
  dnf install -y openssh-server openssl shadow-utils
 fi
elif command -v apk >/dev/null 2>&1; then
 apk add --no-cache ca-certificates git curl build-base python3 "$@"
 if [ "$ssh_enabled" = yes ]; then apk add --no-cache openssh-server openssh-keygen openssl shadow; fi
else
 echo 'Unsupported chosen image: require Debian/Ubuntu apt, Fedora-family dnf, or Alpine apk' >&2
 exit 1
fi
'''
SSH_CONFIG = '''Port 22
ListenAddress 0.0.0.0
HostKey /etc/ssh/ssh_host_ed25519_key
AuthorizedKeysFile /root/.ssh/authorized_keys
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
AllowUsers root
AllowTcpForwarding no
AllowAgentForwarding no
X11Forwarding no
PermitTunnel no
GatewayPorts no
UsePAM no
Subsystem sftp internal-sftp
'''
PROVISION_SSH = r'''import json, pathlib, pwd, secrets, subprocess, sys, time
v = json.load(sys.stdin)
account = pwd.getpwnam('root')
if account.pw_dir != '/root': raise RuntimeError('Optional SSH requires the supported root home /root')
def command(argv, data=None):
    result = subprocess.run(argv, input=data, text=True, capture_output=True)
    if result.returncode: raise RuntimeError('Guest key-only account provisioning failed')
    return result.stdout.strip()
shadow = next(line.split(':') for line in pathlib.Path('/etc/shadow').read_text().splitlines() if line.startswith('root:'))
if not shadow[1] or shadow[1].startswith(('!', '*')):
    # OpenSSH with UsePAM=no rejects locked accounts even for valid public keys.
    # Use an undisclosed random password hash to make the account eligible; SSH password auth stays disabled.
    digest = command(['openssl', 'passwd', '-6', '-stdin'], secrets.token_urlsafe(64) + '\n')
    command(['chpasswd', '-e'], 'root:' + digest + '\n')
command(['chage', '-E', '-1', '-M', '-1', '-d', str(int(time.time() // 86400)), 'root'])
if account.pw_shell.rsplit('/', 1)[-1] in ('nologin', 'false'):
    command(['usermod', '-s', '/bin/sh', 'root'])
shadow = next(line.split(':') for line in pathlib.Path('/etc/shadow').read_text().splitlines() if line.startswith('root:'))
if not shadow[1] or shadow[1].startswith(('!', '*')) or shadow[7] not in ('', '-1'):
    raise RuntimeError('Root account remains ineligible for key-only SSH')
p = pathlib.Path('/root/.ssh'); p.mkdir(mode=0o700, parents=True, exist_ok=True); p.chmod(0o700)
k = p / 'authorized_keys'
existing = k.read_text().splitlines() if k.exists() else []
if v['key'] not in existing: existing.append(v['key'])
k.write_text('\n'.join(existing) + '\n'); k.chmod(0o600)
pathlib.Path('/etc/cortex-sshd.conf').write_text(v['config'])
'''
START_SSH = r'''set -eu
ssh-keygen -A
mkdir -p /run/sshd
/usr/sbin/sshd -t -f /etc/cortex-sshd.conf
if command -v systemctl >/dev/null 2>&1; then
 if [ -f /etc/debian_version ]; then systemctl unmask ssh.service ssh.socket; systemctl disable --now ssh.socket ssh.service; else systemctl unmask sshd.service; systemctl disable --now sshd.service; fi
 cat >/etc/systemd/system/cortex-ssh.service <<'UNIT'
[Unit]
Description=Cortex opt-in public-key SSH
After=network.target
[Service]
ExecStart=/usr/sbin/sshd -D -e -f /etc/cortex-sshd.conf
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
 systemctl daemon-reload
 systemctl enable --now cortex-ssh.service
 systemctl restart cortex-ssh.service
else
 if rc-service sshd status >/dev/null 2>&1; then rc-service sshd stop; fi
 cat >/etc/init.d/cortex-ssh <<'INIT'
#!/sbin/openrc-run
command=/usr/sbin/sshd
command_args='-D -e -f /etc/cortex-sshd.conf'
command_background=true
pidfile=/run/cortex-ssh.pid
depend() { need net; }
INIT
 chmod 755 /etc/init.d/cortex-ssh
 rc-update add cortex-ssh default
 rc-service cortex-ssh restart
fi
'''


def provision(instance, project):
    try:
        values = secret('development-' + instance)
    except FileNotFoundError:
        values = {}
    if set(values) - {'SSH_PUBLIC_KEY', 'EXTRA_PACKAGES'}:
        raise ValueError('Development environment permits only SSH_PUBLIC_KEY and EXTRA_PACKAGES')
    packages = values.get('EXTRA_PACKAGES', '').split()
    if any(not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.+:_-]*', package) for package in packages):
        raise ValueError('EXTRA_PACKAGES must be whitespace-separated package names, never package-manager flags')
    key = values.get('SSH_PUBLIC_KEY')
    if key and not re.fullmatch(r'(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,2}(?: [^\r\n]+)?', key):
        raise ValueError('SSH_PUBLIC_KEY must be one OpenSSH public key without authorized_keys options')
    prefix = ['incus', 'exec', instance, '--project', project, '--']
    run(*prefix, '/bin/sh', '-c', INSTALL, 'cortex-tools', 'yes' if key else 'no', *packages)
    if key:
        run(*prefix, 'python3', '-c', PROVISION_SSH, input=json.dumps({'key': key, 'config': SSH_CONFIG}))
        run(*prefix, '/bin/sh', '-c', START_SSH)
        output = run(*prefix, '/usr/sbin/sshd', '-T', '-f', '/etc/cortex-sshd.conf')
        if 'passwordauthentication no' not in output.splitlines() or 'kbdinteractiveauthentication no' not in output.splitlines():
            raise RuntimeError('Chosen image did not enforce key-only SSH')
    else:
        run(*prefix, '/bin/sh', '-c', '''set -eu
if [ -f /etc/systemd/system/cortex-ssh.service ]; then
 systemctl disable --now cortex-ssh.service
elif [ -f /etc/init.d/cortex-ssh ]; then
 if rc-service cortex-ssh status >/dev/null 2>&1; then rc-service cortex-ssh stop; fi
 python3 -c "from pathlib import Path; Path('/etc/runlevels/default/cortex-ssh').unlink(missing_ok=True)"
fi
''')
