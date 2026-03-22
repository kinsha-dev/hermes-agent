import pytest
from unittest.mock import patch, MagicMock
from tools import download_instagram_video, extract_audio


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
        with pytest.raises(RuntimeError, match="ffmpeg failed.*codec error"):
            extract_audio(str(fake_video))
