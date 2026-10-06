# Workspace storage

A single Nextcloud `workspace` tree backed by encrypted Google Drive, with a
bounded local cache and explicit availability controls. The existing OAuth
homepage and privacy policy remain at the repository root.

## Components

- A focused patch against rclone **v1.75.1**, commit
  `687d264b689b8c49a67e2e52a8a5e0caa01c04ce`. The existing VFS handles encryption,
  reads, writes, cloud uploads and retries. Added code owns persistent retention
  rules, hydration jobs, availability reporting and safe local eviction.
- A Nextcloud **34** app using the public file-action and navigation APIs. Storage controls are
  available to signed-in administrators in the Files web interface.
- A checksum-verifying installer for the existing `red` server. It preserves the
  original systemd service and adds an override, with health-check rollback.

## Behavior

| Control or state | Meaning |
| --- | --- |
| Hot | The complete current file is cached on Ubuntu. |
| Cold | The complete file is not locally cached; some downloaded chunks may exist. |
| Mixed | A folder contains a mixture of complete and incomplete local files. |
| Keep hot | Persist a pin and download contents. Folder rules include future children. |
| Make cold | Switch to automatic retention and release clean local copies. Explicit child pins remain protected. Pending writes wait for cloud upload. |
| Allow automatic caching | Remove the pin without immediately deleting local contents; overrides a parent pin. |
| Use parent folder policy | Remove the explicit override and inherit the containing folder's policy. |
| Cancel download | Cancel that queued request and apply automatic retention at that path. Already downloaded content remains usable. |

File rows show MDI flame (hot), snowflake (cold), and pin icons. Mixed folders
show both availability icons. Clicking the icons opens details; there are no
hover tooltips or duplicate inline status buttons.

**Workspace activity** in the Files sidebar lists download requests (including
folder totals and the current child), queued work, pending uploads and failures.
It offers per-download cancellation and **Cancel all downloads**. Cancelling an
unfinished pinned request removes its pin; completed pins and uploads are left
alone. Queue changes invalidate the worker's previous snapshot and persist over
restart. Transfers initiated by direct WebDAV reads or other clients are not
managed download requests and cannot be cancelled from this view.

Opening a cold file through the normal Files click action starts a durable
background job and shows a preparation panel. Closing the panel keeps the job
running. Once complete, the app delegates to Nextcloud's normal viewer. Direct
download URLs, shared links, other Nextcloud apps and native clients keep their
normal read behavior; they do not receive the custom preparation panel.

The budget is editable from the `workspace` folder's action menu. It begins with
the existing **2 GiB** target; temporary contents expire after **24 hours** of
inactivity. The existing **10 GiB free-space reserve** is retained. The budget is
a target rather than a disk quota: pins, active reads and pending uploads are
protected, and uploads can exceed it. Explicit full-file downloads check capacity
and report when protected files leave insufficient room.

All ordinary edits should go through Nextcloud/WebDAV. Editing VFS cache files
directly is unsupported. A fully cached file does not guarantee that directory
browsing or reopening will work while Drive is unreachable.

## Build and validation

Requires Go 1.26+ and Node/npm. From a clean checkout:

```sh
bash scripts/build.sh
```

The script fetches the exact upstream revision, checks/applies the patch, runs
VFS/cache tests with race detection and the app regression tests, then builds the
Linux amd64 binary and Nextcloud app. Each patch revision gets its own cached
source tree, so rebuilding does not reuse an older implementation.
Build products and checksums are in `dist/`.

Run the integration test on Linux as an ordinary user:

```sh
python3 tests/integration.py /absolute/path/to/rclone-workspace
```

It creates an encrypted local test remote and separate ports/cache. It tests full
downloads, persistent pins, age pressure, abrupt restarts, renames, safe eviction,
capacity rejection, pending-write recovery, actual failed-upload retries, active
and queued cancellation, and cancellation persistence across restarts. It
does not use Google credentials or live workspace files.

## Installation on red

Stage these files together in `/home/saipr/workspace-storage-build/`:
`rclone-workspace`, `workspace_storage.tar.gz`, `SHA256SUMS.json`, and `install.py`.
Then run:

```sh
sudo python3 /home/saipr/workspace-storage-build/install.py
```

The installer is deliberately specific to the existing `saipr` account, rclone
remote `workspace:`, Nextcloud mount `workspace`, and Nextcloud snap installation.
It keeps WebDAV on `127.0.0.1:8686` and adds an authenticated control endpoint on
`127.0.0.1:8687`. Browsers call Nextcloud; only its server calls the control API.
No control credentials are sent to the browser. Nextcloud enforces login,
administrator access, CSRF checks and file access within the user's workspace.

After installation, hard-refresh Files. Check a disposable file using its status
icon, Keep hot and Make cold. Open Workspace activity from the Files sidebar to
see the queue. The existing cloud files are not moved or reformatted.

## State, upgrades and recovery

Retention rules and queued jobs are atomically persisted next to the VFS metadata
tree as `workspace.workspace.json`. Retain that file, the VFS cache and metadata,
and the rclone configuration when backing up the server. Do not delete cache
files to make them cold: pending writes may exist there.

An interrupted rename records both paths so pins remain protected until the move
can be reconciled. If both paths exist after an interruption, the status reports
that inspection is needed rather than guessing which copy to remove.

This is a maintained rclone patch. Do not replace the installed custom binary
with a stock self-update; rebuild and run the tests when updating upstream.
The original `/usr/bin/rclone` remains available for ordinary CLI operations.

To disable the custom interface and restore the original service configuration:

```sh
sudo nextcloud.occ app:disable workspace_storage
sudo mv /etc/systemd/system/workspace-storage.service.d/workspace.conf /etc/systemd/system/workspace-storage.service.d/workspace.conf.disabled
sudo systemctl daemon-reload
sudo systemctl restart workspace-storage.service
```

Stock rclone preserves pending uploads but does not honor the custom pins. The
policy file remains available for re-enabling the extension. Independently of
this app, standard rclone with the crypt credentials can recover the Drive files.

Google Drive holds the live encrypted collection. This project does **not** yet
configure restic snapshots or historical retention; deleting a workspace file is
different from making it cold and can delete its live cloud copy.

The rclone patch follows upstream's MIT license. The Nextcloud app is AGPL-3.0-or-later.
