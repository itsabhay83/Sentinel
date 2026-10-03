import { Reveal } from "./reveal";
import { SignUpCta } from "./auth-buttons";

export function FinalCta() {
  return (
    <section aria-labelledby="final-cta-title" className="relative isolate overflow-hidden border-t border-line/60">
      {/* The radar returns for the closing band, same sweep as the fold. Both
          layers are behind the text and inert to the pointer. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="sentinel-dotgrid absolute inset-0" />
        <div className="absolute left-1/2 top-1/2 size-[44rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/[0.06] blur-[130px]" />
        <div className="sentinel-radar absolute left-1/2 top-1/2 size-[52rem] -translate-x-1/2 -translate-y-1/2 rounded-full" />
      </div>

      <Reveal className="mx-auto max-w-2xl px-6 py-28 text-center lg:py-36">
        <h2 id="final-cta-title" className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
          Stop getting paged by one bad probe.
        </h2>
        <div className="mt-10 flex justify-center">
          <SignUpCta label="Start monitoring free" />
        </div>
        <p className="mt-4 text-sm text-ink-3">Free while in beta. No card required.</p>
      </Reveal>
    </section>
  );
}
