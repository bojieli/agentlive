# Authenticated remote artifacts

Codex, Claude, Kimi and OpenCode import and publishing can capture HTTP(S) attachments from explicitly configured origins. Create an artifact policy JSON file:

```json
{
  "origins": [
    {
      "origin": "https://files.example.com",
      "authorizationEnv": "ARTIFACT_AUTHORIZATION"
    }
  ],
  "maxBytes": 25165824,
  "timeoutMs": 15000
}
```

Set `ARTIFACT_AUTHORIZATION` in the publisher environment to the complete authorization header value, such as `Bearer <token>`. Omit `authorizationEnv` for an origin that needs no credential. The policy file accepts environment names rather than literal credentials.

```sh
agentlive publish --agent opencode \
  --native-server http://127.0.0.1:4096 --native-session ses_example \
  --remote-artifact-policy ./artifact-policy.json
```

For a historical export, use the same policy with `agentlive import --agent opencode --source <export.json> --remote-artifact-policy <file>`. Family import adds `--include-children --source-root <exports-directory>`. Retry uses retained bytes even after remote URLs expire. To continue the import live, provide the original export, `--resume-import`, the matching family scope, and the same policy and secret environment to `publish`.

Claude image and document blocks with `source.type: "url"` use the same resolver. Use `--agent claude --source <transcript.jsonl> --remote-artifact-policy <file>` with `import` or `publish`; `--include-children` also captures URL blocks from child transcripts. Claude fresh and resumed managed launch accept the policy as well. URL-backed images/documents do not need to declare a media type; the response supplies it. When the source does declare one, it must match the response. Existing base64 attachment capture remains available without a remote policy.

Kimi `image_url`, `audio_url` and `video_url` parts are supported in `context.append_message` and `content.part` loop events. HTTP(S) URLs use the configured remote policy; data URLs are captured directly without a remote policy. Declared media kinds must match the captured MIME type. Family import and live child capture use the same conversion. Use `--agent kimi` with the policy option for authenticated media. This captures bytes for download and portable recordings; it does not establish audio/video playback support in every viewer.

Kimi converter version 4 changes media from unsupported gaps into attachments. Existing version-3 import/live bindings are rejected before conversion; automatic version migration is not implemented. Preserve those publisher directories until migration is available. New version-4 imports, live continuation and family expansion share compatible converter identities.

The Kimi URL shapes are based on the [upstream Kosong message schema at af41060](https://github.com/MoonshotAI/kimi-cli/blob/af41060edf127d0f32efa58726fd17dea383e654/packages/kosong/src/kosong/message.py). Synthetic wire and CLI tests cover the conversion, but installed-version media acceptance remains open.

Codex supports `image` user-input parts with a `url` in structured history and app-server items, plus legacy `input_image` parts with a string `image_url`. HTTP(S) URLs use the remote policy; image data URLs are captured directly. Import, live file publication, managed launch and family capture share this conversion. `localImage`/`local_image` path capture retains its existing behavior. The installed Codex 0.153.4 app-server JSON schema confirms the `image`/`url` input shape; this schema check does not establish interactive native media acceptance.

Codex converter version 4 adds image conversion to previously unavailable or omitted source content. Version-3 bindings require explicit migration; new version-4 imports support continuation and family expansion with compatible policies. Use the original `--record-format legacy` on legacy live continuation.

The option also applies to OpenCode managed launch and child capture. Native-server authentication remains configured separately through `OPENCODE_SERVER_PASSWORD`; it is never automatically forwarded to a file URL.

Origins must be exact normalized HTTP(S) origins, without paths, user information, or trailing slashes. The publisher rejects redirects, unlisted origins, credential-bearing URLs, fragments, non-200 responses, mismatched media types, oversized bodies, and invalid UTF-8 text. Text with a declared non-UTF-8 charset is rejected. Defaults are 24 MiB per artifact and 15 seconds per request; configured limits can be lower, and timeouts can be at most 60 seconds. Policies accept at most 64 origins and 64 KiB of JSON.

Captured bytes are filtered using the recording's known secrets, including configured authorization values. The response's declared media type does not decide this: bytes that decode as strict UTF-8 are filtered as text and the rest are scanned for the UTF-8 encoding of each secret, as described under [artifacts](recording.md#attachments-and-artifacts). Filtering remains exact-substring, so an encoded or case-shifted copy of a secret survives. The immutable filtered bytes are uploaded to AgentLive and referenced by attachment events. Unannounced uploads remain hidden from viewers. Ordinary attachment download and `.agentlive` export/reimport then use those retained bytes without access to the native URL. Remote source URLs are represented by generic attachment references in published events.

Restart reuses a durable capture outcome for the same native file descriptor; it does not refresh an unchanged URL. A changed descriptor creates a new source identity. These native URL descriptors do not provide a verified historical content hash, so remote downloads have `live-capture` provenance even when discovered in retained history. They are not proof of the URL's past contents. A crash before the outcome checkpoint may require fetching the URL again; conflicting bytes are rejected by the spool identity check.

The policy and credentials are pinned through capture-policy hashes. Keep them consistent when reattaching; changing a policy on an existing recording requires migration, which is not yet implemented. Broader native media fidelity, HTML/CSS dependency bundles, and background artifact delivery remain unfinished. A failed remote capture currently stops that capture operation and requires recovery; it does not silently substitute unavailable or newer historical bytes.
