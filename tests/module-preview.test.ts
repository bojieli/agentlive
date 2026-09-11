import { expect, it } from "vitest";
import { ModulePreviewCompiler } from "../apps/web/src/module-preview.js";
function compiler(files: Record<string, string>) {
  let bytes = 0;
  const instance = new ModulePreviewCompiler(
    (name, from) => {
      const target = new URL(
        name,
        `https://bundle.invalid/${from}`,
      ).pathname.slice(1);
      return target in files ? target : undefined;
    },
    (path) => files[path]!,
    (code) => {
      bytes += Buffer.byteLength(code);
    },
  );
  return { instance, bytes: () => bytes };
}
it("rewrites cycles, reexports and literal dynamic imports to one stable map entry per file", () => {
  const files = {
    "a.js":
      'import {b} from "./b.js"; export {b}; export const a="a"; import("./b.js");',
    "b.js": 'export {a as b} from "./a.js";',
  };
  const { instance, bytes } = compiler(files);
  const name = instance.add(files["a.js"], "a.js", "a.js");
  expect(instance.add(files["a.js"], "a.js", "a.js")).toBe(name);
  const text = instance.importMap();
  const map = JSON.parse(
    text.slice(text.indexOf(">") + 1, text.lastIndexOf("<")),
  ).imports;
  expect(Object.keys(map)).toHaveLength(2);
  const source = Buffer.from(map[name].split(",")[1], "base64").toString();
  expect(source).toContain('import("agentlive-module-1")');
  expect(source).not.toContain("./b.js");
  expect(bytes()).toBe(
    Object.values(files).reduce(
      (total, code) => total + Buffer.byteLength(code),
      0,
    ),
  );
});
it.each([
  "import(name)",
  "import(`./${name}.js`)",
  "console.log(import.meta.url)",
  'import "bare-name"',
  'import "https://evil.invalid/a.js"',
  'import "./missing.js"',
  'import x from "./a.js" with { type: "json" }',
])("rejects unsupported or unavailable module references: %s", (code) => {
  const { instance } = compiler({ "a.js": "export default 1" });
  expect(() => instance.add(code, "index.html")).toThrow();
});
it("bounds deep dependency graphs before recursive traversal exhausts the stack", () => {
  const files = Object.fromEntries(
    Array.from({ length: 140 }, (_, index) => [
      `${index}.js`,
      `import "./${index + 1}.js";`,
    ]),
  );
  const { instance } = compiler(files);
  expect(() => instance.add(files["0.js"]!, "0.js", "0.js")).toThrow("limits");
});
