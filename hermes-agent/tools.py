import os
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
