import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ContextUsage } from "../../../core/extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { addUsageToTotals, createUsageTotals, type UsageTotals } from "../../../core/usage-totals.ts";
import { theme } from "../theme/theme.ts";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

interface SessionStats {
	session: AgentSession;
	sessionId: string;
	leafId: string | null;
	entryCount: number;
	limitsModel: unknown;
	usageTotals: UsageTotals;
	latestCacheHitRate: number | undefined;
	promptedRequests: number;
	contextUsage: ContextUsage | undefined;
	/** The model a viewed session recorded last; undefined in a live footer. */
	sessionModel: SessionModel | undefined;
}

/** The model and thinking level a session's own entries name, as text: no registry lookup. */
interface SessionModel {
	provider: string | undefined;
	label: string;
}

/**
 * What the footer describes: the live agent and its model, or a session file shown read-only (`pi --view`),
 * whose model is the one its entries recorded, even when that model's provider is not loaded here.
 */
export type FooterMode = "live" | "view";

/** Cache hit rates at or above this are normal for a continuing session and stay out of the footer. */
const CACHE_HIT_WARNING_PERCENT = 90;

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	private sessionStats?: SessionStats;
	private readonly mode: FooterMode;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider, mode: FooterMode = "live") {
		this.session = session;
		this.footerData = footerData;
		this.mode = mode;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	/**
	 * Usage totals and context usage scan the whole session, and the footer renders on every frame.
	 * Entries are append-only and every append moves the leaf, so the results only change with the
	 * session, leaf, entry count, or the model whose context window applies.
	 */
	private getSessionStats(): SessionStats {
		const sessionManager = this.session.sessionManager;
		const entryCount = sessionManager.getEntryCount();
		const sessionId = sessionManager.getSessionId();
		const leafId = sessionManager.getLeafId();
		const limitsModel = this.session.routedModel?.model ?? this.session.model;
		const cached = this.sessionStats;
		if (
			cached &&
			cached.session === this.session &&
			cached.sessionId === sessionId &&
			cached.leafId === leafId &&
			cached.entryCount === entryCount &&
			cached.limitsModel === limitsModel
		) {
			return cached;
		}

		// Calculate cumulative usage from ALL session entries (not just post-compaction messages)
		const usageTotals = createUsageTotals();
		let latestCacheHitRate: number | undefined;
		let promptedRequests = 0;

		for (const entry of sessionManager.getEntries()) {
			if (entry.type === "usage") {
				addUsageToTotals(usageTotals, entry.usage);
			} else if (entry.type === "message" && entry.message.role === "assistant") {
				addUsageToTotals(usageTotals, entry.message.usage);

				const latestPromptTokens =
					entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
				if (latestPromptTokens > 0) promptedRequests++;
				latestCacheHitRate =
					latestPromptTokens > 0 ? (entry.message.usage.cacheRead / latestPromptTokens) * 100 : undefined;
			} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
				addUsageToTotals(usageTotals, entry.message.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
		}

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		const sessionModel = this.mode === "view" ? describeSessionModel(sessionManager) : undefined;
		this.sessionStats = {
			session: this.session,
			sessionId,
			leafId,
			entryCount,
			limitsModel,
			usageTotals,
			latestCacheHitRate,
			promptedRequests,
			contextUsage,
			sessionModel,
		};
		return this.sessionStats;
	}

	render(width: number): string[] {
		const state = this.session.state;
		const { usageTotals, latestCacheHitRate, promptedRequests, contextUsage, sessionModel } = this.getSessionStats();
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextTokens = contextUsage?.tokens ?? null;

		// Replace home directory with ~
		let pwd = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);

		// Add git branch if available
		const branch = this.footerData.getGitBranch();
		if (branch) {
			pwd = `${pwd} (${branch})`;
		}

		// Add session name if set
		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) {
			pwd = `${pwd} • ${sessionName}`;
		}

		if (this.session.sessionManager.isPersisted() || this.mode === "view") {
			pwd = `${pwd} • ${this.session.sessionManager.getSessionId()}`;
		}

		// Session token totals live in /session; the footer keeps what changes the next decision.
		const statsParts = [];
		const contextDisplay = `ctx ${contextTokens === null ? "?" : formatTokens(contextTokens)}${this.autoCompactEnabled ? "" : " (auto off)"}`;
		// Each part carries its own color: a colored part ends with a foreground reset, which would
		// drop an outer dim wrapper for every part after it.
		statsParts.push(
			theme.fg(contextPercentValue > 90 ? "error" : contextPercentValue > 70 ? "warning" : "dim", contextDisplay),
		);

		// The first request of a session has nothing cached yet; a later miss means the cache was lost.
		if (
			(usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) &&
			promptedRequests > 1 &&
			latestCacheHitRate !== undefined &&
			latestCacheHitRate < CACHE_HIT_WARNING_PERCENT
		) {
			statsParts.push(theme.fg("warning", `cache ${latestCacheHitRate.toFixed(0)}%`));
		}

		// Kimi Coding is subscription-backed despite using API-key authentication. A subscription's
		// cost is only an estimate of API pricing, so it stays in /session.
		const provider = sessionModel ? sessionModel.provider : state.model?.provider;
		const usingSubscription = provider
			? provider === "kimi-coding" || this.session.modelRuntime.isUsingSubscription(provider)
			: false;
		if (usageTotals.cost && !usingSubscription) {
			statsParts.push(theme.fg("dim", `$${usageTotals.cost.toFixed(3)}`));
		}
		if (areExperimentalFeaturesEnabled()) {
			statsParts.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
		}

		let statsLeft = statsParts.join(" ");

		// Calculate available space for padding (minimum 2 spaces between stats and model)
		const minPadding = 2;

		const rightSideWithoutProvider = sessionModel ? sessionModel.label : this.describeLiveModel();

		// Extension statuses, sorted by key. They join the stats line when they fit next to the model,
		// and take a line of their own otherwise.
		const statusText = Array.from(this.footerData.getExtensionStatuses().entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => sanitizeStatusText(text))
			.join(" ");
		const inlineStatuses =
			statusText !== "" &&
			visibleWidth(statsLeft) + 1 + visibleWidth(statusText) + minPadding + visibleWidth(rightSideWithoutProvider) <=
				width;
		if (inlineStatuses) statsLeft = `${statsLeft} ${statusText}`;

		let statsLeftWidth = visibleWidth(statsLeft);

		// If statsLeft is too wide, truncate it
		if (statsLeftWidth > width) {
			statsLeft = truncateToWidth(statsLeft, width, "...");
			statsLeftWidth = visibleWidth(statsLeft);
		}

		// Prepend the provider in parentheses if there are multiple providers and there's enough room
		let rightSide = rightSideWithoutProvider;
		if (!sessionModel && this.footerData.getAvailableProviderCount() > 1 && state.model) {
			rightSide = `(${state.model!.provider}) ${rightSideWithoutProvider}`;
			if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
				// Too wide, fall back
				rightSide = rightSideWithoutProvider;
			}
		}

		const rightSideWidth = visibleWidth(rightSide);
		const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

		let statsLine: string;
		if (totalNeeded <= width) {
			// Both fit - add padding to right-align model
			const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
			statsLine = statsLeft + padding + rightSide;
		} else {
			// Need to truncate right side
			const availableForRight = width - statsLeftWidth - minPadding;
			if (availableForRight > 0) {
				const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
				const truncatedRightWidth = visibleWidth(truncatedRight);
				const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
				statsLine = statsLeft + padding + truncatedRight;
			} else {
				// Not enough space for right side at all
				statsLine = statsLeft;
			}
		}

		// Apply dim to each part separately. statsLeft may contain color codes (for context %)
		// that end with a reset, which would clear an outer dim wrapper. So we dim the parts
		// before and after the colored section independently.
		const dimStatsLeft = theme.fg("dim", statsLeft);
		const remainder = statsLine.slice(statsLeft.length); // padding + rightSide
		const dimRemainder = theme.fg("dim", remainder);

		const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
		const lines = [pwdLine, dimStatsLeft + dimRemainder];

		if (statusText !== "" && !inlineStatuses) {
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(truncateToWidth(statusText, width, theme.fg("dim", "...")));
		}

		return lines;
	}

	/** The live model's id, its thinking level if it reasons, and where a virtual model routed the latest response. */
	private describeLiveModel(): string {
		const state = this.session.state;
		const modelName = state.model?.id || "no-model";
		let description = modelName;
		if (state.model?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			description = thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
		}
		const routed = this.session.routedModel;
		if (routed) {
			const level = routed.thinkingLevel ? ` • ${routed.thinkingLevel}` : "";
			description += ` → ${routed.model.id}${level}`;
		}
		return description;
	}
}

/** `provider/model • level` from the current branch's entries; the level is left out when thinking is off. */
function describeSessionModel(sessionManager: AgentSession["sessionManager"]): SessionModel {
	const { model, thinkingLevel } = sessionManager.getBranchModelSettings();
	const name = model ? `${model.provider}/${model.modelId}` : "no-model";
	return { provider: model?.provider, label: thinkingLevel === "off" ? name : `${name} • ${thinkingLevel}` };
}
