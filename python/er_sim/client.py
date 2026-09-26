"""Talk to the TypeScript engine: a long-lived JSON-lines session, or one-off headless runs."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any


def repo_root() -> Path:
    """The repository root (this file lives in <root>/python/er_sim)."""
    return Path(os.environ.get("ER_SIM_ROOT", Path(__file__).resolve().parents[2]))


def _cli() -> list[str]:
    root = repo_root()
    tsx = root / "node_modules" / ".bin" / "tsx"
    return [str(tsx), str(root / "tools" / "headless" / "src" / "cli.ts")]


class SimError(RuntimeError):
    pass


class SimClient:
    """One simulation session in a Node subprocess. Use as a context manager, or call close()."""

    def __init__(self) -> None:
        self._proc = subprocess.Popen(
            [*_cli(), "serve"],
            cwd=repo_root(),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            bufsize=1,
        )

    def request(self, payload: dict[str, Any]) -> dict[str, Any]:
        assert self._proc.stdin and self._proc.stdout
        self._proc.stdin.write(json.dumps(payload) + "\n")
        self._proc.stdin.flush()
        line = self._proc.stdout.readline()
        if not line:
            raise SimError("simulation server exited")
        reply = json.loads(line)
        if not reply.get("ok"):
            raise SimError(reply.get("error", "unknown error"))
        return reply

    def reset(self, config: dict[str, Any], seed: int = 1) -> dict[str, Any]:
        return self.request({"op": "reset", "config": config, "seed": seed})["obs"]

    def step(self, minutes: float = 60, commands: list[dict[str, Any]] | None = None) -> tuple[dict[str, Any], bool]:
        reply = self.request({"op": "step", "minutes": minutes, "commands": commands or []})
        return reply["obs"], reply["done"]

    def metrics(self) -> dict[str, Any]:
        return self.request({"op": "metrics"})["metrics"]

    def close(self) -> None:
        if self._proc.poll() is None:
            try:
                self.request({"op": "close"})
            except (SimError, BrokenPipeError, OSError):
                pass
        for pipe in (self._proc.stdin, self._proc.stdout):
            if pipe:
                pipe.close()
        try:
            self._proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self._proc.kill()
            self._proc.wait()

    def __enter__(self) -> "SimClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


def run_headless(config: dict[str, Any], seeds: list[int]) -> list[dict[str, Any]]:
    """Run a config to the end for each seed; returns the metrics of each run."""
    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / "config.json"
        path.write_text(json.dumps(config))
        out = subprocess.run(
            [*_cli(), "run", "--config", str(path), "--seeds", f"{min(seeds)}-{max(seeds)}"],
            cwd=repo_root(),
            capture_output=True,
            text=True,
            check=True,
        )
    runs = json.loads(out.stdout)["runs"]
    return [r["metrics"] for r in runs if r["seed"] in seeds]
