import { execFile } from "node:child_process";

/** The HTTP methods the adapters use: GET for reads, the others for the four writes. */
export type ForgeMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** One API request an adapter makes to its host. */
export interface ForgeRequest {
  host: string;
  method: ForgeMethod;
  /** The API path relative to the host's API root, with its query, such as `repos/acme/tally/issues?state=all`. */
  path: string;
  /** Extra request headers, such as `If-None-Match`. */
  headers?: Record<string, string>;
  /** A JSON request body, sent as `application/json`. Only writes have one. */
  body?: unknown;
}

/** The HTTP response to a {@link ForgeRequest}, whatever its status. */
export interface ForgeResponse {
  status: number;
  /** Header names are lower case. */
  headers: Record<string, string>;
  body: string;
}

/**
 * The seam under the adapters: how an API request reaches the host (ADR-0015).
 * It returns every HTTP response, 304 and error statuses included, and throws
 * only when no HTTP response came back. Tests replace it with recorded responses.
 */
export interface Transport {
  request(request: ForgeRequest): Promise<ForgeResponse>;
}

/** No HTTP response came back: the CLI is missing, not logged in, or could not reach the host. */
export class TransportError extends Error {
  /** True when the CLI says it is not logged in for the host. */
  readonly loggedOut: boolean;
  /** True when the CLI is not installed: its executable was not found. */
  readonly cliMissing: boolean;

  constructor(message: string, loggedOut: boolean, cliMissing = false) {
    super(message);
    this.name = "TransportError";
    this.loggedOut = loggedOut;
    this.cliMissing = cliMissing;
  }
}

/** The owner's CLI for a forge: `gh` for GitHub, `glab` for GitLab. */
export type ForgeCli = "gh" | "glab";

export interface CliTransportOptions {
  /** The executable to run; the CLI's own name, found on PATH, by default. */
  executable?: string;
  /** How long one call may run before it is ended. */
  timeoutMs?: number;
}

/** `gh` exits 4 when the host needs `gh auth login`. */
const GH_EXIT_AUTH_REQUIRED = 4;
/**
 * `glab` has no exit code of its own for a missing login. When it holds a
 * host's login but cannot use it, such as a token missing from the keyring, it
 * refuses before sending anything and tells the owner to run `glab auth
 * login`. With no login at all for the host it sends the request without a
 * token, and the forge's 401 says so instead.
 */
const GLAB_AUTH_REQUIRED = /glab auth login|glab is not authenticated/;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

/**
 * Runs every request as `gh api --hostname <host>` or `glab api --hostname
 * <host>`, so entail never holds or stores a token: the CLI uses the owner's
 * own login, keyring and host configuration (ADR-0015).
 *
 * The CLI is asked to include the response's status line and headers, and the
 * transport reads the HTTP status from them rather than the exit code: `gh api`
 * exits 1 on a 304 Not Modified, which is not an error.
 */
export class CliTransport implements Transport {
  readonly #cli: ForgeCli;
  readonly #executable: string;
  readonly #timeoutMs: number;

  constructor(cli: ForgeCli, options: CliTransportOptions = {}) {
    this.#cli = cli;
    this.#executable = options.executable ?? cli;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  request(request: ForgeRequest): Promise<ForgeResponse> {
    const args = ["api", "--hostname", request.host, "--include", "--method", request.method];
    const headers = { ...request.headers };
    if (request.body !== undefined) headers["Content-Type"] = "application/json";
    for (const [name, value] of Object.entries(headers)) {
      args.push("--header", `${name}: ${value}`);
    }
    // A body goes through standard input as raw JSON, so the CLI never reads
    // it as typed fields or a file name.
    if (request.body !== undefined) args.push("--input", "-");
    args.push(request.path);

    return new Promise((resolve, reject) => {
      const child = execFile(
        this.#executable,
        args,
        {
          encoding: "utf8",
          maxBuffer: MAX_OUTPUT_BYTES,
          timeout: this.#timeoutMs,
          env: {
            ...process.env,
            GH_PROMPT_DISABLED: "1",
            GH_NO_UPDATE_NOTIFIER: "1",
            GLAB_CHECK_UPDATE: "false",
            NO_PROMPT: "1",
            NO_COLOR: "1",
          },
        },
        (error, stdout, stderr) => {
          // A timeout or an output overflow leaves the output cut short, so only
          // a CLI that ran to its own exit is read for a response.
          const code = error && typeof error.code === "number" ? error.code : null;
          const ranToExit = !error || (code !== null && !error.killed);
          const response = ranToExit ? parseIncludedResponse(stdout) : null;
          if (response) {
            resolve(response);
            return;
          }
          const detail = stderr.trim() || error?.message || "no HTTP response";
          const loggedOut =
            code !== null && (this.#cli === "gh" ? code === GH_EXIT_AUTH_REQUIRED : GLAB_AUTH_REQUIRED.test(stderr));
          const cliMissing = error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
          reject(
            new TransportError(`${this.#cli} api ${request.method} ${request.path} on ${request.host}: ${detail}`, loggedOut, cliMissing),
          );
        },
      );
      // A CLI that exits before reading its input closes the pipe; its exit is what counts.
      child.stdin?.on("error", () => {});
      child.stdin?.end(request.body === undefined ? undefined : JSON.stringify(request.body));
    });
  }
}

const STATUS_LINE = /^HTTP\/[\d.]+ (\d{3})(?: .*)?$/;

/**
 * Parses a CLI's `--include` output: an HTTP status line, header lines, a
 * blank line, then the body. Returns null when the output does not start with
 * a status line, meaning no HTTP response came back.
 */
export function parseIncludedResponse(output: string): ForgeResponse | null {
  const headerEnd = /\r?\n\r?\n/.exec(output);
  const head = headerEnd ? output.slice(0, headerEnd.index) : output;
  const body = headerEnd ? output.slice(headerEnd.index + headerEnd[0].length) : "";
  const [statusLine = "", ...headerLines] = head.split(/\r?\n/);
  const status = STATUS_LINE.exec(statusLine.trim());
  if (!status) return null;

  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[name] = name in headers ? `${headers[name]}, ${value}` : value;
  }
  return { status: Number(status[1]), headers, body };
}
