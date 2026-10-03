import type { FailureCode } from "@sentinel/shared";

export interface ClassifiedError {
  readonly code: FailureCode;
  readonly detail: string;
}

interface NodeishError {
  // Not always a string: a `child_process` rejection carries the exit status
  // here as a number, which is why this is read through `codeOf` below.
  readonly code?: string | number;
  readonly errno?: number;
  readonly syscall?: string;
  readonly message?: string;
  readonly name?: string;
  readonly reason?: string;
  readonly cause?: unknown;
}

/**
 * Maps a raw Node error onto the failure taxonomy in `packages/shared`.
 *
 * The mapping is intentionally explicit rather than a regex over `message`:
 * Node's error strings change between releases, `error.code` does not.
 */
export function classifyNodeError(error: unknown, aborted = false): ClassifiedError {
  const err = normalize(error);
  const code = codeOf(err);
  const detail = err.message ?? String(error);

  if (aborted || code === "ABORT_ERR" || err.name === "AbortError") {
    return { code: "HTTP_TIMEOUT", detail: "request exceeded the configured timeout" };
  }

  switch (code) {
    // ---- DNS -------------------------------------------------------------
    case "ENOTFOUND":
    case "EAI_NODATA":
    case "EAI_NONAME":
      return { code: "DNS_NXDOMAIN", detail };
    case "EAI_AGAIN":
    case "ETIMEOUT":
      return { code: "DNS_TIMEOUT", detail };
    case "ESERVFAIL":
    case "EAI_FAIL":
    case "SERVFAIL":
      return { code: "DNS_SERVFAIL", detail };
    case "EREFUSED":
      return { code: "DNS_SERVFAIL", detail };

    // ---- TCP -------------------------------------------------------------
    case "ECONNREFUSED":
      return { code: "TCP_REFUSED", detail };
    case "ECONNRESET":
      return { code: "TCP_RESET", detail };
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "EHOSTDOWN":
    case "ENETDOWN":
      return { code: "TCP_UNREACHABLE", detail };
    case "ETIMEDOUT":
    case "ECONNABORTED":
      return { code: "TCP_TIMEOUT", detail };
    case "EPIPE":
      return { code: "TCP_RESET", detail };

    // ---- TLS -------------------------------------------------------------
    case "CERT_HAS_EXPIRED":
      return { code: "TLS_EXPIRED", detail: "the server certificate has expired" };
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return { code: "TLS_HOSTNAME_MISMATCH", detail };
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "UNABLE_TO_GET_ISSUER_CERT":
    case "UNABLE_TO_GET_ISSUER_CERT_LOCALLY":
    case "CERT_UNTRUSTED":
      return { code: "TLS_UNTRUSTED", detail };
    case "ERR_SSL_WRONG_VERSION_NUMBER":
    case "ERR_SSL_UNSUPPORTED_PROTOCOL":
    case "EPROTO":
      return { code: "TLS_PROTOCOL_ERROR", detail };
    case "ERR_TLS_HANDSHAKE_TIMEOUT":
      return { code: "TLS_HANDSHAKE_FAILED", detail };

    // ---- HTTP framing ----------------------------------------------------
    case "HPE_INVALID_CONSTANT":
    case "HPE_INVALID_HEADER_TOKEN":
    case "ERR_HTTP_INVALID_STATUS_CODE":
      return { code: "TLS_PROTOCOL_ERROR", detail };
    case "ERR_TOO_MANY_REDIRECTS":
      return { code: "HTTP_REDIRECT_LOOP", detail };
    default:
      break;
  }

  // Some TLS failures surface only as a message; check the common ones.
  if (code.startsWith("ERR_TLS") || /ssl|tls|handshake/i.test(detail)) {
    return { code: "TLS_HANDSHAKE_FAILED", detail };
  }

  return { code: "UNKNOWN", detail };
}

/**
 * Node only promises a string `code` on *errors it raises itself*. A rejected
 * `execFile` puts the child's numeric exit status in the same field, and a
 * `DOMException` exposes a legacy numeric `code`. Treating those as strings
 * threw a TypeError out of the callers' catch blocks, turning a recordable
 * check failure into a dead job, so anything non-string is discarded here and
 * classified from `detail` instead.
 */
function codeOf(err: NodeishError): string {
  return typeof err.code === "string" ? err.code : "";
}

function normalize(error: unknown): NodeishError {
  if (error && typeof error === "object") {
    const err = error as NodeishError;
    // undici and Node's fetch nest the real cause one level down.
    if (!codeOf(err) && err.cause && typeof err.cause === "object") {
      const cause = err.cause as NodeishError;
      if (codeOf(cause)) return { ...cause, message: cause.message ?? err.message };
    }
    return err;
  }
  return { message: String(error) };
}
