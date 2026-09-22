import type { FailureCode } from "@sentinel/shared";
import { readPath, type Assertion } from "./assertions";
import { runHttpCheck, type CheckOutcome, type HttpCheckConfig } from "./http";
import type { ResolveOptions } from "./ssrf";

export interface FlowStep {
  readonly name: string;
  readonly url: string;
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string | null;
  readonly expectedStatusCodes?: readonly number[];
  readonly assertions?: readonly Assertion[];
  /** Variables to pull out of this step's response: `{ token: "$.access_token" }` */
  readonly extract?: Record<string, string>;
}

export interface FlowStepResult {
  readonly name: string;
  readonly index: number;
  readonly outcome: CheckOutcome;
}

export interface FlowCheckResult {
  readonly ok: boolean;
  readonly failureCode: FailureCode | null;
  readonly errorDetail: string | null;
  readonly failedStep: string | null;
  readonly totalMs: number;
  readonly steps: readonly FlowStepResult[];
}

export interface FlowCheckConfig {
  readonly steps: readonly FlowStep[];
  readonly timeoutMs?: number;
  readonly resolve?: ResolveOptions;
}

const TEMPLATE_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;

/**
 * Runs an ordered sequence of HTTP requests, chaining values forward.
 *
 * A later step references an earlier one as `{{login.body.$.token}}` or the
 * shorthand `{{step1.body.token}}`. The flow stops at the first failing step —
 * continuing would produce cascading noise, not information.
 */
export async function runFlowCheck(config: FlowCheckConfig): Promise<FlowCheckResult> {
  const startedAt = performance.now();
  const results: FlowStepResult[] = [];
  const scope: Record<string, unknown> = {};

  for (const [index, step] of config.steps.entries()) {
    const resolvedStep: HttpCheckConfig = {
      url: interpolate(step.url, scope),
      method: step.method ?? "GET",
      headers: interpolateRecord(step.headers ?? {}, scope),
      body: step.body ? interpolate(step.body, scope) : null,
      timeoutMs: config.timeoutMs,
      expectedStatusCodes: step.expectedStatusCodes,
      assertions: step.assertions,
      resolve: config.resolve,
      followRedirects: true,
    };

    const outcome = await runHttpCheck(resolvedStep);
    results.push({ name: step.name, index, outcome });

    if (!outcome.ok) {
      return {
        ok: false,
        failureCode: outcome.failureCode,
        errorDetail: outcome.errorDetail,
        failedStep: step.name,
        totalMs: round(performance.now() - startedAt),
        steps: results,
      };
    }

    // Publish this step under both its name and its ordinal alias.
    const stepScope = buildStepScope(outcome);
    scope[step.name] = stepScope;
    scope[`step${index + 1}`] = stepScope;

    if (step.extract) {
      for (const [variable, path] of Object.entries(step.extract)) {
        scope[variable] = extractValue(outcome, path);
      }
    }
  }

  return {
    ok: true,
    failureCode: null,
    errorDetail: null,
    failedStep: null,
    totalMs: round(performance.now() - startedAt),
    steps: results,
  };
}

function buildStepScope(outcome: CheckOutcome): Record<string, unknown> {
  let parsedBody: unknown = outcome.bodySnippet;
  if (outcome.bodySnippet) {
    try {
      parsedBody = JSON.parse(outcome.bodySnippet);
    } catch {
      parsedBody = outcome.bodySnippet;
    }
  }
  return {
    body: parsedBody,
    text: outcome.bodySnippet ?? "",
    headers: outcome.responseHeaders ?? {},
    status: outcome.statusCode,
  };
}

function extractValue(outcome: CheckOutcome, path: string): unknown {
  if (path.startsWith("headers.")) {
    return outcome.responseHeaders?.[path.slice("headers.".length).toLowerCase()] ?? null;
  }
  if (!outcome.bodySnippet) return null;
  try {
    return readPath(JSON.parse(outcome.bodySnippet), path);
  } catch {
    return null;
  }
}

export function interpolate(template: string, scope: Record<string, unknown>): string {
  return template.replace(TEMPLATE_PATTERN, (_match, expression: string) => {
    const value = readPath(scope, expression);
    if (value === undefined || value === null) return "";
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

function interpolateRecord(
  record: Record<string, string>,
  scope: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = interpolate(value, scope);
  }
  return out;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
