import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import http from "node:http";
import type { Source } from "../types.ts";
import { Store } from "./store.ts";

export interface WebOptions {
  sources: Source[];
  host: string;
  port: number;
  open: boolean;
}

const MAX_UPLOAD = 1024 ** 3;

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_UPLOAD) throw Object.assign(new Error("upload too large (max 1 GB)"), { status: 413 });
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
  execFile(cmd, [url], () => {});
}

export async function serve(o: WebOptions) {
  const store = new Store(o.sources);
  const token = crypto.randomBytes(16).toString("hex");
  const page = await fsp.readFile(new URL("./index.html", import.meta.url), "utf8");
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(o.host);
  let allowedHosts = new Set<string>();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      // DNS-rebinding guard: a page on another domain that resolves to 127.0.0.1
      // arrives with its own Host header.
      if (loopback && !allowedHosts.has(req.headers.host ?? "")) return send(res, 403, { error: "bad host" });

      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, PAGE_HEADERS);
        return res.end(page);
      }
      if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });

      const given = req.headers["x-agtail-token"] ?? url.searchParams.get("token");
      const ok = typeof given === "string" && given.length === token.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
      if (!ok) return send(res, 401, { error: "missing or wrong token; open the URL printed by `agtail web`" });

      const p = url.searchParams;
      const csv = (k: string) => (p.get(k) ?? "").split(",").map((x) => x.trim()).filter(Boolean);

      if (req.method === "GET" && url.pathname === "/api/sessions") {
        return send(res, 200, await store.sessions());
      }
      if (req.method === "GET" && url.pathname === "/api/session") {
        const s = await store.session(p.get("key") ?? "");
        return s ? send(res, 200, s) : send(res, 404, { error: "no such session" });
      }
      if (req.method === "GET" && url.pathname === "/api/search") {
        const q = p.get("q") ?? "";
        if (!q.trim()) return send(res, 400, { error: "empty query" });
        try {
          return send(res, 200, await store.search(q, { regex: p.get("regex") === "1", agents: csv("agents"), kinds: csv("kinds") }));
        } catch (err) {
          if (err instanceof SyntaxError) return send(res, 400, { error: `bad regex: ${err.message}` });
          throw err;
        }
      }
      if (req.method === "GET" && url.pathname === "/api/backup") {
        const keys = csv("keys");
        const dir = `agtail-backup-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
        res.writeHead(200, {
          "content-type": "application/gzip",
          "content-disposition": `attachment; filename="${dir}.tar.gz"`,
          "cache-control": "no-store",
        });
        await store.backup(keys, res, dir);
        return;
      }
      if (req.method === "POST" && (url.pathname === "/api/import/preview" || url.pathname === "/api/import/apply")) {
        const body = await readBody(req);
        const name = decodeURIComponent(String(req.headers["x-filename"] ?? "upload"));
        const items =
          url.pathname.endsWith("apply") ? await store.applyImport(body, name) : await store.planImport(body, name);
        return send(res, 200, items);
      }
      return send(res, 404, { error: "not found" });
    } catch (err: any) {
      if (res.headersSent) return res.destroy();
      send(res, err?.status ?? 500, { error: err?.message ?? String(err) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host, () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const shown = o.host === "0.0.0.0" || o.host === "::" ? "127.0.0.1" : o.host.includes(":") ? `[${o.host}]` : o.host;
  const url = `http://${shown}:${port}/?token=${token}`;
  process.stderr.write(`agtail web: ${url}\n(ctrl-c to stop)\n`);
  if (!loopback) process.stderr.write(`warning: listening on ${o.host}; anyone with the URL can read your sessions\n`);
  if (o.open) openBrowser(url);
  store.sessions().catch(() => {}); // warm the index while the browser opens
  return server;
}
