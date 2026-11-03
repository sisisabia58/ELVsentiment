from pathlib import Path

from launch_gate import scan_forbidden

ROOT = Path(__file__).resolve().parents[1]


def test_product_tree_has_no_reply_or_external_delivery():
    assert scan_forbidden(ROOT) == []
    app = ROOT / "apps" / "web" / "src" / "app"
    names = [path.name for path in app.rglob("*")]
    assert "reply" not in names
    assert not any("reply" in name for name in names)
