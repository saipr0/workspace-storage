#!/usr/bin/env bash
set -euo pipefail
project_dir=$(cd "$(dirname "$0")/.." && pwd)
source_dir="$project_dir/.build/rclone"
mkdir -p "$project_dir/.build" "$project_dir/dist"
if [[ ! -d "$source_dir/.git" ]]; then
  git clone --depth 1 --branch v1.75.1 https://github.com/rclone/rclone.git "$source_dir"
fi
[[ $(git -C "$source_dir" rev-parse HEAD) == 687d264b689b8c49a67e2e52a8a5e0caa01c04ce ]] || { echo 'Unexpected rclone revision'; exit 1; }
if ! git -C "$source_dir" apply --reverse --check "$project_dir/rclone/workspace.patch" 2>/dev/null; then
  git -C "$source_dir" apply --check "$project_dir/rclone/workspace.patch"
  git -C "$source_dir" apply "$project_dir/rclone/workspace.patch"
fi
cd "$source_dir"
go test ./vfs/vfscache ./vfs
go test -race ./vfs/vfscache ./vfs -run '^TestWorkspace'
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -ldflags '-X github.com/rclone/rclone/fs.Version=v1.75.1-workspace.2' -o "$project_dir/dist/rclone-workspace" .
cd "$project_dir"
npm ci --ignore-scripts
npm run build
tar -czf dist/workspace_storage.tar.gz -C nextcloud workspace_storage
cp scripts/install.py dist/install.py
python3 scripts/manifest.py
