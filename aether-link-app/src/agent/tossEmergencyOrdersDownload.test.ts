import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

describe("Toss uses the remote native browser path", () => {
  it("passes the actual Agent runtime action to the input server without fetching or writing files", async () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const parsed = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
    const factory = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "createAgentCommandRuntime");
    if (!factory || !ts.isFunctionDeclaration(factory)) throw Error("Agent command runtime not found");
    const returned = factory.body?.statements.find(ts.isReturnStatement)?.expression;
    if (!returned || !ts.isObjectLiteralExpression(returned)) throw Error("Agent runtime object not found");
    const injection = returned.properties.find(node => ts.isPropertyAssignment(node) && node.name.getText(parsed) === "injectAction");
    if (!injection || !ts.isPropertyAssignment(injection)) throw Error("Agent injector not found");
    const compiled = ts.transpile(`const handler = ${injection.initializer.getText(parsed)};`, { target: ts.ScriptTarget.ES2022 });
    const inject = vi.fn(async (_action: string) => {});
    const handler = new Function("persistentInputInjector", "pointerState", "recordPendingPointerAction", "recordSuccessfulPointerAction", "console", `${compiled}; return handler;`)({ inject }, {}, vi.fn(), vi.fn(), { log: vi.fn() });
    for (const action of ["system toss-emergency-download", "system edge-download", "system asp-login"]) await handler(action);
    expect(inject.mock.calls).toEqual([["system toss-emergency-download"], ["system edge-download"], ["system asp-login"]]);
    inject.mockRejectedValueOnce(new Error("browser launch failed"));
    await expect(handler("system toss-emergency-download")).rejects.toThrow("browser launch failed");
  });
});
