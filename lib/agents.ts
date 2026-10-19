/**
 * MOCK AGENTS: this file is the single place to swap in your real agents.
 *
 * `generateTurn` receives the ticker, whose turn it is, the round and the
 * transcript so far, and yields text chunks. Replace the body with a call to
 * your model/provider (stream its tokens out through `yield`) and the rest of
 * the app (API route, streaming UI, history) keeps working unchanged.
 *
 * The text below is generic placeholder copy. It does not use real data about
 * any company.
 */

export type Side = "bull" | "bear" | "judge";

export interface TurnInput {
  ticker: string;
  side: Side;
  round: number; // 1-3 are the main rounds, higher means follow-up, 0 for the judge
  question?: string;
  history: { side: "bull" | "bear"; text: string }[];
}

const BULL = [
  "{T} has a strong story to tell: a business that can keep growing while it reinvests in what it does best. When a company compounds like that, patience tends to be rewarded.",
  "A slow stretch is not a broken business. The strengths that built {T} are still there, and markets often price in the worst case during slow patches.",
  "Weigh the whole journey, not a single quarter. If {T} keeps executing, today's concerns will look like small bumps in a long road.",
];

const BEAR = [
  "A good company is not always a good investment. The question for {T} is how much of the good news is already in the price, and what happens if growth disappoints.",
  "Quality and loyalty are not the same as growth. If growth at {T} slows while expectations stay high, the price has very little room for error.",
  "Before buying {T}, ask what would change your mind. If you cannot name it, you are holding a hope rather than a thesis.",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function compose(input: TurnInput): string {
  const t = input.ticker;
  if (input.side === "judge") {
    return `Both sides made fair points about ${t}. The Optimist's best case is steady long-term execution. The Skeptic's best case is that expectations may already be priced in. This verdict is placeholder text: connect your real agents to get an analysis grounded in data.`;
  }
  if (input.question) {
    return input.side === "bull"
      ? `On that question about ${t}: the Optimist would say the answer favours patience, because strong businesses tend to recover from rough patches.`
      : `On that question about ${t}: the Skeptic would say to test it against the downside first, and only then decide whether the price leaves enough margin of safety.`;
  }
  const i = Math.min(Math.max(input.round, 1), 3) - 1;
  return (input.side === "bull" ? BULL : BEAR)[i].replaceAll("{T}", t);
}

export async function* generateTurn(input: TurnInput): AsyncGenerator<string> {
  const words = compose(input).split(" ");
  for (const word of words) {
    yield word + " ";
    await sleep(28);
  }
}
