#!/usr/bin/env python3
"""Run with python3 tools/test-publication-audit.py; no external packages."""
import importlib.util
import pathlib
import tempfile

spec = importlib.util.spec_from_file_location('audit', pathlib.Path(__file__).with_name('publication-audit.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
with tempfile.TemporaryDirectory() as temporary:
    root = pathlib.Path(temporary)
    (root / 'safe.txt').write_text('http://127.0.0.1:3080 admin@example.com 192.0.2.1\n')
    assert list(audit.findings(root, ['safe.txt'])) == []
    (root / 'unsafe.txt').write_text('postgresql://account:credential@localhost/db\n')
    assert ('unsafe.txt', 1, 'credential-url') in list(audit.findings(root, ['unsafe.txt']))
    (root / 'linked.txt').symlink_to(root / 'safe.txt')
    assert ('linked.txt', 0, 'symlink') in list(audit.findings(root, ['linked.txt']))
    assert ('../outside', 0, 'unsafe-path') in list(audit.findings(root, ['../outside']))
print('Publication boundary checks passed')
