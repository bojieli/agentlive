import {
  ARTIFACT_BUNDLE_MEDIA_TYPE,
  decodeArtifactBundle,
} from "@agentlive/protocol";
import {
  BundleViewer,
  StaticPreview,
  InteractivePreview,
} from "./bundle-viewer.js";
import {
  buildHtmlAttachmentPreview,
  type VerifiedBundle,
} from "./bundle-preview.js";
import { useEffect, useRef, useState } from "react";
import {
  loadAttachment,
  rasterPreview,
  textPreview,
  type Attachment,
} from "./attachments.js";
export function AttachmentViewer({
  attachment,
  streamId,
  credential,
  onClose,
}: {
  attachment: Attachment;
  streamId: string;
  credential: string;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<{
    download: string;
    bundle?: VerifiedBundle;
    html?: ReturnType<typeof buildHtmlAttachmentPreview>;
    previewError?: string;
    interactiveSource?: Uint8Array;
    image?: string;
    text?: string;
  }>();
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  useEffect(() => {
    const stop = new AbortController(),
      urls: string[] = [];
    setLoaded(undefined);
    setError("");
    void loadAttachment(attachment, streamId, credential, stop.signal)
      .then(async (bytes) => {
        const bundle =
          attachment.mediaType === ARTIFACT_BUNDLE_MEDIA_TYPE
            ? await decodeArtifactBundle(bytes)
            : undefined;
        if (stop.signal.aborted) return;
        const download = URL.createObjectURL(
          new Blob([bytes], { type: "application/octet-stream" }),
        );
        urls.push(download);
        let html: ReturnType<typeof buildHtmlAttachmentPreview> | undefined;
        let previewError: string | undefined;
        if (
          attachment.mediaType.split(";", 1)[0]!.trim().toLowerCase() ===
          "text/html"
        ) {
          try {
            html = buildHtmlAttachmentPreview(bytes, attachment.hash);
          } catch {
            previewError =
              "This HTML file exceeds the supported static preview limits. You can download the verified original.";
          }
        }
        const raster = rasterPreview(bytes, attachment.mediaType);
        const image = raster
          ? URL.createObjectURL(new Blob([bytes], { type: raster.mediaType }))
          : undefined;
        if (image) urls.push(image);
        const text = image
          ? undefined
          : textPreview(bytes, attachment.mediaType);
        setLoaded({
          download,
          ...(bundle ? { bundle } : {}),
          ...(html ? { html, interactiveSource: new Uint8Array(bytes) } : {}),
          ...(previewError ? { previewError } : {}),
          ...(image ? { image } : {}),
          ...(text === undefined ? {} : { text }),
        });
      })
      .catch((error: unknown) => {
        if (!stop.signal.aborted)
          setError(
            error instanceof Error
              ? error.message
              : "Attachment loading failed",
          );
      });
    return () => {
      stop.abort();
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [attachment, streamId, credential]);
  return (
    <dialog
      ref={dialog}
      onCancel={onClose}
      className="attachment-viewer"
      aria-label="Attachment inspector"
    >
      <div className="session-heading">
        <div>
          <h3>{attachment.filename}</h3>
          <small>
            Version {attachment.version} ·{" "}
            {attachment.byteSize.toLocaleString()} bytes
          </small>
        </div>
        <button onClick={onClose}>Close attachment</button>
      </div>
      {error ? (
        <p role="alert">{error}</p>
      ) : !loaded ? (
        <p role="status">Loading and verifying attachment…</p>
      ) : (
        <>
          <a href={loaded.download} download={attachment.filename}>
            Download verified file
          </a>
          {loaded.html ? (
            <section
              className="bundle-viewer"
              aria-label="HTML attachment preview"
            >
              <p>
                Static preview. Scripts and forms are disabled. Separate
                dependencies are not included in this file.
              </p>
              {loaded.html.warnings.length > 0 && (
                <ul>
                  {loaded.html.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}
              <StaticPreview html={loaded.html.html} path="attachment.html" />
              <InteractivePreview
                key={attachment.hash}
                path="attachment.html"
                build={() =>
                  buildHtmlAttachmentPreview(
                    loaded.interactiveSource!,
                    attachment.hash,
                    true,
                  )
                }
              />
              {loaded.text !== undefined && (
                <details>
                  <summary>Captured source</summary>
                  <pre>{loaded.text}</pre>
                </details>
              )}
            </section>
          ) : loaded.previewError ? (
            <p>{loaded.previewError}</p>
          ) : loaded.bundle ? (
            <BundleViewer key={attachment.hash} bundle={loaded.bundle} />
          ) : loaded.image ? (
            <img
              src={loaded.image}
              alt={attachment.filename}
              onError={() =>
                setLoaded((current) =>
                  current ? { download: current.download } : undefined,
                )
              }
            />
          ) : loaded.text !== undefined ? (
            <pre>{loaded.text}</pre>
          ) : (
            <p className="muted">
              Preview is unavailable for this file. You can download the
              original.
            </p>
          )}
        </>
      )}
    </dialog>
  );
}
