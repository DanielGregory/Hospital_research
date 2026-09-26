"""Python access to the ER simulation engine.

The engine is TypeScript; this package talks to it through the headless runner's
JSON-lines server (`pnpm headless serve`). Standard library only; if `gymnasium`
is installed, `er_sim.env.make_gym_env` wraps the environment for it.
"""

from .client import SimClient, run_headless, repo_root
from .env import ErEnv, ACTIONS

__all__ = ["SimClient", "run_headless", "repo_root", "ErEnv", "ACTIONS"]
