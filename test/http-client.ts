// A plain HTTP client for the local server's tests. It sends exactly the
// headers it is given, `Host` included, which `fetch` does not allow.
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";

export interface SentRequest {
  method?: string;
  path?: string;
  /** Defaults to the server's own `127.0.0.1:<port>`; null sends none. */
  host?: string | null;
  headers?: Record<string, string>;
  body?: string;
}

export interface Received {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export function send(port: number, sent: SentRequest = {}): Promise<Received> {
  const headers: Record<string, string> = { ...sent.headers };
  if (sent.host !== null) headers.Host = sent.host ?? `127.0.0.1:${port}`;
  if (sent.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(sent.body));
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method: sent.method ?? "GET", path: sent.path ?? "/", headers, setHost: false, agent: false },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end(sent.body);
  });
}

/** A form post from the server's own page, as a browser sends it. */
export function postForm(port: number, path: string, form: Record<string, string>, headers: Record<string, string> = {}): Promise<Received> {
  return send(port, {
    method: "POST",
    path,
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: `http://127.0.0.1:${port}`, ...headers },
    body: new URLSearchParams(form).toString(),
  });
}

/** A port nothing is listening on right now. */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
