import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { generateKeyPairSync, X509Certificate, createSign } from "node:crypto";
import type { AddressInfo } from "node:net";

/**
 * A single local server that can produce every failure mode the checker must
 * classify. Used by the unit tests so we never depend on the public internet.
 *
 * Routes:
 *   /ok                 200 with a JSON body
 *   /slow?ms=500        200 after a delay
 *   /status/:code       arbitrary status code
 *   /redirect/:n        n hops then /ok
 *   /loop               infinite redirect to itself
 *   /large?mb=3         streams more than the 2 MB cap
 *   /reset              destroys the socket mid-response
 *   /headers            echoes a custom header
 *   /login              POST that returns {"token":"..."} for flow tests
 *   /me                 requires Authorization: Bearer <token>
 */
export interface FixtureServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

function handler(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  if (path === "/ok") {
    const body = JSON.stringify({ status: "healthy", version: "1.4.2", region: "local" });
    res.writeHead(200, { "content-type": "application/json", "x-sentinel-test": "ok" });
    res.end(body);
    return;
  }

  if (path === "/slow") {
    const ms = Number(url.searchParams.get("ms") ?? "300");
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("slow but alive");
    }, ms);
    return;
  }

  if (path.startsWith("/status/")) {
    const code = Number(path.slice("/status/".length));
    res.writeHead(Number.isInteger(code) ? code : 500, { "content-type": "text/plain" });
    res.end(`status ${code}`);
    return;
  }

  if (path.startsWith("/redirect/")) {
    const remaining = Number(path.slice("/redirect/".length));
    const next = remaining <= 1 ? "/ok" : `/redirect/${remaining - 1}`;
    res.writeHead(302, { location: next });
    res.end();
    return;
  }

  if (path === "/loop") {
    res.writeHead(302, { location: "/loop" });
    res.end();
    return;
  }

  if (path === "/large") {
    const mb = Number(url.searchParams.get("mb") ?? "3");
    res.writeHead(200, { "content-type": "application/octet-stream" });
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    let written = 0;
    const target = mb * 1024 * 1024;
    const pump = (): void => {
      while (written < target) {
        written += chunk.length;
        if (!res.write(chunk)) {
          res.once("drain", pump);
          return;
        }
      }
      res.end();
    };
    pump();
    return;
  }

  if (path === "/reset") {
    res.socket?.destroy();
    return;
  }

  if (path === "/headers") {
    res.writeHead(200, { "content-type": "text/plain", "x-api-version": "2024-11-01" });
    res.end("headers");
    return;
  }

  if (path === "/login" && req.method === "POST") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ access_token: "tok_flow_12345", expires_in: 3600 }));
    return;
  }

  if (path === "/me") {
    const auth = req.headers.authorization ?? "";
    if (auth === "Bearer tok_flow_12345") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ user: "sentinel", plan: "pro" }));
      return;
    }
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

async function listen(server: Server, scheme: "http" | "https"): Promise<FixtureServer> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `${scheme}://127.0.0.1:${address.port}`,
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export async function startFixtureServer(): Promise<FixtureServer> {
  return await listen(createHttpServer(handler), "http");
}

/** HTTPS server with a self-signed cert — exercises the TLS_UNTRUSTED path. */
export async function startSelfSignedServer(): Promise<FixtureServer> {
  const { key, cert } = generateSelfSignedCert();
  return await listen(createHttpsServer({ key, cert }, handler), "https");
}

function generateSelfSignedCert(): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  // Node has no cert-authoring API, so we build a minimal DER by hand.
  const cert = buildSelfSignedCertificate(publicKey.export({ type: "spki", format: "der" }) as Buffer, privateKey);
  return { key: keyPem, cert };
}

// --- Minimal X.509 authoring -------------------------------------------------
// Just enough DER to produce a valid self-signed leaf for 127.0.0.1. Node
// cannot mint certificates, and pulling in `node-forge` for a test fixture is
// not worth the dependency.

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

function derInteger(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  do {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  } while (remaining > 0);
  if ((bytes[0] ?? 0) & 0x80) bytes.unshift(0);
  return der(0x02, Buffer.from(bytes));
}

function derOid(parts: readonly number[]): Buffer {
  const first = (parts[0] ?? 0) * 40 + (parts[1] ?? 0);
  const bytes: number[] = [first];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [];
    let remaining = part;
    do {
      chunk.unshift(remaining & 0x7f);
      remaining >>= 7;
    } while (remaining > 0);
    for (let i = 0; i < chunk.length - 1; i += 1) chunk[i] = (chunk[i] ?? 0) | 0x80;
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}

function derUtcTime(date: Date): Buffer {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const text =
    pad(date.getUTCFullYear() % 100) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "Z";
  return der(0x17, Buffer.from(text, "ascii"));
}

function buildSelfSignedCertificate(spki: Buffer, privateKey: import("node:crypto").KeyObject): string {
  const sha256WithRsa = der(0x30, Buffer.concat([derOid([1, 2, 840, 113549, 1, 1, 11]), der(0x05, Buffer.alloc(0))]));
  const commonName = der(
    0x31,
    der(0x30, Buffer.concat([derOid([2, 5, 4, 3]), der(0x0c, Buffer.from("127.0.0.1", "utf8"))])),
  );
  const name = der(0x30, commonName);

  const now = new Date();
  const notBefore = new Date(now.getTime() - 60_000);
  const notAfter = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const validity = der(0x30, Buffer.concat([derUtcTime(notBefore), derUtcTime(notAfter)]));

  // subjectAltName = IP:127.0.0.1
  const ipAddress = der(0x87, Buffer.from([127, 0, 0, 1]));
  const sanExtension = der(
    0x30,
    Buffer.concat([derOid([2, 5, 29, 17]), der(0x04, der(0x30, ipAddress))]),
  );
  const extensions = der(0xa3, der(0x30, sanExtension));

  const tbs = der(
    0x30,
    Buffer.concat([
      der(0xa0, derInteger(2)),
      derInteger(Math.floor(Math.random() * 1_000_000) + 1),
      sha256WithRsa,
      name,
      validity,
      name,
      spki,
      extensions,
    ]),
  );

  const signer = createSign("sha256");
  signer.update(tbs);
  signer.end();
  const signature = signer.sign(privateKey);

  const certificate = der(
    0x30,
    Buffer.concat([tbs, sha256WithRsa, der(0x03, Buffer.concat([Buffer.from([0]), signature]))]),
  );

  const base64 = certificate.toString("base64").replace(/(.{64})/g, "$1\n");
  const pem = `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`;

  // Fail loudly here rather than inside a confusing TLS error later.
  new X509Certificate(pem);
  return pem;
}
