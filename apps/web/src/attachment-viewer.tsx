import { useEffect, useRef, useState } from "react";
import {
  loadAttachment,
  pngPreviewSize,
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
      .then((bytes) => {
        if (stop.signal.aborted) return;
        const download = URL.createObjectURL(
          new Blob([bytes], { type: "application/octet-stream" }),
        );
        urls.push(download);
        const image = pngPreviewSize(bytes)
          ? URL.createObjectURL(new Blob([bytes], { type: "image/png" }))
          : undefined;
        if (image) urls.push(image);
        const text = image
          ? undefined
          : textPreview(bytes, attachment.mediaType);
        setLoaded({
          download,
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
          {loaded.image ? (
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
