"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, KeyRound, RotateCw, Webhook } from "lucide-react";

import { cn } from "@/lib/utils";
import { Reveal } from "./reveal";

/**
 * The developer band.
 *
 * The request and the response are the real ones: the route is
 * `apps/web/src/app/api/v1/monitors/route.ts` and the JSON below is the exact
 * shape it returns, down to the key order. A marketing snippet that does not
 * match the endpoint is a support ticket with extra steps.
 */
const SNIPPETS = [
  {
    id: "curl",
    label: "cURL",
    code: `curl https://api.sentinel.dev/api/v1/monitors \\
  -H "Authorization: Bearer $SENTINEL_API_KEY"`,
  },
  {
    id: "js",
    label: "JavaScript",
    code: `const res = await fetch(
  "https://api.sentinel.dev/api/v1/monitors",
  { headers: { Authorization: \`Bearer \${process.env.SENTINEL_API_KEY}\` } },
);
const { data } = await res.json();`,
  },
  {
    id: "python",
    label: "Python",
    code: `import os, httpx

res = httpx.get(
    "https://api.sentinel.dev/api/v1/monitors",
    headers={"Authorization": f"Bearer {os.environ['SENTINEL_API_KEY']}"},
)
data = res.json()["data"]`,
  },
] as const;

const RESPONSE = `{
  "data": [
    {
      "id": "8f3c…",
      "name": "API — checkout",
      "url": "https://api.acme.com/v1/checkout",
      "type": "http",
      "status": "UP",
      "intervalSeconds": 60,
      "regions": ["bom","fra","gru","iad","lhr","sin","sjc","syd"],
      "failingRegions": [],
      "lastCheckAt": "2026-02-11T09:41:03.118Z",
      "lastLatencyMs": 184,
      "uptime30d": 99.982
    }
  ]
}`;

const POINTS = [
  {
    icon: KeyRound,
    title: "Scoped keys, shown once",
    body: "A key is minted with explicit scopes — monitors:read, incidents:read — and only its HMAC is stored. Missing, malformed, unknown, revoked and expired keys all return the same 401, so the response never tells an attacker which one they have.",
  },
  {
    icon: RotateCw,
    title: "Rotation with a 24-hour fuse",
    body: "Rotating a key keeps the old secret valid for 24 hours. A deploy picks up the new one on its own schedule instead of racing a cutover, and 30/90/365-day expiry is set at creation.",
  },
  {
    icon: Webhook,
    title: "Heartbeats for anything on cron",
    body: "A heartbeat monitor hands you a token URL. Your job calls it when it finishes, and silence past the interval is the failure — the one check type where not hearing from you is the signal.",
  },
] as const;

export function ApiBand() {
  const [active, setActive] = useState(0);
  // `SNIPPETS` is a tuple, so index 0 is known to exist; an arbitrary index is not.
  const snippet = SNIPPETS[active] ?? SNIPPETS[0];

  return (
    <section id="api" aria-labelledby="api-title" className="border-y border-line/60 bg-surface/20">
      <div className="mx-auto max-w-6xl px-6 py-24 lg:py-32">
        <Reveal>
          <h2 id="api-title" className="max-w-2xl text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            Every verdict is two lines of shell away
          </h2>
          <p className="mt-4 max-w-2xl text-pretty leading-relaxed text-ink-2">
            Read-only for now, deliberately. Writes through the API need idempotency keys and per-key rate
            limits to be safe, and a half-guarded write endpoint is worse than none.
          </p>
        </Reveal>

        <Reveal className="mt-12" delayMs={60}>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="min-w-0 overflow-hidden rounded-xl border border-line bg-canvas/80 backdrop-blur">
              <div className="flex items-center justify-between gap-2 border-b border-line pr-2">
                <Tabs active={active} onChange={setActive} />
                <CopyButton code={snippet.code} label={`${snippet.label} request`} />
              </div>
              {/* Shorter on mobile, where the panes stack and the request no longer
                  has to match the response's height to keep the row even. */}
              <CodeBlock code={snippet.code} className="h-48 lg:h-80" />
            </div>

            <div className="min-w-0 overflow-hidden rounded-xl border border-line bg-canvas/80 backdrop-blur">
              <div className="flex items-center justify-between gap-2 border-b border-line py-1.5 pl-4 pr-2">
                <span className="font-mono text-[11px] text-ink-3">200 OK · application/json</span>
                <CopyButton code={RESPONSE} label="Response body" />
              </div>
              <CodeBlock code={RESPONSE} className="h-80" />
            </div>
          </div>
        </Reveal>

        <div className="mt-12 grid gap-8 md:grid-cols-3">
          {POINTS.map((point, index) => (
            <Reveal key={point.title} delayMs={index * 70}>
              <point.icon className="size-4 text-accent" aria-hidden />
              <h3 className="mt-3 text-sm font-medium tracking-tight text-ink">{point.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-2">{point.body}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * A group of toggle buttons rather than an ARIA tablist. A real tablist owes the
 * visitor arrow-key roving focus and a labelled tabpanel; this is three buttons
 * that swap the text of one code block, and `aria-pressed` describes that
 * honestly without claiming keyboard behaviour nobody implemented.
 */
function Tabs({ active, onChange }: { active: number; onChange: (index: number) => void }) {
  return (
    <div role="group" aria-label="Request language" className="relative flex">
      {SNIPPETS.map((snippet, index) => (
        <button
          key={snippet.id}
          type="button"
          aria-pressed={index === active}
          onClick={() => onChange(index)}
          className={cn(
            "px-4 py-3 text-xs font-medium transition-colors duration-150",
            index === active ? "text-ink" : "text-ink-3 hover:text-ink-2",
          )}
        >
          {snippet.label}
        </button>
      ))}
      {/*
        One underline that slides, rather than a border on each tab: a single
        transform is cheaper than three colour transitions, and it is the slide
        itself that tells you which way the selection moved.
      */}
      <span
        aria-hidden
        className="sentinel-tab-underline absolute -bottom-px left-0 h-0.5 bg-accent"
        style={{ width: `${100 / SNIPPETS.length}%`, transform: `translateX(${active * 100}%)` }}
      />
      {/* The underline is positioned against the tab row, so the row owns its own
          width even though the bordered header it sits in is wider. */}
    </div>
  );
}

/**
 * The button lives in the card's header, not floating over the code. A pane
 * that scrolls horizontally would otherwise slide its longest line underneath
 * an overlay button — exactly the line someone came to read.
 */
function CopyButton({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  /*
   * Deliberately not `async`: a click handler that returns a promise is a
   * handler nothing ever awaits. Any non-secure origin — and any browser
   * without the clipboard API — lands in the rejection path, where failing
   * quietly is right: the code is still selectable, so nothing is lost.
   */
  function copy() {
    navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1600);
      },
      () => undefined,
    );
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="shrink-0 rounded-lg p-2 text-ink-3 transition-colors duration-150 hover:bg-surface-2 hover:text-ink"
    >
      {copied ? <Check className="size-3.5 text-accent" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      <span className="sr-only">{copied ? `${label} copied` : `Copy ${label.toLowerCase()}`}</span>
    </button>
  );
}

/** Height is fixed by the caller so switching tabs can never resize the row. */
function CodeBlock({ code, className }: { code: string; className: string }) {
  return (
    <pre className={cn("overflow-auto p-5 font-mono text-[11px] leading-relaxed text-ink-2", className)}>
      <code>{code}</code>
    </pre>
  );
}
