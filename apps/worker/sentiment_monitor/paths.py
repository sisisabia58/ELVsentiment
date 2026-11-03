import os
from pathlib import Path


def repo_root() -> Path:
    config_dir = os.environ.get("CONFIG_DIR", "").strip()
    if config_dir:
        return Path(config_dir).resolve().parent
    return Path(__file__).resolve().parents[3]
