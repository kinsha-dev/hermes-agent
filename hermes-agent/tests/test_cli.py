import os
import pytest
from unittest.mock import patch
import importlib.util


def _load_cli_mod():
    """Load __main__.py by file path to avoid resolving to pytest.__main__."""
    main_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "__main__.py"))
    spec = importlib.util.spec_from_file_location("hermes.__main__", main_path)
    cli_mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cli_mod)
    return cli_mod


def test_cli_prints_transcript(capsys):
    cli_mod = _load_cli_mod()
    with patch.object(cli_mod, "run_agent", return_value="This is the transcript."):
        with patch("sys.argv", ["hermes", "https://www.instagram.com/reel/abc123/"]):
            cli_mod.main()
    captured = capsys.readouterr()
    assert "This is the transcript." in captured.out


def test_cli_exits_with_error_on_failure():
    cli_mod = _load_cli_mod()
    with patch.object(cli_mod, "run_agent", side_effect=RuntimeError("yt-dlp failed: private post")):
        with patch("sys.argv", ["hermes", "https://www.instagram.com/reel/abc123/"]):
            with pytest.raises(SystemExit) as exc_info:
                cli_mod.main()
    assert exc_info.value.code == 1


def test_cli_exits_when_no_url_given(capsys):
    cli_mod = _load_cli_mod()
    with patch("sys.argv", ["hermes"]):
        with pytest.raises(SystemExit) as exc_info:
            cli_mod.main()
    assert exc_info.value.code == 1
    captured = capsys.readouterr()
    assert "Usage" in captured.err
