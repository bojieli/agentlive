import { expect, it } from "vitest";
import { captureArtifactBundle } from "../packages/adapters/src/artifact-bundle.js";
import {
  artifactBundleHash,
  canonicalJson,
  decodeArtifactBundle,
} from "../packages/protocol/src/index.js";

it("captures cyclic HTML/CSS dependency graphs with relative references, filtered leaves and explicit omissions", async () => {
  const sources = new Map([
    [
      "https://native.example/index.html",
      {
        mediaType: "text/html",
        bytes: Buffer.from(
          '<link rel="stylesheet" href="styles/main.css"><a href="next.html#target">secret</a><img src="image.png"><img src="https://elsewhere.example/private?token=secret">',
        ),
      },
    ],
    [
      "https://native.example/next.html",
      {
        mediaType: "text/html",
        bytes: Buffer.from('<a href="index.html">back</a>'),
      },
    ],
    [
      "https://native.example/styles/main.css",
      {
        mediaType: "text/css",
        bytes: Buffer.from(
          '@import "other.css"; body{background:url(../image.png)}',
        ),
      },
    ],
    [
      "https://native.example/styles/other.css",
      {
        mediaType: "text/css",
        bytes: Buffer.from('@import "main.css"; /* secret */'),
      },
    ],
    [
      "https://native.example/image.png",
      { mediaType: "image/png", bytes: Buffer.from([137, 80, 78, 71]) },
    ],
  ]);
  const reads: string[] = [];
  const run = () =>
    captureArtifactBundle({
      entrypoint: "https://native.example/index.html",
      signal: AbortSignal.timeout(5000),
      filter: (text) => text.replaceAll("secret", "[redacted]"),
      load: async (url) => {
        reads.push(url);
        return sources.get(url) ?? { unavailable: "outside-scope" };
      },
    });
  const captured = await run();
  const bundle = await decodeArtifactBundle(captured.bytes);
  expect(bundle.manifest.files).toHaveLength(5);
  expect(bundle.manifest.unavailable).toHaveLength(1);
  expect(reads.filter((url) => sources.has(url))).toHaveLength(5);
  const html = Buffer.from(
    bundle.files.get(bundle.manifest.entrypoint)!,
  ).toString();
  expect(html).toContain("[redacted]");
  const linkedPage = bundle.manifest.files.find(
    (file) =>
      file.mediaType === "text/html" &&
      file.path !== bundle.manifest.entrypoint,
  )!;
  expect(html).toContain(`href="${linkedPage.path}#target"`);
  expect(html).not.toContain("native.example");
  expect(html).not.toContain("elsewhere.example");
  for (const file of bundle.manifest.files) {
    const text = Buffer.from(bundle.files.get(file.path)!).toString();
    expect(text).not.toContain("secret");
    if (file.mediaType === "text/css")
      expect(text).not.toContain("../image.png");
  }
  expect((await run()).bytes).toEqual(captured.bytes);
  expect(
    sources.get("https://native.example/index.html")!.bytes.toString(),
  ).toContain("secret");
});

it("rejects corrupt, duplicate, escaping, oversized and unreferenced bundle data before exposing files", async () => {
  const original = await captureArtifactBundle({
    entrypoint: "file:///root/index.html",
    signal: AbortSignal.timeout(5000),
    filter: (text) => text,
    load: async () => ({ mediaType: "text/html", bytes: Buffer.from("hello") }),
  });
  const encode = async (mutate: (input: any) => void) => {
    const input = JSON.parse(original.bytes.toString());
    mutate(input);
    input.manifestHash = await artifactBundleHash(
      new TextEncoder().encode(canonicalJson(input.manifest)),
    );
    return Buffer.from(canonicalJson(input));
  };
  for (const path of [
    "../escape",
    "/absolute",
    "a/%2e%2e/b",
    "C:/file",
    "a\\b",
    "a//b",
  ]) {
    await expect(
      decodeArtifactBundle(
        await encode((input) => {
          input.manifest.files[0].path = path;
        }),
      ),
    ).rejects.toThrow();
  }
  await expect(
    decodeArtifactBundle(
      await encode((input) => {
        input.manifest.files.push(input.manifest.files[0]);
      }),
    ),
  ).rejects.toThrow("Duplicate");
  await expect(
    decodeArtifactBundle(
      await encode((input) => {
        input.manifest.files[0].byteSize++;
      }),
    ),
  ).rejects.toThrow();
  await expect(
    decodeArtifactBundle(
      await encode((input) => {
        input.blobs["a".repeat(64)] = "";
      }),
    ),
  ).rejects.toThrow("unreferenced");
  await expect(
    decodeArtifactBundle(
      await encode((input) => {
        input.blobs[input.manifest.files[0].hash] = "A".repeat(
          input.blobs[input.manifest.files[0].hash].length,
        );
      }),
    ),
  ).rejects.toThrow();
  const badManifest = JSON.parse(original.bytes.toString());
  badManifest.manifest.entrypoint = "different.html";
  await expect(
    decodeArtifactBundle(Buffer.from(JSON.stringify(badManifest))),
  ).rejects.toThrow("manifest hash");
  await expect(
    decodeArtifactBundle(new Uint8Array(24 * 1024 * 1024 + 1)),
  ).rejects.toThrow("encoded limit");
});

it("bounds recursive capture and cancels outstanding source work", async () => {
  const bundle = await captureArtifactBundle({
    entrypoint: "https://native.example/0",
    filter: (text) => text,
    signal: AbortSignal.timeout(5000),
    load: async (url) => ({
      mediaType: "text/html",
      bytes: Buffer.from(
        `<a href="${Number(new URL(url).pathname.slice(1)) + 1}">next</a>`,
      ),
    }),
  });
  expect(bundle.manifest.files).toHaveLength(9);
  expect(bundle.manifest.unavailable.map((item) => item.reason)).toEqual([
    "depth-limit",
  ]);
  const abort = new AbortController();
  await expect(
    captureArtifactBundle({
      entrypoint: "https://native.example/0",
      filter: (text) => text,
      signal: abort.signal,
      load: async () => {
        abort.abort();
        return { mediaType: "text/html", bytes: Buffer.from("stop") };
      },
    }),
  ).rejects.toThrow();
});

it("captures allowed local files without following symlink escapes or changing source bytes", async () => {
  const { mkdtemp, mkdir, writeFile, readFile, symlink, rm } =
    await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { pathToFileURL } = await import("node:url");
  const { createBundleLoader } =
    await import("../packages/adapters/src/bundle-loader.js");
  const root = await mkdtemp(join(tmpdir(), "agentlive-bundle-"));
  try {
    const allowed = join(root, "allowed");
    await mkdir(allowed);
    const entry = join(allowed, "index.html");
    const html =
      '<img src="image.png"><a href="escape.txt">outside</a><a href="missing.txt">missing</a>';
    await writeFile(entry, html);
    await writeFile(join(allowed, "image.png"), Buffer.from([1, 2, 3]));
    await writeFile(join(root, "private.txt"), "must not capture");
    await symlink(join(root, "private.txt"), join(allowed, "escape.txt"));
    const load = await createBundleLoader({ roots: [allowed] });
    const result = await captureArtifactBundle({
      entrypoint: pathToFileURL(entry).href,
      load,
      signal: AbortSignal.timeout(5000),
      filter: (text) => text,
    });
    expect(result.manifest.files).toHaveLength(2);
    expect(
      result.manifest.unavailable.map((item) => item.reason).sort(),
    ).toEqual(["missing", "outside-scope"]);
    const bundle = await decodeArtifactBundle(result.bytes);
    expect(
      [...bundle.files.values()].some((bytes) =>
        Buffer.from(bytes).toString().includes("must not capture"),
      ),
    ).toBe(false);
    expect(await readFile(entry, "utf8")).toBe(html);
    expect(
      await load("https://unlisted.example/private", AbortSignal.timeout(5000)),
    ).toEqual({ unavailable: "outside-scope" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rewrites base URLs, responsive images and cyclic module graphs without executing scripts", async () => {
  const sources = new Map([
    [
      "https://native.example/page.html",
      {
        mediaType: "text/html",
        bytes: Buffer.from(
          '<base href="/assets/"><base href="https://ignored.example/"><picture><source srcset="small.png 400w, large.png 800w"></picture><img srcset="small.png 1x, large.png 2x"><script type="module">import {x} from "./main.js"; globalThis.bundleMustNeverRun = x;</script>',
        ),
      },
    ],
    [
      "https://native.example/assets/small.png",
      { mediaType: "image/png", bytes: Buffer.from([1]) },
    ],
    [
      "https://native.example/assets/large.png",
      { mediaType: "image/png", bytes: Buffer.from([2]) },
    ],
    [
      "https://native.example/assets/main.js",
      {
        mediaType: "application/javascript",
        bytes: Buffer.from(
          'import {helper} from "./helper.js"; export const x = helper; export * from "./other.js"; import("./lazy.js"); import(`./${name}.js`);',
        ),
      },
    ],
    [
      "https://native.example/assets/helper.js",
      {
        mediaType: "application/javascript",
        bytes: Buffer.from(
          'import {x} from "./main.js"; export const helper = 1;',
        ),
      },
    ],
    [
      "https://native.example/assets/other.js",
      {
        mediaType: "application/javascript",
        bytes: Buffer.from("export const other = 2;"),
      },
    ],
    [
      "https://native.example/assets/lazy.js",
      {
        mediaType: "application/javascript",
        bytes: Buffer.from("export default 3;"),
      },
    ],
  ]);
  const loaded: string[] = [];
  const result = await captureArtifactBundle({
    entrypoint: "https://native.example/page.html",
    filter: (text) => text,
    signal: AbortSignal.timeout(5000),
    load: async (url) => {
      loaded.push(url);
      return sources.get(url) ?? { unavailable: "missing" };
    },
  });
  expect(loaded).toHaveLength(7);
  expect(
    loaded.every(
      (url) => !url.includes("ignored.example") && !url.includes("*"),
    ),
  ).toBe(true);
  const bundle = await decodeArtifactBundle(result.bytes);
  expect(bundle.manifest.files).toHaveLength(7);
  expect(bundle.manifest.unavailable.map((item) => item.reason)).toEqual([
    "unsupported",
  ]);
  const html = Buffer.from(
    bundle.files.get(bundle.manifest.entrypoint)!,
  ).toString();
  expect(html).toContain("<base>");
  expect(html).not.toContain("<base href=");
  expect(html).toMatch(/srcset="f\d+\.png 400w, f\d+\.png 800w"/);
  expect(html).toMatch(/srcset="f\d+\.png 1x, f\d+\.png 2x"/);
  expect(html).toMatch(/from "\.\/f\d+\.js"/);
  const main = [...bundle.files.values()]
    .map((bytes) => Buffer.from(bytes).toString())
    .find((text) => text.includes("export const x"))!;
  expect(main).not.toContain("./helper.js");
  expect(main).not.toContain("./lazy.js");
  expect(main).toMatch(/import\("\.\/f\d+\.js"\)/);
  expect(main).toContain("import(`./${name}.js`)");
  expect(
    (globalThis as { bundleMustNeverRun?: unknown }).bundleMustNeverRun,
  ).toBeUndefined();
});

it("records unresolved module names and invalid srcset without fetching invented targets", async () => {
  const loaded: string[] = [];
  const result = await captureArtifactBundle({
    entrypoint: "https://native.example/index.html",
    filter: (text) => text,
    signal: AbortSignal.timeout(5000),
    load: async (url) => {
      loaded.push(url);
      return {
        mediaType: "text/html",
        bytes: Buffer.from(
          '<img srcset="a.png 1q"><script type="module">import x from "bare-package"; import(foo);</script>',
        ),
      };
    },
  });
  expect(loaded).toHaveLength(1);
  expect(result.manifest.unavailable.map((item) => item.reason)).toEqual([
    "unsupported",
    "unsupported",
    "unsupported",
  ]);
});

it("removes source base hrefs while preserving same-document fragment links", async () => {
  let reads = 0;
  const result = await captureArtifactBundle({
    entrypoint: "https://native.example/index.html",
    filter: (text) => text,
    signal: AbortSignal.timeout(5000),
    load: async () => {
      reads++;
      return {
        mediaType: "text/html",
        bytes: Buffer.from(
          '<base href="index.html"><a href="#target">jump</a><p id="target">target</p>',
        ),
      };
    },
  });
  expect(reads).toBe(1);
  expect(result.manifest.unavailable).toEqual([]);
  const bundle = await decodeArtifactBundle(result.bytes);
  const html = Buffer.from(
    bundle.files.get(bundle.manifest.entrypoint)!,
  ).toString();
  expect(html).toContain('href="#target"');
  expect(html).not.toContain("<base href=");
});
