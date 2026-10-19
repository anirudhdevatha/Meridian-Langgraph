import builtins
import json
import os
import re
import sys
import tempfile
from unittest import mock

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from langchain_core.runnables.graph import Graph
from pydantic import BaseModel


BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))


def _load_graph():
    # main.py runs a CLI at import time: it prompts with input() and renders the
    # graph to a PNG over the network. Neither belongs in a server, so neutralise
    # both for the duration of the import (and keep my_graph.png out of the repo).
    if BACKEND_DIR not in sys.path:
        sys.path.insert(0, BACKEND_DIR)
    with tempfile.TemporaryDirectory() as scratch:
        cwd = os.getcwd()
        os.chdir(scratch)
        try:
            with mock.patch.object(builtins, "input", lambda *_: ""), \
                 mock.patch.object(Graph, "draw_mermaid_png", lambda *_, **__: b""):
                from main import graph
        finally:
            os.chdir(cwd)
    return graph


graph = _load_graph()

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv(
        "CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"
    ).split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)

TICKER = re.compile(r"^[A-Z]{1,5}([.-][A-Z])?$")


class TickerRequest(BaseModel):
    ticker: str


def _event(payload: dict) -> str:
    return json.dumps(payload) + "\n"


def _debate_events(ticker: str):
    """Run the graph and yield one NDJSON line per debate turn as it is produced."""
    final = {"consensus": False, "turns": 0, "bull": None, "bear": None}
    try:
        stream = graph.stream(
            {
                "ticker": ticker,
                "turns": 0,
                "consensus": False,
                "changed": True,
                "debate_log": [],
            },
            stream_mode="updates",
        )
        openings = []  # bull and bear run in parallel; hold the pair so bull always leads
        for chunk in stream:
            for update in chunk.values():
                entries = update.get("debate_log", [])
                if entries and entries[0]["round"] == 0:
                    openings.extend(entries)
                    entries = openings if len(openings) == 2 else []
                for entry in sorted(entries, key=lambda e: e["speaker"] != "bull"):
                    yield _event({"type": "turn", **entry})
                for key in final:
                    if key in update:
                        final[key] = update[key]

        yield _event({
            "type": "done",
            "consensus": final["consensus"],
            "rounds": final["turns"],
            "bull_rating": final["bull"]["rating"],
            "bear_rating": final["bear"]["rating"],
        })
    except Exception as e:
        yield _event({"type": "error", "message": f"Error analyzing {ticker}: {e}"})


@app.post("/api/debate")
def debate(payload: TickerRequest):
    ticker = payload.ticker.strip().upper()
    if not TICKER.match(ticker):
        raise HTTPException(status_code=400, detail="Invalid ticker")
    # a sync generator is iterated in a threadpool, so the blocking graph doesn't stall the event loop
    return StreamingResponse(
        _debate_events(ticker),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-store"},
    )
