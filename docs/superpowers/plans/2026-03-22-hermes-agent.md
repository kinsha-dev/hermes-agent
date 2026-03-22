# Hermes Agent Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Python CLI agent using the Claude Agent SDK that takes an Instagram URL, downloads the video, extracts the audio, and returns a plain-text transcript via Claude's native audio input.

**Architecture:** Three tools are registered with the Claude Agent SDK loop — `download_instagram_video` (yt-dlp), `extract_audio` (ffmpeg), and `transcribe_audio` (Claude multimodal API). The agent orchestrates them in sequence: download → extract → transcribe → print.

**Tech Stack:** Python 3.11+, `anthropic` SDK (Agent SDK), `yt-dlp`, `ffmpeg` (system), `pytest`, `python-dotenv`

---

## Chunk 1: Project scaffold and tools

### Task 1: Project scaffold

**Files:**
- Create: `hermes-agent/requirements.txt`
- Create: `hermes-agent/.env.example`

- [ ] **Step 1: Create `hermes-agent/` directory and `requirements.txt`**

```
anthropic>=0.40.0
python-dotenv>=1.0.0
pytest>=8.0.0
pytest-asyncio>=0.24.0
```

- [ ] **Step 2: Create `.env.example`**

```
ANTHROPIC_API_KEY=your_key_here
```

- [ ] **Step 3: Verify no syntax issues**

Run: `python -c "import ast; print('ok')"` (just a sanity check the shell is working)
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add hermes-agent/
git commit -m "feat: scaffold hermes-agent project"
```

---

### Task 2: `download_instagram_video` tool — test first

**Files:**
- Create: `hermes-agent/tests/__init__.py`
- Create: `hermes-agent/tests/test_tools.py`
- Create: `hermes-agent/tools.py`

- [ ] **Step 1: Create `hermes-agent/tests/__init__.py`** (empty file)

- [ ] **Step 2: Write the failing test in `hermes-agent/tests/test_tools.py`**

```python
import os
import pytest
from unittest.mock import patch, MagicMock
from tools import download_instagram_video


def test_download_returns_path_on_success(tmp_path):
    fake_video = tmp_path / "video.mp4"
    fake_video.write_bytes(b"fake")

    with patch("tools.subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=0)
        with patch("tools.glob") as mock_glob:
            mock_glob.return_value = [str(fake_video)]
            result = download_instagram_video(
                "https://www.instagram.com/reel/abc123/",
                output_dir=str(tmp_path),
            )

    assert result == str(fake_video)


def test_download_raises_on_yt_dlp_failure(tmp_path):
    with patch("tools.subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=1, stderr="login required")
        with pytest.raises(RuntimeError, match="yt-dlp failed"):
            download_instagram_video(
                "https://www.instagram.com/reel/abc123/",
                output_dir=str(tmp_path),
            )


def test_download_raises_when_no_file_produced(tmp_path):
    with patch("tools.subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=0)
        with patch("tools.glob") as mock_glob:
            mock_glob.return_value = []
            with pytest.raises(RuntimeError, match="no video file"):
                download_instagram_video(
                    "https://www.instagram.com/reel/abc123/",
                    output_dir=str(tmp_path),
                )
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd hermes-agent && python -m pytest tests/test_tools.py::test_download_returns_path_on_success -v`
Expected: `ModuleNotFoundError: No module named 'tools'`

- [ ] **Step 4: Implement `download_instagram_video` in `hermes-agent/tools.py`**

```python
import subprocess
import tempfile
from glob import glob as _glob


def glob(pattern):
    """Thin wrapper so tests can patch it."""
    return _glob(pattern)


def download_instagram_video(url: str, output_dir: str | None = None) -> str:
    """Download an Instagram video using yt-dlp.

    Returns the path to the downloaded video file.
    Raises RuntimeError on failure.
    """
    if output_dir is None:
        output_dir = tempfile.mkdtemp(prefix="hermes_")

    result = subprocess.run(
        ["yt-dlp", "-o", f"{output_dir}/%(id)s.%(ext)s", url],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        raise RuntimeError(f"yt-dlp failed: {result.stderr.strip()}")

    matches = glob(f"{output_dir}/*.mp4") + glob(f"{output_dir}/*.webm") + glob(f"{output_dir}/*.mkv")
    if not matches:
        raise RuntimeError("yt-dlp exited 0 but no video file found in output dir")

    return matches[0]
```

- [ ] **Step 5: Install deps and run all download tests**

Run: `cd hermes-agent && pip install -r requirements.txt && python -m pytest tests/test_tools.py -k download -v`
Expected: 3 tests PASS

- [ ] **Step 6: Commit**

```bash
git add hermes-agent/tools.py hermes-agent/tests/
git commit -m "feat: add download_instagram_video tool with tests"
```

---

### Task 3: `extract_audio` tool — test first

**Files:**
- Modify: `hermes-agent/tests/test_tools.py`
- Modify: `hermes-agent/tools.py`

- [ ] **Step 1: Add `from tools import extract_audio` to the imports section at the top of `hermes-agent/tests/test_tools.py`**, then append the following test functions after the existing tests:

```python
from tools import extract_audio


def test_extract_audio_returns_mp3_path(tmp_path):
    fake_video = tmp_path / "video.mp4"
    fake_video.write_bytes(b"fake")
    expected_audio = str(tmp_path / "video.mp3")

    with patch("tools.subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=0)
        result = extract_audio(str(fake_video))

    assert result == expected_audio


def test_extract_audio_raises_on_ffmpeg_failure(tmp_path):
    fake_video = tmp_path / "video.mp4"
    fake_video.write_bytes(b"fake")

    with patch("tools.subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=1, stderr="codec error")
        with pytest.raises(RuntimeError, match="ffmpeg failed"):
            extract_audio(str(fake_video))
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd hermes-agent && python -m pytest tests/test_tools.py -k extract -v`
Expected: `ImportError: cannot import name 'extract_audio'`

- [ ] **Step 3: Add `import os` at the top of `hermes-agent/tools.py`** (after `import subprocess`), then add `extract_audio`:

```python
import os


def extract_audio(video_path: str) -> str:
    """Extract audio from video file as mp3 using ffmpeg.

    Returns the path to the .mp3 file.
    Raises RuntimeError on failure.
    """
    audio_path = os.path.splitext(video_path)[0] + ".mp3"

    result = subprocess.run(
        ["ffmpeg", "-y", "-i", video_path, "-vn", "-acodec", "libmp3lame", "-q:a", "4", audio_path],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr.strip()}")

    return audio_path
```

- [ ] **Step 4: Run all tests**

Run: `cd hermes-agent && python -m pytest tests/test_tools.py -v`
Expected: 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add hermes-agent/tools.py hermes-agent/tests/test_tools.py
git commit -m "feat: add extract_audio tool with tests"
```

---

### Task 4: `transcribe_audio` tool — test first

**Files:**
- Modify: `hermes-agent/tests/test_tools.py`
- Modify: `hermes-agent/tools.py`

- [ ] **Step 1: Add `from tools import transcribe_audio` to the imports section at the top of `hermes-agent/tests/test_tools.py`**, then append the following test functions after the existing tests:

```python
from tools import transcribe_audio


def test_transcribe_audio_returns_text(tmp_path):
    audio_file = tmp_path / "audio.mp3"
    audio_file.write_bytes(b"fake audio bytes")

    mock_client = MagicMock()
    mock_client.messages.create.return_value = MagicMock(
        content=[MagicMock(text="Hello world this is a transcript.")]
    )

    result = transcribe_audio(str(audio_file), client=mock_client)

    assert result == "Hello world this is a transcript."
    mock_client.messages.create.assert_called_once()


def test_transcribe_audio_raises_when_file_missing():
    mock_client = MagicMock()
    with pytest.raises(FileNotFoundError):
        transcribe_audio("/nonexistent/audio.mp3", client=mock_client)


def test_transcribe_audio_raises_on_file_too_large(tmp_path):
    audio_file = tmp_path / "big.mp3"
    # Write a file larger than 25 MB limit
    audio_file.write_bytes(b"x" * (26 * 1024 * 1024))

    mock_client = MagicMock()
    with pytest.raises(RuntimeError, match="exceeds 25 MB"):
        transcribe_audio(str(audio_file), client=mock_client)
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd hermes-agent && python -m pytest tests/test_tools.py -k transcribe -v`
Expected: `ImportError: cannot import name 'transcribe_audio'`

- [ ] **Step 3: Verify the model ID `claude-opus-4-6` is valid**

Run: `python -c "import anthropic; c = anthropic.Anthropic(); print([m.id for m in c.models.list().data if 'opus' in m.id])"` (requires `ANTHROPIC_API_KEY` set)
Expected: list containing `claude-opus-4-6` (or update `MODEL` in `tools.py` to the current Opus model ID if it has changed)

- [ ] **Step 4: Add `import base64` at the top of `hermes-agent/tools.py`**, then add `transcribe_audio`

> **Note on audio API format:** Before coding, verify the correct content block type for audio in the Anthropic docs (https://docs.anthropic.com/en/docs/build-with-claude/files). As of early 2026, audio uses `"type": "document"` with `"media_type": "audio/mpeg"` — same block shape as PDFs. If the API has changed, update the `content` block accordingly. The mock-based tests will pass regardless; only the live smoke test (Task 7) will surface any mismatch.

```python
MAX_AUDIO_BYTES = 25 * 1024 * 1024  # 25 MB
MODEL = "claude-opus-4-6"


def transcribe_audio(audio_path: str, client=None) -> str:
    """Send audio file to Claude for transcription.

    Returns plain-text transcript string.
    Raises FileNotFoundError if audio_path doesn't exist.
    Raises RuntimeError if file exceeds 25 MB.
    """
    import anthropic

    if not os.path.exists(audio_path):
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    file_size = os.path.getsize(audio_path)
    if file_size > MAX_AUDIO_BYTES:
        raise RuntimeError(
            f"Audio file ({file_size // (1024*1024)} MB) exceeds 25 MB Claude input limit"
        )

    if client is None:
        client = anthropic.Anthropic()

    with open(audio_path, "rb") as f:
        audio_data = base64.standard_b64encode(f.read()).decode("utf-8")

    response = client.messages.create(
        model=MODEL,
        max_tokens=4096,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "document",
                        "source": {
                            "type": "base64",
                            "media_type": "audio/mpeg",
                            "data": audio_data,
                        },
                    },
                    {
                        "type": "text",
                        "text": "Please transcribe all spoken words in this audio. Output only the transcript text with no commentary or formatting.",
                    },
                ],
            }
        ],
    )

    return response.content[0].text
```

- [ ] **Step 5: Run all tests**

Run: `cd hermes-agent && python -m pytest tests/test_tools.py -v`
Expected: 8 tests PASS

- [ ] **Step 6: Commit**

```bash
git add hermes-agent/tools.py hermes-agent/tests/test_tools.py
git commit -m "feat: add transcribe_audio tool with tests"
```

---

## Chunk 2: Agent loop and CLI

### Task 5: Agent loop in `agent.py` (Claude tool-use agentic loop)

**Files:**
- Create: `hermes-agent/agent.py`
- Create: `hermes-agent/tests/test_agent.py`

The agent is not a plain function call sequence — it defines three tools as JSON schemas and runs a proper Claude tool-use agentic loop: send prompt → handle `tool_use` blocks → send tool results → repeat until `end_turn`.

- [ ] **Step 1: Write failing test in `hermes-agent/tests/test_agent.py`**

```python
import pytest
from unittest.mock import patch, MagicMock, call
from agent import run_agent


def _make_tool_use_block(id_, name, input_):
    block = MagicMock()
    block.type = "tool_use"
    block.id = id_
    block.name = name
    block.input = input_
    return block


def _make_text_block(text):
    block = MagicMock()
    block.type = "text"
    block.text = text
    return block


def test_run_agent_completes_tool_loop():
    """Agent should call all three tools via the SDK loop and return final text."""
    mock_client = MagicMock()

    # Turn 1: Claude asks to download
    turn1 = MagicMock()
    turn1.stop_reason = "tool_use"
    turn1.content = [_make_tool_use_block("t1", "download_instagram_video", {"url": "https://www.instagram.com/reel/abc/"})]

    # Turn 2: Claude asks to extract
    turn2 = MagicMock()
    turn2.stop_reason = "tool_use"
    turn2.content = [_make_tool_use_block("t2", "extract_audio", {"video_path": "/tmp/video.mp4"})]

    # Turn 3: Claude asks to transcribe
    turn3 = MagicMock()
    turn3.stop_reason = "tool_use"
    turn3.content = [_make_tool_use_block("t3", "transcribe_audio", {"audio_path": "/tmp/video.mp3"})]

    # Turn 4: final answer
    turn4 = MagicMock()
    turn4.stop_reason = "end_turn"
    turn4.content = [_make_text_block("Hello world this is a transcript.")]

    mock_client.messages.create.side_effect = [turn1, turn2, turn3, turn4]

    with patch("agent.download_instagram_video", return_value="/tmp/video.mp4") as mock_dl, \
         patch("agent.extract_audio", return_value="/tmp/video.mp3") as mock_ex, \
         patch("agent.transcribe_audio", return_value="Hello world this is a transcript.") as mock_tr:
        result = run_agent("https://www.instagram.com/reel/abc/", client=mock_client)

    mock_dl.assert_called_once_with(url="https://www.instagram.com/reel/abc/")
    mock_ex.assert_called_once_with(video_path="/tmp/video.mp4")
    mock_tr.assert_called_once_with(audio_path="/tmp/video.mp3")
    assert result == "Hello world this is a transcript."
    assert mock_client.messages.create.call_count == 4


def test_run_agent_tool_error_is_returned_to_claude():
    """If a tool raises, the error is sent back to Claude as a tool_result with is_error=True."""
    mock_client = MagicMock()

    turn1 = MagicMock()
    turn1.stop_reason = "tool_use"
    turn1.content = [_make_tool_use_block("t1", "download_instagram_video", {"url": "https://bad/"})]

    turn2 = MagicMock()
    turn2.stop_reason = "end_turn"
    turn2.content = [_make_text_block("Could not download the video.")]

    mock_client.messages.create.side_effect = [turn1, turn2]

    with patch("agent.download_instagram_video", side_effect=RuntimeError("yt-dlp failed: private")):
        result = run_agent("https://bad/", client=mock_client)

    # Second call to messages.create should include is_error tool result
    second_call_messages = mock_client.messages.create.call_args_list[1][1]["messages"]
    tool_result_msg = second_call_messages[-1]
    assert tool_result_msg["role"] == "user"
    assert tool_result_msg["content"][0]["is_error"] is True
    assert result == "Could not download the video."
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd hermes-agent && python -m pytest tests/test_agent.py -v`
Expected: `ModuleNotFoundError: No module named 'agent'`

- [ ] **Step 3: Create `hermes-agent/agent.py`**

```python
"""Hermes Agent — Claude tool-use agentic loop for Instagram video transcription."""

import anthropic

from tools import download_instagram_video, extract_audio, transcribe_audio

MODEL = "claude-opus-4-6"

TOOLS = [
    {
        "name": "download_instagram_video",
        "description": "Download a video from an Instagram URL using yt-dlp.",
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "Instagram post or reel URL"},
            },
            "required": ["url"],
        },
    },
    {
        "name": "extract_audio",
        "description": "Extract the audio track from a local video file as an mp3.",
        "input_schema": {
            "type": "object",
            "properties": {
                "video_path": {"type": "string", "description": "Absolute path to the video file"},
            },
            "required": ["video_path"],
        },
    },
    {
        "name": "transcribe_audio",
        "description": "Transcribe spoken words in a local mp3 audio file using Claude.",
        "input_schema": {
            "type": "object",
            "properties": {
                "audio_path": {"type": "string", "description": "Absolute path to the mp3 file"},
            },
            "required": ["audio_path"],
        },
    },
]

_TOOL_IMPL = {
    "download_instagram_video": lambda args: download_instagram_video(**args),
    "extract_audio": lambda args: extract_audio(**args),
    "transcribe_audio": lambda args: transcribe_audio(**args),
}


def run_agent(url: str, client=None) -> str:
    """Run the Claude agentic loop to transcribe an Instagram video.

    Claude decides which tools to call and in what order.
    Returns the final plain-text transcript from Claude.
    """
    if client is None:
        client = anthropic.Anthropic()

    messages = [
        {
            "role": "user",
            "content": f"Please transcribe the audio from this Instagram video: {url}",
        }
    ]

    while True:
        response = client.messages.create(
            model=MODEL,
            max_tokens=4096,
            tools=TOOLS,
            messages=messages,
        )

        messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason == "end_turn":
            for block in response.content:
                if hasattr(block, "text"):
                    return block.text
            return ""

        if response.stop_reason == "tool_use":
            tool_results = []
            for block in response.content:
                if block.type == "tool_use":
                    try:
                        result = _TOOL_IMPL[block.name](block.input)
                        tool_results.append(
                            {
                                "type": "tool_result",
                                "tool_use_id": block.id,
                                "content": str(result),
                            }
                        )
                    except Exception as exc:
                        tool_results.append(
                            {
                                "type": "tool_result",
                                "tool_use_id": block.id,
                                "content": f"Error: {exc}",
                                "is_error": True,
                            }
                        )
            messages.append({"role": "user", "content": tool_results})
```

- [ ] **Step 4: Run agent tests**

Run: `cd hermes-agent && python -m pytest tests/test_agent.py -v`
Expected: 2 tests PASS

- [ ] **Step 5: Commit**

```bash
git add hermes-agent/agent.py hermes-agent/tests/test_agent.py
git commit -m "feat: add Claude tool-use agentic loop with tests"
```

---

### Task 6: CLI entry point

**Files:**
- Create: `hermes-agent/__main__.py`
- Create: `hermes-agent/tests/test_cli.py`

Note: CLI tests live in a separate file (`test_cli.py`) to avoid module-import caching issues when testing `__main__`.

- [ ] **Step 1: Write failing tests in `hermes-agent/tests/test_cli.py`**

```python
import sys
import pytest
from io import StringIO
from unittest.mock import patch
import importlib


def _run_main(argv):
    """Import and call main() with a clean module state each time."""
    import __main__ as cli_mod
    importlib.reload(cli_mod)
    with patch("sys.argv", argv):
        cli_mod.main()


def test_cli_prints_transcript(capsys):
    with patch("__main__.run_agent", return_value="This is the transcript."):
        _run_main(["hermes", "https://www.instagram.com/reel/abc123/"])
    captured = capsys.readouterr()
    assert "This is the transcript." in captured.out


def test_cli_exits_with_error_on_failure():
    with patch("__main__.run_agent", side_effect=RuntimeError("yt-dlp failed: private post")):
        with pytest.raises(SystemExit) as exc_info:
            _run_main(["hermes", "https://www.instagram.com/reel/abc123/"])
    assert exc_info.value.code == 1


def test_cli_exits_when_no_url_given(capsys):
    with pytest.raises(SystemExit) as exc_info:
        _run_main(["hermes"])
    assert exc_info.value.code == 1
    captured = capsys.readouterr()
    assert "Usage" in captured.err
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd hermes-agent && python -m pytest tests/test_cli.py -v`
Expected: `ModuleNotFoundError: No module named '__main__'`

- [ ] **Step 3: Create `hermes-agent/__main__.py`**

```python
"""CLI entry point: python __main__.py <instagram_url>"""

import sys
from agent import run_agent


def main():
    if len(sys.argv) != 2:
        print("Usage: python __main__.py <instagram_url>", file=sys.stderr)
        sys.exit(1)

    url = sys.argv[1]

    try:
        transcript = run_agent(url)
        print(transcript)
    except RuntimeError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run all tests**

Run: `cd hermes-agent && python -m pytest tests/ -v`
Expected: all tests PASS

- [ ] **Step 5: Smoke test the CLI (no URL arg — should print usage)**

Run: `cd hermes-agent && python __main__.py 2>&1 || true`
Expected: `Usage: python __main__.py <instagram_url>` printed to stderr, exit code 1

- [ ] **Step 6: Commit**

```bash
git add hermes-agent/__main__.py hermes-agent/tests/test_cli.py
git commit -m "feat: add CLI entry point with error handling"
```

---

## Chunk 3: Final wiring and smoke test

### Task 7: Load `.env` and verify end-to-end

**Files:**
- Modify: `hermes-agent/__main__.py`

- [ ] **Step 1: Add dotenv loading to `hermes-agent/__main__.py`**

Add at the top of `__main__.py`, before `from agent import run_agent`:

```python
from dotenv import load_dotenv
load_dotenv()
```

Full updated file:

```python
"""CLI entry point: python __main__.py <instagram_url>"""

import sys
from dotenv import load_dotenv

load_dotenv()

from agent import run_agent


def main():
    if len(sys.argv) != 2:
        print("Usage: python __main__.py <instagram_url>", file=sys.stderr)
        sys.exit(1)

    url = sys.argv[1]

    try:
        transcript = run_agent(url)
        print(transcript)
    except RuntimeError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Copy `.env.example` to `.env` and add your key**

```bash
cp hermes-agent/.env.example hermes-agent/.env
# Edit .env and fill in ANTHROPIC_API_KEY
```

- [ ] **Step 3: Install system deps if not present**

```bash
which yt-dlp || pip install yt-dlp
which ffmpeg || brew install ffmpeg   # macOS; use apt on Linux
```

- [ ] **Step 4: Run full test suite**

Run: `cd hermes-agent && python -m pytest tests/ -v`
Expected: all tests PASS

- [ ] **Step 5: Live smoke test with a real public Instagram reel**

Substitute a real public Instagram reel URL (any public reel you can access in a browser):

Run: `cd hermes-agent && python __main__.py "https://www.instagram.com/reel/REPLACE_WITH_REAL_REEL_ID/"`

Expected:
- Exit code 0
- One or more lines of transcript text printed to stdout
- No "Error:" lines on stderr

- [ ] **Step 6: Final commit**

```bash
git add hermes-agent/__main__.py
git commit -m "feat: load .env in CLI entry point; hermes agent complete"
```
