import type { Metadata } from "next";
import DebateApp from "../../components/DebateApp";

export const metadata: Metadata = {
  title: "Meridian — Debate",
};

export default function DebatePage() {
  return <DebateApp />;
}
