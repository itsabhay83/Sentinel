import {
  ASSERTION_KINDS,
  ASSERTION_OPERATORS,
  MONITOR_TYPES,
  REGION_CODES,
  limitsFor,
  type Plan,
} from "@sentinel/shared";
import { z } from "zod";

/** Parses `Key: value` lines into a header map; blank lines are ignored. */
export function parseHeaderLines(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return out;
}

const monitorSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  type: z.enum(MONITOR_TYPES),
  url: z.string().trim().min(1, "URL is required").max(2000),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).default("GET"),
  headers: z.string().max(8000).optional().default(""),
  body: z.string().max(100_000).optional().default(""),
  intervalSeconds: z.coerce.number().int().min(20).max(86_400),
  timeoutMs: z.coerce.number().int().min(1000).max(120_000),
  followRedirects: z.coerce.boolean().default(false),
  maxRedirects: z.coerce.number().int().min(0).max(5).default(5),
  expectedStatusCodes: z
    .string()
    .optional()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isInteger(n) && n >= 100 && n <= 599),
    ),
  regions: z.array(z.enum(REGION_CODES)).min(1, "Select at least one region"),
  quorumRatio: z.coerce.number().min(0.1).max(1),
  minRegionsRequired: z.coerce.number().int().min(1).max(8),
  confirmationFailures: z.coerce.number().int().min(1).max(10),
  confirmationSuccesses: z.coerce.number().int().min(1).max(10),
  degradedThresholdMs: z
    .string()
    .optional()
    .default("")
    .transform((v) => (v.trim() === "" ? null : Number.parseInt(v, 10)))
    .refine((v) => v === null || (Number.isInteger(v) && v > 0), "Degraded threshold must be a positive number"),
  groupName: z.string().trim().max(120).optional().default(""),
  tags: z
    .string()
    .optional()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
});

export type MonitorInput = z.infer<typeof monitorSchema>;

export function readForm(formData: FormData) {
  return monitorSchema.safeParse({
    name: formData.get("name"),
    type: formData.get("type"),
    url: formData.get("url"),
    method: formData.get("method") ?? "GET",
    headers: formData.get("headers") ?? "",
    body: formData.get("body") ?? "",
    intervalSeconds: formData.get("intervalSeconds"),
    timeoutMs: formData.get("timeoutMs"),
    followRedirects: formData.get("followRedirects") === "on",
    maxRedirects: formData.get("maxRedirects") ?? 5,
    expectedStatusCodes: formData.get("expectedStatusCodes") ?? "",
    regions: formData.getAll("regions").map(String),
    quorumRatio: formData.get("quorumRatio"),
    minRegionsRequired: formData.get("minRegionsRequired"),
    confirmationFailures: formData.get("confirmationFailures"),
    confirmationSuccesses: formData.get("confirmationSuccesses"),
    degradedThresholdMs: formData.get("degradedThresholdMs") ?? "",
    groupName: formData.get("groupName") ?? "",
    tags: formData.get("tags") ?? "",
  });
}

/** Assertions arrive as parallel indexed arrays from the repeatable form rows. */
export function readAssertions(formData: FormData) {
  const kinds = formData.getAll("assertionKind").map(String);
  const targets = formData.getAll("assertionTarget").map(String);
  const operators = formData.getAll("assertionOperator").map(String);
  const values = formData.getAll("assertionValue").map(String);
  const out: { kind: (typeof ASSERTION_KINDS)[number]; target: string | null; operator: string; value: string; orderIndex: number }[] = [];
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i];
    const value = (values[i] ?? "").trim();
    const operator = operators[i] ?? "contains";
    if (!kind || !value) continue;
    if (!(ASSERTION_KINDS as readonly string[]).includes(kind)) continue;
    if (!(ASSERTION_OPERATORS as readonly string[]).includes(operator)) continue;
    const target = (targets[i] ?? "").trim();
    out.push({
      kind: kind as (typeof ASSERTION_KINDS)[number],
      target: target === "" ? null : target,
      operator,
      value,
      orderIndex: out.length,
    });
  }
  return out;
}

export function validateAgainstPlan(plan: Plan, input: { intervalSeconds: number; regions: string[] }, currentCount: number, isNew: boolean): string | null {
  const limits = limitsFor(plan);
  if (isNew && currentCount >= limits.maxMonitors) {
    return `Your ${plan} plan allows ${limits.maxMonitors} monitors. Upgrade to add more.`;
  }
  if (input.intervalSeconds < limits.minIntervalSeconds) {
    return `Your ${plan} plan has a minimum interval of ${limits.minIntervalSeconds}s.`;
  }
  if (input.regions.length > limits.maxRegionsPerMonitor) {
    return `Your ${plan} plan allows ${limits.maxRegionsPerMonitor} regions per monitor.`;
  }
  return null;
}

type AuditedFields = { name: string; url: string; intervalSeconds: number };

/**
 * Only the plainly-readable fields are diffed. Headers and bodies are encrypted
 * precisely because they carry the customer's credentials, so they must never
 * be reconstructable from the audit trail.
 */
export function describeChanges(before: AuditedFields, after: AuditedFields): Record<string, unknown> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (before.name !== after.name) changes.name = { from: before.name, to: after.name };
  if (before.url !== after.url) changes.url = { from: before.url, to: after.url };
  if (before.intervalSeconds !== after.intervalSeconds) {
    changes.intervalSeconds = { from: before.intervalSeconds, to: after.intervalSeconds };
  }
  return changes;
}
