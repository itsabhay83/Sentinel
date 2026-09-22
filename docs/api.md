# Sentinel API

Two public surfaces: a read-only REST API for your monitors and incidents, and a heartbeat
endpoint for jobs that check in on their own schedule.

Base URL in development: `http://localhost:3000`

---

## Authentication

REST endpoints authenticate with an API key in the `Authorization` header:

```
Authorization: <YOUR_API_KEY>
```

Create keys in **Settings → API keys**. The secret is displayed exactly once — only its HMAC is
stored, so a lost key must be replaced rather than recovered. Every key is scoped to the
organisation that created it; there is no way to read another tenant's data with it.

Missing, malformed, unknown, **revoked** and **expired** keys all return `401`:

```json
{ "error": "unauthorized" }
```

The four cases are deliberately indistinguishable. A response that separated "no such key" from
"revoked key" would confirm to whoever holds a leaked secret that it was once real.

### Scopes

Every key carries an explicit set of scopes, chosen when it is created:

| Scope               | Grants                                    |
| ------------------- | ----------------------------------------- |
| `monitors:read`     | `GET /api/v1/monitors`                    |
| `monitors:write`    | Reserved for future write endpoints       |
| `incidents:read`    | `GET /api/v1/incidents`                   |
| `incidents:write`   | Reserved for future write endpoints       |
| `status_pages:read` | Reserved for future status-page endpoints |

New keys default to the read-only pair. A key that authenticates but lacks the scope an endpoint
requires gets `403` — never `401`, because the credential itself is fine:

```json
{ "error": "forbidden", "message": "This API key is missing the 'monitors:read' scope." }
```

### Expiry and rotation

A key may be created with an expiry of 30, 90 or 365 days, or with none at all. Past its
`expiresAt` it is refused with `401`; **Settings → API keys** shows how long each key has left and
when it was last used.

**Rotate** mints a successor with the same scopes and puts the predecessor on a **24-hour fuse**
instead of killing it immediately. Both keys work during that window, so a deployment can pick up
the new secret without a gap in service. **Revoke** is immediate and has no grace period; it is a
soft revocation, so the key keeps appearing in the audit trail as the thing that made past calls.

---

## Rate limits

Every endpoint under `/api/` is metered with a token bucket. The REST endpoints are keyed on the
**API key id**, so one noisy key cannot spend another's budget, and a shared NAT address is not a
shared limit. The heartbeat endpoint is keyed on the token in its path.

| Surface                            | Burst | Refills over |
| ---------------------------------- | ----- | ------------ |
| `GET /api/v1/*`                    | 120   | 60s          |
| `GET\|POST /api/heartbeat/{token}` | 60    | 60s          |

Successful responses carry the headers too, so a client can slow itself down before it is refused:

| Header                | Meaning                                   |
| --------------------- | ----------------------------------------- |
| `RateLimit-Limit`     | Burst capacity                            |
| `RateLimit-Remaining` | Requests left in the bucket               |
| `RateLimit-Policy`    | `<capacity>;w=<window seconds>`           |
| `Retry-After`         | Seconds to wait — sent**only** on a `429` |

Over budget returns `429`:

```json
{ "error": "rate_limited", "message": "Too many requests. Please retry later." }
```

---

## `GET /api/v1/monitors`

Requires the `monitors:read` scope. Every monitor in your organisation with its current consensus
state.

```bash
curl -H "Authorization: Bearer $SENTINEL_API_KEY" \
  http://localhost:3000/api/v1/monitors
```

```json
{
  "monitors": [
    {
      "id": "39853dbf-9d7b-4565-bb01-b38da8434bef",
      "name": "API — checkout",
      "type": "http",
      "url": "https://checkout.acme-rockets.invalid/v1/checkout",
      "status": "DOWN",
      "since": "2026-09-07T10:05:30.113Z",
      "intervalSeconds": 30,
      "paused": false,
      "groupName": "API",
      "tags": ["api", "critical", "revenue"],
      "lastLatencyMs": null,
      "failingRegions": ["bom", "fra", "iad"]
    }
  ]
}
```

`status` is one of `UP`, `DEGRADED`, `PARTIAL_OUTAGE`, `DOWN`, `PAUSED`, `INCONCLUSIVE`,
`PENDING`. `since` is when the monitor entered that status, not when it was last checked —
useful for computing time-to-detect.

`failingRegions` is the set of regions that voted failure in the most recent evaluated cycle.
On a `PARTIAL_OUTAGE` this tells you which part of the world is affected.

---

## `GET /api/v1/incidents`

Requires the `incidents:read` scope. Incidents for your organisation, newest first.

**Query parameters**

| Parameter | Default | Meaning                                  |
| --------- | ------- | ---------------------------------------- |
| `open`    | `false` | `true` returns only unresolved incidents |
| `limit`   | `50`    | Maximum incidents to return (cap 200)    |

```bash
curl -H "Authorization: Bearer $SENTINEL_API_KEY" \
  "http://localhost:3000/api/v1/incidents?open=true&limit=10"
```

```json
{
  "incidents": [
    {
      "id": "66abde74-6897-4bb8-a723-869ec21eea0d",
      "monitorId": "39853dbf-9d7b-4565-bb01-b38da8434bef",
      "monitorName": "API — checkout",
      "severity": "down",
      "startedAt": "2026-09-07T10:05:30.113Z",
      "resolvedAt": null,
      "primaryFailureCode": "DNS_NXDOMAIN",
      "affectedRegions": ["bom", "fra", "iad"],
      "acknowledgedAt": null
    }
  ]
}
```

`severity` is `down`, `partial` or `degraded`. `primaryFailureCode` is the most common failure
code across the regions that failed — see the taxonomy below.

Writes are not exposed. Creating and editing monitors happens in the dashboard; publishing
mutations here requires idempotency keys and per-key rate limiting first.

---

## `GET|POST /api/heartbeat/{token}`

Heartbeat monitors invert the usual direction: instead of Sentinel calling your service, your
job calls Sentinel when it finishes. If a ping does not arrive within
`expectedEverySeconds + graceSeconds`, the scheduler opens a `HEARTBEAT_MISSED` incident.

Both verbs work, so it drops into a cron line or a container healthcheck without ceremony.
No authentication — the token in the path _is_ the credential. It is rate-limited per token rather
than per caller IP, so one machine pinging for a dozen monitors is never throttled on another's
behalf.

```bash
# at the end of your nightly job
curl -fsS https://sentinel.example.com/api/heartbeat/hb_7f3a9c2e1b8d4056
```

```json
{ "ok": true, "monitor": "Nightly ETL heartbeat", "receivedAt": "2026-09-07T02:14:31.882Z" }
```

An unknown token returns `404`. A successful ping flips the monitor to `UP` and automatically
resolves any open `HEARTBEAT_MISSED` incident, so recovery needs no manual action.

---

## Outbound webhooks

Webhook alert channels `POST` JSON when an incident opens or resolves:

```json
{
  "event": "incident.opened",
  "incidentId": "66abde74-6897-4bb8-a723-869ec21eea0d",
  "monitor": {
    "id": "39853dbf-9d7b-4565-bb01-b38da8434bef",
    "name": "API — checkout",
    "url": "https://checkout.acme-rockets.invalid/v1/checkout"
  },
  "severity": "down",
  "primaryFailureCode": "DNS_NXDOMAIN",
  "affectedRegions": ["bom", "fra", "iad"],
  "startedAt": "2026-09-07T10:05:30.113Z",
  "resolvedAt": null
}
```

`event` is `incident.opened` or `incident.resolved`.

### Verifying the signature

When the channel has a secret configured, two headers are sent:

| Header                 | Contents                                            |
| ---------------------- | --------------------------------------------------- |
| `X-Sentinel-Signature` | `HMAC-SHA256(secret, "{timestamp}.{rawBody}")`, hex |
| `X-Sentinel-Timestamp` | Unix seconds                                        |

Compute the HMAC over the timestamp, a literal `.`, and the **raw** request body — parsing and
re-serialising the JSON first will change the bytes and break the comparison.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, headers, secret) {
  const timestamp = headers["x-sentinel-timestamp"];
  const received = headers["x-sentinel-signature"];

  // Reject replays outside a 5-minute window.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");

  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(received, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Compare in constant time. A naive `===` leaks the correct signature one byte at a time.

---

## Status page feeds

Public status pages are served without authentication at `/status/{slug}`, with an RSS 2.0
incident feed alongside:

```bash
curl http://localhost:3000/status/acme/rss
```

Status pages expose only the display names configured for them — never internal monitor names
or target URLs.

---

## Failure codes

Every failed check carries a code identifying which phase of the request broke. The dashboard
renders each with a plain-English explanation and a suggested next step.

| Phase     | Codes                                                                                                                        |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| DNS       | `DNS_NXDOMAIN`, `DNS_TIMEOUT`, `DNS_SERVFAIL`                                                                                |
| TCP       | `TCP_REFUSED`, `TCP_TIMEOUT`, `TCP_RESET`, `TCP_UNREACHABLE`                                                                 |
| TLS       | `TLS_EXPIRED`, `TLS_HOSTNAME_MISMATCH`, `TLS_UNTRUSTED`, `TLS_HANDSHAKE_FAILED`, `TLS_PROTOCOL_ERROR`, `CERT_EXPIRING`       |
| HTTP      | `HTTP_4XX`, `HTTP_5XX`, `HTTP_TIMEOUT`, `HTTP_REDIRECT_LOOP`, `HTTP_TOO_LARGE`                                               |
| Assertion | `ASSERT_KEYWORD_MISSING`, `ASSERT_KEYWORD_PRESENT`, `ASSERT_JSONPATH_FAILED`, `ASSERT_HEADER_FAILED`, `ASSERT_RESPONSE_TIME` |
| Heartbeat | `HEARTBEAT_MISSED`                                                                                                           |
| Policy    | `BLOCKED_TARGET`, `DOMAIN_EXPIRING`, `UNKNOWN`                                                                               |

`BLOCKED_TARGET` means the SSRF guard refused the address — a private range, a loopback address,
or a cloud metadata endpoint — and no connection was attempted.

---

## Regions

| Code  | Location                |
| ----- | ----------------------- |
| `bom` | Mumbai, India           |
| `sin` | Singapore               |
| `fra` | Frankfurt, Germany      |
| `lhr` | London, United Kingdom  |
| `iad` | Ashburn, United States  |
| `sjc` | San Jose, United States |
| `gru` | São Paulo, Brazil       |
| `syd` | Sydney, Australia       |

`bom`, `fra` and `iad` run by default in development.
