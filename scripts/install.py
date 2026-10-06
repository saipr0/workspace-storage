#!/usr/bin/env python3
"""Install the reviewed build on red. Run with sudo; no passwords are printed."""
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request

if os.geteuid() != 0:
    sys.exit('Run this installer with sudo on the Ubuntu server.')
source = Path(__file__).resolve().parent
manifest = json.loads((source / 'SHA256SUMS.json').read_text())
for filename, expected in manifest.items():
    if hashlib.sha256((source / filename).read_bytes()).hexdigest() != expected:
        sys.exit('Build checksum mismatch: ' + filename)
if not Path('/home/saipr/.config/rclone/rclone.conf').is_file():
    sys.exit('Expected rclone configuration is missing; no changes made.')

def run(*args):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError('Command failed: ' + args[0] + ' ' + args[1] + ': ' + result.stderr.replace(globals().get('password', '__unset__'), '[redacted]')[-1000:])
    return result.stdout

destination = Path('/usr/local/lib/workspace-storage')
destination.mkdir(parents=True, exist_ok=True)
binary = destination / 'rclone'
if binary.exists(): shutil.copy2(binary, destination / 'rclone.previous')
staged_binary = destination / 'rclone.new'
shutil.copy2(source / 'rclone-workspace', staged_binary)
staged_binary.chmod(0o755)
os.replace(staged_binary, binary)
extra = Path('/var/snap/nextcloud/current/nextcloud/extra-apps')
app = extra / 'workspace_storage'
backup = None
if app.exists():
    backup = destination / ('app-backup-' + str(int(time.time())))
    shutil.copytree(app, backup)
with tarfile.open(source / 'workspace_storage.tar.gz') as archive:
    archive.extractall(extra, filter='data')
for directory, dirs, files in os.walk(app):
    os.chmod(directory, 0o755)
    for filename in files: os.chmod(Path(directory) / filename, 0o644)

secret_file = destination / 'service.env'
if secret_file.exists():
    password = dict(line.split('=', 1) for line in secret_file.read_text().splitlines())['RCLONE_RC_PASS']
else:
    password = secrets.token_urlsafe(36)
    fd = os.open(secret_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write('RCLONE_RC_USER=workspace\nRCLONE_RC_PASS=' + password + '\n')

dropin_dir = Path('/etc/systemd/system/workspace-storage.service.d')
dropin_dir.mkdir(parents=True, exist_ok=True)
dropin = dropin_dir / 'workspace.conf'
previous = dropin.read_bytes() if dropin.exists() else None
dropin.write_text('''[Service]
EnvironmentFile=/usr/local/lib/workspace-storage/service.env
ExecStart=
ExecStart=/usr/local/lib/workspace-storage/rclone serve webdav workspace: --config=/home/saipr/.config/rclone/rclone.conf --addr=127.0.0.1:8686 --htpasswd=/home/saipr/.config/workspace-storage/webdav.htpasswd --vfs-cache-mode=full --cache-dir=/home/saipr/.cache/workspace-storage --vfs-cache-max-size=320G --vfs-cache-min-free-space=30G --vfs-cache-max-age=24h --log-level=INFO --rc --rc-addr=127.0.0.1:8687
''')
try:
    run('systemctl', 'daemon-reload')
    run('systemctl', 'restart', 'workspace-storage.service')
    authorization = 'Basic ' + base64.b64encode(('workspace:' + password).encode()).decode()
    for attempt in range(20):
        try:
            req = urllib.request.Request('http://127.0.0.1:8687/vfs/status',
                data=b'{"path":"","fs":"workspace:"}',
                headers={'Authorization': authorization, 'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=5) as response: json.load(response)
            break
        except Exception:
            if attempt == 19: raise RuntimeError('Workspace service health check failed')
            time.sleep(1)
    run('nextcloud.occ', 'config:app:set', 'workspace_storage', 'rc_password', '--value=' + password)
    run('nextcloud.occ', 'app:enable', 'workspace_storage')
    run('snap', 'restart', 'nextcloud.php-fpm')
except Exception as error:
    if previous is None: dropin.unlink(missing_ok=True)
    else: dropin.write_bytes(previous)
    if (destination / 'rclone.previous').exists():
        shutil.copy2(destination / 'rclone.previous', destination / 'rclone.restore')
        os.replace(destination / 'rclone.restore', binary)
    if backup is not None:
        shutil.copytree(backup, app, dirs_exist_ok=True)
    run('systemctl', 'daemon-reload')
    run('systemctl', 'restart', 'workspace-storage.service')
    run('snap', 'restart', 'nextcloud.php-fpm')
    sys.exit(str(error) + '. Previous service configuration restored.')
print('Workspace storage installed. Refresh Nextcloud Files to see storage controls.')
