#!/usr/bin/env python3
"""Install only the status-panel changes from the checksummed app bundle."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

if os.geteuid() != 0:
    sys.exit('Run this update with sudo on the Ubuntu server.')
source = Path(__file__).resolve().parent
bundle = source / 'workspace_storage.tar.gz'
expected = json.loads((source / 'SHA256SUMS.json').read_text())[bundle.name]
if hashlib.sha256(bundle.read_bytes()).hexdigest() != expected:
    sys.exit('App checksum mismatch; no changes made.')
app = Path('/var/snap/nextcloud/current/nextcloud/extra-apps/workspace_storage')
files = ['src/workspace.js', 'js/workspace.js', 'css/workspace.css',
         'lib/Controller/WorkspaceController.php']
with tarfile.open(bundle) as archive:
    updates = {name: archive.extractfile('workspace_storage/' + name).read() for name in files}
if not all((app / name).is_file() for name in files):
    sys.exit('Existing app files are missing; no changes made.')
backup = Path(tempfile.mkdtemp(prefix='panel-backup-', dir='/usr/local/lib/workspace-storage'))
for name in files:
    target = backup / name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(app / name, target)

def replace(path, data):
    temporary = path.with_name(path.name + '.new')
    temporary.write_bytes(data)
    temporary.chmod(0o644)
    os.replace(temporary, path)

try:
    for name, data in updates.items():
        replace(app / name, data)
    subprocess.run(['snap', 'restart', 'nextcloud.php-fpm'], check=True)
except Exception:
    for name in files:
        replace(app / name, (backup / name).read_bytes())
    subprocess.run(['snap', 'restart', 'nextcloud.php-fpm'], check=False)
    raise
print('Storage panel updated successfully. Hard-refresh Nextcloud in your browser.')
