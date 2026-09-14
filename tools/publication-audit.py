#!/usr/bin/env python3
"""Audit an explicit publication file list. Output locations, never matched values."""
import argparse
import ipaddress
import pathlib
import re
import sys

DENIED_PARTS = {'.git', '.secrets', '.omc', '.omp', '.claude', '.codex', '.pi',
                '.planning', '.worktrees', 'node_modules', '.output', 'coverage',
                '__pycache__'}
DENIED_SUFFIXES = {'.db', '.sqlite', '.sqlite3', '.pem', '.key', '.p12', '.pfx',
                   '.log', '.pyc', '.tgz', '.zip', '.zst', '.gz'}
PATTERNS = {
    'private-key': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----'),
    'credential-url': re.compile(r'\b(?:https?|postgres(?:ql)?|mysql|redis)://[^\s/:]+:[^\s/@]+@'),
    'personal-home': re.compile(r'/home/(?!example(?:/|\b)|user(?:/|\b)|test(?:/|\b))[^\s/\'"{}$`]+'),
    'tailnet-identity': re.compile(r'\b[a-zA-Z0-9.-]+\.ts\.net\b'),
    'email': re.compile(r'\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b'),
}
IPV4 = re.compile(r'(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])')
DOC_NETS = tuple(ipaddress.ip_network(n) for n in ('192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24'))


def findings(root, names):
    for name in names:
        rel = pathlib.PurePosixPath(name)
        if rel.is_absolute() or '..' in rel.parts or not rel.parts:
            yield name, 0, 'unsafe-path'
            continue
        path = root.joinpath(*rel.parts)
        if any(part in DENIED_PARTS for part in rel.parts) or rel.parts[0] in {'backups', 'logs', 'data', 'state'} or path.suffix.lower() in DENIED_SUFFIXES:
            yield name, 0, 'private-or-generated-file'
        if path.name.startswith('.env') and path.name != '.env.example':
            yield name, 0, 'environment-file'
        if path.is_symlink() or any(p.is_symlink() for p in path.parents if p != root.parent):
            yield name, 0, 'symlink'
            continue
        try:
            text = path.read_text(encoding='utf-8')
        except (OSError, UnicodeError):
            yield name, 0, 'unreadable-or-binary-file'
            continue
        for number, line in enumerate(text.splitlines(), 1):
            for label, pattern in PATTERNS.items():
                matches = list(pattern.finditer(line))
                if label == 'email':
                    matches = [m for m in matches if not (m.group(1) in {'example.com', 'example.org', 'example.net'} or m.group(1).endswith('.example'))]
                if matches:
                    yield name, number, label
            for match in IPV4.finditer(line):
                try:
                    address = ipaddress.ip_address(match.group())
                except ValueError:
                    continue
                if address.is_loopback or address.is_unspecified or any(address in net for net in DOC_NETS):
                    continue
                if address.is_private or address in ipaddress.ip_network('100.64.0.0/10'):
                    yield name, number, 'network-address-review'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=pathlib.Path, default=pathlib.Path.cwd())
    parser.add_argument('--files', type=pathlib.Path, required=True, help='NUL-separated exact publication paths')
    args = parser.parse_args()
    names = [n for n in args.files.read_text().split('\0') if n]
    if not names:
        parser.error('publication file list is empty')
    issues = list(findings(args.root.resolve(), names))
    for name, number, label in issues:
        print(f'{name}:{number}: {label}')
    print(f'{len(names)} files checked; {len(issues)} findings require review')
    return bool(issues)


if __name__ == '__main__':
    sys.exit(main())
