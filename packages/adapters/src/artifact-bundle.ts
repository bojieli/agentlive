import { parseSrcset, stringifySrcset } from "srcset";
import { init as initModules, parse as parseModules } from "es-module-lexer";
import { createHash } from "node:crypto";
import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";
import postcss from "postcss";
import valueParser from "postcss-value-parser";
import {
  ARTIFACT_BUNDLE_MAX_BYTES,
  ARTIFACT_BUNDLE_MAX_CONTENT_BYTES,
  ARTIFACT_BUNDLE_MAX_FILES,
  artifactBundleManifestSchema,
  canonicalJson,
  decodeArtifactBundle,
  type ArtifactBundleManifest,
} from "@agentlive/protocol";
export type BundleSource = { bytes: Uint8Array; mediaType: string };
export type BundleLoadResult =
  BundleSource | { unavailable: "outside-scope" | "missing" | "unsupported" };
const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
/** The loader enforces filesystem/origin access policy and stable-copy semantics. No source is modified. */
export async function captureArtifactBundle(options: {
  entrypoint: string;
  load: (url: string, signal: AbortSignal) => Promise<BundleLoadResult>;
  filter: (text: string) => string;
  signal: AbortSignal;
}) {
  const files: ArtifactBundleManifest["files"] = [];
  const unavailable: ArtifactBundleManifest["unavailable"] = [];
  const visited = new Map<string, string>();
  const blobs: Record<string, string> = {};
  let sourceBytes = 0,
    outputBytes = 0,
    references = 0;
  const missing = (
    from: string,
    reason: ArtifactBundleManifest["unavailable"][number]["reason"],
  ) => {
    if (unavailable.length >= 2048)
      throw new Error("Artifact bundle exceeds unavailable reference limit");
    const target = `missing/r${unavailable.length}`;
    unavailable.push({ from, target, reason });
    return target;
  };
  const visit = async (
    url: string,
    depth: number,
    from: string,
  ): Promise<string> => {
    options.signal.throwIfAborted();
    if (++references > 4096)
      throw new Error("Artifact bundle exceeds reference limit");
    const known = visited.get(url);
    if (known) return known;
    if (depth > 8) return missing(from, "depth-limit");
    if (visited.size >= ARTIFACT_BUNDLE_MAX_FILES)
      throw new Error("Artifact bundle exceeds file limit");
    const source = await options.load(url, options.signal);
    options.signal.throwIfAborted();
    if ("unavailable" in source) return missing(from, source.unavailable);
    sourceBytes += source.bytes.byteLength;
    if (sourceBytes > ARTIFACT_BUNDLE_MAX_CONTENT_BYTES)
      throw new Error("Artifact bundle exceeds source byte limit");
    const mime = source.mediaType.toLowerCase();
    const extension =
      (
        {
          "text/html": "html",
          "text/css": "css",
          "application/javascript": "js",
          "text/javascript": "js",
          "image/png": "png",
          "image/jpeg": "jpg",
          "image/svg+xml": "svg",
        } as Record<string, string>
      )[mime] ?? "bin";
    const path = `f${visited.size}.${extension}`;
    visited.set(url, path);
    let referenceBase = url;
    const reference = async (raw: string) => {
      if (!raw || (raw.startsWith("#") && referenceBase === url)) return raw;
      let target: URL;
      try {
        target = new URL(raw, referenceBase);
      } catch {
        return missing(path, "unsupported");
      }
      const fragment = target.hash;
      target.hash = "";
      if (
        !["file:", "http:", "https:", "data:"].includes(target.protocol) ||
        target.username ||
        target.password
      )
        return missing(path, "outside-scope");
      return (await visit(target.href, depth + 1, path)) + fragment;
    };
    const css = async (text: string) => {
      let tree: postcss.Root;
      try {
        tree = postcss.parse(text);
      } catch {
        throw new Error("Invalid artifact bundle CSS");
      }
      const rewriteValue = async (value: string, importRule = false) => {
        const parsed = valueParser(value);
        const refs: { node: valueParser.Node; url: string }[] = [];
        parsed.walk((node) => {
          if (node.type === "function" && node.value.toLowerCase() === "url") {
            const child = node.nodes.filter(
              (part) => part.type !== "space" && part.type !== "comment",
            );
            if (
              child.length === 1 &&
              (child[0]!.type === "word" || child[0]!.type === "string")
            )
              refs.push({ node: node, url: child[0]!.value });
            return false;
          }
        });
        if (importRule) {
          const first = parsed.nodes.find(
            (node) => node.type !== "space" && node.type !== "comment",
          );
          if (first?.type === "string")
            refs.push({ node: first, url: first.value });
        }
        for (const item of refs) {
          const target = await reference(item.url);
          if (item.node.type === "function")
            item.node.nodes = [
              {
                type: "string",
                quote: '"',
                value: target,
                sourceIndex: 0,
                sourceEndIndex: 0,
              },
            ];
          else if (item.node.type === "string") item.node.value = target;
        }
        return parsed.toString();
      };
      const nodes: postcss.ChildNode[] = [];
      tree.walk((node) => {
        nodes.push(node);
      });
      for (const node of nodes) {
        if (node.type === "decl") node.value = await rewriteValue(node.value);
        if (node.type === "atrule" && node.name.toLowerCase() === "import")
          node.params = await rewriteValue(node.params, true);
      }
      return tree.toString();
    };
    const javascript = async (text: string) => {
      await initModules();
      let imports: ReturnType<typeof parseModules>[0];
      try {
        [imports] = parseModules(text);
      } catch {
        throw new Error("Invalid artifact bundle JavaScript");
      }
      const edits: { start: number; end: number; value: string }[] = [];
      for (const item of imports) {
        options.signal.throwIfAborted();
        if (
          item.type === "import-meta" ||
          item.specifier === undefined ||
          (item.type === "dynamic" && item.glob)
        ) {
          missing(path, "unsupported");
          continue;
        }
        if (item.type !== "dynamic" && item.typeOnly) continue;
        const specifier = item.specifier!;
        const target = /^(\.\.?\/|\/|https?:|file:|data:)/.test(specifier)
          ? await reference(specifier)
          : missing(path, "unsupported");
        const relative = "./" + target;
        edits.push({
          start: item.start,
          end: item.end,
          value: item.type === "dynamic" ? JSON.stringify(relative) : relative,
        });
      }
      for (const edit of edits.sort((a, b) => b.start - a.start))
        text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
      return text;
    };
    let bytes = Buffer.from(source.bytes);
    const isText =
      mime.startsWith("text/") ||
      [
        "application/javascript",
        "application/json",
        "application/xml",
        "image/svg+xml",
      ].includes(mime) ||
      mime.endsWith("+json") ||
      mime.endsWith("+xml");
    if (isText) {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("Artifact bundle text is not valid UTF-8");
      }
      if (mime === "text/html") {
        const tree = parse(text);
        const nodes: DefaultTreeAdapterMap["node"][] = [tree];
        let foundBase = false,
          visitedNodes = 0;
        while (nodes.length) {
          if (++visitedNodes > 100000)
            throw new Error("Artifact bundle HTML exceeds node limit");
          const node = nodes.pop()!;
          if ("tagName" in node && node.tagName === "base" && !foundBase) {
            const href = node.attrs.find((attr) => attr.name === "href");
            if (href) {
              foundBase = true;
              try {
                const base = new URL(href.value, url);
                if (
                  !["file:", "http:", "https:"].includes(base.protocol) ||
                  base.username ||
                  base.password
                )
                  throw new Error();
                referenceBase = base.href;
              } catch {
                missing(path, "unsupported");
              }
            }
          }
          if ("childNodes" in node)
            for (let index = node.childNodes.length - 1; index >= 0; index--)
              nodes.push(node.childNodes[index]!);
        }
        const walk = async (
          node: DefaultTreeAdapterMap["node"],
        ): Promise<void> => {
          if ("tagName" in node) {
            if (node.tagName === "base")
              node.attrs = node.attrs.filter((attr) => attr.name !== "href");
            for (const attr of node.attrs) {
              if (
                [
                  "src",
                  "href",
                  "poster",
                  "data",
                  "action",
                  "formaction",
                ].includes(attr.name)
              )
                attr.value = await reference(attr.value);
              if (attr.name === "srcset" || attr.name === "imagesrcset") {
                let candidates: ReturnType<typeof parseSrcset>;
                try {
                  candidates = parseSrcset(attr.value, { strict: true });
                } catch {
                  candidates = [];
                  attr.value = missing(path, "unsupported");
                }
                if (candidates.length) {
                  const rewritten = [];
                  for (const candidate of candidates)
                    rewritten.push({
                      ...candidate,
                      url: await reference(candidate.url),
                    });
                  attr.value = stringifySrcset(rewritten, { strict: true });
                }
              }
              if (attr.name === "style") attr.value = await css(attr.value);
            }
            if (node.tagName === "style")
              for (const child of node.childNodes)
                if (child.nodeName === "#text")
                  (child as DefaultTreeAdapterMap["textNode"]).value =
                    await css(
                      (child as DefaultTreeAdapterMap["textNode"]).value,
                    );
            if (node.tagName === "script") {
              const type = node.attrs
                .find((attr) => attr.name === "type")
                ?.value.trim()
                .toLowerCase();
              if (type === "importmap") missing(path, "unsupported");
              if (
                type === "module" &&
                !node.attrs.some((attr) => attr.name === "src")
              )
                for (const child of node.childNodes)
                  if (child.nodeName === "#text") {
                    const script = child as DefaultTreeAdapterMap["textNode"];
                    script.value = await javascript(script.value);
                  }
            }
            if (node.tagName === "template" && "content" in node)
              await walk(
                node.content as DefaultTreeAdapterMap["documentFragment"],
              );
          }
          if ("childNodes" in node)
            for (const child of node.childNodes) await walk(child);
        };
        await walk(tree);
        text = serialize(tree);
      } else if (mime === "text/css") text = await css(text);
      else if (["application/javascript", "text/javascript"].includes(mime))
        text = await javascript(text);
      else if (["image/svg+xml", "application/xml"].includes(mime))
        missing(path, "unsupported");
      bytes = Buffer.from(options.filter(text));
    }
    outputBytes += bytes.byteLength;
    if (outputBytes > ARTIFACT_BUNDLE_MAX_CONTENT_BYTES)
      throw new Error("Artifact bundle exceeds rewritten byte limit");
    const digest = hash(bytes);
    blobs[digest] = bytes.toString("base64");
    files.push({
      path,
      mediaType: mime,
      hash: digest,
      byteSize: bytes.byteLength,
    });
    return path;
  };
  const entrypoint = await visit(new URL(options.entrypoint).href, 0, "entry");
  const manifest = artifactBundleManifestSchema.parse({
    format: "agentlive.artifact-bundle",
    version: 1,
    entrypoint,
    files: files.sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
    unavailable,
  });
  const bytes = Buffer.from(
    canonicalJson({
      manifest,
      manifestHash: hash(canonicalJson(manifest)),
      blobs,
    }),
  );
  if (bytes.byteLength > ARTIFACT_BUNDLE_MAX_BYTES)
    throw new Error("Artifact bundle exceeds encoded byte limit");
  await decodeArtifactBundle(bytes);
  return { bytes, manifest };
}
