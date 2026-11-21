from pathlib import Path

from launch_gate import scan_forbidden

ROOT = Path(__file__).resolve().parents[1]


def test_only_the_verified_opencode_transport_is_allowed(tmp_path):
    transport = tmp_path / "apps/worker/sentiment_monitor/opencode.py"
    transport.parent.mkdir(parents=True)
    allowed = 'OPENCODE_URL = "https://opencode.ai/inference/go/v1/chat/completions"'
    transport.write_text(allowed)
    assert scan_forbidden(tmp_path) == []

    separate = transport.with_name("unapproved.py")
    separate.write_text(allowed)
    assert scan_forbidden(tmp_path) == [str(separate)]
    separate.unlink()

    transport.write_text(allowed + '\nUNAPPROVED = "https://other.invalid/v1/chat/completions"')
    assert scan_forbidden(tmp_path) == [str(transport)]
    transport.write_text(allowed + '\nDELIVERY = "https://hooks.slack.com/send"')
    assert scan_forbidden(tmp_path) == [str(transport)]


def test_product_tree_has_no_reply_or_external_delivery():
    assert scan_forbidden(ROOT) == []
    app = ROOT / "apps" / "web" / "src" / "app"
    names = [path.name for path in app.rglob("*")]
    assert "reply" not in names
    assert not any("reply" in name for name in names)
