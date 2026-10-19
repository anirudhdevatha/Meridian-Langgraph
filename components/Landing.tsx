import Link from "next/link";
import CompassMark from "./CompassMark";
import LandingVideo from "./LandingVideo";

const NAV_ITEMS = [
  "Learn",
  "About",
  "How it Works",
  "Contact",
  "Login",
  "Sign Up",
] as const;

export default function Landing() {
  return (
    <main className="landing">
      <LandingVideo />

      <nav className="landing__nav" aria-label="Main">
        <ul>
          {NAV_ITEMS.map((item) => (
            <li key={item}>
              <a href="#">{item}</a>
            </li>
          ))}
        </ul>
      </nav>

      <div className="landing__content">
        <CompassMark />

        <p className="landing__brand">
          <a href="#" aria-label="Meridian home">
            MERIDIAN
          </a>
        </p>

        <p className="landing__tagline">
          Navigate your stocks and let our multi-agent council take the reins.
        </p>

        <div className="landing__actions">
          <Link href="/debate" className="landing__btn">
            Start your journey <span aria-hidden="true">→</span>
          </Link>
          <a href="#" className="landing__btn landing__btn--ghost">
            See how it works
          </a>
        </div>

      </div>
    </main>
  );
}
