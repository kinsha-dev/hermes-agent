# Hermes Agent — Design Spec

**Date:** 2026-03-22
**Status:** Approved

## Overview

A standalone Python CLI agent built with the Claude Agent SDK that accepts an Instagram post URL, downloads the video, extracts the audio, and returns a plain-text transcript using Claude's native multimodal audio input.

## Goals

- Accept an Instagram URL from the command line
- Produce a plain-text transcript of the spoken audio in that video
- Stay within the Anthropic ecosystem (no extra APIs or API keys)

## Non-Goals

- Structured summaries, timestamps, or speaker diarization
- Monitoring Instagram for new posts
- Support for other platforms (YouTube, TikTok, etc.) — out of scope for v1

## Architecture

The agent is a small Python CLI with three tools registered to the Claude Agent SDK loop:

### Tools

| Tool | Input | Output | Implementation |
|---|---|---|---|
| `download_instagram_video` | Instagram URL (str) | Local video file path (str) | `yt-dlp` subprocess |
| `extract_audio` | Video file path (str) | Audio file path (.mp3) (str) | `ffmpeg` subprocess |
| `transcribe_audio` | Audio file path (str) | Plain-text transcript (str) | Claude multimodal API (base64 audio) |

### Data Flow

```
CLI arg (Instagram URL)
  → agent calls download_instagram_video(url)       → /tmp/hermes/<id>.mp4
  → agent calls extract_audio(video_path)           → /tmp/hermes/<id>.mp3
  → agent calls transcribe_audio(audio_path)        → "transcript text..."
  → prints transcript to stdout
```

### File Structure

```
hermes-agent/
├── agent.py          # Claude Agent SDK loop, tool registration, CLI entry point
├── tools.py          # Tool implementations: yt-dlp, ffmpeg, Claude audio call
├── requirements.txt  # anthropic (includes Agent SDK)
└── .env.example      # ANTHROPIC_API_KEY=
```

## Dependencies

- **Python** 3.11+
- **yt-dlp** — system or pip install, used to download Instagram video
- **ffmpeg** — system install, used to extract audio track
- **anthropic** Python SDK — Agent SDK + Claude API calls

No additional API keys required beyond `ANTHROPIC_API_KEY`.

## Error Handling

| Scenario | Behavior |
|---|---|
| Private or deleted post | `yt-dlp` error caught, agent returns clear error message |
| Audio file > 25 MB | Agent reports size limit exceeded; chunking deferred to v2 |
| No speech in video | Claude returns minimal/empty transcript; agent surfaces it as-is |
| Missing system deps (yt-dlp, ffmpeg) | Tool raises `RuntimeError` with install instructions |

## Model

- Uses `claude-opus-4-6` (or latest capable model) for the agent loop and audio transcription
- Audio sent as base64-encoded `audio/mpeg` in a multimodal user message
