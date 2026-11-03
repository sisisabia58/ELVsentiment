import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
DOCKERFILES = (
    REPO_ROOT / "deploy" / "web.Dockerfile",
    REPO_ROOT / "deploy" / "worker.Dockerfile",
)
FORBIDDEN = ("PASSWORD", "SECRET", "TOKEN", "DATABASE_URL")


def _copy_sources(line: str) -> list[str]:
    stripped = line.strip()
    if not stripped.startswith("COPY"):
        return []
    rest = stripped[4:].strip()
    while rest.startswith("--"):
        rest = rest.split(maxsplit=1)[1] if " " in rest else ""
    tokens = rest.split()
    if len(tokens) <= 1:
        return tokens
    return tokens[:-1]


def test_deploy_dockerfiles_sanity():
    for dockerfile in DOCKERFILES:
        text = dockerfile.read_text(encoding="utf-8")
        assert re.search(r"^FROM\s+", text, re.MULTILINE), dockerfile.name
        assert "CONFIG_DIR=/app/config" in text
        users = re.findall(r"^USER\s+(\S+)", text, re.MULTILINE)
        assert users, f"{dockerfile.name} must drop root"
        assert users[-1] not in {"root", "0"}, dockerfile.name
        for word in FORBIDDEN:
            assert word not in text, f"{dockerfile.name} must not contain {word}"
        for line in text.splitlines():
            if line.strip().startswith("COPY"):
                for source in _copy_sources(line):
                    assert (REPO_ROOT / source).exists(), f"missing COPY source {source!r} in {dockerfile.name}"
    ignored = (REPO_ROOT / ".dockerignore").read_text(encoding="utf-8")
    assert ".env" in ignored
    assert "node_modules" in ignored
