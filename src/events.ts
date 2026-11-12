import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { BoardEvent } from "./api-types.ts";
import { LOG_DIRECTORY } from "./records.ts";

/**
 * What the board hears live, over server-sent events on `/api/events`: that
 * something changed (it then reads again what it shows), and when a repo is
 * being checked and what the check found.
 */
export class EventBus {
  readonly #listeners = new Set<(event: BoardEvent) => void>();

  on(listener: (event: BoardEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(event: BoardEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // One listener that fails, such as a closed connection, does not stop the others.
      }
    }
  }

  get listeners(): number {
    return this.#listeners.size;
  }
}

/**
 * Emits "changed" whenever a repo's log is written, by this process or any
 * other (such as `entail confirm` from a terminal), at most once per
 * `debounceMs`. Returns a function that stops watching.
 */
export function watchLogs(dataDirectory: string, bus: EventBus, debounceMs = 150): () => void {
  const directory = join(dataDirectory, LOG_DIRECTORY);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let timer: NodeJS.Timeout | null = null;
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(directory, { recursive: true, persistent: false }, () => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        bus.emit({ type: "changed" });
      }, debounceMs);
    });
    watcher.on("error", () => watcher?.close());
  } catch {
    // Without file watching the board still hears every change made through this process.
  }
  return () => {
    watcher?.close();
    if (timer !== null) clearTimeout(timer);
  };
}
