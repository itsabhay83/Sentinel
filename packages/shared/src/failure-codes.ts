/**
 * The failure taxonomy. Every non-OK check result carries exactly one of these
 * codes — never a generic "down". Each code maps to a plain-English
 * explanation and a suggested action, both rendered in the incident UI.
 */

export const FAILURE_CODES = [
  "DNS_NXDOMAIN",
  "DNS_TIMEOUT",
  "DNS_SERVFAIL",

  "TCP_TIMEOUT",
  "TCP_REFUSED",
  "TCP_RESET",
  "TCP_UNREACHABLE",

  "TLS_EXPIRED",
  "TLS_HOSTNAME_MISMATCH",
  "TLS_UNTRUSTED",
  "TLS_HANDSHAKE_FAILED",
  "TLS_PROTOCOL_ERROR",

  "HTTP_TIMEOUT",
  "HTTP_4XX",
  "HTTP_5XX",
  "HTTP_REDIRECT_LOOP",
  "HTTP_TOO_LARGE",

  "ASSERT_KEYWORD_MISSING",
  "ASSERT_KEYWORD_PRESENT",
  "ASSERT_JSONPATH_FAILED",
  "ASSERT_HEADER_FAILED",
  "ASSERT_RESPONSE_TIME",

  "HEARTBEAT_MISSED",

  /**
   * Expiry warnings, not check failures. They ride the same taxonomy so the
   * incident timeline, alert templates and status page render them without a
   * parallel code path.
   */
  "CERT_EXPIRING",
  "DOMAIN_EXPIRING",

  /** Target resolved to a private/loopback/link-local address — SSRF guard. */
  "BLOCKED_TARGET",

  "UNKNOWN",
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

export interface FailureExplanation {
  /** Short label for badges. */
  readonly label: string;
  /** Which phase of the request the failure occurred in. */
  readonly phase: "dns" | "tcp" | "tls" | "http" | "assertion" | "heartbeat" | "policy";
  /** Plain-English cause, shown in the incident UI. */
  readonly explanation: string;
  /** What the operator should actually do about it. */
  readonly suggestedAction: string;
}

export const FAILURE_EXPLANATIONS: Readonly<Record<FailureCode, FailureExplanation>> = {
  DNS_NXDOMAIN: {
    label: "DNS: no such domain",
    phase: "dns",
    explanation:
      "The domain name does not resolve. The authoritative nameserver replied that no record exists for this hostname.",
    suggestedAction:
      "Check the domain is still registered and that the A/AAAA record exists. Common after a DNS migration or an expired domain.",
  },
  DNS_TIMEOUT: {
    label: "DNS: timeout",
    phase: "dns",
    explanation: "The DNS resolver did not answer within the timeout.",
    suggestedAction:
      "Your nameservers may be overloaded or unreachable from this region. Check nameserver health and any recent NS record change.",
  },
  DNS_SERVFAIL: {
    label: "DNS: server failure",
    phase: "dns",
    explanation:
      "The nameserver returned SERVFAIL — it is reachable but could not produce an answer.",
    suggestedAction:
      "Usually a broken DNSSEC chain or a misconfigured zone. Validate the zone with `dig +dnssec` against your authoritative servers.",
  },

  TCP_TIMEOUT: {
    label: "TCP: timeout",
    phase: "tcp",
    explanation:
      "The TCP handshake never completed. Packets are being dropped rather than rejected.",
    suggestedAction:
      "Typically a firewall or security group silently dropping traffic, or the host being down. Confirm the port is open to the public internet.",
  },
  TCP_REFUSED: {
    label: "TCP: connection refused",
    phase: "tcp",
    explanation:
      "The host is reachable but actively refused the connection — nothing is listening on that port.",
    suggestedAction:
      "The service is likely stopped or crashed, or is bound to localhost instead of 0.0.0.0. Check the process and its bind address.",
  },
  TCP_RESET: {
    label: "TCP: connection reset",
    phase: "tcp",
    explanation: "The connection was established and then forcibly reset by the peer.",
    suggestedAction:
      "Often a load balancer draining, a protocol mismatch (HTTP sent to an HTTPS port), or a crash mid-request.",
  },
  TCP_UNREACHABLE: {
    label: "TCP: host unreachable",
    phase: "tcp",
    explanation: "No network route to the host from this region.",
    suggestedAction:
      "A routing or BGP problem between this probe region and your host. If only one region reports this, it is a network path issue, not an outage.",
  },

  TLS_EXPIRED: {
    label: "TLS: certificate expired",
    phase: "tls",
    explanation: "The TLS certificate presented by the server is past its expiry date.",
    suggestedAction:
      "Renew the certificate immediately. If you use ACME/Let's Encrypt, check that the renewal cron actually ran and reloaded the server.",
  },
  TLS_HOSTNAME_MISMATCH: {
    label: "TLS: hostname mismatch",
    phase: "tls",
    explanation:
      "The certificate served does not cover this hostname. Common after a CDN or load-balancer change.",
    suggestedAction:
      "Add the hostname to the certificate's SAN list, or point the DNS record at the origin that holds the correct certificate.",
  },
  TLS_UNTRUSTED: {
    label: "TLS: untrusted certificate",
    phase: "tls",
    explanation:
      "The certificate chain does not terminate in a trusted root — usually a self-signed cert or a missing intermediate.",
    suggestedAction:
      "Serve the full chain including intermediates. Verify with `openssl s_client -showcerts` from outside your network.",
  },
  TLS_HANDSHAKE_FAILED: {
    label: "TLS: handshake failed",
    phase: "tls",
    explanation: "The TLS handshake failed before a secure channel could be established.",
    suggestedAction:
      "Check for a cipher-suite or TLS-version mismatch, or an SNI misconfiguration on the load balancer.",
  },
  TLS_PROTOCOL_ERROR: {
    label: "TLS: protocol error",
    phase: "tls",
    explanation: "The peer spoke something other than valid TLS on this port.",
    suggestedAction:
      "Confirm the port actually terminates TLS. Sending HTTPS to a plaintext HTTP port produces exactly this.",
  },

  HTTP_TIMEOUT: {
    label: "HTTP: timeout",
    phase: "http",
    explanation:
      "The connection succeeded but the server did not return a complete response within the timeout.",
    suggestedAction:
      "The application is hanging — look at slow database queries, exhausted connection pools, or a saturated worker pool.",
  },
  HTTP_4XX: {
    label: "HTTP: client error",
    phase: "http",
    explanation:
      "The server returned a 4xx status that is not in this monitor's expected-status list.",
    suggestedAction:
      "A 401/403 usually means auth changed or a token expired. A 404 means the route moved. Update the monitor if this is intentional.",
  },
  HTTP_5XX: {
    label: "HTTP: server error",
    phase: "http",
    explanation: "The server returned a 5xx status — the application itself is failing.",
    suggestedAction:
      "Check application logs and error tracking for the same timestamp. A 502/503 points at the upstream being down behind a proxy.",
  },
  HTTP_REDIRECT_LOOP: {
    label: "HTTP: redirect loop",
    phase: "http",
    explanation: "The request exceeded the redirect limit without reaching a final response.",
    suggestedAction:
      "Classic causes: an HTTP→HTTPS rule fighting a proxy that terminates TLS, or a trailing-slash rule that bounces forever.",
  },
  HTTP_TOO_LARGE: {
    label: "HTTP: response too large",
    phase: "http",
    explanation: "The response body exceeded the 2 MB cap and was aborted.",
    suggestedAction:
      "Monitor a lightweight health endpoint instead of a full page. Sentinel only needs headers and a bounded prefix.",
  },

  ASSERT_KEYWORD_MISSING: {
    label: "Assertion: keyword missing",
    phase: "assertion",
    explanation:
      "The response was returned successfully but did not contain the required keyword.",
    suggestedAction:
      "The page may be rendering an error state while still returning 200 — a 'soft' outage that a status-code check alone would miss.",
  },
  ASSERT_KEYWORD_PRESENT: {
    label: "Assertion: forbidden keyword present",
    phase: "assertion",
    explanation: "The response contained a keyword that must never appear.",
    suggestedAction:
      "Often catches stack traces, 'Application Error', or maintenance pages leaking to users behind a 200.",
  },
  ASSERT_JSONPATH_FAILED: {
    label: "Assertion: JSONPath failed",
    phase: "assertion",
    explanation: "A JSONPath assertion did not match the expected value.",
    suggestedAction:
      "Either the API contract changed or a dependency is degraded and the payload is reporting it. Compare against the captured body snippet.",
  },
  ASSERT_HEADER_FAILED: {
    label: "Assertion: header failed",
    phase: "assertion",
    explanation: "A response header did not match the expected value.",
    suggestedAction:
      "Check for a changed cache-control, content-type, or a missing security header after a deploy.",
  },
  ASSERT_RESPONSE_TIME: {
    label: "Assertion: too slow",
    phase: "assertion",
    explanation: "The response arrived but exceeded the configured response-time budget.",
    suggestedAction:
      "The endpoint is up but violating its latency SLO. Check the waterfall to see which phase regressed.",
  },

  HEARTBEAT_MISSED: {
    label: "Heartbeat missed",
    phase: "heartbeat",
    explanation:
      "A scheduled job did not check in within its expected interval plus grace period.",
    suggestedAction:
      "The cron job failed to start, crashed before pinging, or the scheduler host is down. Check the job's own logs.",
  },

  CERT_EXPIRING: {
    label: "Certificate expiring",
    phase: "tls",
    explanation:
      "The TLS certificate for this host is valid today but expires soon. Browsers will start refusing the connection the moment it lapses.",
    suggestedAction:
      "Renew the certificate now. If ACME renewal is automated, check that the renewal job is still running and that the HTTP-01 or DNS-01 challenge still resolves.",
  },

  DOMAIN_EXPIRING: {
    label: "Domain expiring",
    phase: "policy",
    explanation:
      "The domain registration expires soon. Once it lapses, DNS stops resolving and every check on this domain fails at once.",
    suggestedAction:
      "Renew the registration with your registrar and enable auto-renew. Confirm the billing card on file has not expired.",
  },

  BLOCKED_TARGET: {
    label: "Blocked target",
    phase: "policy",
    explanation:
      "The target resolved to a private, loopback, or link-local address. Sentinel refuses to probe internal networks from shared infrastructure.",
    suggestedAction:
      "Point the monitor at a publicly routable address. Internal endpoints need a self-hosted probe inside your network.",
  },

  UNKNOWN: {
    label: "Unknown failure",
    phase: "policy",
    explanation: "The check failed in a way Sentinel could not classify.",
    suggestedAction:
      "Open the raw error detail on the response log row and report it if it recurs — every unknown is a taxonomy gap worth closing.",
  },
};

export function explainFailure(code: FailureCode): FailureExplanation {
  return FAILURE_EXPLANATIONS[code];
}

/** Codes that indicate a network-path problem rather than an origin problem. */
export const NETWORK_PATH_CODES: ReadonlySet<FailureCode> = new Set<FailureCode>([
  "TCP_TIMEOUT",
  "TCP_UNREACHABLE",
  "DNS_TIMEOUT",
]);

export function isFailureCode(value: string): value is FailureCode {
  return (FAILURE_CODES as readonly string[]).includes(value);
}
