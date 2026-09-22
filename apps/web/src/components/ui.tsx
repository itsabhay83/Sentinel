/**
 * Every low-level primitive in one module.
 *
 * A component-per-file layout is idiomatic for a shadcn install, but these are
 * eleven small, tightly-coupled pieces that share one token vocabulary. Keeping
 * them together means the visual language is auditable in a single read.
 */
import * as React from "react";
import Link from "next/link";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ button */

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 active:scale-[0.98]",
  {
    variants: {
      variant: {
        primary:
          "bg-accent text-[#04140e] hover:bg-[#34d399] shadow-[0_1px_0_0_rgba(255,255,255,0.14)_inset,0_6px_18px_-8px_rgba(16,185,129,0.7)]",
        secondary: "bg-surface-3 text-ink hover:bg-line-strong border border-line-strong",
        ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink",
        outline: "border border-line-strong text-ink hover:bg-surface-2",
        danger: "bg-down/15 text-down border border-down/40 hover:bg-down/25",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        md: "h-9 px-4",
        lg: "h-11 px-6 text-base",
        icon: "size-9",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export function LinkButton({
  className,
  variant,
  size,
  href,
  ...props
}: React.ComponentProps<typeof Link> & VariantProps<typeof buttonVariants>) {
  return <Link href={href} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

/* -------------------------------------------------------------------- card */

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-xl border border-line bg-surface/80 backdrop-blur-sm",
        "shadow-[0_1px_0_0_rgba(255,255,255,0.03)_inset]",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center justify-between gap-3 px-5 py-4", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-sm font-semibold tracking-tight text-ink", className)} {...props} />;
}

export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-xs text-ink-3", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 pb-5", className)} {...props} />;
}

/* ------------------------------------------------------------------- badge */

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4",
  {
    variants: {
      tone: {
        neutral: "border-line-strong bg-surface-3 text-ink-2",
        accent: "border-accent/40 bg-accent/10 text-accent",
        warn: "border-degraded/40 bg-degraded/10 text-degraded",
        danger: "border-down/40 bg-down/10 text-down",
        info: "border-inconclusive/40 bg-inconclusive/10 text-inconclusive",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export function Badge({
  className,
  tone,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

/* ------------------------------------------------------------------- input */

const fieldBase =
  "w-full rounded-lg border border-line-strong bg-surface-2 px-3 text-sm text-ink placeholder:text-ink-3 transition-colors hover:border-[#3a4356] focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40 disabled:opacity-50";

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(fieldBase, "h-9", className)} {...props} />;
}

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(fieldBase, "min-h-24 py-2 font-mono text-xs", className)} {...props} />;
}

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(fieldBase, "h-9 appearance-none bg-[right_0.6rem_center] pr-8", className)}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b7488' stroke-width='2.5' stroke-linecap='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
        backgroundRepeat: "no-repeat",
      }}
      {...props}
    />
  );
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn("mb-1.5 block text-xs font-medium text-ink-2", className)}
      {...props}
    />
  );
}

export function Field({
  label,
  hint,
  children,
  className,
  htmlFor,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div className={className}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="mt-1 text-[11px] text-ink-3">{hint}</p> : null}
    </div>
  );
}

/* ---------------------------------------------------------------- checkbox */

export function Checkbox({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="checkbox"
      className={cn(
        "size-4 shrink-0 cursor-pointer appearance-none rounded border border-line-strong bg-surface-2 transition-colors",
        "checked:border-accent checked:bg-accent",
        "checked:bg-[url('data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%2304140e%22%20stroke-width%3D%224%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M20%206%209%2017l-5-5%22/%3E%3C/svg%3E')] checked:bg-contain checked:bg-center checked:bg-no-repeat",
        className,
      )}
      {...props}
    />
  );
}

/* ------------------------------------------------------------------- misc */

export function Separator({ className }: { className?: string }) {
  return <div className={cn("h-px w-full bg-line", className)} />;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      {icon ? <div className="text-ink-3 [&_svg]:size-8">{icon}</div> : null}
      <div>
        <p className="text-sm font-medium text-ink">{title}</p>
        {description ? <p className="mt-1 max-w-sm text-xs text-ink-3">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Alert({
  tone = "danger",
  children,
  className,
}: {
  tone?: "danger" | "warn" | "accent";
  children: React.ReactNode;
  className?: string;
}) {
  const tones = {
    danger: "border-down/40 bg-down/10 text-down",
    warn: "border-degraded/40 bg-degraded/10 text-degraded",
    accent: "border-accent/40 bg-accent/10 text-accent",
  } as const;
  return (
    <div className={cn("rounded-lg border px-3 py-2 text-xs", tones[tone], className)} role="alert">
      {children}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded bg-surface-3", className)} />;
}

const STAT_TONE = {
  default: "text-ink",
  up: "text-up",
  down: "text-down",
  warn: "text-degraded",
  muted: "text-ink-2",
} as const;

/** Key/value row used across detail panels. */
export function Stat({
  label,
  value,
  sub,
  className,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  className?: string;
  tone?: keyof typeof STAT_TONE;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <p className="text-[11px] uppercase tracking-wide text-ink-3">{label}</p>
      <p className={cn("tnum mt-1 truncate text-lg font-semibold", STAT_TONE[tone])}>{value}</p>
      {sub ? <p className="mt-0.5 truncate text-[11px] text-ink-3">{sub}</p> : null}
    </div>
  );
}
