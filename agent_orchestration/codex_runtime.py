from __future__ import annotations

import json
import os
from typing import Any

from pydantic import BaseModel

from iriai_compose import AgentRuntime, Role, Workspace


class CodexAgentRuntime(AgentRuntime):
    """
    OpenAI/Codex-backed AgentRuntime for iriai-compose.

    Environment variables:
    - OPENAI_API_KEY (required)
    - OPENAI_MODEL (optional, default: gpt-5)
    - OPENAI_BASE_URL (optional)
    """

    name = "codex"

    def __init__(
        self,
        model: str | None = None,
        api_key: str | None = None,
        base_url: str | None = None,
    ) -> None:
        self.model = model or os.getenv("OPENAI_MODEL", "gpt-5")
        self.api_key = api_key or os.getenv("OPENAI_API_KEY")
        self.base_url = base_url or os.getenv("OPENAI_BASE_URL")
        if not self.api_key:
            raise RuntimeError("OPENAI_API_KEY is required for CodexAgentRuntime.")

        from openai import AsyncOpenAI

        client_kwargs: dict[str, Any] = {"api_key": self.api_key}
        if self.base_url:
            client_kwargs["base_url"] = self.base_url
        self.client = AsyncOpenAI(**client_kwargs)

    async def invoke(
        self,
        role: Role,
        prompt: str,
        *,
        output_type: type[BaseModel] | None = None,
        workspace: Workspace | None = None,
        session_key: str | None = None,
    ) -> str | BaseModel:
        system_prompt = role.prompt or "You are a helpful coding and workflow assistant."
        user_prompt = prompt

        if output_type is not None:
            # Keep this explicit until we adopt Responses.parse-style structured output here.
            schema_name = output_type.__name__
            schema_json = output_type.model_json_schema()
            user_prompt = (
                f"{prompt}\n\n"
                "Return only valid JSON matching this schema.\n"
                f"Schema name: {schema_name}\n"
                f"Schema: {json.dumps(schema_json, indent=2)}"
            )

        response = await self.client.responses.create(
            model=self.model,
            input=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        )

        text = _extract_response_text(response)
        if output_type is None:
            return text
        return output_type.model_validate_json(text)


def _extract_response_text(response: Any) -> str:
    direct = getattr(response, "output_text", None)
    if direct:
        return str(direct).strip()

    output = getattr(response, "output", None) or []
    chunks: list[str] = []
    for item in output:
        content = getattr(item, "content", None) or []
        for part in content:
            if getattr(part, "type", "") in {"output_text", "text"}:
                txt = getattr(part, "text", None)
                if txt:
                    chunks.append(str(txt))

    return "\n".join(chunks).strip()
