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
