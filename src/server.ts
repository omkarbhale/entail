import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { PageHealth } from "./health.ts";
import type { OperationalLog } from "./operational-log.ts";
import { renderPage } from "./page.ts";

/** The only address the local server listens on (ADR-0017). */
export const SERVER_ADDRESS = "127.0.0.1";
/** The hidden field that carries the per-start token on every form. */
export const TOKEN_FIELD = "token";
/** A form larger than this is refused. */
export const MAX_FORM_BYTES = 64 * 1024;

/** What every page knows about the server serving it. */
export interface ServerInfo {
  port: number;
  /** `http://127.0.0.1:<port>`, the origin entail's links are posted with. */
  origin: string;
  /** Issued when the process starts; every form carries it back. */
  token: string;
  /** The pages listed in the shared header, in order. */
  nav: readonly NavLink[];
  /** entail's health as every page's header shows it, read at each request (spec §16); none when left out. */
  health?: () => PageHealth;
}

export interface NavLink {
  path: string;
  label: string;
}

export interface PageRequest {
  url: URL;
  server: ServerInfo;
}

export interface FormRequest extends PageRequest {
  /** The posted form, already checked for the per-start token. */
  form: URLSearchParams;
}

/** A page's reply: HTML with a status, or a redirect (303 See Other) to another path. */
export type Reply = { status: number; html: string } | { redirect: string };

/** One page the local server serves, at one exact path. */
export interface Page {
  path: string;
  /** The page's label in the shared header, when it is listed there. */
  nav?: string;
  /** A page that reads the forge or git replies once those reads are done. */
  get?(request: PageRequest): Reply | Promise<Reply>;
  post?(request: FormRequest): Reply | Promise<Reply>;
}

export interface ServerOptions {
  /** The board port; 0 picks a free one (tests only). */
  port: number;
  pages: readonly Page[];
  log?: OperationalLog;
  /** entail's health, shown at the top of every page (spec §16). */
  health?: () => PageHealth;
}

export interface LocalServer {
  readonly info: ServerInfo;
  /** Stops accepting requests and closes open connections. */
  close(): Promise<void>;
}

export class BoardPortTakenError extends Error {
  readonly port: number;
  constructor(port: number, options?: ErrorOptions) {
    super(
      `the board port ${port} on ${SERVER_ADDRESS} is already in use. ` +
        `Stop whatever is using it and start entail again; entail does not move to another port, ` +
        `so the links it has posted keep working.`,
      options,
    );
    this.name = "BoardPortTakenError";
    this.port = port;
  }
}

const SECURITY_HEADERS = {
  // A little inline script and style, nothing loaded from elsewhere, and never framed.
  "Content-Security-Policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; " +
    "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  // Not no-referrer: under it a browser sends `Origin: null` on a same-origin form post.
  "Referrer-Policy": "same-origin",
  "Cache-Control": "no-store",
} as const;

/**
 * Starts the local server every page is served from (spec §15, ADR-0017).
 *
 * It listens on 127.0.0.1 only and rejects with {@link BoardPortTakenError}
 * when its port is taken, rather than picking another, because the links in
 * notices and issue comments must keep working across restarts. It refuses:
 *
 * - any request whose `Host` is not its own address, which defeats DNS rebinding;
 * - any write whose `Origin` is not its own;
 * - any form post without the per-start token.
 *
 * There is no login.
 */
export async function startServer(options: ServerOptions): Promise<LocalServer> {
  const pages = new Map(options.pages.map((page) => [page.path, page]));
  const nav = options.pages.flatMap((page) => (page.nav === undefined ? [] : [{ path: page.path, label: page.nav }]));
  const token = randomBytes(32).toString("base64url");
  const log = options.log;

  let info: ServerInfo | undefined;
  const server = createServer((req, res) => {
    handle(req, res, info!, pages, log).catch((error: unknown) => {
      log?.error("board-request-failed", { method: req.method, path: pathOf(req), error: messageOf(error) });
      if (!res.headersSent) send(res, 500, "text/plain", "entail could not serve this page; see the operational log.\n");
      else res.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      reject(error.code === "EADDRINUSE" ? new BoardPortTakenError(options.port, { cause: error }) : error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: SERVER_ADDRESS, port: options.port, exclusive: true });
  });

  const port = (server.address() as AddressInfo).port;
  info = { port, origin: `http://${SERVER_ADDRESS}:${port}`, token, nav, ...(options.health ? { health: options.health } : {}) };

  let closing: Promise<void> | undefined;
  return {
    info,
    close() {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  info: ServerInfo,
  pages: ReadonlyMap<string, Page>,
  log: OperationalLog | undefined,
): Promise<void> {
  const refuse = (status: number, reason: string, text: string) => {
    log?.warn("board-request-refused", { reason, method: req.method, path: pathOf(req) });
    // A refused write's body may be unread; the connection is not reused.
    if (req.method !== "GET" && req.method !== "HEAD") res.setHeader("Connection", "close");
    send(res, status, "text/plain", `${text}\n`);
  };

  if (!ownHosts(info.port).has((req.headers.host ?? "").toLowerCase())) {
    return refuse(403, "foreign-host", "entail serves only its own address.");
  }

  const method = req.method ?? "GET";
  const write = method !== "GET" && method !== "HEAD";
  if (write && !ownOrigins(info.port).has(req.headers.origin ?? "")) {
    return refuse(403, "foreign-origin", "entail takes writes only from its own pages.");
  }

  const url = new URL(req.url ?? "/", info.origin);
  const page = pages.get(url.pathname);
  const request: PageRequest = { url, server: info };

  if (!write) {
    if (page?.get === undefined) {
      return reply(res, page ? notAllowed(request) : notFound(request));
    }
    return reply(res, await page.get(request));
  }

  if (method !== "POST" || page?.post === undefined) {
    // Read nothing of a write no page takes, and do not reuse the connection.
    res.setHeader("Connection", "close");
    return reply(res, page ? notAllowed(request) : notFound(request));
  }
  const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") {
    return refuse(415, "not-a-form", "entail takes only its own forms.");
  }
  const body = await readBody(req, MAX_FORM_BYTES);
  if (body === null) {
    return refuse(413, "form-too-large", "This form is too large.");
  }
  const form = new URLSearchParams(body);
  if (!sameToken(form.get(TOKEN_FIELD), info.token)) {
    return refuse(
      403,
      "missing-token",
      "This form is not from the running entail. If entail restarted since the page was opened, reload it and try again.",
    );
  }
  return reply(res, await page.post({ ...request, form }));
}

function ownHosts(port: number): Set<string> {
  // `localhost` always resolves to this machine, so it is as safe from DNS rebinding as the address itself.
  return new Set([`${SERVER_ADDRESS}:${port}`, `localhost:${port}`]);
}

function ownOrigins(port: number): Set<string> {
  return new Set([...ownHosts(port)].map((host) => `http://${host}`));
}

function sameToken(given: string | null, token: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Reads a request body as UTF-8, or resolves null once it grows past `limit` bytes. */
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.removeAllListeners("data");
        req.resume();
        resolve(null);
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function reply(res: ServerResponse, r: Reply): void {
  if ("redirect" in r) {
    res.setHeader("Location", r.redirect);
    send(res, 303, "text/plain", "");
  } else {
    send(res, r.status, "text/html", r.html);
  }
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": `${type}; charset=utf-8`, "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function notFound(request: PageRequest): Reply {
  return {
    status: 404,
    html: renderPage(request, { title: "Not found", body: "<h1>Not found</h1>\n<p>entail has no page here.</p>" }),
  };
}

function notAllowed(request: PageRequest): Reply {
  return {
    status: 405,
    html: renderPage(request, { title: "Not allowed", body: "<h1>Not allowed</h1>\n<p>This page does not take that request.</p>" }),
  };
}

function pathOf(req: IncomingMessage): string {
  return (req.url ?? "/").split("?")[0]!;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
