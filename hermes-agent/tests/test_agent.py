import pytest
from unittest.mock import patch, MagicMock
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
