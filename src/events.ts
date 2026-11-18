import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { BoardEvent } from "./api-types.ts";
import { LOG_DIRECTORY, SETTINGS_FILE } from "./records.ts";

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
 * Emits "changed" whenever a repo's log or the settings for every repo are
 * written, by this process or any other (such as `entail confirm` or
 * `entail settings` from a terminal), at most once per `debounceMs`. Returns
 * a function that stops watching.
 */
export function watchLogs(dataDirectory: string, bus: EventBus, debounceMs = 150): () => void {
  const directory = join(dataDirectory, LOG_DIRECTORY);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let timer: NodeJS.Timeout | null = null;
  const changed = () => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      bus.emit({ type: "changed" });
    }, debounceMs);
  };
  const watchers: FSWatcher[] = [];
  const watchIt = (path: string, recursive: boolean, listener: (file: string | null) => void) => {
    try {
      const watcher = watch(path, { recursive, persistent: false }, (_event, file) => listener(file === null ? null : String(file)));
      watcher.on("error", () => watcher.close());
      watchers.push(watcher);
    } catch {
      // Without file watching the board still hears every change made through this process.
    }
  };
  watchIt(directory, true, changed);
  // The settings are written whole and renamed into place, so the data directory sees their name.
  watchIt(dataDirectory, false, (file) => {
    if (file === null || file === SETTINGS_FILE) changed();
  });
  return () => {
    for (const watcher of watchers) watcher.close();
    if (timer !== null) clearTimeout(timer);
  };
}
