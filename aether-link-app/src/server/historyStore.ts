import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConnectionHistoryEntry } from "../domain/types";

export interface HistoryStore {
  readHistory: () => Promise<ConnectionHistoryEntry[]>;
  writeHistory: (history: ConnectionHistoryEntry[]) => Promise<void>;
  addHistoryEntry: (entry: ConnectionHistoryEntry) => Promise<void>;
}

export function createMemoryHistoryStore(initialHistory: ConnectionHistoryEntry[] = []): HistoryStore {
  let history = initialHistory;
  return {
    async readHistory() {
      return history;
    },
    async writeHistory(nextHistory) {
      history = nextHistory;
    },
    async addHistoryEntry(entry) {
      history.push(entry);
    },
  };
}

export function createFileHistoryStore(filePath: string): HistoryStore {
  return {
    async readHistory() {
      try {
        const content = await readFile(filePath, "utf8");
        const payload = JSON.parse(content) as { history?: ConnectionHistoryEntry[] };
        return Array.isArray(payload.history) ? payload.history : [];
      } catch (error) {
        if (isNotFoundError(error)) {
          return [];
        }
        throw error;
      }
    },
    async writeHistory(history) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, `${JSON.stringify({ history }, null, 2)}\n`, "utf8");
    },
    async addHistoryEntry(entry) {
      const history = await this.readHistory();
      history.push(entry);
      await this.writeHistory(history);
    },
  };
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
