import { NextResponse } from "next/server";
import type { RouteErrorResponse, RouteRefusalReason, ToolSettingsResponse } from "@/lib/api-types";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  readBuiltinTools,
  readPowerShellToolEnabled,
  writeBuiltinTools,
  writePowerShellToolEnabled,
} from "@/lib/powershell-settings";
import { SETTINGS_BUILTIN_TOOLS } from "@/lib/tool-presets";

export const dynamic = "force-dynamic";

// The only writer of the global `defaultTools` key: the built-in tool switches
// and the PowerShell switch (Windows) in Settings › General edit it, under the
// lock pi's SettingsManager takes on the same file.
// Every refusal carries a `reason` code the panel translates, beside the
// English `error` it shows only as the diagnostic of an `internal` failure.

const CHANGES = ["enabled", "builtinTools"] as const;

function refusal(status: number, reason: RouteRefusalReason, error: string) {
  return NextResponse.json({ error, reason } satisfies RouteErrorResponse, { status });
}

function errorResponse(error: unknown) {
  return refusal(500, "internal", error instanceof Error ? error.message : String(error));
}

async function readToolSettings(): Promise<ToolSettingsResponse> {
  // One after the other: each takes the file lock, and a reader that finds it
  // held backs off for about a second.
  const powerShellEnabled = await readPowerShellToolEnabled();
  const builtinTools = await readBuiltinTools();
  return { isWindows: process.platform === "win32", powerShellEnabled, builtinTools };
}

export async function GET() {
  try {
    return NextResponse.json(await readToolSettings());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return refusal(403, "request-denied", "Untrusted API request");
  }
  if (!hasJsonContentType(req)) {
    return refusal(415, "content-type", "Content-Type must be application/json");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return refusal(400, "invalid-request", "Invalid JSON body");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return refusal(400, "invalid-request", "Expected a JSON object");
  }
  const changes = body as { enabled?: unknown; builtinTools?: unknown };
  if (CHANGES.filter((key) => key in changes).length !== 1) {
    return refusal(400, "invalid-request", "Send one of enabled (PowerShell) or builtinTools");
  }

  if ("builtinTools" in changes) {
    // The built-in tools new sessions start with; every other defaultTools entry is kept.
    const tools = changes.builtinTools;
    if (!Array.isArray(tools) || !tools.every((name) => SETTINGS_BUILTIN_TOOLS.includes(name))) {
      return refusal(400, "invalid-request", `builtinTools must list names from ${SETTINGS_BUILTIN_TOOLS.join(", ")}`);
    }
    try {
      await writeBuiltinTools(tools);
      return NextResponse.json(await readToolSettings());
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (process.platform !== "win32") {
    return refusal(404, "invalid-request", "PowerShell tool settings are only available on Windows");
  }
  if (typeof changes.enabled !== "boolean") {
    return refusal(400, "invalid-request", "enabled must be a boolean");
  }
  try {
    await writePowerShellToolEnabled(changes.enabled);
    return NextResponse.json(await readToolSettings());
  } catch (error) {
    return errorResponse(error);
  }
}
