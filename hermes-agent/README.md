# Hermes Agent

A Python CLI that downloads an Instagram video, extracts its audio, and transcribes it — all in one command.

## How it works

```
Instagram URL → yt-dlp (download) → ffmpeg (audio extract) → Whisper (transcribe) → transcript
```

## Requirements

- Python 3.11+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — `brew install yt-dlp`
- [ffmpeg](https://ffmpeg.org/) — `brew install ffmpeg`

```bash
pip install -r requirements.txt
```

## Usage

```bash
python __main__.py <instagram_url>
```

**Example:**

```bash
python __main__.py "https://www.instagram.com/reels/DWMDDi0jh8P/"
```

Outputs the transcript to stdout.

## Project structure

```
hermes-agent/
├── __main__.py      # CLI entry point
├── agent.py         # Claude agentic loop (tool-use orchestration)
├── tools.py         # download_instagram_video, extract_audio, transcribe_audio
├── requirements.txt
└── tests/
    ├── test_tools.py
    ├── test_agent.py
    └── test_cli.py
```

## Running tests

```bash
pytest tests/ -v
```

## Notes

- Transcription uses [OpenAI Whisper](https://github.com/openai/whisper) (`base` model) running locally — no API key required.
- Downloaded files are written to a temp directory and can be safely deleted after use.
- Instagram login may be required for private content — pass cookies via `yt-dlp`'s `--cookies` flag if needed.
