import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  ProjectTrustResponse,
  ProjectTrustUnreadableResponse,
  RouteErrorResponse,
  RouteRefusalReason,
} from "@/lib/api-types";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { invalidateModelsCache } from "@/lib/models-cache";
import { getProjectTrustStatus, trustProject } from "@/lib/project-trust";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { destroyRpcSessionsForCwd, hasBusyRpcSessionForCwd } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function refusal(status: number, reason: RouteRefusalReason, error: string) {
  return NextResponse.json({ error, reason } satisfies RouteErrorResponse, { status });
}

/**
 * The folder: absolute (400 `cwd-invalid`), inside the allowed roots as given
 * — a `..` is refused, not collapsed (403 `cwd-denied`) — and only then a
 * directory (400 `cwd-not-directory`), so a folder outside the roots gets the
 * same answer whether or not it exists. A relative path is refused rather than
 * resolved against the server process's own folder.
 */
async function validateCwd(value: unknown): Promise<{ cwd: string } | { response: NextResponse }> {
  if (typeof value !== "string" || !value.trim() || !isAbsolute(value)) {
    return { response: refusal(400, "cwd-invalid", "cwd must be an absolute path") };
  }
  if (!isExistingFilePathAllowed(value, await getAllowedFileRoots())) {
    return { response: refusal(403, "cwd-denied", "Access denied") };
  }
  const cwd = resolve(value);
  let directory = false;
  try {
    directory = statSync(cwd).isDirectory();
  } catch {
    // Removed since the check.
  }
  if (!directory) return { response: refusal(400, "cwd-not-directory", "cwd must be a directory") };
  return { cwd };
}

// GET /api/project-trust?cwd=<folder>: the trust status.
export async function GET(req: Request) {
  const result = await validateCwd(new URL(req.url).searchParams.get("cwd"));
  if ("response" in result) return result.response;
  try {
    return NextResponse.json(getProjectTrustStatus(result.cwd, getAgentDir()) satisfies ProjectTrustResponse);
  } catch (error) {
    // trust.json unparsable, or locked by another process (the pi CLI) past the
    // store's short wait; trusting would fail the same way right now.
    return NextResponse.json(
      { error: errorMessage(error), reason: "trust-unreadable" } satisfies ProjectTrustUnreadableResponse,
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return refusal(403, "request-denied", "Untrusted API request");
  if (!hasJsonContentType(req)) return refusal(415, "content-type", "Content-Type must be application/json");
  try {
    // A body that is not JSON names no cwd.
    const body = await req.json().catch(() => null) as { cwd?: unknown } | null;
    const result = await validateCwd(body?.cwd);
    if ("response" in result) return result.response;

    const agentDir = getAgentDir();
    const current = getProjectTrustStatus(result.cwd, agentDir);
    if (!current.requiresTrust) {
      return refusal(409, "trust-not-required", "This project has no resources that require trust");
    }
    if (hasBusyRpcSessionForCwd(result.cwd)) {
      return refusal(409, "session-busy", "Wait for the active session to finish before trusting this project");
    }

    const status = trustProject(result.cwd, agentDir);
    invalidateModelsCache();
    await destroyRpcSessionsForCwd(result.cwd);
    return NextResponse.json(status);
  } catch (error) {
    return refusal(500, "internal", errorMessage(error));
  }
}
