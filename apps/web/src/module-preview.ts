import { parse } from "es-module-lexer/js";

export function scriptDataUrl(code: string): string {
  const bytes = new TextEncoder().encode(code);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192)
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return "data:text/javascript;base64," + btoa(binary);
}

/** Assign stable names before visiting dependencies, so cycles use import-map
 * references instead of recursively embedding one another's data URLs. */
export class ModulePreviewCompiler {
  private readonly modules = new Map<string, { name: string; url: string }>();
  private inline = 0;
  private edges = 0;
  constructor(
    private readonly resolve: (
      specifier: string,
      from: string,
    ) => string | undefined,
    private readonly read: (path: string) => string,
    private readonly account: (code: string) => void,
  ) {}
  add(code: string, from: string, file?: string, depth = 0): string {
    const key = file === undefined ? `inline:${this.inline++}` : `file:${file}`;
    const existing = this.modules.get(key);
    if (existing) return existing.name;
    if (this.modules.size >= 256 || depth > 128)
      throw new Error("Interactive module graph exceeds preview limits.");
    const module = { name: `agentlive-module-${this.modules.size}`, url: "" };
    this.modules.set(key, module);
    this.account(code);
    const [imports] = parse(code);
    const edits: { start: number; end: number; value: string }[] = [];
    for (const item of imports) {
      if (++this.edges > 4096)
        throw new Error("Interactive module imports exceed preview limits.");
      if (
        item.type === "import-meta" ||
        item.specifier === undefined ||
        (item.type === "dynamic" && item.glob) ||
        item.phase !== null ||
        item.attributes !== null ||
        (item.type !== "dynamic" && item.typeOnly)
      )
        throw new Error(
          "This module uses unsupported computed imports, import metadata or import attributes.",
        );
      // Bare names and source import maps are not captured dependency identities.
      const target = /^(\.\.?\/|\/)/.test(item.specifier)
        ? this.resolve(item.specifier, from)
        : undefined;
      if (!target)
        throw new Error("A required module dependency was not captured.");
      const name = this.add(this.read(target), target, target, depth + 1);
      edits.push({
        start: item.start,
        end: item.end,
        value: item.type === "dynamic" ? JSON.stringify(name) : name,
      });
    }
    for (const edit of edits.sort((a, b) => b.start - a.start))
      code = code.slice(0, edit.start) + edit.value + code.slice(edit.end);
    module.url = scriptDataUrl(code);
    return module.name;
  }
  importMap(): string {
    if (!this.modules.size) return "";
    const imports = Object.fromEntries(
      [...this.modules.values()].map((module) => [module.name, module.url]),
    );
    return `<script type="importmap">${JSON.stringify({ imports }).replaceAll("<", "\\u003c")}</script>`;
  }
}
