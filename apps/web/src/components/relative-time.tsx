"use client";

import { useEffect, useState } from "react";
import { formatDateTime, relativeTime } from "@/lib/utils";

/**
 * Relative timestamps inside a client component cannot be hydration-safe on
 * their own: the server stamps the HTML with its clock, and by the time the
 * browser hydrates, "30 seconds ago" has become "29 seconds ago". The string is
 * genuinely supposed to differ, so the mismatch is suppressed on this one
 * element rather than papered over by reading the clock less often.
 *
 * `now` stays null until mount so the first client render reuses whatever the
 * server wrote; the effect then pins a real clock and re-renders immediately,
 * correcting the text within a frame and keeping it fresh after that.
 */
export function RelativeTime({
  value,
  fallback = "never",
  className,
}: {
  value: Date | string | number | null | undefined;
  fallback?: string;
  className?: string;
}) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  if (value === null || value === undefined) {
    return <span className={className}>{fallback}</span>;
  }

  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return <span className={className}>—</span>;
  }

  return (
    <time
      dateTime={parsed.toISOString()}
      // Absolute time is rendered in the viewer's locale, so it is only safe
      // once we are past hydration.
      title={now === null ? undefined : formatDateTime(parsed)}
      className={className}
      suppressHydrationWarning
    >
      {relativeTime(parsed, now ?? undefined)}
    </time>
  );
}
