import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { z } from "zod";
import {
  importClaudeRecording,
  importCodexRecording,
  importKimiRecording,
  importOpenCodeRecording,
} from "@agentlive/adapters";
import {
  canonicalJson,
  idSchema,
  migrationOriginSchema,
} from "@agentlive/protocol";
import { StreamingRedactor } from "@agentlive/publisher";
import { atomicJson } from "@agentlive/storage";
import { removeRecording, listRecordings } from "@agentlive/client";
import { request, originOf } from "@agentlive/client/transport";
import { withFrozenImportMigration } from "./inspect-migration.js";

const hash = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const targetSchema = z.strictObject({
  streamId: idSchema,
  revision: idSchema,
  producerEvents: z.number().int().nonnegative().safe(),
});
const intentSchema = z.strictObject({
  version: z.literal(1),
  operationId: idSchema,
  sourceManifestHash: digest,
  sourceStreamId: idSchema,
  sourceRevision: idSchema,
  disposition: z.enum(["retain", "remove"]),
  requestHash: digest,
  targetPolicyHash: digest,
  targetDirectory: z.string(),
  target: targetSchema.optional(),
  completed: z.boolean(),
});
type Intent = z.infer<typeof intentSchema>;
type ImportOptions = Parameters<typeof importCodexRecording>[0];

/** Changed projections get an independent private recording and durable retry identity. */
export async function migrateImport(options: {
  directory: string;
  nativeSource: string;
  operationId: string;
  expectedManifestHash: string;
  disposition: "retain" | "remove";
  confirmRemoval?: boolean;
  sourceRoot?: string;
  ownerCredential: string;
  targetServerOrigin?: string;
  targetOwnerCredential?: string;
  secrets?: readonly string[];
  artifactRoots?: readonly string[];
  artifactBaseDirectory?: string;
  artifactBundles?: boolean;
  remoteArtifacts?: ImportOptions["remoteArtifacts"];
  signal: AbortSignal;
}) {
  idSchema.parse(options.operationId);
  digest.parse(options.expectedManifestHash);
  z.enum(["retain", "remove"]).parse(options.disposition);
  if (options.disposition === "remove" && !options.confirmRemoval)
    throw new Error("Replacement removal requires --confirm-removal");
  let receipt:
    | {
        operationId: string;
        sourceStreamId: string;
        sourceRevision: string;
        targetServerOrigin: string;
        disposition: "retain" | "remove";
        target: z.infer<typeof targetSchema>;
        publisherDirectory: string;
        stateDirectory: string | null;
        visibility: "private";
        completed: true;
      }
    | undefined;
  await withFrozenImportMigration(
    options.directory,
    options.nativeSource,
    options.signal,
    async ({ directory, binding, imported, read }) => {
      if (hash(imported) !== options.expectedManifestHash)
        throw new Error("Import manifest changed since inspection");
      const source = z
        .object({
          converterVersion: z.string(),
          nativeSessionId: z.literal(binding.nativeSessionId),
          sourcePrefix: digest,
          sourceBytes: z.number().int().nonnegative().safe(),
          title: z.string().max(500),
          artifactBaseDirectory: z.string(),
          artifactRoots: z.array(z.string()),
          familySources: z
            .array(
              z.object({
                sourcePath: z.string(),
                nativeAgent: idSchema,
                boundary: z.object({
                  prefixHash: digest,
                  offset: z.number().int().nonnegative().safe(),
                }),
              }),
            )
            .max(199)
            .optional(),
        })
        .parse(imported);
      const targetServerOrigin = originOf(
        options.targetServerOrigin ?? binding.serverOrigin,
      );
      const external = targetServerOrigin !== binding.serverOrigin;
      if (external && !options.targetOwnerCredential)
        throw new Error(
          "Server migration requires a separate destination credential",
        );
      if (
        !external &&
        options.targetOwnerCredential &&
        options.targetOwnerCredential !== options.ownerCredential
      )
        throw new Error(
          "Same-server replacement must use its source owner credential",
        );
      const targetOwnerCredential =
        options.targetOwnerCredential ?? options.ownerCredential;
      const family = source.familySources !== undefined;
      if (
        family &&
        ["codex", "opencode"].includes(binding.nativeAgent) &&
        !options.sourceRoot
      )
        throw new Error("Family replacement requires --source-root");
      const raw = await read("replacement-import.json", true);
      let intent: Intent | undefined =
        raw === undefined ? undefined : intentSchema.parse(raw);
      const requestHash = hash({
        nativeSource: resolve(options.nativeSource),
        sourceRoot: options.sourceRoot ? resolve(options.sourceRoot) : null,
        operationId: options.operationId,
        sourceManifestHash: options.expectedManifestHash,
        sourceStreamId: binding.streamId,
        sourceRevision: binding.revision,
        disposition: options.disposition,
        ...(external ? { targetServerOrigin } : {}),
      });
      if (intent && intent.requestHash !== requestHash)
        throw new Error(
          "Replacement request differs from saved migration; use its original arguments",
        );
      const headers = { authorization: `Bearer ${options.ownerCredential}` };
      const base = `${binding.serverOrigin}/api/v1/streams/${binding.streamId}`;
      if (!intent?.target) {
        // Owner-only endpoint: public readability does not authorize migration.
        await request(
          fetch,
          base + "/visibility",
          { headers },
          options.signal,
          4096,
        );
        const metadata = z
          .object({
            revision: z.literal(binding.revision),
            lifecycle: z.literal("ended"),
          })
          .parse(
            JSON.parse(
              (await request(fetch, base, { headers }, options.signal, 4096))
                .text,
            ),
          );
        void metadata;
      }
      if (external && !intent)
        await listRecordings({
          serverOrigin: targetServerOrigin,
          credential: targetOwnerCredential,
          signal: options.signal,
          limit: 1,
        });
      let targetConverterVersion: string | undefined;
      const replacementStateDirectory = join(
        directory,
        "replacements",
        hash(options.operationId),
      );
      // Retain retry identity for operations created before the CLI state layout.
      const legacyLayout =
        intent !== undefined &&
        dirname(intent.targetDirectory) === replacementStateDirectory;
      const publisherRoot = legacyLayout
        ? replacementStateDirectory
        : join(replacementStateDirectory, "publisher");
      const titleFilter = new StreamingRedactor([
        ...(options.secrets ?? []),
        options.ownerCredential,
        targetOwnerCredential,
        ...(options.remoteArtifacts?.origins.flatMap((entry) =>
          entry.authorization ? [entry.authorization] : [],
        ) ?? []),
      ]);
      const title = (
        titleFilter.push(source.title) + titleFilter.finish()
      ).slice(0, 500);
      const common: ImportOptions = {
        sourcePath: resolve(options.nativeSource),
        publisherRoot,
        serverOrigin: targetServerOrigin,
        ownerCredential: targetOwnerCredential,
        title,
        visibility: "private",
        signal: options.signal,
        secrets: external
          ? [...(options.secrets ?? []), options.ownerCredential]
          : (options.secrets ?? []),
        artifactRoots: options.artifactRoots ?? source.artifactRoots,
        artifactBaseDirectory:
          options.artifactBaseDirectory ?? source.artifactBaseDirectory,
        ...(options.artifactBundles ? { artifactBundles: true } : {}),
        ...(options.remoteArtifacts
          ? { remoteArtifacts: options.remoteArtifacts }
          : {}),
        beforeImport: async (identity, targetDirectory) => {
          targetConverterVersion = identity.converterVersion;
          // Recheck what the adapter actually inspected, before any remote creation.
          const sources = (children: typeof identity.familySources) =>
            (children ?? [])
              .map((child) => ({
                nativeAgent: child.nativeAgent,
                boundary: child.boundary,
              }))
              .sort((a, b) => a.nativeAgent.localeCompare(b.nativeAgent));
          if (
            identity.nativeSessionId !== binding.nativeSessionId ||
            identity.sourcePrefix !== source.sourcePrefix ||
            identity.sourceBytes !== source.sourceBytes ||
            canonicalJson(sources(identity.familySources)) !==
              canonicalJson(sources(source.familySources))
          )
            throw new Error(
              "Replacement native identity, frozen boundary or family scope changed",
            );
          const targetPolicyHash = hash(identity);
          if (intent) {
            if (
              intent.targetPolicyHash !== targetPolicyHash ||
              intent.targetDirectory !== targetDirectory
            )
              throw new Error(
                "Replacement converter or filter policy changed during retry",
              );
          } else {
            intent = {
              version: 1,
              operationId: options.operationId,
              sourceManifestHash: options.expectedManifestHash,
              sourceStreamId: binding.streamId,
              sourceRevision: binding.revision,
              disposition: options.disposition,
              requestHash,
              targetPolicyHash,
              targetDirectory,
              completed: false,
            };
            await atomicJson(
              join(directory, "replacement-import.json"),
              intent,
            );
          }
          // Local lineage accompanies the replacement binding, independent of source manifests.
          await atomicJson(join(targetDirectory, "migration-origin.json"), {
            version: 1,
            operationId: options.operationId,
            serverOrigin: binding.serverOrigin,
            streamId: binding.streamId,
            revision: binding.revision,
            sourceManifestHash: options.expectedManifestHash,
            targetPolicyHash,
            disposition: options.disposition,
          });
        },
      };
      const result =
        binding.nativeAgent === "claude"
          ? await importClaudeRecording({ ...common, includeChildren: family })
          : binding.nativeAgent === "kimi"
            ? await importKimiRecording({ ...common, includeChildren: family })
            : binding.nativeAgent === "codex"
              ? await importCodexRecording({
                  ...common,
                  ...(family
                    ? { familyRoot: resolve(options.sourceRoot!) }
                    : {}),
                })
              : await importOpenCodeRecording({
                  ...common,
                  ...(family
                    ? { familyRoot: resolve(options.sourceRoot!) }
                    : {}),
                });
      const target = targetSchema.parse({
        streamId: result.streamId,
        revision: result.revision,
        producerEvents: result.producerEvents,
      });
      if (!intent)
        throw new Error("Replacement import did not prepare its migration");
      if (
        intent.target &&
        canonicalJson(intent.target) !== canonicalJson(target)
      )
        throw new Error("Replacement receipt changed during retry");
      intent = { ...intent, target };
      await atomicJson(join(directory, "replacement-import.json"), intent);
      const origin = migrationOriginSchema.parse({
        version: 1,
        operationId: options.operationId,
        sourceStreamId: binding.streamId,
        sourceRevision: binding.revision,
        sourceConverterVersion: source.converterVersion,
        targetConverterVersion,
        requestedSourceDisposition: options.disposition,
        ...(external
          ? {
              externalSource: {
                serverOrigin: binding.serverOrigin,
                verification: "owner-declared",
              },
            }
          : {}),
      });
      const lineageResponse = await request(
        fetch,
        `${targetServerOrigin}/api/v1/streams/${target.streamId}/migration-origin`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${targetOwnerCredential}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ revision: target.revision, origin }),
        },
        options.signal,
        4096,
      );
      const savedLineage = z
        .strictObject({
          revision: z.literal(target.revision),
          origin: migrationOriginSchema,
        })
        .parse(JSON.parse(lineageResponse.text));
      if (canonicalJson(savedLineage.origin) !== canonicalJson(origin))
        throw new Error("Migration lineage receipt differs");
      if (options.disposition === "remove") {
        await removeRecording({
          serverOrigin: binding.serverOrigin,
          streamId: binding.streamId,
          revision: binding.revision,
          operationId: hash({
            migration: options.operationId,
            action: "remove",
          }),
          credential: options.ownerCredential,
          signal: options.signal,
        });
      }
      await atomicJson(join(directory, "replacement-import.json"), {
        ...intent,
        completed: true,
      });
      receipt = {
        operationId: options.operationId,
        sourceStreamId: binding.streamId,
        sourceRevision: binding.revision,
        targetServerOrigin,
        disposition: options.disposition,
        target,
        publisherDirectory: intent.targetDirectory,
        stateDirectory: legacyLayout ? null : replacementStateDirectory,
        visibility: "private",
        completed: true,
      };
    },
  );
  return receipt!;
}
