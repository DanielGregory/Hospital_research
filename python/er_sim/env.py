"""A Gym-style environment: every step, an agent adjusts staffing and flow, then the ED runs for a while.

    env = ErEnv(config)
    obs, info = env.reset(seed=1)
    obs, reward, terminated, truncated, info = env.step(action)

Observations are flat lists of floats (see OBSERVATION_NAMES). Actions index ACTIONS.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .client import SimClient

ACTIONS = [
    "noop",
    "doctor+1",
    "doctor-1",
    "fast_track_on",
    "fast_track_off",
    "escalate_on",
    "escalate_off",
]

OBSERVATION_NAMES = [
    "time_fraction",
    "waiting_untriaged",
    "waiting_esi1",
    "waiting_esi2",
    "waiting_esi3",
    "waiting_esi4",
    "waiting_esi5",
    "waiting_for_bed",
    "beds_main_occupied",
    "beds_fast_track_occupied",
    "boarders",
    "doctors_on_duty",
    "doctors_busy",
    "doctor_fatigue",
    "fast_track_open",
    "escalated",
]


@dataclass
class RewardWeights:
    """Default reward: minus the cost of what happened during the step (all weights are placeholders)."""

    waiting_hour: float = 1.0  # per patient-hour waiting to be seen
    lwbs: float = 5.0  # per patient who left without being seen
    deterioration: float = 10.0
    bounce_back: float = 5.0
    doctor_hour: float = 0.5  # per doctor-hour on duty (staffing is not free)


def flatten(obs: dict[str, Any]) -> list[float]:
    w = obs["waitingByAcuity"]
    doc = obs["staff"].get("doctor", {"onDuty": 0, "busy": 0, "meanFatigue": 0})
    return [
        obs["now"] / obs["duration"],
        w["0"], w["1"], w["2"], w["3"], w["4"], w["5"],
        obs["waitingForBed"],
        obs["bedsOccupied"]["main"],
        obs["bedsOccupied"]["fastTrack"],
        obs["boarders"],
        doc["onDuty"],
        doc["busy"],
        doc["meanFatigue"],
        1.0 if obs["fastTrackOpen"] else 0.0,
        1.0 if obs["escalated"] else 0.0,
    ]


class ErEnv:
    """Episodes run one config from t = 0 to its duration, `step_minutes` at a time."""

    def __init__(self, config: dict[str, Any], step_minutes: float = 60, weights: RewardWeights | None = None, max_doctors: int = 10) -> None:
        self.config = config
        self.step_minutes = step_minutes
        self.weights = weights or RewardWeights()
        self.max_doctors = max_doctors
        self._client: SimClient | None = None
        self._obs: dict[str, Any] | None = None

    @property
    def action_count(self) -> int:
        return len(ACTIONS)

    def reset(self, seed: int | None = None) -> tuple[list[float], dict[str, Any]]:
        if self._client is None:
            self._client = SimClient()
        self._obs = self._client.reset(self.config, seed if seed is not None else 1)
        return flatten(self._obs), {"raw": self._obs}

    def _commands(self, action: int) -> list[dict[str, Any]]:
        assert self._obs is not None
        name = ACTIONS[action]
        doctors = self._obs["staff"].get("doctor", {"onDuty": 0})["onDuty"]
        if name == "doctor+1" and doctors < self.max_doctors:
            return [{"type": "setStaff", "role": "doctor", "count": doctors + 1}]
        if name == "doctor-1" and doctors > 1:
            return [{"type": "setStaff", "role": "doctor", "count": doctors - 1}]
        if name in ("fast_track_on", "fast_track_off"):
            return [{"type": "setFastTrack", "enabled": name == "fast_track_on"}]
        if name in ("escalate_on", "escalate_off") and self._obs["inpatientFree"] is not None:
            return [{"type": "setEscalation", "enabled": name == "escalate_on"}]
        return []

    def step(self, action: int) -> tuple[list[float], float, bool, bool, dict[str, Any]]:
        if self._client is None or self._obs is None:
            raise RuntimeError("call reset() first")
        if not 0 <= action < len(ACTIONS):
            raise ValueError(f"action must be in 0..{len(ACTIONS) - 1}")
        before = self._obs
        after, done = self._client.step(self.step_minutes, self._commands(action))
        self._obs = after
        reward = self.reward(before, after)
        return flatten(after), reward, done, False, {"raw": after}

    def reward(self, before: dict[str, Any], after: dict[str, Any]) -> float:
        w = self.weights
        d = lambda k: after["totals"][k] - before["totals"][k]  # noqa: E731
        hours = (after["now"] - before["now"]) / 60
        doctors = after["staff"].get("doctor", {"onDuty": 0})["onDuty"]
        return -(
            w.waiting_hour * d("waitingPatientMinutes") / 60
            + w.lwbs * d("lwbs")
            + w.deterioration * d("deteriorations")
            + w.bounce_back * d("bounceBacks")
            + w.doctor_hour * doctors * hours
        )

    def metrics(self) -> dict[str, Any]:
        if self._client is None:
            raise RuntimeError("call reset() first")
        return self._client.metrics()

    def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None


def make_gym_env(config: dict[str, Any], **kwargs: Any):  # pragma: no cover - needs gymnasium
    """Wrap ErEnv as a gymnasium.Env (requires `pip install gymnasium numpy`)."""
    import gymnasium as gym
    import numpy as np

    class ErGymEnv(gym.Env):
        metadata = {"render_modes": []}

        def __init__(self) -> None:
            self.inner = ErEnv(config, **kwargs)
            self.action_space = gym.spaces.Discrete(len(ACTIONS))
            self.observation_space = gym.spaces.Box(0, np.inf, shape=(len(OBSERVATION_NAMES),), dtype=np.float32)

        def reset(self, *, seed: int | None = None, options: dict | None = None):
            super().reset(seed=seed)
            obs, info = self.inner.reset(seed)
            return np.asarray(obs, dtype=np.float32), info

        def step(self, action):
            obs, r, term, trunc, info = self.inner.step(int(action))
            return np.asarray(obs, dtype=np.float32), r, term, trunc, info

        def close(self) -> None:
            self.inner.close()

    return ErGymEnv()
