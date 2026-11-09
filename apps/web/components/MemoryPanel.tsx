"use client";

import { useEffect, useState } from "react";
import type { MemoryRun, MemorySnapshot, MemoryStatus } from "@/lib/memory-panel-types";

// Observational memory in the open session (F046 prototype): a read-only top
// panel polling GET /api/sessions/[id]/memory while open. Its rows are the
// sections `/om:status` prints, as the running extension published them.

const POLL_MS = 3000;

function runText(run: MemoryRun | undefined, noun: string): string {
  if (!run) return "none yet";
  const dropped = run.dropped ? `, ${run.dropped} dropped` : "";
  return `${run.at ? new Date(run.at).toLocaleString() : "unknown time"}: ${run.recorded} ${noun}${dropped}`;
}

function errorText(errors: MemoryStatus["errors"]): string {
  const lines = [
    ...(errors.observer ? [`Observer: ${errors.observer}`] : []),
    ...(errors.reflector ? [`Reflector: ${errors.reflector}`] : []),
  ];
  return lines.join("\n") || "none";
}

export function MemoryPanel({ sessionId }: { sessionId: string | null }) {
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/memory`, { cache: "no-store" });
        const body = await response.json() as MemorySnapshot | { error: string };
        if (cancelled) return;
        if ("error" in body) { setError(body.error); return; }
        setSnapshot(body);
        setError(null);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) timer = setTimeout(load, POLL_MS);
      }
    };
    void load();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [sessionId]);

  const shown = snapshot?.sessionId === sessionId ? snapshot : null;
  const row = (label: string, value: string, key: string) => (
    <div key={key} data-memory-row={key} style={{ display: "flex", gap: 12 }}>
      <span style={{ minWidth: 120, color: "var(--text-muted)" }}>{label}</span>
      <span style={{ flex: 1, minWidth: 0, whiteSpace: "pre-wrap" }}>{value}</span>
    </div>
  );

  return (
    <div data-memory-panel style={{ background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", boxShadow: "0 10px 28px rgba(0,0,0,0.10)", padding: "12px 16px", fontSize: 12, fontFamily: "var(--font-mono)", lineHeight: 1.5 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", marginBottom: 8, fontFamily: "inherit" }}>
        <strong>Observational memory</strong>
        {shown && <span style={{ color: "var(--text-dim)" }}>{!shown.live ? "from file (no progress or errors until it runs)" : shown.omStatus ? "live session, as /om:status" : "live session (memory has published no status yet)"}</span>}
        {error && <span style={{ color: "#f85149" }}>{error}</span>}
      </div>
      {!sessionId ? <div style={{ color: "var(--text-muted)" }}>Open a session.</div> : !shown ? <div style={{ color: "var(--text-muted)" }}>Loading…</div> : (
        <>
          {row("Status", shown.status ?? "not shown", "status")}
          {shown.omStatus?.passive && row("Mode", "Passive: automatic memory workers and activation disabled", "mode")}
          {row("Memory", shown.memoryLines.join("\n"), "counts")}
          {shown.omStatus && row("Activity", shown.omStatus.activity.join("\n"), "activity")}
          {shown.omStatus && row("In flight", shown.omStatus.inFlight.join("\n") || "nothing", "in-flight")}
          {shown.omStatus && row("Last error", errorText(shown.omStatus.errors), "errors")}
          {row("Observer", runText(shown.observer, "observations"), "observer")}
          {row("Reflector", runText(shown.reflector, "reflections"), "reflector")}
          {([["visible", "Visible memory (/om:view)", shown.memoryText], ["recorded", "Recorded memory (/om:view full)", shown.recordedMemoryText]] as const).map(([key, label, text]) => (
            <details key={key} style={{ marginTop: 8 }}>
              <summary style={{ cursor: "pointer", color: "var(--text-muted)" }}>{label}</summary>
              <pre data-memory-text={key} style={{ margin: "6px 0 0", maxHeight: 360, overflow: "auto", whiteSpace: "pre-wrap", fontSize: 11 }}>{text}</pre>
            </details>
          ))}
          <div style={{ marginTop: 6, color: "var(--text-dim)" }}>{shown.ledgerModule}</div>
        </>
      )}
    </div>
  );
}
