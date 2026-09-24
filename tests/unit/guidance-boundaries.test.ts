import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { guidanceBoundaryViolations } from "../../scripts/check-guidance-boundaries";

const temporaryRoots: Array<string> = [];
function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "guidance-boundaries-"));
  temporaryRoots.push(root);
  const values = {
    "tsconfig.json": JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", baseUrl: ".", paths: { "@app/*": ["src/*"] } } }),
    "src/modules/work/index.ts": "export { value } from './internal.js';",
    "src/modules/work/internal.ts": "export const value = 1;",
    ...files,
  };
  for (const [name, content] of Object.entries(values)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}
afterEach(() => { for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("guidance import boundaries", () => {
  it("allows application composition through a module's public entry", () => {
    const root = fixture({ "src/modules/guidance.ts": "import { value } from './work/index.js'; export const modules = [value];" });
    expect(guidanceBoundaryViolations(root)).toEqual([]);
  });

  it("rejects a module import added to the neutral runtime, including a TypeScript alias", () => {
    const root = fixture({ "src/guidance/runtime.ts": "import { value } from '@app/modules/work/index.js'; export const runtime = value;" });
    expect(guidanceBoundaryViolations(root)).toEqual([expect.stringContaining("src/guidance/runtime.ts:1 -> src/modules/work/index.ts")]);
  });

  it("rejects external imports, type imports, and dynamic imports of module internals", () => {
    const root = fixture({ "src/client/App.tsx": "import { value } from '../modules/work/internal.js';\ntype Value = typeof import('../modules/work/internal.js');\nconst lazy = import('../modules/work/internal.js');" });
    const failures = guidanceBoundaryViolations(root);
    expect(failures).toHaveLength(3);
    expect(failures.every((failure) => failure.includes("Consumers must import a module's public index.ts."))).toBe(true);
  });

  it("rejects a renderer importing application dispatch or a computed import", () => {
    const root = fixture({
      "src/client/use-workspace.ts": "export const command = () => {};",
      "src/client/guidance/Notes.tsx": "import { command } from '../use-workspace'; const name = 'work'; import(name);",
    });
    expect(guidanceBoundaryViolations(root)).toHaveLength(2);
  });
});
