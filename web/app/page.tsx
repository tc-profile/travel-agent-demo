import ChatWidget from "@/components/ChatWidget";
import OpenPlannerButton from "@/components/OpenPlannerButton";

const DESTINATIONS = [
  { name: "Lisbon", country: "Portugal", from: "$640", gradient: "from-[#e8a24b] to-[#d9622b]" },
  { name: "Kyoto", country: "Japan", from: "$980", gradient: "from-[#c96b8f] to-[#6a3b6e]" },
  { name: "Reykjavík", country: "Iceland", from: "$720", gradient: "from-[#3f7c8a] to-[#123c4a]" },
  { name: "Cape Town", country: "South Africa", from: "$860", gradient: "from-[#3f8f6f] to-[#0f4c4c]" },
  { name: "Santorini", country: "Greece", from: "$710", gradient: "from-[#5fa8d3] to-[#1c5d7a]" },
  { name: "Patagonia", country: "Argentina & Chile", from: "$1,150", gradient: "from-[#8a7a4f] to-[#3d3320]" },
];

const FEATURES = [
  {
    title: "AI-powered planning",
    body: "Describe your trip in plain language — our AI travel agent asks the right follow-ups and builds a day-by-day itinerary.",
  },
  {
    title: "Real weather, honestly sourced",
    body: "Forecasts come from live data when your dates are close, or a clearly-labeled estimate from last year when they're far out.",
  },
  {
    title: "Curated-style picks",
    body: "Flight and hotel options are generated for this demo and clearly marked as such — nothing here is bookable.",
  },
];

const TESTIMONIALS = [
  {
    quote: "Told it I wanted a slow week in Kyoto and it actually asked about my budget before suggesting anything.",
    name: "Demo testimonial",
  },
  {
    quote: "Appreciated that it just said the weather forecast wasn't available yet instead of making something up.",
    name: "Demo testimonial",
  },
  {
    quote: "Planned a long-weekend itinerary faster than I could open three tabs myself.",
    name: "Demo testimonial",
  },
];

export default function Home() {
  return (
    <>
      <div className="bg-secondary px-4 py-2 text-center text-xs text-white/90">
        Portfolio demo — flights &amp; hotels shown are mock data; nothing here is bookable.
      </div>

      <header className="sticky top-0 z-10 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <span className="font-display text-lg font-semibold tracking-tight text-foreground">
            Aviana <span className="text-primary">Travel</span>
          </span>
          <nav className="hidden items-center gap-8 text-sm text-foreground/70 sm:flex">
            <a href="#destinations" className="transition hover:text-foreground">
              Destinations
            </a>
            <OpenPlannerButton className="transition hover:text-foreground">Plan a trip</OpenPlannerButton>
            <a href="#about" className="transition hover:text-foreground">
              About
            </a>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero */}
        <section className="relative overflow-hidden bg-[radial-gradient(120%_100%_at_50%_0%,rgba(217,98,43,0.12),transparent_60%)]">
          <div className="mx-auto grid max-w-6xl gap-12 px-6 py-20 sm:py-28 md:grid-cols-2 md:items-center">
            <div>
              <p className="text-xs font-semibold tracking-[0.2em] text-accent uppercase">
                Journeys, thoughtfully planned
              </p>
              <h1 className="mt-4 font-display text-4xl font-semibold leading-[1.1] text-foreground sm:text-5xl">
                Your next trip, planned in one conversation.
              </h1>
              <p className="mt-5 max-w-md text-base text-muted">
                Aviana pairs a curated destination guide with an AI travel agent that plans your
                itinerary in real time — flights, stays, and honest weather, all in one place.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <OpenPlannerButton className="rounded-full bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition hover:opacity-90">
                  Plan your trip
                </OpenPlannerButton>
                <a
                  href="#destinations"
                  className="rounded-full border border-border px-6 py-3 text-sm font-medium text-foreground transition hover:border-primary hover:text-primary"
                >
                  Explore destinations
                </a>
              </div>
            </div>
            <div className="relative aspect-[4/3] overflow-hidden rounded-3xl bg-gradient-to-br from-[#e8a24b] via-[#d9622b] to-[#123c4a] shadow-[0_30px_70px_-30px_rgba(31,42,46,0.5)]">
              <div className="absolute inset-0 flex items-end p-6">
                <div className="rounded-xl bg-black/25 px-4 py-3 text-white backdrop-blur-sm">
                  <p className="text-xs uppercase tracking-wide text-white/80">Featured</p>
                  <p className="font-display text-lg font-semibold">5 days in Lisbon, from $640</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Destinations */}
        <section id="destinations" className="mx-auto max-w-6xl px-6 py-20">
          <div className="max-w-xl">
            <p className="text-xs font-semibold tracking-[0.2em] text-accent uppercase">Popular destinations</p>
            <h2 className="mt-3 font-display text-3xl font-semibold text-foreground">
              Where Aviana travelers are headed
            </h2>
          </div>
          <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {DESTINATIONS.map((d) => (
              <div
                key={d.name}
                className="group overflow-hidden rounded-2xl border border-border bg-surface transition hover:shadow-[0_25px_50px_-30px_rgba(31,42,46,0.4)]"
              >
                <div className={`aspect-[4/3] bg-gradient-to-br ${d.gradient}`} />
                <div className="flex items-center justify-between px-5 py-4">
                  <div>
                    <p className="font-display text-lg font-semibold text-foreground">{d.name}</p>
                    <p className="text-sm text-muted">{d.country}</p>
                  </div>
                  <p className="text-sm font-medium text-primary">{d.from}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Features */}
        <section className="border-y border-border bg-surface/60">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <div className="grid gap-10 sm:grid-cols-3">
              {FEATURES.map((f) => (
                <div key={f.title}>
                  <h3 className="font-display text-lg font-semibold text-foreground">{f.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{f.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Plan with AI */}
        <section id="plan" className="mx-auto max-w-6xl px-6 py-20">
          <div className="mx-auto max-w-xl text-center">
            <p className="text-xs font-semibold tracking-[0.2em] text-accent uppercase">Plan a trip</p>
            <h2 className="mt-3 font-display text-3xl font-semibold text-foreground">
              Talk to your AI travel agent
            </h2>
            <p className="mt-4 text-sm leading-relaxed text-muted">
              Tell it where you want to go, roughly when, and your budget. It&apos;ll ask what it
              needs, then pull together flight and hotel options and a real weather outlook
              before proposing a day-by-day plan.
            </p>
            <div className="mt-8">
              <OpenPlannerButton className="rounded-full bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition hover:opacity-90">
                Start planning — chat with Aviana ✦
              </OpenPlannerButton>
            </div>
          </div>
        </section>

        {/* Testimonials */}
        <section id="about" className="border-t border-border bg-surface/60">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <p className="text-xs font-semibold tracking-[0.2em] text-accent uppercase">What travelers say</p>
            <div className="mt-8 grid gap-6 sm:grid-cols-3">
              {TESTIMONIALS.map((t, i) => (
                <blockquote key={i} className="rounded-2xl border border-border bg-background p-6">
                  <p className="text-sm leading-relaxed text-foreground/90">&ldquo;{t.quote}&rdquo;</p>
                  <footer className="mt-4 text-xs font-medium text-muted">{t.name}</footer>
                </blockquote>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-2 px-6 py-10 text-center text-xs text-muted sm:flex-row sm:justify-between sm:text-left">
          <p>Aviana Travel — a portfolio demo, not a real travel agency.</p>
          <p>Built with Next.js, deployed on Vercel.</p>
        </div>
      </footer>

      <ChatWidget />
    </>
  );
}
