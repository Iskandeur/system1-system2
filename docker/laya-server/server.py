from __future__ import annotations

import time
from typing import Any, Dict

from fastapi import FastAPI
from pydantic import BaseModel

import laya

app = FastAPI(title="laya-systemone", version="0.1")


class SystemOneRequest(BaseModel):
    model: str
    state: Any
    questions: Dict[str, Any]


def _jsonify(x: Any) -> Any:
    # Best-effort conversion to plain JSON types.
    if x is None:
        return None
    if isinstance(x, (str, int, float, bool)):
        return x
    if isinstance(x, dict):
        return {str(k): _jsonify(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_jsonify(v) for v in x]

    # numpy scalars
    try:
        import numpy as np  # type: ignore

        if isinstance(x, np.generic):
            return x.item()
    except Exception:
        pass

    return str(x)


_agents: Dict[str, Any] = {}


def _get_agent(model_id: str):
    # Cache per model id; loading pulls weights from Hugging Face on first use.
    if model_id not in _agents:
        _agents[model_id] = laya.load(model_id)
    return _agents[model_id]


@app.post("/v1/systemone")
def systemone(req: SystemOneRequest):
    t0 = time.time()
    agent = _get_agent(req.model)
    result = agent.predict(req.state, req.questions)
    out = {
        "model": req.model,
        "answers": _jsonify(result.get("answers")),
        # We don't have token usage for local inference; keep shape compatible.
        "usage": {},
        "latency_ms": int((time.time() - t0) * 1000),
    }
    return out
