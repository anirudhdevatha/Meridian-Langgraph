#add tools like math tools for the llm and maybe web search tool.
#get better dataset
#add moderator functionality

from dotenv import load_dotenv
import uuid
from langchain_google_genai import ChatGoogleGenerativeAI
from langgraph.graph import StateGraph, START, END
from langchain_core.messages import HumanMessage, SystemMessage, AIMessage
from langgraph.checkpoint.memory import MemorySaver
from typing import Annotated, TypedDict, Literal, Optional
from pydantic import BaseModel, Field
from generate_dataset import generate_current_data
from langgraph.graph.message import add_messages
import operator

SHARED_RULES = """RULES:
- Use only the data provided. Do not use outside knowledge about the company.
- Do not do arithmetic. You may compare provided numbers (higher/lower, above/below), but don't compute new ones.
- If a field is N/A, say it's unavailable. Never guess.
- Every claim in `reasoning` follows IF/THEN/BECAUSE and cites the specific metric by name.
- You only have a current-price snapshot. No financial statements, news, or filings. Let that cap your confidence.
- Note the sector and industry. Some metrics mislead for some company types (e.g. GAAP P/E and payout ratio for REITs, P/E for banks; negative forwardPE means expected losses, not "expensive"). Flag a metric as unreliable instead of taking it at face value.

RATINGS:
- BUY: the data supports meaningful upside on balance.
- HOLD: the data is mixed, or your side's case is weak.
- SELL: the data points to meaningful downside on balance.
A weak case from your side should produce HOLD, not a forced BUY or SELL.
Confidence: 0.3 = barely leaning, 0.6 = solid case, 0.9 = overwhelming. With snapshot-only data, rarely go above 0.7."""

BULL_PROMPT = f"""You are the Bull Analyst on an investment committee. Your job is to find and argue the best evidence for upside in the data, then rate the stock honestly.

Look for:
- Momentum: price vs. fiftyDayAverage and twoHundredDayAverage, proximity to the 52-week high, 52WeekChange.
- Valuation that is justified or improving: forwardPE below trailingPE, a reasonable pegRatio.
- Financial flexibility: a low payoutRatio leaves room for growth and dividend increases.
- Positive volume or low short interest (shortPercentOfFloat, shortRatio).

Acknowledge a risk if it's clearly in the data, but your role is to surface the upside others might miss.

{SHARED_RULES}"""

BEAR_PROMPT = f"""You are the Bear Analyst on an investment committee. Your job is to find and argue the biggest risks in the data, then rate the stock honestly.

Look for:
- Valuation risk: high trailingPE or forwardPE, steep priceToBook or enterpriseToEbitda, pegRatio above ~2.
- Technical risk: price stretched above the twoHundredDayAverage, or breaking below the fiftyDayAverage; 52WeekChange suggesting a run-up that could reverse.
- Crowding or bearish positioning: high shortPercentOfFloat or shortRatio.
- Yield and payout risk: a payoutRatio near or above 100%, or a dividend that looks unsustainable.

Acknowledge a strength if it's clearly in the data, but your role is to surface the downside others might miss.

{SHARED_RULES}"""

load_dotenv()

bull_llm = ChatGoogleGenerativeAI(model="gemini-3.1-flash-lite", temperature=0.2)
bear_llm = ChatGoogleGenerativeAI(model="gemini-3.1-flash-lite", temperature=0.2)

class State(TypedDict):
    ticker: str
    current_data: dict
    bull: Optional[dict]
    bear: Optional[dict]
    consensus: bool
    turns: int
    changed: bool
    debate_log: Annotated[list[dict], operator.add]

class AgentResponse(BaseModel):
    rating: Literal["BUY", "HOLD", "SELL"]
    confidence: float = Field(..., ge=0, le=1)
    reasoning: str = Field(..., description="IF/THEN/BECAUSE format")
    key_points: list[str]

class Rebuttal(BaseModel):
    rating: Literal["BUY", "HOLD", "SELL"]
    confidence: float = Field(..., ge=0, le=1)
    reasoning: str = Field(..., description=(
        "Respond directly to the opponent's 1-2 strongest points, naming the metric. "
        "Do NOT restate your earlier argument. Only new points. 3-5 sentences."))
    concessions: list[str] = Field(..., description="Opponent points you accept. Empty list if none.")
    what_would_change_my_mind: str

def rebut(side, llm, own, opp, data, n):
    prompt = f"""You are the {side} analyst in round {n} of a committee debate.

    DATA:
    {format_data(data)}

    YOUR PREVIOUS POSITION:
    Rating: {own['rating']} (confidence {own['confidence']})
    {own['reasoning']}

    OPPONENT'S LATEST POSITION:
    Rating: {opp['rating']} (confidence {opp['confidence']})
    {opp['reasoning']}

    INSTRUCTIONS:
    1. Answer the opponent's strongest points directly, citing the metric.
    2. Concede anything they got right. Conceding is not weakness.
    3. Do not repeat your earlier argument. If you have nothing new, say so briefly.
    4. Change your rating or confidence only if their points justify it.
    5. Say what specific evidence would change your mind."""
    result = llm.with_structured_output(Rebuttal).invoke([
        SystemMessage(content=f"You are the {side} analyst on an investment committee. Rate honestly.\n\n{SHARED_RULES}"),
        HumanMessage(content=prompt),
    ])
    return result.model_dump()

def fmt_big(v):
    for div, suffix in ((1e12, "T"), (1e9, "B"), (1e6, "M")):
        if abs(v) >= div:
            return f"${v / div:.2f}{suffix}"
    return f"${v:,.2f}"

def format_data(d: dict) -> str:
    lines = []
    for k, m in d.items():
        v, unit = m["value"], m["unit"]
        if v is None:
            lines.append(f"{k}: N/A")
        elif unit == "USD":
            lines.append(f"{k}: {fmt_big(v)}")
        elif unit == "%":
            lines.append(f"{k}: {v:.2f}%")
        elif unit == "x":
            lines.append(f"{k}: {v:.2f}x")
        elif unit == "days":
            lines.append(f"{k}: {v:.1f} days")
        elif unit == "shares":
            lines.append(f"{k}: {v:,.0f} shares")
        else:
            lines.append(f"{k}: {v}")
    return "\n".join(lines)

def fetch_data(state: State):
    data = generate_current_data(state["ticker"])
    if data["currentPrice"]["value"] is None:
        raise ValueError(f"No data for ticker {state['ticker']}")
    return {"current_data": data}

def prompt_bull(state: State):
    structured = bull_llm.with_structured_output(AgentResponse)
    result = structured.invoke(
        [
            SystemMessage(content=BULL_PROMPT),
            HumanMessage(
                content=f"Analyze the stock data and build the bullish thesis. Ticker: {state['ticker']}\n\nCURRENT DATA:\n{format_data(state['current_data'])}"
            )
        ]
    )
    out = result.model_dump()
    return {"bull": out, "debate_log": [{"round": 0, "speaker": "bull", **out}]}

def prompt_bear(state: State):
    structured = bear_llm.with_structured_output(AgentResponse)
    result = structured.invoke(
        [
            SystemMessage(content=BEAR_PROMPT),
            HumanMessage(
                content=f"Analyze the stock data and build the bearish thesis. Ticker: {state['ticker']}\n\nCURRENT DATA:\n{format_data(state['current_data'])}"
            )
        ]
    )
    out = result.model_dump()
    return {"bear": out, "debate_log": [{"round": 0, "speaker": "bear", **out}]}

MAX_TURNS = 3

def router_node(state: State):
    return {"consensus": state["bull"]["rating"] == state["bear"]["rating"]}

def consensus_router(state: State):
    stalemate = state["turns"] >= 1 and not state.get("changed", True)
    if state["consensus"] or stalemate or state["turns"] >= MAX_TURNS:
        return "review"
    return "debate"

def debate(state: State):
    n = state["turns"] + 1
    data = state["current_data"]
    bull_prev, bear_prev = state["bull"], state["bear"]

    bull_new = rebut("bull", bull_llm, bull_prev, bear_prev, data, n)
    bear_new = rebut("bear", bear_llm, bear_prev, bull_new, data, n)  # bear answers the bull's updated take

    changed = (bull_new["rating"] != bull_prev["rating"]
               or bear_new["rating"] != bear_prev["rating"])
    return {
        "bull": bull_new, "bear": bear_new,
        "turns": n, "changed": changed,
        "debate_log": [{"round": n, "speaker": "bull", **bull_new},
                       {"round": n, "speaker": "bear", **bear_new}],
    }

def review(state: State):
    print(f"\n--- REACHED REVIEW NODE ---")
    print(f"Final Consensus: {state.get('consensus')}")
    print(f"Total Turns: {state.get('turns')}")
    return {}

graph_builder = StateGraph(State)

graph_builder.add_node('fetch_data', fetch_data)
graph_builder.add_node('bull_analyst', prompt_bull)
graph_builder.add_node('bear_analyst', prompt_bear)
graph_builder.add_node('router_node', router_node)
graph_builder.add_node('debate', debate)
graph_builder.add_node('review', review)

graph_builder.add_edge(START, "fetch_data")
graph_builder.add_edge("fetch_data", "bull_analyst")
graph_builder.add_edge("fetch_data", "bear_analyst")
graph_builder.add_edge(["bull_analyst", "bear_analyst"], "router_node")
graph_builder.add_conditional_edges("router_node", consensus_router, {"debate": "debate", "review": "review"})
graph_builder.add_edge("debate", "router_node")
graph_builder.add_edge("review", END)

graph = graph_builder.compile()

ticker = input("Enter a ticker: ")
print("")

png_bytes = graph.get_graph().draw_mermaid_png()
with open("my_graph.png", "wb") as f:
    f.write(png_bytes)

if __name__ == "__main__":
    result = graph.invoke({
        "ticker": ticker,
        "turns": 0,
        "consensus": False,
        "changed": True,
        "debate_log": [],
    })

    log = sorted(result["debate_log"], key=lambda e: (e["round"], e["speaker"] != "bull"))
    for e in log:
        label = "INITIAL" if e["round"] == 0 else f"ROUND {e['round']}"
        print(f"\n[{label}] {e['speaker'].upper()}: {e['rating']} ({e['confidence']})")
        print(e["reasoning"])
        if e.get("concessions"):
            print("Concedes:", "; ".join(e["concessions"]))
        if e.get("what_would_change_my_mind"):
            print("Would change my mind:", e["what_would_change_my_mind"])

    print("\n" + "=" * 50)
    print(f"Consensus: {result['consensus']} | Rounds: {result['turns']}")
    print(f"Final Bull: {result['bull']['rating']} | Final Bear: {result['bear']['rating']}")