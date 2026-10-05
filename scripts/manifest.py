import hashlib
import json
from pathlib import Path
root = Path(__file__).resolve().parent.parent / 'dist'
manifest = {name: hashlib.sha256((root / name).read_bytes()).hexdigest()
            for name in ['rclone-workspace', 'workspace_storage.tar.gz']}
(root / 'SHA256SUMS.json').write_text(json.dumps(manifest, indent=2) + '\n')
