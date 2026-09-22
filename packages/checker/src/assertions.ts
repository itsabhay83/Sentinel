import type { AssertionKind, AssertionOperator, FailureCode } from "@sentinel/shared";

export interface Assertion {
  readonly kind: AssertionKind;
  readonly target: string | null;
  readonly operator: AssertionOperator;
  readonly value: string;
}

export interface AssertionContext {
  readonly body: string;
  readonly headers: Record<string, string>;
  readonly statusCode: number;
  readonly responseTimeMs: number;
}

export interface AssertionFailure {
  readonly code: FailureCode;
  readonly detail: string;
}

/**
 * Evaluates assertions in order and returns the FIRST failure, or null when
 * every assertion holds. Order matters: it lets a user put the cheap
 * status/keyword checks before an expensive JSON parse.
 */
export function evaluateAssertions(
  assertions: readonly Assertion[],
  ctx: AssertionContext,
): AssertionFailure | null {
  for (const assertion of assertions) {
    const failure = evaluateOne(assertion, ctx);
    if (failure) return failure;
  }
  return null;
}

function evaluateOne(assertion: Assertion, ctx: AssertionContext): AssertionFailure | null {
  switch (assertion.kind) {
    case "keyword": {
      if (ctx.body.includes(assertion.value)) return null;
      return {
        code: "ASSERT_KEYWORD_MISSING",
        detail: `expected body to contain "${truncate(assertion.value)}"`,
      };
    }
    case "not_keyword": {
      if (!ctx.body.includes(assertion.value)) return null;
      return {
        code: "ASSERT_KEYWORD_PRESENT",
        detail: `body unexpectedly contains "${truncate(assertion.value)}"`,
      };
    }
    case "header": {
      const name = (assertion.target ?? "").toLowerCase();
      const actual = ctx.headers[name];
      if (actual !== undefined && compare(actual, assertion.operator, assertion.value)) return null;
      return {
        code: "ASSERT_HEADER_FAILED",
        detail:
          actual === undefined
            ? `header "${name}" was not present`
            : `header "${name}" was "${truncate(actual)}", expected ${assertion.operator} "${truncate(assertion.value)}"`,
      };
    }
    case "jsonpath": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(ctx.body);
      } catch {
        return { code: "ASSERT_JSONPATH_FAILED", detail: "response body is not valid JSON" };
      }
      const path = assertion.target ?? "$";
      const found = readPath(parsed, path);
      if (found === undefined) {
        return { code: "ASSERT_JSONPATH_FAILED", detail: `path "${path}" not found in response` };
      }
      const actual = typeof found === "string" ? found : JSON.stringify(found);
      if (compare(actual, assertion.operator, assertion.value)) return null;
      return {
        code: "ASSERT_JSONPATH_FAILED",
        detail: `path "${path}" was ${truncate(actual)}, expected ${assertion.operator} "${truncate(assertion.value)}"`,
      };
    }
    case "response_time": {
      const budget = Number(assertion.value);
      if (!Number.isFinite(budget)) return null;
      if (ctx.responseTimeMs <= budget) return null;
      return {
        code: "ASSERT_RESPONSE_TIME",
        detail: `response took ${Math.round(ctx.responseTimeMs)}ms, budget is ${budget}ms`,
      };
    }
    default: {
      const exhaustive: never = assertion.kind;
      return { code: "UNKNOWN", detail: `unsupported assertion kind ${String(exhaustive)}` };
    }
  }
}

function compare(actual: string, operator: AssertionOperator, expected: string): boolean {
  switch (operator) {
    case "equals":
      return actual === expected;
    case "not_equals":
      return actual !== expected;
    case "contains":
      return actual.includes(expected);
    case "not_contains":
      return !actual.includes(expected);
    case "matches":
      return safeRegex(expected)?.test(actual) ?? false;
    case "gt":
      return numeric(actual) > numeric(expected);
    case "lt":
      return numeric(actual) < numeric(expected);
    case "gte":
      return numeric(actual) >= numeric(expected);
    case "lte":
      return numeric(actual) <= numeric(expected);
    default: {
      const exhaustive: never = operator;
      throw new Error(`unsupported operator ${String(exhaustive)}`);
    }
  }
}

function numeric(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * User-supplied regexes are attacker-adjacent input. A malformed pattern must
 * fail the assertion, never crash the probe.
 */
function safeRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/**
 * Minimal JSONPath: supports `$.a.b[0].c` and the bare `a.b` form.
 * A full JSONPath engine is a dependency we do not need for assertions.
 */
export function readPath(root: unknown, path: string): unknown {
  const normalized = path.startsWith("$") ? path.slice(1) : path;
  const segments = normalized
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((segment) => segment.length > 0);

  let current: unknown = root;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function truncate(value: string, max = 80): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
