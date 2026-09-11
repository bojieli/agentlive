import { useEffect, useMemo, useRef, useState } from "react";
import { buildBundlePreview, type VerifiedBundle } from "./bundle-preview.js";
import { rasterPreview, textPreview } from "./attachments.js";
export function StaticPreview({ html, path }: { html: string; path: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const send = () =>
    frame.current?.contentWindow?.postMessage(
      { type: "agentlive-static-preview", html },
      "*",
    );
  useEffect(send, [html]);
  return (
    <iframe
      ref={frame}
      title={`Static preview of ${path}`}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      src="/artifact-preview"
      onLoad={send}
    />
  );
}
export function InteractivePreview({
  path,
  build,
}: {
  path: string;
  build: () => { html: string; warnings: string[] };
}) {
  const [preview, setPreview] = useState<{
    html: string;
    warnings: string[];
  }>();
  const [error, setError] = useState("");
  const frame = useRef<HTMLIFrameElement>(null);
  const send = () =>
    frame.current?.contentWindow?.postMessage(
      { type: "agentlive-interactive-preview", html: preview?.html },
      "*",
    );
  return (
    <section aria-label="Interactive HTML preview">
      {preview ? (
        <>
          <p>
            Interactive preview. Network access, navigation and form submission
            are blocked.
          </p>
          <button onClick={() => setPreview(undefined)}>
            Stop interactive preview
          </button>
          {preview.warnings.length > 0 && (
            <ul>
              {preview.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          <iframe
            ref={frame}
            title={`Interactive preview of ${path}`}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            src="/artifact-interactive"
            onLoad={send}
          />
        </>
      ) : (
        <button
          onClick={() => {
            setError("");
            try {
              setPreview(build());
            } catch (error) {
              setError(
                error instanceof Error
                  ? error.message
                  : "Interactive preview is unavailable.",
              );
            }
          }}
        >
          Run interactive preview
        </button>
      )}
      {error && (
        <p role="status">
          {error} The static preview and download remain available.
        </p>
      )}
    </section>
  );
}
export function BundleViewer({ bundle }: { bundle: VerifiedBundle }) {
  const [path, setPath] = useState(bundle.manifest.entrypoint);
  const [urls, setUrls] = useState<{ download: string; image?: string }>();
  const file = bundle.manifest.files.find((file) => file.path === path)!;
  const bytes = bundle.files.get(path)!;
  useEffect(() => {
    const download = URL.createObjectURL(
      new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }),
    );
    const raster = rasterPreview(bytes, file.mediaType);
    const image = raster
      ? URL.createObjectURL(
          new Blob([new Uint8Array(bytes)], { type: raster.mediaType }),
        )
      : undefined;
    setUrls({ download, ...(image ? { image } : {}) });
    return () => {
      URL.revokeObjectURL(download);
      if (image) URL.revokeObjectURL(image);
    };
  }, [bytes, file.mediaType]);
  const preview = useMemo(() => {
    if (file.mediaType !== "text/html") return undefined;
    try {
      return buildBundlePreview(bundle, path);
    } catch {
      return {
        error: "This HTML file exceeds the supported static preview limits.",
      };
    }
  }, [bundle, path, file.mediaType]);
  const text = useMemo(
    () => textPreview(new Uint8Array(bytes), file.mediaType),
    [bytes, file.mediaType],
  );
  return (
    <section aria-label="Bundle contents" className="bundle-viewer">
      <p>
        {bundle.manifest.files.length} verified files ·{" "}
        {bundle.manifest.unavailable.length} unavailable references
      </p>
      <label>
        Captured file{" "}
        <select value={path} onChange={(event) => setPath(event.target.value)}>
          {bundle.manifest.files.map((file) => (
            <option key={file.path} value={file.path}>
              {file.path}
              {file.path === bundle.manifest.entrypoint ? " (entrypoint)" : ""}
            </option>
          ))}
        </select>
      </label>
      <p>
        {file.mediaType} · {file.byteSize.toLocaleString()} bytes{" "}
        {urls && (
          <a href={urls.download} download={file.path.split("/").at(-1)}>
            Download selected file
          </a>
        )}
      </p>
      {preview && "html" in preview ? (
        <>
          <p>Static preview. Scripts and forms are disabled.</p>
          {preview.warnings.length > 0 && (
            <ul>
              {preview.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          <StaticPreview html={preview.html} path={path} />
          <InteractivePreview
            key={path}
            path={path}
            build={() => buildBundlePreview(bundle, path, true)}
          />
        </>
      ) : preview && "error" in preview ? (
        <p>{preview.error}</p>
      ) : urls?.image ? (
        <img src={urls.image} alt={path} />
      ) : null}
      {text !== undefined && (
        <details>
          <summary>Captured source</summary>
          <pre>{text}</pre>
        </details>
      )}
      {bundle.manifest.unavailable.length > 0 && (
        <details>
          <summary>
            Unavailable references ({bundle.manifest.unavailable.length})
          </summary>
          <ul>
            {bundle.manifest.unavailable.map((item, index) => (
              <li key={index}>
                {item.from} → {item.target}: {item.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
