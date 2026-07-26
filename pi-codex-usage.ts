/** pi-codex-usage
 *
 * Purpose: show current ChatGPT-backed Codex usage windows through
 * `/codex-usage` and publish a compact value for pi-footer-compositor.
 *
 * Strategy: reuse Pi's OpenAI Codex OAuth access token to query the
 * undocumented ChatGPT `/wham/usage` endpoint. Refresh at TUI startup, after
 * the agent settles, and periodically while idle. Validate responses before
 * publishing and degrade stale values to `?` when refreshes keep failing.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (5.6)
 * License: CC BY 4.0
 * Version: 0.1
 * Date: 2026-07-16
 * Last verified with Pi: 0.80.6
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const AUTH_CLAIM = "https://api.openai.com/auth";
const REQUEST_TIMEOUT_MS = 15_000;
const BACKGROUND_REFRESH_INTERVAL_MS = 5 * 60_000;
const STALE_AFTER_MS = 15 * 60_000;
const UNKNOWN_AFTER_MS = 60 * 60_000;
const FOOTER_STATUS_KEY = "footer-compositor:right:20:codex-usage";

interface UsageWindow {
	used_percent: number;
	limit_window_seconds: number;
	reset_after_seconds?: number;
	reset_at: number;
}

interface UsageResponse {
	plan_type?: string;
	rate_limit?: {
		primary_window?: UsageWindow | null;
		secondary_window?: UsageWindow | null;
	} | null;
}

function extractAccountId(token: string): string {
	const parts = token.split(".");
	if (parts.length !== 3) {
		throw new Error("OpenAI Codex is not using ChatGPT OAuth. Run /login and select OpenAI Codex.");
	}

	let payload: unknown;
	try {
		payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
	} catch {
		throw new Error("Could not decode the OpenAI Codex OAuth token.");
	}

	const accountId = (payload as Record<string, any>)?.[AUTH_CLAIM]?.chatgpt_account_id;
	if (typeof accountId !== "string" || !accountId) {
		throw new Error("The OpenAI Codex OAuth token does not contain a ChatGPT account ID.");
	}
	return accountId;
}

function assertWindow(value: unknown): value is UsageWindow {
	if (!value || typeof value !== "object") return false;
	const window = value as Partial<UsageWindow>;
	return (
		typeof window.used_percent === "number" &&
		Number.isFinite(window.used_percent) &&
		typeof window.limit_window_seconds === "number" &&
		Number.isFinite(window.limit_window_seconds) &&
		typeof window.reset_at === "number" &&
		Number.isFinite(window.reset_at)
	);
}

function windowName(windowSeconds: number): string {
	if (windowSeconds === 5 * 60 * 60) return "5h";
	if (windowSeconds === 7 * 24 * 60 * 60) return "Week";

	const hours = windowSeconds / 3600;
	if (Number.isInteger(hours)) return `${hours}h`;
	return `${Math.round(windowSeconds / 60)}m`;
}

function relativeReset(resetAtSeconds: number): string {
	const remainingSeconds = Math.max(0, Math.round(resetAtSeconds - Date.now() / 1000));
	if (remainingSeconds < 60) return "in <1m";

	const totalMinutes = Math.ceil(remainingSeconds / 60);
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;

	if (days > 0) return `in ${days}d ${hours}h`;
	if (hours > 0) return `in ${hours}h ${minutes}m`;
	return `in ${minutes}m`;
}

function formatWindow(window: UsageWindow): string {
	const used = Math.round(window.used_percent * 10) / 10;
	return `${windowName(window.limit_window_seconds)}: ${used}% used, resets ${relativeReset(window.reset_at)}`;
}

async function fetchUsage(ctx: ExtensionContext, signal?: AbortSignal): Promise<UsageResponse> {
	const token = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
	if (!token) {
		throw new Error("OpenAI Codex is not logged in. Run /login and select OpenAI Codex.");
	}

	const accountId = extractAccountId(token);
	const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const response = await fetch(USAGE_URL, {
		signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
		headers: {
			Authorization: `Bearer ${token}`,
			"ChatGPT-Account-Id": accountId,
			Accept: "application/json",
			Originator: "pi-codex-usage",
		},
	});

	if (!response.ok) {
		if (response.status === 401 || response.status === 403) {
			throw new Error(`ChatGPT rejected the Codex credentials (HTTP ${response.status}).`);
		}
		throw new Error(`ChatGPT usage request failed (HTTP ${response.status}).`);
	}

	const payload: unknown = await response.json();
	if (!payload || typeof payload !== "object") {
		throw new Error("The ChatGPT usage response has an unexpected format.");
	}

	const usage = payload as UsageResponse;
	if (getWindows(usage).length === 0) {
		throw new Error("The ChatGPT usage response did not contain any Codex usage windows.");
	}
	return usage;
}

function getWindows(usage: UsageResponse): UsageWindow[] {
	return [usage.rate_limit?.primary_window, usage.rate_limit?.secondary_window].filter(assertWindow);
}

function formatUsage(usage: UsageResponse): string {
	const windows = getWindows(usage);
	if (windows.length === 0) {
		throw new Error("The ChatGPT usage response did not contain any Codex usage windows.");
	}

	const plan = usage.plan_type ? ` (${usage.plan_type})` : "";
	return [`Codex usage${plan}`, ...windows.map(formatWindow)].join("\n");
}

function compactWindow(window: UsageWindow): string {
	const used = Math.round(window.used_percent * 10) / 10;
	if (window.limit_window_seconds === 5 * 60 * 60) return `5h${used}%`;
	if (window.limit_window_seconds === 7 * 24 * 60 * 60) return `W${used}%`;
	return `${windowName(window.limit_window_seconds)}${used}%`;
}

function renderFooterStatus(ctx: ExtensionContext, usage: UsageResponse, stale = false): string | undefined {
	if (ctx.mode !== "tui") return undefined;
	const windows = getWindows(usage);
	if (windows.length === 0) return undefined;

	const text = `C ${windows.map(compactWindow).join(" ")}${stale ? "?" : ""}`;
	const highestUsage = Math.max(...windows.map((window) => window.used_percent));
	return highestUsage > 90
		? ctx.ui.theme.fg("error", text)
		: stale || highestUsage > 70
			? ctx.ui.theme.fg("warning", text)
			: ctx.ui.theme.fg("dim", text);
}

function renderUnknownFooterStatus(ctx: ExtensionContext): string | undefined {
	return ctx.mode === "tui" ? ctx.ui.theme.fg("warning", "C ?") : undefined;
}

export default function (pi: ExtensionAPI) {
	let sessionActive = false;
	let latestCtx: ExtensionContext | undefined;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let requestController: AbortController | undefined;
	let refreshInFlight: Promise<UsageResponse> | undefined;
	let latestUsage: UsageResponse | undefined;
	let latestUsageAt = 0;
	let footerStatusPublished = false;
	let publishedFooterStatus: string | undefined;

	function publishFooterStatus(ctx: ExtensionContext, value: string | undefined): void {
		if (ctx.mode !== "tui") return;
		if (footerStatusPublished && publishedFooterStatus === value) return;
		footerStatusPublished = true;
		publishedFooterStatus = value;
		ctx.ui.setStatus(FOOTER_STATUS_KEY, value);
	}

	function publishRefreshFailure(ctx: ExtensionContext): void {
		if (!sessionActive || ctx.mode !== "tui") return;
		if (!latestUsage) {
			publishFooterStatus(ctx, renderUnknownFooterStatus(ctx));
			return;
		}

		const age = Date.now() - latestUsageAt;
		if (age >= UNKNOWN_AFTER_MS) publishFooterStatus(ctx, renderUnknownFooterStatus(ctx));
		else if (age >= STALE_AFTER_MS) publishFooterStatus(ctx, renderFooterStatus(ctx, latestUsage, true));
		// For short outages, leave the recent successful value unchanged.
	}

	async function refresh(ctx: ExtensionContext): Promise<UsageResponse> {
		latestCtx = ctx;
		if (refreshInFlight) return refreshInFlight;

		requestController = new AbortController();
		const task = fetchUsage(ctx, requestController.signal);
		refreshInFlight = task;
		try {
			const usage = await task;
			latestUsage = usage;
			latestUsageAt = Date.now();
			if (sessionActive) publishFooterStatus(ctx, renderFooterStatus(ctx, usage));
			return usage;
		} catch (error) {
			publishRefreshFailure(ctx);
			throw error;
		} finally {
			if (refreshInFlight === task) refreshInFlight = undefined;
			requestController = undefined;
		}
	}

	function refreshInBackground(ctx: ExtensionContext): void {
		void refresh(ctx).catch(() => {
			// Failure state is reflected compactly in the footer. Explicit command
			// failures are reported to the user; background failures stay quiet.
		});
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		sessionActive = true;
		latestCtx = ctx;
		refreshInBackground(ctx);

		refreshTimer = setInterval(() => {
			if (latestCtx?.isIdle()) refreshInBackground(latestCtx);
		}, BACKGROUND_REFRESH_INTERVAL_MS);
		refreshTimer.unref();
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (sessionActive) refreshInBackground(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		sessionActive = false;
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = undefined;
		latestCtx = undefined;
		requestController?.abort();
		requestController = undefined;
		refreshInFlight = undefined;
		latestUsage = undefined;
		latestUsageAt = 0;
		ctx.ui.setStatus(FOOTER_STATUS_KEY, undefined);
		footerStatusPublished = false;
		publishedFooterStatus = undefined;
	});

	pi.registerCommand("codex-usage", {
		description: "Show current ChatGPT Codex usage windows",
		handler: async (_args, ctx) => {
			try {
				ctx.ui.notify(formatUsage(await refresh(ctx)), "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`pi-codex-usage: ${message}`, "error");
			}
		},
	});
}
