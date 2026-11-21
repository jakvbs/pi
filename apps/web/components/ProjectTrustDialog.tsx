"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type {
  ProjectTrustResponse,
  ProjectTrustStatus,
  RouteErrorResponse,
  RouteRefusalReason,
} from "@/lib/api-types";
import { revealHiddenCharacters } from "@/lib/hidden-characters";
import { openStackedDialog } from "@/lib/stacked-dialog";

/** How long the dialog waits for the folder's fresh trust status before it stops holding Trust back. */
export const TRUST_STATUS_TIMEOUT_MS = 10_000;

/** Why trusting failed: a route refusal carries its `reason`; a network failure has none. */
export interface ProjectTrustFailure {
  error: string;
  reason?: RouteRefusalReason;
}

/** The folder's trust as the dialog read it when it opened. */
export type ProjectTrustDialogStatus =
  | { state: "loading" }
  | { state: "failed"; error?: string; reason?: RouteRefusalReason; timedOut?: boolean }
  | { state: "loaded"; status: ProjectTrustStatus };

const STATUS_ID = "project-trust-status";
const NOTICE_ID = "project-trust-notice";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trustStatusFrom(data: ProjectTrustResponse): ProjectTrustStatus {
  const status: ProjectTrustStatus = {
    requiresTrust: data.requiresTrust,
    trusted: data.trusted,
    decision: data.decision,
    inherited: data.inherited,
  };
  if (data.decisionPath !== undefined) status.decisionPath = data.decisionPath;
  if (data.decisionError !== undefined) status.decisionError = data.decisionError;
  return status;
}

/** The status a GET answer carries, or why it carries none. */
export function projectTrustStatusFrom(
  ok: boolean,
  status: number,
  data: Partial<ProjectTrustResponse & RouteErrorResponse>,
): ProjectTrustDialogStatus {
  if (ok && !data.error && typeof data.requiresTrust === "boolean") {
    return { state: "loaded", status: trustStatusFrom(data as ProjectTrustResponse) };
  }
  return { state: "failed", error: data.error ?? `HTTP ${status}`, reason: data.reason };
}

/** Why the dialog no longer offers Trust: the folder's trust changed since the page read it. */
function settledTrustNotice(status: ProjectTrustStatus | undefined): string | undefined {
  if (!status) return undefined;
  if (!status.requiresTrust) return "trust.reason.trust-not-required";
  if (status.trusted) return "trust.alreadyTrusted";
  return undefined;
}

/**
 * Asks before trusting a project. The folder's trust is read again when the
 * dialog opens, not taken from the status the page loaded with: it can change
 * in between. Trust waits for that read, so a folder trusted meanwhile, or no
 * longer needing trust, is no longer offered Trust; a read that fails or takes
 * too long stops holding Trust back. The fresh status goes to `onStatus`. It
 * opens from the page's restricted-mode banner, above Settings when Settings
 * is open, so Escape closes it alone.
 */
export function ProjectTrustDialog({
  cwd,
  busy,
  error,
  onCancel,
  onConfirm,
  onStatus,
}: {
  cwd: string;
  busy: boolean;
  error: ProjectTrustFailure | null;
  onCancel: () => void;
  onConfirm: () => void;
  /** The fresh status the dialog read, so the page's restricted-mode banner can follow it. */
  onStatus?: (status: ProjectTrustStatus) => void;
}) {
  const [trust, setTrust] = useState<ProjectTrustDialogStatus>({ state: "loading" });
  // Read through a ref, so a new callback on every page render does not fetch again.
  const onStatusRef = useRef(onStatus);
  useEffect(() => {
    onStatusRef.current = onStatus;
  }, [onStatus]);

  useEffect(() => {
    let active = true;
    let timedOut = false;
    setTrust({ state: "loading" });
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TRUST_STATUS_TIMEOUT_MS);
    fetch(`/api/project-trust?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as Partial<ProjectTrustResponse & RouteErrorResponse>;
        if (!active) return;
        const next = projectTrustStatusFrom(response.ok, response.status, data);
        setTrust(next);
        if (next.state === "loaded") onStatusRef.current?.(next.status);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setTrust(timedOut ? { state: "failed", timedOut: true } : { state: "failed", error: errorMessage(reason) });
      })
      .finally(() => window.clearTimeout(timer));
    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [cwd]);

  return (
    <ProjectTrustDialogView
      cwd={cwd}
      busy={busy}
      error={error}
      trust={trust}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

/** The dialog for a status in any state, without the fetch; exported for tests. */
export function ProjectTrustDialogView({
  cwd,
  busy,
  error,
  trust,
  onCancel,
  onConfirm,
}: {
  cwd: string;
  busy: boolean;
  error: ProjectTrustFailure | null;
  trust: ProjectTrustDialogStatus;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const loading = trust.state === "loading";
  const notice = trust.state === "loaded" ? settledTrustNotice(trust.status) : undefined;
  const dialogRef = useRef<HTMLDivElement>(null);
  // Read through refs, so the Escape listener registered once sees the current props.
  const busyRef = useRef(busy);
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    busyRef.current = busy;
    onCancelRef.current = onCancel;
  }, [busy, onCancel]);

  // The dialog can open above Settings: Escape closes it alone (taken in
  // the capture phase, before Settings' own handler), focus moves into it, and
  // goes back to what had it once it closes. Escape is ignored while trusting,
  // like Cancel and the backdrop, but still never reaches Settings.
  useEffect(() => openStackedDialog(document, dialogRef.current, () => {
    if (!busyRef.current) onCancelRef.current();
  }), []);

  return (
    <div
      role="presentation"
      className="project-trust-backdrop"
      onClick={(event) => {
        if (!busy && event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-trust-title"
        aria-describedby="project-trust-description"
        tabIndex={-1}
        className="project-trust-dialog"
      >
        <div className="project-trust-body">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#f59e0b"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="project-trust-icon"
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
          <div className="project-trust-content">
            <div id="project-trust-title" className="project-trust-title">
              {t("trust.dialogTitle")}
            </div>
            <div id="project-trust-description" className="project-trust-text">
              {t("trust.dialogBody")}
            </div>
            <code className="project-trust-path">{revealHiddenCharacters(cwd)}</code>
            {notice && <p id={NOTICE_ID} role="status" className="project-trust-notice">{t(notice)}</p>}
            <ProjectTrustStatusSection trust={trust} />
          </div>
        </div>
        {/* Outside the scrolling body, so a long path cannot hide it. */}
        {error && <ProjectTrustError error={error} />}
        <div className="project-trust-footer">
          <button
            type="button"
            className="project-trust-button"
            onClick={onCancel}
            disabled={busy}
          >
            {notice ? t("trust.close") : t("trust.cancel")}
          </button>
          {!notice && (
            <button
              type="button"
              className="project-trust-button is-primary"
              onClick={onConfirm}
              disabled={busy || loading}
              aria-busy={busy || undefined}
              aria-describedby={loading ? STATUS_ID : undefined}
            >
              {busy ? t("trust.trusting") : t("trust.trustProject")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Why trusting failed: the translated reason, or for an internal or network failure its diagnostic. */
function ProjectTrustError({ error }: { error: ProjectTrustFailure }) {
  const { t } = useI18n();
  const translated = error.reason !== undefined && error.reason !== "internal";
  return (
    <div role="alert" className="project-trust-error">
      {translated ? t(`trust.reason.${error.reason}`) : t("trust.trustFailed")}
      {!translated && <code className="project-trust-error-detail">{revealHiddenCharacters(error.error)}</code>}
    </div>
  );
}

/** While the fresh status loads, or why it could not be read; exported for tests. */
export function ProjectTrustStatusSection({ trust }: { trust: ProjectTrustDialogStatus }) {
  const { t } = useI18n();
  if (trust.state === "loading") {
    return <p id={STATUS_ID} role="status" className="project-trust-status">{t("trust.status.loading")}</p>;
  }
  if (trust.state === "loaded") return null;
  // An internal failure has nothing to translate: its diagnostic is the reason.
  const detail = trust.reason && trust.reason !== "internal" ? t(`trust.reason.${trust.reason}`) : trust.error;
  return (
    <div className="project-trust-failed">
      <p className="project-trust-line is-warning">{t(trust.timedOut ? "trust.status.timedOut" : "trust.status.loadFailed")}</p>
      {detail && <code className="project-trust-detail">{revealHiddenCharacters(detail)}</code>}
    </div>
  );
}
