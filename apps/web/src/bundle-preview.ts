import { ModulePreviewCompiler, scriptDataUrl } from "./module-preview.js";
import { parseSrcset, stringifySrcset } from "srcset";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import postcss from "postcss";
import valueParser from "postcss-value-parser";
import { decodeArtifactBundle } from "@agentlive/protocol";
import { rasterPreview } from "./attachments.js";
export type VerifiedBundle = Awaited<ReturnType<typeof decodeArtifactBundle>>;
const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const allowed = new Set(
  "html head body div span p a h1 h2 h3 h4 h5 h6 main section article aside header footer nav figure figcaption picture source img ul ol li dl dt dd table thead tbody tfoot tr td th caption colgroup col pre code blockquote br hr strong em b i u s small sub sup details summary label button style".split(
    " ",
  ),
);
const omitted = new Set(
  "script noscript iframe frame frameset object embed svg math template meta base input textarea select option".split(
    " ",
  ),
);
/** Produces static markup only. Never attaches untrusted nodes to the host document. */
export function buildBundlePreview(
  bundle: Pick<VerifiedBundle, "manifest" | "files">,
  path = bundle.manifest.entrypoint,
  interactive = false,
) {
  const byPath = new Map(
    bundle.manifest.files.map((file) => [file.path, file]),
  );
  const warnings = new Set<string>();
  let nodes = 0,
    cssBytes = 0,
    imageBytes = 0,
    scriptBytes = 0;
  const imageCache = new Map<string, string>();
  const read = (path: string) => {
    const bytes = bundle.files.get(path);
    if (!bytes || bytes.byteLength > 1024 * 1024)
      throw new Error("Preview text exceeds 1 MiB or is unavailable");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  };
  const resolve = (raw: string, from: string) => {
    try {
      const base = new URL(from, "https://bundle.invalid/");
      const url = new URL(raw, base);
      if (url.origin !== base.origin || url.search) return;
      const path = url.pathname.slice(1);
      return byPath.has(path) ? path : undefined;
    } catch {
      return;
    }
  };
  const accountScript = (code: string) => {
    scriptBytes += new TextEncoder().encode(code).length;
    if (scriptBytes > 2 * 1024 * 1024)
      throw new Error("Interactive scripts exceed 2 MiB.");
  };
  const readScript = (target: string) => {
    if (
      !["text/javascript", "application/javascript"].includes(
        byPath.get(target)?.mediaType ?? "",
      )
    )
      throw new Error("A required script was not captured as JavaScript.");
    return read(target);
  };
  const modules = new ModulePreviewCompiler(resolve, readScript, accountScript);
  const image = (raw: string, from: string) => {
    const target = resolve(raw, from);
    if (!target) {
      warnings.add("Some image references are unavailable.");
      return "";
    }
    const cached = imageCache.get(target);
    if (cached) return cached;
    const bytes = bundle.files.get(target)!;
    const raster = rasterPreview(bytes, byPath.get(target)!.mediaType);
    if (!raster || imageBytes + bytes.byteLength > 8 * 1024 * 1024) {
      warnings.add(
        "Only bounded PNG, JPEG and static WebP images are rendered in this preview.",
      );
      return "";
    }
    imageBytes += bytes.byteLength;
    let binary = "";
    for (let index = 0; index < bytes.length; index += 8192)
      binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
    const data = `data:${raster.mediaType};base64,` + btoa(binary);
    imageCache.set(target, data);
    return data;
  };
  let candidates = 0;
  const responsive = (value: string) => {
    try {
      const parsed = parseSrcset(value, { strict: true });
      candidates += parsed.length;
      if (candidates > 512) throw new Error("Too many responsive images");
      const verified = parsed.flatMap((candidate) => {
        const url = image(candidate.url, path);
        return url ? [{ ...candidate, url }] : [];
      });
      return stringifySrcset(verified, { strict: true });
    } catch {
      warnings.add(
        "Some responsive image candidates are invalid or exceed preview limits.",
      );
      return "";
    }
  };
  const css = (
    text: string,
    from: string,
    parents = new Set<string>(),
  ): string => {
    cssBytes += text.length;
    if (cssBytes > 2 * 1024 * 1024 || parents.size > 8) {
      warnings.add("Some styles exceed preview limits.");
      return "";
    }
    let tree: postcss.Root;
    try {
      tree = postcss.parse(text);
    } catch {
      warnings.add("Some styles could not be displayed.");
      return "";
    }
    const imports: postcss.AtRule[] = [];
    tree.walkAtRules((rule) => {
      if (rule.name.toLowerCase() === "import") imports.push(rule);
      else if (
        ["font-face", "namespace", "charset"].includes(rule.name.toLowerCase())
      )
        rule.remove();
    });
    for (const rule of imports) {
      const parsed = valueParser(rule.params);
      const first = parsed.nodes.find(
        (node) => node.type !== "space" && node.type !== "comment",
      );
      const raw =
        first?.type === "string"
          ? first.value
          : first?.type === "function" && first.value.toLowerCase() === "url"
            ? first.nodes[0]?.value
            : undefined;
      const target = raw ? resolve(raw, from) : undefined;
      const tail = first ? rule.params.slice(first.sourceEndIndex).trim() : "";
      if (
        !target ||
        byPath.get(target)?.mediaType !== "text/css" ||
        parents.has(target) ||
        /\b(layer|supports)\b/i.test(tail)
      ) {
        rule.remove();
        warnings.add("Some stylesheet imports are unavailable or unsupported.");
        continue;
      }
      const rewritten = css(
        read(target),
        target,
        new Set([...parents, target]),
      );
      rule.replaceWith(
        postcss.parse(tail ? `@media ${tail}{${rewritten}}` : rewritten),
      );
    }
    tree.walkDecls((declaration) => {
      if (
        declaration.prop.toLowerCase() === "behavior" ||
        declaration.prop.toLowerCase() === "-moz-binding"
      ) {
        declaration.remove();
        return;
      }
      const parsed = valueParser(declaration.value);
      parsed.walk((node) => {
        if (node.type !== "function" || node.value.toLowerCase() !== "url")
          return;
        const raw = node.nodes[0]?.value ?? "";
        const data = [...imageCache.values()].includes(raw)
          ? raw
          : image(raw, from);
        node.nodes = [
          {
            type: "string",
            quote: '"',
            value: data,
            sourceIndex: 0,
            sourceEndIndex: 0,
          },
        ];
        return false;
      });
      declaration.value = parsed.toString();
    });
    return tree.toString().replaceAll("<", "\\3c ");
  };
  if (byPath.get(path)?.mediaType !== "text/html")
    throw new Error("Static preview requires an HTML file");
  const tree = parse(read(path));
  const render = (node: DefaultTreeAdapterMap["node"], depth = 0): string => {
    if (++nodes > 20000 || depth > 128)
      throw new Error("HTML exceeds static preview limits");
    if (node.nodeName === "#text")
      return escape((node as DefaultTreeAdapterMap["textNode"]).value);
    if (!("tagName" in node))
      return "childNodes" in node
        ? node.childNodes.map((child) => render(child, depth + 1)).join("")
        : "";
    const tag = node.tagName;
    const controls =
      interactive &&
      ["input", "textarea", "select", "option", "canvas", "form"].includes(tag);
    if (interactive && tag === "script") {
      const type =
        node.attrs.find((attr) => attr.name === "type")?.value.toLowerCase() ??
        "";
      if (
        !["", "text/javascript", "application/javascript", "module"].includes(
          type,
        )
      ) {
        if (type === "importmap")
          throw new Error(
            "Source import maps are not yet supported in interactive previews.",
          );
        return "";
      }
      const source = node.attrs.find((attr) => attr.name === "src")?.value;
      let code: string;
      let scriptPath: string | undefined;
      if (source) {
        const target = resolve(source, path);
        if (
          !target ||
          !["text/javascript", "application/javascript"].includes(
            byPath.get(target)?.mediaType ?? "",
          )
        )
          throw new Error("A required script was not captured as JavaScript.");
        scriptPath = target;
        code = readScript(target);
      } else
        code = node.childNodes
          .filter((child) => child.nodeName === "#text")
          .map((child) => (child as DefaultTreeAdapterMap["textNode"]).value)
          .join("");
      if (type === "module") {
        const name = modules.add(code, scriptPath ?? path, scriptPath);
        const async = node.attrs.some((attr) => attr.name === "async")
          ? " async"
          : "";
        return `<script type="module"${async}>import ${JSON.stringify(name)};</script>`;
      }
      accountScript(code);
      const execution = source
        ? node.attrs
            .filter((attr) =>
              ["defer", "async", "nomodule"].includes(attr.name),
            )
            .map((attr) => ` ${attr.name}`)
            .join("")
        : "";
      return `<script${execution} src="${scriptDataUrl(code)}"></script>`;
    }
    if (omitted.has(tag) && !controls) return "";
    if (
      tag === "source" &&
      (!("tagName" in (node.parentNode ?? {})) ||
        (node.parentNode as DefaultTreeAdapterMap["element"]).tagName !==
          "picture")
    )
      return "";
    if (tag === "link") {
      if (
        !node.attrs.some(
          (attr) =>
            attr.name === "rel" &&
            attr.value.toLowerCase().split(/\s+/).includes("stylesheet"),
        )
      )
        return "";
      const target = resolve(
        node.attrs.find((attr) => attr.name === "href")?.value ?? "",
        path,
      );
      if (!target || byPath.get(target)?.mediaType !== "text/css") {
        warnings.add("A stylesheet is unavailable.");
        return "";
      }
      return `<style>${css(read(target), target, new Set([target]))}</style>`;
    }
    if (tag === "style")
      return `<style>${css(
        node.childNodes
          .filter((child) => child.nodeName === "#text")
          .map((child) => (child as DefaultTreeAdapterMap["textNode"]).value)
          .join(""),
        path,
      )}</style>`;
    const children = node.childNodes
      .map((child) => render(child, depth + 1))
      .join("");
    if (!allowed.has(tag) && !controls) return children;
    const attrs: string[] = [];
    for (const attr of node.attrs) {
      if (attr.namespace || (!interactive && attr.name.startsWith("on")))
        continue;
      let value = attr.value;
      if (
        interactive &&
        (attr.name.startsWith("on") ||
          /^data-[a-z0-9_-]+$/.test(attr.name) ||
          [
            "type",
            "value",
            "name",
            "checked",
            "selected",
            "disabled",
            "placeholder",
            "min",
            "max",
            "step",
            "multiple",
            "rows",
            "cols",
            "for",
            "tabindex",
          ].includes(attr.name))
      ) {
        // Navigation-bearing attributes remain excluded; forms cannot submit.
      } else if (tag === "img" && attr.name === "src")
        value = image(value, path);
      else if ((tag === "img" || tag === "source") && attr.name === "srcset")
        value = responsive(value);
      else if ((tag === "img" || tag === "source") && attr.name === "sizes") {
        /* CSS length descriptors contain no fetchable URL. */
      } else if (tag === "source" && attr.name === "media") {
        /* Media query only. */
      } else if (tag === "source" && attr.name === "type") {
        if (
          !["image/png", "image/jpeg", "image/webp"].includes(
            value.toLowerCase(),
          )
        )
          continue;
      } else if (attr.name === "style") value = css(value, path);
      else if (
        attr.name === "href" &&
        tag === "a" &&
        /^#[A-Za-z0-9_-]+$/.test(value)
      ) {
        /* same-document anchors */
      } else if (
        ![
          "class",
          "id",
          "title",
          "lang",
          "dir",
          "width",
          "height",
          "colspan",
          "rowspan",
          "alt",
          "role",
        ].includes(attr.name) &&
        !/^aria-[a-z-]+$/.test(attr.name)
      )
        continue;
      attrs.push(`${attr.name}="${escape(value)}"`);
    }
    if (tag === "button" && !interactive) attrs.push("disabled");
    return `<${tag}${attrs.length ? " " + attrs.join(" ") : ""}>${children}${["img", "source", "br", "hr", "col", "input"].includes(tag) ? "" : `</${tag}>`}`;
  };
  let html = render(tree);
  const csp =
    (interactive
      ? "script-src 'unsafe-inline' data:; "
      : "script-src 'none'; ") +
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  html =
    "<!doctype html>" +
    html.replace(
      /<head(?: [^>]*)?>/,
      `<head><meta http-equiv="Content-Security-Policy" content="${escape(csp)}"><meta name="referrer" content="no-referrer">${modules.importMap()}`,
    );
  if (html.length > 12 * 1024 * 1024)
    throw new Error("Static preview exceeds output limit");
  return { html, warnings: [...warnings] };
}

/** The caller has already verified the outer attachment bytes. External dependencies are not fetched. */
export function buildHtmlAttachmentPreview(
  bytes: Uint8Array,
  hash: string,
  interactive = false,
) {
  const path = "attachment.html";
  const bundle: Pick<VerifiedBundle, "manifest" | "files"> = {
    manifest: {
      format: "agentlive.artifact-bundle",
      version: 1,
      entrypoint: path,
      files: [{ path, mediaType: "text/html", byteSize: bytes.length, hash }],
      unavailable: [],
    },
    files: new Map([[path, bytes]]),
  };
  return buildBundlePreview(bundle, path, interactive);
}
