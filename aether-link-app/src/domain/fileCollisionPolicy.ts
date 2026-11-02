export type FileCollisionPolicy = "overwrite" | "rename" | "skip";

export function isFileCollisionPolicy(value: unknown): value is FileCollisionPolicy {
  return value === "overwrite" || value === "rename" || value === "skip";
}
