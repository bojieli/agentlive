import { z } from "zod";
import { idSchema } from "@agentlive/protocol";
import { request, originOf } from "./http.js";
export const reportSubmissionSchema = z.strictObject({
  operationId: idSchema,
  category: z.enum(["privacy", "harmful", "spam", "other"]),
  details: z.string().trim().min(1).max(1000),
});
export type ReportSubmission = z.infer<typeof reportSubmissionSchema>;
export async function submitReport(options: {
  serverOrigin: string;
  streamId: string;
  credential: string;
  input: ReportSubmission;
  signal: AbortSignal;
  fetch?: typeof fetch;
}) {
  const streamId = idSchema.parse(options.streamId);
  const input = reportSubmissionSchema.parse(options.input);
  const response = await request(
    options.fetch ?? fetch,
    `${originOf(options.serverOrigin)}/api/v1/streams/${encodeURIComponent(streamId)}/reports`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.credential
          ? { authorization: `Bearer ${options.credential}` }
          : {}),
      },
      body: JSON.stringify(input),
    },
    options.signal,
    4096,
  );
  return z
    .strictObject({
      reportId: idSchema,
      receivedAt: z.number().int().nonnegative().safe(),
    })
    .parse(JSON.parse(response.text));
}

export const reportDecisionSchema = z.strictObject({
  operationId: idSchema,
  action: z.enum(["dismiss", "remove"]),
  revision: idSchema,
  note: z.string().trim().min(1).max(500),
});
export type ReportDecision = z.infer<typeof reportDecisionSchema>;
const operatorReportSchema = reportSubmissionSchema.extend({
  id: idSchema,
  streamId: idSchema,
  revision: idSchema,
  reporterId: idSchema.optional(),
  createdAt: z.number().int().nonnegative().safe(),
  status: z.enum(["open", "removing", "dismissed", "removed"]),
  decision: reportDecisionSchema.optional(),
  reviewRevision: idSchema.optional(),
  reconciliations: z
    .array(
      z.strictObject({
        previousRevision: idSchema,
        revision: idSchema,
        restoredAt: z.number().int().nonnegative().safe(),
        previousDecision: reportDecisionSchema.optional(),
      }),
    )
    .max(32)
    .optional(),
  resolvedAt: z.number().int().nonnegative().safe().optional(),
});
export type OperatorReport = z.infer<typeof operatorReportSchema>;
type OperatorOptions = {
  serverOrigin: string;
  credential: string;
  signal: AbortSignal;
  fetch?: typeof fetch;
};
export async function listReports(
  options: OperatorOptions & { after?: string; limit?: number },
) {
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Report limit must be from 1 to 100");
  const url = new URL("/api/v1/reports", originOf(options.serverOrigin));
  url.searchParams.set("limit", String(limit));
  if (options.after !== undefined)
    url.searchParams.set("after", idSchema.parse(options.after));
  const response = await request(
    options.fetch ?? fetch,
    url.href,
    { headers: { authorization: `Bearer ${options.credential}` } },
    options.signal,
    8 * 1024 * 1024,
  );
  const page = z
    .strictObject({
      reports: z.array(operatorReportSchema).max(limit),
      nextAfter: idSchema.nullable(),
    })
    .parse(JSON.parse(response.text));
  let previous = options.after;
  for (const report of page.reports) {
    if (previous !== undefined && report.id <= previous)
      throw new Error("Report page is not ordered");
    previous = report.id;
  }
  if (
    page.nextAfter !== null &&
    (page.reports.length !== limit || page.nextAfter !== previous)
  )
    throw new Error("Invalid report cursor");
  return page;
}
export async function decideReport(
  options: OperatorOptions & { reportId: string; decision: ReportDecision },
) {
  const id = idSchema.parse(options.reportId);
  const decision = reportDecisionSchema.parse(options.decision);
  const response = await request(
    options.fetch ?? fetch,
    `${originOf(options.serverOrigin)}/api/v1/reports/${encodeURIComponent(id)}/decision`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(decision),
    },
    options.signal,
    256 * 1024,
  );
  const report = operatorReportSchema.parse(JSON.parse(response.text));
  if (
    report.id !== id ||
    (report.reviewRevision ?? report.revision) !== decision.revision ||
    report.status !==
      (decision.action === "remove" ? "removed" : "dismissed") ||
    report.resolvedAt === undefined ||
    !report.decision ||
    Object.entries(decision).some(
      ([key, value]) => report.decision![key as keyof ReportDecision] !== value,
    )
  )
    throw new Error("Report decision confirmation differs");
  return report;
}
