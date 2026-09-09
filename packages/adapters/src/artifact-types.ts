import type { CapturedAttachment } from "@agentlive/publisher";
export type FileArtifactResolver = (request: {
  artifactId: string;
  sourceKey: string;
  path: string;
  historical: boolean;
  expectedSourceHash?: string;
}) => Promise<{ attachment: CapturedAttachment } | { reason: string }>;
