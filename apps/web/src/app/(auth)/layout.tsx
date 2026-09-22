import Link from "next/link";
import { Radar } from "lucide-react";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative isolate flex min-h-dvh flex-col items-center justify-center px-6 py-12">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute left-1/2 top-[-16rem] size-[36rem] -translate-x-1/2 rounded-full bg-accent/[0.06] blur-[110px]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_1px_1px,rgba(255,255,255,0.03)_1px,transparent_0)] [background-size:32px_32px]" />
      </div>
      <Link href="/" className="mb-8 flex items-center gap-2 font-semibold tracking-tight">
        <Radar className="size-5 text-accent" />
        Sentinel
      </Link>
      <div className="w-full max-w-md animate-fade-up">{children}</div>
    </main>
  );
}
