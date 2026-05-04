# News Reel Skill — Design Document
**Date:** 2026-03-05
**Status:** Approved

## Overview

A new clawdbott skill (`news-reel`) that generates faceless vertical video Reels (1080×1920) about trending news/geopolitical topics. Claude writes the script and orchestrates a 5-step pipeline: script → DALL-E images → OpenAI TTS voiceover → subtitles → ffmpeg assembly. Output is saved locally for manual posting.

---

## Pipeline

```
User topic (via WhatsApp or direct prompt)
    │
    ▼
1. SCRIPT (Claude)
   - 5–6 segments, each with: narration text, image_prompt, duration_seconds
   - Written in movie-trailer / breaking-news cadence
   - Short punchy sentences, dramatic pauses marked with "..."
   - Saved as script.json
    │
    ▼
2. IMAGES (DALL-E 3)
   - One vertical image (1024×1536) per segment
   - Cinematic, dramatic, high-detail prompts
   - Saved as images/01.png … 06.png
    │
    ▼
3. VOICEOVER (OpenAI TTS)
   - Voice: onyx (deep, authoritative)
   - Speed: 0.92 (slower = more gravitas)
   - With_timestamps: true (word-level timing for subtitles)
   - Saved as voiceover.mp3 + timestamps.json
    │
    ▼
4. SUBTITLES (Python)
   - 3–5 words per card, timed from word-level TTS timestamps
   - ASS format with white bold text, black stroke, centered bottom-third
   - Saved as subtitles.ass
    │
    ▼
5. ASSEMBLE (ffmpeg)
   - Each image shown for its segment duration
   - Ken Burns zoom/pan effect per image
   - Voiceover audio track
   - Dramatic CC0 music bed at -22dB (bundled: assets/dramatic.mp3)
   - Burned-in subtitles
   - Output: 1080×1920, H.264, 30fps, AAC audio
   - Saved as final.mp4
```

---

## File Structure

```
skills/news-reel/
  SKILL.md
  requirements.txt          # openai, requests
  assets/
    dramatic.mp3            # CC0 music bed (freepd.com)
  scripts/
    generate.py             # orchestrator — runs all 5 steps
    tts.py                  # OpenAI TTS → voiceover.mp3 + timestamps.json
    subtitles.py            # timestamps.json → subtitles.ass
    assemble.py             # ffmpeg Ken Burns + audio mix + subs → final.mp4
```

---

## Output Structure

```
~/.openclaw/workspace/reels/
  YYYY-MM-DD-HH-MM-<slug>/
    script.json
    images/
      01.png … 06.png
    voiceover.mp3
    timestamps.json
    subtitles.ass
    assets/
      dramatic.mp3          # symlinked or copied from skill assets
    final.mp4               # ← ready to post
```

---

## Script JSON Format

Claude produces this structure:

```json
{
  "title": "US Submarine Sinks Iranian Warship",
  "segments": [
    {
      "text": "Deep beneath the Indian Ocean... a US Navy submarine was tracking its target.",
      "image_prompt": "dramatic cinematic underwater view of a US Navy submarine in dark ocean depths, military, tense atmosphere, vertical composition",
      "duration_seconds": 8
    },
    {
      "text": "What happened next... shocked the world.",
      "image_prompt": "massive explosion on the surface of the Indian Ocean at night, burning warship, dramatic red and orange flames reflecting on water, vertical cinematic",
      "duration_seconds": 5
    }
  ]
}
```

---

## How Claude Uses the Skill

From SKILL.md, Claude will:

1. Parse the topic from the user message
2. Write `script.json` inline (5–6 segments)
3. Create the output directory: `~/.openclaw/workspace/reels/YYYY-MM-DD-HH-MM-<slug>/`
4. Save `script.json` to the output directory
5. Run the orchestrator:
```bash
python3 {baseDir}/scripts/generate.py \
  --script <out-dir>/script.json \
  --out-dir <out-dir> \
  --music {baseDir}/assets/dramatic.mp3
```
6. Report the output path on completion

---

## Technical Specs

| Parameter | Value |
|-----------|-------|
| Resolution | 1080×1920 (9:16 vertical) |
| Frame rate | 30fps |
| Video codec | H.264 (libx264) |
| Audio codec | AAC 128kbps |
| Duration | 35–55 seconds |
| TTS voice | onyx |
| TTS speed | 0.92 |
| Music level | -22dB under voiceover |
| Image model | dall-e-3 |
| Image size | 1024×1536 |
| Ken Burns | 1.05× zoom over segment duration, random pan direction |

---

## Dependencies

- `ffmpeg` (available in container via video-frames skill)
- `python3` (available in container)
- `openai` Python package (pip install)
- `OPENAI_API_KEY` env var

---

## Constraints

- No Instagram API — output only, user posts manually
- All output in `~/.openclaw/workspace/reels/` (bind-mounted to host)
- Music track is CC0 (freepd.com) — no attribution or licensing issues
