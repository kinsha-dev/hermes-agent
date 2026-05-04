"""LM Studio HTTP client matching the /api/v1/chat API."""

import json
import os
import re

import requests

LM_STUDIO_URL = os.getenv("LM_STUDIO_URL", "http://localhost:1234")
LM_STUDIO_MODEL = os.getenv("LM_STUDIO_MODEL", "gemma-4-e2b-it")

_TOOL_CALL_RE = re.compile(r"```json\s*(\{.*?\})\s*```", re.DOTALL)

_SYSTEM_PROMPT = """\
You are a helpful assistant that transcribes Instagram videos step by step.

You have access to three tools. To call a tool, output a JSON block like this:

```json
{"tool": "<tool_name>", "args": {<key>: <value>, ...}}
```

Available tools:
- download_instagram_video(url: str) -> str  — downloads a video, returns local path
- extract_audio(video_path: str) -> str       — extracts mp3 from video, returns audio path
- transcribe_audio(audio_path: str) -> str   — transcribes audio, returns transcript text

Call one tool at a time. When you have the final transcript, output it as plain text with no JSON block.
"""


class LMStudioClient:
    def __init__(self, base_url: str = LM_STUDIO_URL, model: str = LM_STUDIO_MODEL):
        self.base_url = base_url.rstrip("/")
        self.model = model

    def chat(self, system_prompt: str, user_input: str) -> str:
        resp = requests.post(
            f"{self.base_url}/api/v1/chat",
            json={"model": self.model, "system_prompt": system_prompt, "input": user_input},
            timeout=120,
        )
        resp.raise_for_status()
        data = resp.json()
        for item in data.get("output", []):
            if item.get("type") == "message":
                return item["content"]
        raise RuntimeError(f"No message output in LM Studio response: {data}")


def run_agent_lmstudio(url: str, tool_impl: dict, client: LMStudioClient | None = None) -> str:
    """Agentic loop using LM Studio/Gemma via text-based JSON tool calls."""
    if client is None:
        client = LMStudioClient()

    conversation: list[str] = [f"Please transcribe the audio from this Instagram video: {url}"]

    for _ in range(10):
        user_input = "\n\n".join(conversation)
        reply = client.chat(_SYSTEM_PROMPT, user_input)

        match = _TOOL_CALL_RE.search(reply)
        if not match:
            return reply.strip()

        try:
            call = json.loads(match.group(1))
            tool_name = call["tool"]
            args = call.get("args", {})
        except (json.JSONDecodeError, KeyError) as exc:
            raise RuntimeError(f"Could not parse tool call from model output: {reply!r}") from exc

        if tool_name not in tool_impl:
            raise RuntimeError(f"Unknown tool: {tool_name!r}")

        try:
            result = tool_impl[tool_name](args)
            tool_feedback = f"Tool {tool_name!r} returned: {result}"
        except Exception as exc:
            tool_feedback = f"Tool {tool_name!r} raised an error: {exc}"

        conversation.append(f"Assistant: {reply}")
        conversation.append(f"Tool result: {tool_feedback}")

    raise RuntimeError("Agent exceeded maximum iterations without producing a final answer.")
