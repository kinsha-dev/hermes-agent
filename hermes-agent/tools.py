import base64
import os
import subprocess
import tempfile
from glob import glob as _glob


def glob(pattern):
    """Thin wrapper so tests can patch it."""
    return _glob(pattern)


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
        timeout=300,
    )

    if result.returncode != 0:
        raise RuntimeError(f"yt-dlp failed: {result.stderr.strip()}")

    matches = glob(f"{output_dir}/*.mp4") + glob(f"{output_dir}/*.webm") + glob(f"{output_dir}/*.mkv")
    if not matches:
        raise RuntimeError("yt-dlp exited 0 but no video file found in output dir")

    return matches[0]


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
        timeout=120,
    )

    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr.strip()}")

    return audio_path
