"""Hermes Agent — agentic loop for Instagram video transcription.

LLM backend is selected via the LLM_BACKEND env var:
  - "anthropic" (default): uses Claude with native tool_use
  - "lmstudio": uses LM Studio / Gemma via text-based JSON tool calls
"""

import os

import anthropic

from lmstudio import LMStudioClient, run_agent_lmstudio
from tools import MODEL, download_instagram_video, extract_audio, transcribe_audio

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

def run_agent(url: str, client=None) -> str:
    """Run the agentic loop to transcribe an Instagram video.

    Backend is selected by the LLM_BACKEND env var ("anthropic" or "lmstudio").
    Returns the final plain-text transcript.
    """
    backend = os.getenv("LLM_BACKEND", "anthropic").lower()

    tool_impl = {
        "download_instagram_video": lambda args: download_instagram_video(**args),
        "extract_audio": lambda args: extract_audio(**args),
        "transcribe_audio": lambda args: transcribe_audio(**args),
    }

    if backend == "lmstudio":
        lm_client = client if isinstance(client, LMStudioClient) else LMStudioClient()
        return run_agent_lmstudio(url, tool_impl, client=lm_client)

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
            messages=list(messages),
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
                        result = tool_impl[block.name](block.input)
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
            if not tool_results:
                raise RuntimeError(
                    "stop_reason was tool_use but no tool_use blocks found in response"
                )
            messages.append({"role": "user", "content": tool_results})
        else:
            raise RuntimeError(f"Unexpected stop_reason: {response.stop_reason!r}")
