"use client";

import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import type { BoardLane, BoardSubagent, BoardTicket, FactoryBoard } from "@/lib/factory-board-types";
import { isPlainActivation, sessionDeepLink } from "@/lib/session-links";
import type { SessionInfo } from "@/lib/types";

// The factory board (F046 prototype): one global, read-only top panel. Polls
// GET /api/board while open, so a subagent's status follows the session list's.

const POLL_MS = 3000;
const LANE_TITLES: Record<BoardLane, string> = { active: "Active", planned: "Planned", done: "Done (latest 10)" };
const STATUS_COLORS: Record<BoardSubagent["status"], string> = {
  starting: "var(--accent)",
  queued: "var(--text-muted)",
  running: "var(--accent)",
  completed: "#3fb950",
  failed: "#f85149",
  aborted: "var(--text-muted)",
  interrupted: "#d29922",
};

interface Props {
  sessions: SessionInfo[];
  onSelectSession: (session: SessionInfo) => void;
}

export function FactoryBoardPanel({ sessions, onSelectSession }: Props) {
  const [board, setBoard] = useState<FactoryBoard | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const response = await fetch("/api/board", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const next = await response.json() as FactoryBoard;
        if (!cancelled) { setBoard(next); setLoadError(null); }
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) timer = setTimeout(load, POLL_MS);
      }
    };
    void load();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  const openChat = (event: MouseEvent<HTMLAnchorElement>, sessionId: string) => {
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session || !isPlainActivation(event)) return;
    event.preventDefault();
    onSelectSession(session);
  };

  const byTicket = new Map<string, BoardSubagent[]>();
  for (const subagent of board?.subagents ?? []) {
    const key = subagent.ticket ?? "";
    byTicket.set(key, [...(byTicket.get(key) ?? []), subagent]);
  }
  const shownIds = new Set(Object.values(board?.lanes ?? {}).flat().map((ticket) => ticket.id));
  const offBoard = [...byTicket].filter(([key]) => key && !shownIds.has(key)).flatMap(([, list]) => list);

  const subagentRows = (list: BoardSubagent[]) => list.map((subagent) => (
    <div key={subagent.sessionId} data-board-subagent={subagent.sessionId} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "2px 0 2px 16px", fontSize: 12 }}>
      <span data-board-status={subagent.status} style={{ color: STATUS_COLORS[subagent.status], minWidth: 78 }}>● {subagent.status}</span>
      <span style={{ color: "var(--text-muted)" }}>{subagent.profile}</span>
      <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{subagent.model ?? "model unknown"}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{subagent.description}</span>
      {subagent.ticket && !shownIds.has(subagent.ticket) && <span style={{ color: "var(--text-dim)" }}>{subagent.ticket}</span>}
      <a href={sessionDeepLink(subagent.sessionId)} onClick={(event) => openChat(event, subagent.sessionId)} style={{ color: "var(--accent)", whiteSpace: "nowrap" }}>
        Open chat
      </a>
    </div>
  ));

  const ticketRow = (ticket: BoardTicket) => (
    <div key={ticket.folder} data-board-ticket={ticket.id} style={{ padding: "3px 0" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 12 }}>
        <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)", minWidth: 40 }}>{ticket.id}</span>
        <span style={{ flex: 1, minWidth: 0 }}>{ticket.title}</span>
        {ticket.repo && <span style={{ color: "var(--text-dim)" }}>{ticket.repo}</span>}
        {ticket.landed && <span style={{ color: "var(--text-dim)" }}>{ticket.landed}</span>}
      </div>
      {subagentRows(byTicket.get(ticket.id) ?? [])}
    </div>
  );

  const section = (title: string, children: ReactNode, key: string) => (
    <section key={key} data-board-lane={key} style={{ marginBottom: 12 }}>
      <h3 style={{ margin: "0 0 4px", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--text-muted)" }}>{title}</h3>
      {children}
    </section>
  );

  return (
    <div data-factory-board style={{ background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", boxShadow: "0 10px 28px rgba(0,0,0,0.10)", padding: "12px 16px" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", marginBottom: 10, fontSize: 12 }}>
        <strong>Factory board</strong>
        <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{board?.specDir}</span>
        {loadError && <span style={{ color: "#f85149" }}>{loadError}</span>}
      </div>
      {!board ? <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Loading…</div> : (
        <>
          {board.error && <div style={{ fontSize: 12, color: "#f85149", marginBottom: 8 }}>{board.error}</div>}
          {(["active", "planned", "done"] as const).map((lane) => section(LANE_TITLES[lane], board.lanes[lane].map(ticketRow), lane))}
          {offBoard.length > 0 && section("Tickets not on the board", subagentRows(offBoard), "off-board")}
          {section("No ticket (latest 20)", (byTicket.get("") ?? []).length > 0
            ? subagentRows(byTicket.get("") ?? [])
            : <div style={{ fontSize: 12, color: "var(--text-dim)", paddingLeft: 16 }}>None</div>, "none")}
        </>
      )}
    </div>
  );
}
