import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Viewer device deletion presentation", () => {
  it("keeps deletion inside the edit dialog behind an explicit second click", () => {
    const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    const dialog = source.slice(
      source.indexOf("function DeviceEditDialog"),
      source.indexOf("function SecureConnectDialog"),
    );

    expect(dialog).toContain("isDeleteArmed");
    expect(dialog).toContain("장비 삭제");
    expect(dialog).toContain("한 번 더 눌러 삭제");
    expect(dialog).toContain("onDelete");
  });
});
