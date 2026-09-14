"""Install the authenticated broker only after its native backend starts."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

parser = argparse.ArgumentParser()
parser.add_argument('action', choices=['apply'])
parser.add_argument('--manifest', required=True)
args = parser.parse_args()
manifest_path = Path(args.manifest).resolve()
manifest = json.loads(manifest_path.read_text())
subprocess.run([sys.executable, str(Path(manifest['root']) / 'scripts/memory/memoryctl.py'),
                'install', '--manifest', str(manifest_path)], check=True)
