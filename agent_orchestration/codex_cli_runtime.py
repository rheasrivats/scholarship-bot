from __future__ import annotations

import asyncio
import json
import os
import tempfile
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from iriai_compose import AgentRuntime, Role, Workspace


class CodexCliAgentRuntime(AgentRuntime):
    """
    Agent runtime backed by local `codex exec`.

    Uses your existing Codex CLI login/session, so no OPENAI_API_KEY is required.
    """

    name = "codex-cli"

    def __init__(self, codex_bin: str | None = None) -> None:
        self.codex_bin = codex_bin or os.getenv("CODEX_BIN", "codex")
        self.timeout_sec = int(os.getenv("CODEX_CLI_TIMEOUT_SEC", "180"))
        self.verbose = os.getenv("CODEX_CLI_VERBOSE", "1") != "0"
        self.enable_search = os.getenv("CODEX_CLI_ENABLE_SEARCH", "1") != "0"

    async def invoke(
        self,
        role: Role,
        prompt: str,
        *,
        output_type: type[BaseModel] | None = None,
        workspace: Workspace | None = None,
        session_key: str | None = None,
    ) -> str | BaseModel:
        cwd = str(workspace.path if workspace else Path.cwd())
        system_prompt = role.prompt or "You are a helpful assistant."
        full_prompt = f"{system_prompt}\n\n## Task\n{prompt}".strip()

        with tempfile.TemporaryDirectory(prefix="codex-cli-runtime-") as td:
            td_path = Path(td)
            output_path = td_path / "last_message.txt"
            schema_path = td_path / "schema.json"

            cmd = [self.codex_bin]
            if self.enable_search:
                cmd.append("--search")
            cmd.extend(
                [
                    "exec",
                    "--skip-git-repo-check",
                    "-C",
                    cwd,
                    "--output-last-message",
                    str(output_path),
                    "-",  # read prompt from stdin
                ]
            )

            if output_type is not None:
                schema_path.write_text(json.dumps(output_type.model_json_schema(), indent=2), encoding="utf-8")
                cmd = [self.codex_bin]
                if self.enable_search:
                    cmd.append("--search")
                cmd.extend(
                    [
                        "exec",
                        "--skip-git-repo-check",
                        "-C",
                        cwd,
                        "--output-schema",
                        str(schema_path),
                        "--output-last-message",
                        str(output_path),
                        "-",
                    ]
                )

            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            if self.verbose:
                print(
                    f"[codex-cli] invoking role='{role.name}' session='{session_key or 'n/a'}' "
                    f"cwd='{cwd}' timeout={self.timeout_sec}s",
                    flush=True,
                )
            try:
                stdout, stderr = await asyncio.wait_for(
                    proc.communicate(full_prompt.encode("utf-8")),
                    timeout=self.timeout_sec,
                )
            except asyncio.TimeoutError as exc:
                proc.kill()
                await proc.wait()
                raise RuntimeError(
                    f"codex exec timed out after {self.timeout_sec}s for role '{role.name}'. "
                    "Try increasing CODEX_CLI_TIMEOUT_SEC, or verify Codex CLI is logged in and online."
                ) from exc

            if proc.returncode != 0:
                stderr_text = stderr.decode("utf-8", errors="replace")
                stdout_text = stdout.decode("utf-8", errors="replace")
                msg = (
                    f"codex exec failed with exit code {proc.returncode}\n"
                    f"stderr (tail):\n{_tail(stderr_text)}\n"
                    f"stdout (tail):\n{_tail(stdout_text)}"
                )
                raise RuntimeError(msg)

            if not output_path.exists():
                raise RuntimeError("codex exec completed but output message file was not created.")

            text = output_path.read_text(encoding="utf-8").strip()
            if self.verbose:
                print(f"[codex-cli] completed role='{role.name}'", flush=True)
            if output_type is None:
                return text
            return output_type.model_validate_json(text)


def _tail(value: str, lines: int = 40) -> str:
    parts = value.strip().splitlines()
    if not parts:
        return "(empty)"
    return "\n".join(parts[-lines:])
