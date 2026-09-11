import { expect, it } from "vitest";
import {
  buildBundlePreview,
  buildHtmlAttachmentPreview,
  type VerifiedBundle,
} from "../apps/web/src/bundle-preview.js";
function bundle(html: string): VerifiedBundle {
  const bytes = new TextEncoder().encode(html);
  return {
    manifestHash: "a".repeat(64),
    manifest: {
      format: "agentlive.artifact-bundle",
      version: 1,
      entrypoint: "index.html",
      files: [
        {
          path: "index.html",
          hash: "b".repeat(64),
          byteSize: bytes.length,
          mediaType: "text/html",
        },
      ],
      unavailable: [],
    },
    files: new Map([["index.html", bytes]]),
  };
}
it("renders a static allowlist with CSP before artifact styles and no active markup", () => {
  const result = buildBundlePreview(
    bundle(
      '<html><head class="x"><style>body{color:red}</style></head><body><script>alert(1)</script><a href="javascript:alert(1)" onclick="alert(1)">link</a><iframe src="https://evil.example"></iframe><svg><script>alert(1)</script></svg><form action="/api"><input><button formaction="/api">send</button></form><p style="background:url(https://evil.example/image)">text</p></body></html>',
    ),
  );
  expect(result.html).toContain("script-src 'none'");
  expect(result.html.indexOf("Content-Security-Policy")).toBeLessThan(
    result.html.indexOf("<style>"),
  );
  for (const forbidden of [
    "<script",
    "<iframe",
    "<svg",
    "<form",
    "<input",
    "onclick",
    "javascript:",
    "evil.example",
    "formaction",
  ])
    expect(result.html).not.toContain(forbidden);
  expect(result.html).toContain("<button disabled>");
  expect(result.html).toContain("<a>link</a>");
});
it("bounds source and nesting before rendering a preview", () => {
  expect(() => buildBundlePreview(bundle("x".repeat(1024 * 1024 + 1)))).toThrow(
    "1 MiB",
  );
  expect(() =>
    buildBundlePreview(
      bundle("<div>".repeat(150) + "nested" + "</div>".repeat(150)),
    ),
  ).toThrow("limits");
});

it("renders only verified PNG srcset candidates with descriptors and bounds candidate count", () => {
  const png = Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDFkAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const input = bundle(
    '<picture><source media="(min-width: 10px)" srcset="image.png 1x, https://evil.example/image 2x"><img sizes="100vw" srcset="image.png 200w"></picture><video><source src="https://evil.example/video"></video><img srcset="image.png 1q">',
  );
  input.manifest.files.push({
    path: "image.png",
    mediaType: "image/png",
    hash: "c".repeat(64),
    byteSize: png.length,
  });
  input.files.set("image.png", png);
  const result = buildBundlePreview(input);
  expect(result.html).toContain(
    '<source media="(min-width: 10px)" srcset="data:image/png;base64,',
  );
  expect(result.html).toContain(' 1x"');
  expect(result.html).toContain(' 200w"');
  expect(result.html).not.toContain("evil.example");
  expect(result.html).not.toContain("<video");
  expect(result.warnings).toContain(
    "Some responsive image candidates are invalid or exceed preview limits.",
  );
  const huge = bundle(
    `<img srcset="${Array.from({ length: 513 }, (_, index) => `image.png ${index + 1}w`).join(", ")}">`,
  );
  huge.manifest.files.push(input.manifest.files[1]!);
  huge.files.set("image.png", png);
  const limited = buildBundlePreview(huge);
  expect(limited.html).not.toContain("data:image/png");
  expect(limited.warnings).toContain(
    "Some responsive image candidates are invalid or exceed preview limits.",
  );
});

it("previews verified standalone HTML without fetching separate dependencies", () => {
  const bytes = new TextEncoder().encode(
    '<style>h1{color:blue}</style><h1>Standalone</h1><script>alert(1)</script><link rel="stylesheet" href="secret.css"><img src="https://private.example/image">',
  );
  const preview = buildHtmlAttachmentPreview(bytes, "a".repeat(64));
  expect(preview.html).toContain("<h1>Standalone</h1>");
  expect(preview.html).toContain("h1{color:blue}");
  expect(preview.html).not.toContain("<script");
  expect(preview.html).not.toContain("private.example");
  expect(preview.warnings).toContain("A stylesheet is unavailable.");
  expect(() =>
    buildHtmlAttachmentPreview(new Uint8Array(1024 * 1024 + 1), "a".repeat(64)),
  ).toThrow("1 MiB");
});

it("compiles explicit classic-script previews while retaining restrictive resources and forms", () => {
  const source = bundle(
    '<button id="count" onclick="this.textContent=1">0</button><form action="/api" target="_top"><input name="x"><button formaction="https://evil.invalid">Send</button></form><script>document.querySelector("#count").dataset.ready="yes";</script><iframe src="/api"></iframe>',
  );
  const active = buildBundlePreview(source, "index.html", true);
  expect(active.html).toContain("script-src 'unsafe-inline' data:");
  expect(active.html).toContain("connect-src 'none'");
  expect(active.html).toContain("form-action 'none'");
  expect(active.html).toContain('onclick="this.textContent=1"');
  expect(active.html).toContain('<input name="x">');
  expect(active.html).toContain('src="data:text/javascript;base64,');
  expect(active.html).not.toContain("/api");
  expect(active.html).not.toContain("evil.invalid");
  expect(active.html).not.toContain("<iframe");
  expect(buildBundlePreview(source).html).not.toContain("<script");
});

it("requires captured scripts and rejects unsupported source import maps", () => {
  expect(() =>
    buildBundlePreview(
      bundle('<script src="missing.js"></script>'),
      "index.html",
      true,
    ),
  ).toThrow("not captured");
  expect(() =>
    buildBundlePreview(
      bundle('<script type="importmap">{"imports":{}}</script>'),
      "index.html",
      true,
    ),
  ).toThrow("import maps");
  const source = bundle('<script src="main.js"></script>');
  const bytes = new TextEncoder().encode('globalThis.loaded = "captured";');
  source.manifest.files.push({
    path: "main.js",
    mediaType: "text/javascript",
    hash: "c".repeat(64),
    byteSize: bytes.length,
  });
  source.files.set("main.js", bytes);
  expect(buildBundlePreview(source, "index.html", true).html).toContain(
    Buffer.from(bytes).toString("base64"),
  );
});
