"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

const STORAGE_KEY = "meridian.debates.v2";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
// the backend runs an opening plus up to this many rebuttals, fewer if the sides agree sooner
const MAX_REBUTTALS = 3;
const TICKER = /^[A-Z]{1,5}([.-][A-Z])?$/;

type Side = "bull" | "bear";
type Status = "debating" | "verdict" | "stopped";

type Rating = "BUY" | "HOLD" | "SELL";

interface Turn {
  id: string;
  side: Side;
  round: number; // 0 is the opening statement, 1+ are rebuttals
  text: string;
  rating: Rating;
  confidence: number;
  keyPoints?: string[];
  concessions?: string[];
  changeMind?: string;
}

interface Debate {
  id: string;
  ticker: string;
  status: Status;
  round: number;
  turns: Turn[];
  verdict?: string;
}

type DebateEvent =
  | {
      type: "turn";
      round: number;
      speaker: Side;
      rating: Rating;
      confidence: number;
      reasoning: string;
      key_points?: string[];
      concessions?: string[];
      what_would_change_my_mind?: string;
    }
  | {
      type: "done";
      consensus: boolean;
      rounds: number;
      bull_rating: Rating;
      bear_rating: Rating;
    }
  | { type: "error"; message: string };

const uid = () =>
  Math.random().toString(36).slice(2) + Date.now().toString(36);

function loadDebates(): Debate[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (d): d is Debate =>
          typeof d === "object" &&
          d !== null &&
          typeof (d as Debate).id === "string" &&
          typeof (d as Debate).ticker === "string" &&
          Array.isArray((d as Debate).turns)
      )
      .map((d) => ({
        ...d,
        // a debate that was cut off by a page reload can't still be running
        status: d.status === "debating" ? "stopped" : d.status,
      }));
  } catch {
    return [];
  }
}

async function streamDebate(
  ticker: string,
  signal: AbortSignal,
  onEvent: (event: DebateEvent) => void
) {
  const res = await fetch(`${API_URL}/api/debate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticker }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error("Request failed");

  // newline-delimited JSON: one event per line, possibly split across chunks
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) onEvent(JSON.parse(line) as DebateEvent);
    }
    if (done) break;
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer) as DebateEvent);
}

function summarize(e: Extract<DebateEvent, { type: "done" }>): string {
  const after =
    e.rounds === 0
      ? "after the opening statements"
      : `after ${e.rounds} round${e.rounds === 1 ? "" : "s"} of rebuttal`;
  if (e.consensus) return `Both sides settled on ${e.bull_rating} ${after}.`;
  return `No consensus ${after}. The Optimist finished at ${e.bull_rating} and the Skeptic at ${e.bear_rating}.`;
}

export default function DebateApp() {
  const [debates, setDebates] = useState<Debate[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sideOpen, setSideOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  // load saved debates once on the client
  useEffect(() => {
    setDebates(loadDebates());
    setHydrated(true);
  }, []);

  // save when idle (not on every streamed token)
  useEffect(() => {
    if (!hydrated || running) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(debates));
    } catch {
      /* storage unavailable: history just won't persist */
    }
  }, [debates, hydrated, running]);

  // stop any stream when leaving the page
  useEffect(() => () => abortRef.current?.abort(), []);

  const active = debates.find((d) => d.id === activeId) ?? null;

  // keep the newest text in view
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [active?.turns, active?.verdict]);

  const update = (id: string, fn: (d: Debate) => Debate) =>
    setDebates((prev) => prev.map((d) => (d.id === id ? fn(d) : d)));

  async function run(debate: Debate) {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setRunning(true);
    setError(null);

    let finished = false;
    try {
      await streamDebate(debate.ticker, ctrl.signal, (ev) => {
        if (ev.type === "error") throw new Error(ev.message);
        if (ev.type === "done") {
          finished = true;
          update(debate.id, (d) => ({
            ...d,
            status: "verdict",
            verdict: summarize(ev),
          }));
          return;
        }
        update(debate.id, (d) => ({
          ...d,
          round: ev.round,
          turns: [
            ...d.turns,
            {
              id: uid(),
              side: ev.speaker,
              round: ev.round,
              text: ev.reasoning,
              rating: ev.rating,
              confidence: ev.confidence,
              keyPoints: ev.key_points,
              concessions: ev.concessions,
              changeMind: ev.what_would_change_my_mind,
            },
          ],
        }));
      });
      if (!finished) throw new Error("The debate ended early.");
    } catch (e) {
      update(debate.id, (d) => ({ ...d, status: "stopped" }));
      if (!ctrl.signal.aborted) {
        setError(
          e instanceof TypeError
            ? "Couldn't reach the analysis server. Is the backend running?"
            : e instanceof Error && e.message !== "Request failed"
              ? e.message
              : "Something went wrong. Please try again."
        );
      }
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      setRunning(false);
    }
  }

  function startDebate(ticker: string) {
    const debate: Debate = {
      id: uid(),
      ticker,
      status: "debating",
      round: 0,
      turns: [],
    };
    setDebates((prev) => [debate, ...prev]);
    setActiveId(debate.id);
    void run(debate);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (running) return;
    const value = input.trim();
    if (!value) return;
    setError(null);

    if (active) return; // follow-ups aren't supported by the backend yet
    const ticker = value.toUpperCase();
    if (!TICKER.test(ticker)) {
      setError("Enter a ticker symbol, like AAPL.");
      return;
    }
    setInput("");
    startDebate(ticker);
  }

  function newDebate() {
    setActiveId(null);
    setInput("");
    setError(null);
    setSideOpen(false);
  }

  function deleteDebate(id: string) {
    if (running && id === activeId) abortRef.current?.abort();
    setDebates((prev) => prev.filter((d) => d.id !== id));
    if (id === activeId) setActiveId(null);
    setConfirmClear(false);
  }

  function clearAll() {
    abortRef.current?.abort();
    setDebates([]);
    setActiveId(null);
    setConfirmClear(false);
  }

  function openDebate(id: string) {
    setActiveId(id);
    setError(null);
    setSideOpen(false);
  }

  let roundLabel = "";
  if (active) {
    if (active.status === "stopped") roundLabel = "Stopped";
    else if (active.status === "verdict") roundLabel = "Verdict";
    else if (active.round === 0) roundLabel = "Opening statements";
    else roundLabel = `Rebuttal ${active.round} of ${MAX_REBUTTALS}`;
  }

  const statusText: Record<Status, string> = {
    debating: "Debating",
    verdict: "Verdict",
    stopped: "Stopped",
  };

  const lastIndex = active ? active.turns.length - 1 : -1;
  const isDebating = active?.status === "debating";

  return (
    <div className="debate">
      {sideOpen && (
        <div className="debate__scrim" onClick={() => setSideOpen(false)} />
      )}

      <aside
        className={`debate__side${sideOpen ? " debate__side--open" : ""}`}
        aria-label="Past debates"
      >
        <p className="debate__logo">
          <Link href="/">MERIDIAN</Link>
        </p>
        <button type="button" className="debate__new" onClick={newDebate}>
          + New debate
        </button>
        <p className="debate__label">Past debates</p>
        {debates.length === 0 ? (
          <p className="debate__note">No debates yet.</p>
        ) : (
          <ul className="debate__list">
            {debates.map((d) => (
              <li key={d.id} className="debate__row">
                <button
                  type="button"
                  className={`debate__item${
                    d.id === activeId ? " debate__item--active" : ""
                  }`}
                  aria-current={d.id === activeId ? "true" : undefined}
                  onClick={() => openDebate(d.id)}
                >
                  {d.ticker}
                  <span className="debate__item-status">
                    {statusText[d.status]}
                  </span>
                </button>
                <button
                  type="button"
                  className="debate__del"
                  aria-label={`Delete ${d.ticker} debate`}
                  onClick={() => deleteDebate(d.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {debates.length > 0 &&
          (confirmClear ? (
            <div className="debate__confirm" role="alert">
              <span>Delete all debates?</span>
              <button type="button" onClick={clearAll}>
                Delete
              </button>
              <button type="button" onClick={() => setConfirmClear(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="debate__clear"
              onClick={() => setConfirmClear(true)}
            >
              Clear history
            </button>
          ))}
      </aside>

      <main className="debate__main">
        <header className="debate__head">
          <button
            type="button"
            className="debate__menu"
            aria-label="Open past debates"
            onClick={() => setSideOpen(true)}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
              <path
                d="M2 5h14M2 9h14M2 13h14"
                stroke="currentColor"
                strokeWidth="1.6"
                fill="none"
              />
            </svg>
          </button>
          <h1 className="debate__ticker">{active ? active.ticker : "New Debate"}</h1>
          {active && <span className="debate__round">{roundLabel}</span>}
          {active && (
            <span className="debate__progress" aria-hidden="true">
              {Array.from({ length: MAX_REBUTTALS + 1 }, (_, i) => (
                <i
                  key={i}
                  className={`debate__dot${
                    active.status === "verdict" || i <= active.round
                      ? " debate__dot--on"
                      : ""
                  }`}
                />
              ))}
            </span>
          )}
        </header>

        <div className="debate__thread" ref={threadRef} aria-busy={running}>
          {!active ? (
            <div className="debate__empty">
              <h2 className="debate__empty-title">
                Which stock shall we argue over?
              </h2>
              <p className="debate__empty-sub">
                Two travellers. One ticker. Real market data.
              </p>
            </div>
          ) : (
            <div className="debate__thread-inner" role="log" aria-label="Debate">
              {active.turns.map((t, i) => (
                <div key={t.id} className="debate__turn">
                  <div
                    className={`debate__msg debate__msg--${t.side}${
                      isDebating && i < lastIndex - 1 ? " debate__msg--dim" : ""
                    }`}
                  >
                    <div className="debate__avatar" aria-hidden="true">
                      <Image
                        src={t.side === "bull" ? "/bull.png" : "/bear.png"}
                        alt=""
                        width={88}
                        height={88}
                      />
                    </div>
                    <div className="debate__body">
                      <p className="debate__who">
                        {t.side === "bull" ? "The Optimist" : "The Skeptic"}
                        <span className="debate__rating">
                          {t.rating} · {Math.round(t.confidence * 100)}%
                        </span>
                      </p>
                      <p className="debate__text">{t.text}</p>
                      {t.keyPoints && t.keyPoints.length > 0 && (
                        <div className="debate__chips">
                          {t.keyPoints.map((c) => (
                            <span key={c} className="debate__chip">
                              {c}
                            </span>
                          ))}
                        </div>
                      )}
                      {t.concessions && t.concessions.length > 0 && (
                        <p className="debate__meta">
                          <b>Concedes:</b> {t.concessions.join(" ")}
                        </p>
                      )}
                      {t.changeMind && (
                        <p className="debate__meta">
                          <b>Would change my mind:</b> {t.changeMind}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              ))}

              {isDebating && (
                <p className="debate__pending" role="status">
                  {active.turns.length === 0
                    ? "Pulling market data and briefing the analysts"
                    : "The analysts are deliberating"}
                  <span className="debate__cursor" aria-hidden="true">
                    …
                  </span>
                </p>
              )}

              {active.verdict !== undefined && (
                <section className="debate__verdict" aria-label="Verdict">
                  <div className="debate__verdict-inner">
                    <h2 className="debate__verdict-title">Verdict</h2>
                    <p className="debate__text">{active.verdict}</p>
                    <p className="debate__note">
                      For education only, not financial advice.
                    </p>
                  </div>
                </section>
              )}
            </div>
          )}
        </div>

        <form className="debate__composer" onSubmit={onSubmit}>
          <div className="debate__pill">
            <input
              className="debate__input"
              aria-label="Ticker symbol"
              placeholder={
                active
                  ? "Start a new debate to try another ticker"
                  : "Enter a ticker, e.g. AAPL"
              }
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={running || !!active}
              maxLength={300}
              autoComplete="off"
              spellCheck={false}
            />
            {running ? (
              <button
                type="button"
                className="debate__send"
                onClick={() => abortRef.current?.abort()}
              >
                Stop
              </button>
            ) : (
              <button
                type="submit"
                className="debate__send"
                disabled={!input.trim() || !!active}
              >
                Begin debate →
              </button>
            )}
          </div>
          {error && (
            <p className="debate__error" role="alert">
              {error}
            </p>
          )}
          {!active && (
            <p className="debate__note">
              For education only, not financial advice.
            </p>
          )}
        </form>
      </main>
    </div>
  );
}
