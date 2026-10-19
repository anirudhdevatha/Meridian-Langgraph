import { generateTurn, type Side, type TurnInput } from "../../../lib/agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TICKER = /^[A-Z]{1,5}([.-][A-Z])?$/;
const SIDES: Side[] = ["bull", "bear", "judge"];

function parse(body: unknown): TurnInput | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;

  const ticker = typeof b.ticker === "string" ? b.ticker.toUpperCase() : "";
  if (!TICKER.test(ticker)) return null;

  const side = b.side as Side;
  if (!SIDES.includes(side)) return null;

  const round = Number(b.round);
  if (!Number.isInteger(round) || round < 0 || round > 10) return null;

  const question =
    typeof b.question === "string" && b.question.trim()
      ? b.question.trim().slice(0, 300)
      : undefined;

  const history = Array.isArray(b.history)
    ? b.history
        .slice(-12)
        .filter(
          (h): h is { side: "bull" | "bear"; text: string } =>
            typeof h === "object" &&
            h !== null &&
            ((h as { side?: unknown }).side === "bull" ||
              (h as { side?: unknown }).side === "bear") &&
            typeof (h as { text?: unknown }).text === "string"
        )
        .map((h) => ({ side: h.side, text: h.text.slice(0, 2000) }))
    : [];

  return { ticker, side, round, question, history };
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const input = parse(body);
  if (!input) return new Response("Invalid request", { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of generateTurn(input)) {
          if (request.signal.aborted) break;
          controller.enqueue(encoder.encode(chunk));
        }
      } catch {
        controller.enqueue(encoder.encode(" [The agent ran into an error.]"));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
