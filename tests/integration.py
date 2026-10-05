#!/usr/bin/env python3
"""Exercise the built binary with an encrypted, disposable local remote.
No Google credentials or live workspace files are used.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error

binary = os.path.abspath(sys.argv[1])

def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]

with tempfile.TemporaryDirectory(prefix='workspace-integration-') as directory:
    root = Path(directory)
    config = root / 'rclone.conf'
    cloud = root / 'cloud'
    cloud.mkdir()
    config.touch(mode=0o600)
    def command(*args, **kwargs):
        return subprocess.run([binary, '--config', str(config), *args], capture_output=True, **kwargs)

    result = command('config', 'create', 'test', 'crypt', 'remote', str(cloud),
                     'password', 'disposable-test-password', '--non-interactive')
    assert result.returncode == 0, result.stderr.decode()
    original = bytes(range(256)) * 8192
    fixture = root / 'fixture'
    fixture.write_bytes(original)
    result = command('copyto', str(fixture), 'test:trip/photo.bin')
    assert result.returncode == 0, result.stderr.decode()
    for name in ['queued/second.bin', 'queued/third.bin']:
        result = command('copyto', str(fixture), 'test:' + name)
        assert result.returncode == 0, result.stderr.decode()
    dav_port, rc_port = port(), port()
    dav = f'http://127.0.0.1:{dav_port}'
    rc = f'http://127.0.0.1:{rc_port}/workspace/control'
    headers = {'Authorization': 'Basic ' + base64.b64encode(b'test:disposable').decode()}
    log = open(root / 'service.log', 'ab')
    process = None

    def request(url, method='GET', body=None):
        req = urllib.request.Request(url, data=body, method=method, headers=headers)
        with urllib.request.urlopen(req, timeout=10) as response:
            return response.read()

    def control(op, path='', **kwargs):
        data = json.dumps(dict(op=op, path=path, **kwargs)).encode()
        req = urllib.request.Request(rc, data=data, headers={**headers, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=15) as response:
            return json.load(response)

    def until(check, timeout=25):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                if check(): return
            except (OSError, urllib.error.URLError): pass
            time.sleep(0.2)
        raise AssertionError('Timed out waiting for expected state')

    def start(delay='1s', bandwidth='off'):
        global process
        process = subprocess.Popen([binary, '--config', str(config), 'serve', 'webdav', 'test:',
            '--addr', f'127.0.0.1:{dav_port}', '--user', 'test', '--pass', 'disposable',
            '--rc', '--rc-addr', f'127.0.0.1:{rc_port}', '--rc-user', 'test', '--rc-pass', 'disposable',
            '--cache-dir', str(root / 'cache'), '--vfs-cache-mode', 'full',
            '--vfs-cache-max-size', '4M', '--vfs-cache-max-age', '1s',
            '--vfs-cache-poll-interval', '200ms', '--vfs-handle-caching', '0s',
            '--low-level-retries', '1', '--retries', '1',
            '--vfs-write-back', delay, '--bwlimit', bandwidth], stdout=log, stderr=log)
        until(lambda: control('settings'))

    def stop(crash=False):
        if process and process.poll() is None:
            process.kill() if crash else process.terminate()
            process.wait(timeout=20)

    try:
        start()
        assert control('status', 'trip/photo.bin')['availability'] == 'cold'
        control('pin', 'trip')
        until(lambda: control('status', 'trip/photo.bin')['availability'] == 'hot')
        time.sleep(2)
        assert control('status', 'trip/photo.bin')['availability'] == 'hot', 'age eviction discarded pin'
        assert request(dav + '/trip/photo.bin') == original
        stop(crash=True)
        start()
        assert control('status', 'trip/photo.bin')['pinned']
        assert request(dav + '/trip/photo.bin') == original
        print('PASS encrypted download, pin, age pressure, abrupt restart', flush=True)

        req = urllib.request.Request(dav + '/trip', method='MOVE', headers={**headers, 'Destination': dav + '/journey'})
        with urllib.request.urlopen(req, timeout=15): pass
        assert control('status', 'journey/photo.bin')['pinned']
        control('cold', 'journey')
        until(lambda: control('status', 'journey/photo.bin')['availability'] == 'cold')
        result = command('cat', 'test:journey/photo.bin')
        assert result.returncode == 0 and result.stdout == original
        print('PASS rename and safe make-cold preserve encrypted remote contents', flush=True)

        control('settings', budget=1024 * 1024)
        control('warm', 'journey/photo.bin')
        until(lambda: bool(control('status', 'journey/photo.bin')['error']))
        assert control('status', 'journey/photo.bin')['availability'] == 'cold'
        control('cancel', 'journey/photo.bin')
        control('settings', budget=8 * 1024 * 1024)
        print('PASS configurable budget rejects oversized hydration', flush=True)

        stop()
        start('1h')
        request(dav + '/pending.bin', 'PUT', original)
        assert control('status', 'pending.bin')['pendingUploads'] == 1
        assert any(row['path'] == 'pending.bin' and row['kind'] == 'upload'
                   and not row['canCancel'] for row in control('activity')['items'])
        control('cancel_all')
        assert control('status', 'pending.bin')['pendingUploads'] == 1
        control('cold', 'pending.bin')
        time.sleep(1)
        assert control('status', 'pending.bin')['availability'] == 'hot'
        stop(crash=True)
        start('1s')
        until(lambda: command('cat', 'test:pending.bin').stdout == original)
        until(lambda: control('status', 'pending.bin')['availability'] == 'cold')
        print('PASS pending upload survives crash and is evicted only after upload', flush=True)

        cloud.chmod(0o500)
        try:
            request(dav + '/retry.bin', 'PUT', original)
            control('cold', 'retry.bin')
            until(lambda: control('status', 'retry.bin')['uploadRetries'] > 0)
            assert control('status', 'retry.bin')['availability'] == 'hot'
            assert any(row['path'] == 'retry.bin' and row['kind'] == 'upload'
                       and row['uploadRetries'] > 0 for row in control('activity')['items'])
        finally:
            cloud.chmod(0o700)
        until(lambda: command('cat', 'test:retry.bin').stdout == original)
        until(lambda: control('status', 'retry.bin')['availability'] == 'cold')
        print('PASS failed upload remains local and retries after remote recovery', flush=True)

        stop()
        start(bandwidth='256k')
        control('pin', 'queued/second.bin')
        control('pin', 'queued/third.bin')
        until(lambda: any(row.get('active') and row.get('cached', 0) > 0
                         for row in control('activity')['items'] if row['kind'] == 'download'))
        assert len([row for row in control('activity')['items'] if row['kind'] == 'download']) == 2
        control('cancel', 'queued/third.bin')
        assert not control('status', 'queued/third.bin')['pinned']
        assert any(row['path'] == 'queued/second.bin' for row in control('activity')['items'])
        control('cancel_all')
        until(lambda: not any(row['kind'] == 'download' for row in control('activity')['items']))
        time.sleep(6)
        assert control('status', 'queued/third.bin')['cached'] == 0, 'cancelled queued job ran'
        stop(crash=True)
        start()
        assert not control('status', 'queued/second.bin')['pinned']
        assert not control('status', 'queued/third.bin')['pinned']
        assert not any(row['kind'] == 'download' for row in control('activity')['items'])
        print('PASS active/queued activity, individual cancellation, cancel all, restart persistence', flush=True)
    except Exception:
        stop()
        print((root / 'service.log').read_text()[-12000:], file=sys.stderr)
        raise
    finally:
        stop()
        log.close()
