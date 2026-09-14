"""Provision the mail worker role against the migrated dashboard database."""
import argparse
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import tempfile
from urllib.parse import quote


def read_env(path):
    state = path.lstat()
    if not stat.S_ISREG(state.st_mode) or state.st_uid != 0 or state.st_mode & 0o077:
        raise ValueError('Expected root-owned mode 0600 secret file')
    values = {}
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        key, separator, value = line.partition('=')
        if not separator or not re.fullmatch(r'[A-Z][A-Z0-9_]*', key):
            raise ValueError('Malformed secret environment')
        parts = shlex.split(value, comments=False)
        if len(parts) > 1:
            raise ValueError('Quote environment values containing spaces')
        values[key] = parts[0] if parts else ''
    return values


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['apply'])
    parser.add_argument('--manifest', required=True)
    args = parser.parse_args()
    manifest = json.loads(Path(args.manifest).read_text())
    secrets = Path(os.environ.get('CORTEX_SECRETS_DIR', '/etc/cortex/secrets'))
    core = read_env(secrets / 'postgresql.env')
    path = secrets / 'mail-guardian.env'
    local = read_env(path)
    database = core.get('POSTGRES_DB', 'cortex')
    owner = core.get('POSTGRES_USER', 'cortex')
    if not all(re.fullmatch(r'[a-z_][a-z0-9_]*', name) for name in (database, owner)):
        raise ValueError('Unsupported PostgreSQL identifier')
    password = local.get('MAIL_GUARDIAN_DB_PASSWORD', '')
    if not re.fullmatch(r'[a-f0-9]{64}', password):
        raise ValueError('Expected generated mail database password')
    def sql(statement):
        result = subprocess.run(['docker', 'exec', '-i', 'cortex-postgresql', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', owner, '-d', database], input=statement, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        return result.stdout.strip()
    account_count = int(sql('SELECT count(*) FROM public.mail_guardian_accounts WHERE enabled;'))
    env_count = int(local.get('MAIL_GUARDIAN_ACCOUNT_COUNT', '0'))
    if env_count < 0 or env_count > 100:
        raise ValueError('Environment accounts must be between zero and 100')
    if not account_count and env_count < 1:
        raise ValueError('Add an account in dashboard Mail settings or protected account environment before applying mail-guardian')
    for number in range(1, env_count + 1):
        prefix = f'MAIL_GUARDIAN_ACCOUNT_{number}_'
        if not all(local.get(prefix + suffix) for suffix in ('SLUG', 'ADDRESS', 'HOST', 'USERNAME', 'PASSWORD_B64')):
            raise ValueError('Incomplete local mail account configuration')
    sql(f"""BEGIN;
DO $role$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mail_guardian') THEN
    CREATE ROLE mail_guardian LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $role$;
ALTER ROLE mail_guardian PASSWORD '{password}';
GRANT CONNECT ON DATABASE "{database}" TO mail_guardian;
GRANT USAGE ON SCHEMA public TO mail_guardian;
GRANT INSERT ON TABLE public.alerts TO mail_guardian;
DO $alerts$ DECLARE sequence_name text; BEGIN
  sequence_name := pg_get_serial_sequence('public.alerts', 'id');
  IF sequence_name IS NOT NULL THEN
    EXECUTE format('GRANT USAGE ON SEQUENCE %s TO mail_guardian', sequence_name);
  END IF;
END $alerts$;
DO $grants$ DECLARE item record; BEGIN
  FOR item IN SELECT c.relname, c.relkind FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname ~ '^mail_guardian_' AND c.relkind IN ('r','p','S')
  LOOP
    IF item.relkind='S' THEN
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO mail_guardian', item.relname);
    ELSE
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO mail_guardian', item.relname);
    END IF;
  END LOOP;
END $grants$;
COMMIT;
""")
    url = f'postgresql://mail_guardian:{quote(password, safe="")}@cortex-postgresql:5432/{database}'
    lines = [line for line in path.read_text().splitlines() if not line.startswith('DATABASE_URL=')]
    lines.append('DATABASE_URL=' + url)
    descriptor, temporary = tempfile.mkstemp(prefix='.mail-guardian-', dir=secrets)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, 'w') as stream:
            stream.write('\n'.join(lines) + '\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print('Mail Guardian account prerequisites and dedicated database role prepared')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError):
        raise SystemExit('Mail Guardian preparation failed: complete dashboard migrations and account onboarding; inspect protected configuration locally')
