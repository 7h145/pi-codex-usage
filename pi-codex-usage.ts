/** pi-codex-usage
 *
 * Purpose: show current ChatGPT-backed Codex usage windows through
 * `/codex-usage` and publish a compact value for pi-footer-compositor.
 *
 * Strategy: reuse Pi's ChatGPT OAuth access token to query the
 * undocumented ChatGPT `/wham/usage` endpoint. Refresh at TUI startup, after
 * the agent settles, and periodically while idle. Validate responses before
 * publishing and degrade stale values to `?` when refreshes keep failing.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (5.6)
 * License: MIT
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
	reset_at: number;
}

interface UsageResponse {
	plan_type?: string;
	rate_limit?: {
		primary_window?: UsageWindow | null;
		secondary_window?: UsageWindow | null;
	} | null;
}

type UsageProvider = "openai" | "openai-codex";
interface UsageSnapshot {
	usage: UsageResponse;
	provider: UsageProvider;
	accountId: string;
}

class UsageError extends Error {}
class RefreshCancelled extends Error {}

function preferredProvider(ctx: ExtensionContext): UsageProvider {
	return ctx.model?.provider === "openai-codex" ? "openai-codex" : "openai";
}

function extractAccountId(token: string, provider: UsageProvider): string {
	const parts = token.split(".");
	if (parts.length !== 3) {
		throw new UsageError(`The ${provider} credential is not a ChatGPT OAuth token. Run /login again.`);
	}

	let payload: unknown;
	try {
		payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
	} catch {
		throw new UsageError(`Could not decode the ${provider} ChatGPT OAuth token.`);
	}

	const claim = payload && typeof payload === "object" ? (payload as Record<string, unknown>)[AUTH_CLAIM] : undefined;
	const accountId = claim && typeof claim === "object" ? (claim as Record<string, unknown>).chatgpt_account_id : undefined;
	if (typeof accountId !== "string" || !accountId || /[^\x21-\x7e]/.test(accountId)) {
		throw new UsageError(`The ${provider} OAuth token does not contain a usable ChatGPT account ID.`);
	}
	return accountId;
}

function assertWindow(value: unknown): value is UsageWindow {
	if (!value || typeof value !== "object") return false;
	const window = value as Partial<UsageWindow>;
	return (
		typeof window.used_percent === "number" &&
		Number.isFinite(window.used_percent * 10) &&
		window.used_percent >= 0 &&
		typeof window.limit_window_seconds === "number" &&
		Number.isSafeInteger(window.limit_window_seconds) &&
		window.limit_window_seconds > 0 &&
		typeof window.reset_at === "number" &&
		Number.isSafeInteger(window.reset_at) &&
		window.reset_at >= 0
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseUsage(payload: unknown): UsageResponse {
	if (!isRecord(payload) || (payload.plan_type != null &&
		(typeof payload.plan_type !== "string" || payload.plan_type.length > 80 || /[\x00-\x1f\x7f]/.test(payload.plan_type)))) {
		throw new UsageError("The ChatGPT usage response has an unexpected format.");
	}
	if (payload.rate_limit == null) {
		throw new UsageError("The ChatGPT usage response did not contain any Codex usage windows.");
	}
	if (!isRecord(payload.rate_limit)) {
		throw new UsageError("The ChatGPT usage response has an unexpected format.");
	}
	const windows: UsageResponse["rate_limit"] = {};
	for (const key of ["primary_window", "secondary_window"] as const) {
		const value = payload.rate_limit[key];
		if (value == null) continue;
		// Reject the response rather than making a broken high-usage window
		// disappear beside a healthy-looking valid window.
		if (!assertWindow(value)) throw new UsageError(`The ChatGPT usage response contains an invalid ${key}.`);
		windows[key] = {
			used_percent: value.used_percent,
			limit_window_seconds: value.limit_window_seconds,
			reset_at: value.reset_at,
		};
	}
	const usage: UsageResponse = { plan_type: typeof payload.plan_type === "string" ? payload.plan_type : undefined, rate_limit: windows };
	if (getWindows(usage).length === 0) {
		throw new UsageError("The ChatGPT usage response did not contain any Codex usage windows.");
	}
	return usage;
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

// Observe late resolution/rejection even when cancellation wins. Pi owns OAuth
// refresh; we stop waiting without interfering with its credential rotation.
function withAbort<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

async function resolveChatGPTAuth(registry: ExtensionContext["modelRegistry"], preferred: UsageProvider, signal: AbortSignal) {
	const providers: UsageProvider[] = preferred === "openai" ? ["openai", "openai-codex"] : ["openai-codex", "openai"];
	for (const provider of providers) {
		signal.throwIfAborted();
		if (!registry.getProvider(provider)) continue;
		let auth;
		try {
			auth = await withAbort(registry.getProviderAuth(provider), signal);
		} catch {
			if (signal.aborted) throw signal.reason;
			throw new UsageError(`Pi could not resolve ${provider} credentials. Run /login again.`);
		}
		// Ordinary OpenAI API keys cannot query ChatGPT subscription usage.
		if (auth?.source !== "OAuth") continue;
		const token = auth.auth.apiKey;
		if (!token) throw new UsageError(`Pi did not provide a ChatGPT access token for ${provider}.`);
		return { provider, token, accountId: extractAccountId(token, provider) };
	}
	throw new UsageError("No ChatGPT OAuth login is available. Run /login and choose OpenAI → Sign in with ChatGPT, or OpenAI Codex (legacy).");
}

async function fetchUsage(ctx: ExtensionContext, signal?: AbortSignal): Promise<UsageSnapshot> {
	const registry = ctx.modelRegistry;
	const preferred = preferredProvider(ctx);
	const deadline = new AbortController();
	const requestSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
	const timeout = setTimeout(() => deadline.abort(), REQUEST_TIMEOUT_MS);
	timeout.unref();
	try {
		const { provider, token, accountId } = await resolveChatGPTAuth(registry, preferred, requestSignal);
		requestSignal.throwIfAborted();
		const response = await withAbort(fetch(USAGE_URL, {
			signal: requestSignal,
			redirect: "error",
			headers: {
				Authorization: `Bearer ${token}`,
				"ChatGPT-Account-Id": accountId,
				Accept: "application/json",
				Originator: "pi-codex-usage",
			},
		}), requestSignal);

		if (!response.ok) {
			void response.body?.cancel().catch(() => {});
			if (response.status === 401 || response.status === 403) {
				throw new UsageError(`ChatGPT rejected the ${provider} credentials (HTTP ${response.status}). Run /login again.`);
			}
			throw new UsageError(`ChatGPT usage request failed (HTTP ${response.status}).`);
		}

		let payload: unknown;
		try {
			payload = await withAbort(response.json(), requestSignal);
		} catch {
			if (requestSignal.aborted) throw requestSignal.reason;
			throw new UsageError("The ChatGPT usage response was not valid JSON.");
		}
		return { usage: parseUsage(payload), provider, accountId };
	} catch (error) {
		if (signal?.aborted) throw new RefreshCancelled("Codex usage refresh cancelled.");
		if (deadline.signal.aborted) throw new UsageError("Codex usage refresh timed out after 15 seconds.");
		throw error instanceof UsageError ? error : new UsageError("Could not reach the ChatGPT usage endpoint.");
	} finally {
		clearTimeout(timeout);
	}
}

function getWindows(usage: UsageResponse): UsageWindow[] {
	return [usage.rate_limit?.primary_window, usage.rate_limit?.secondary_window].filter(assertWindow);
}

function formatUsage(usage: UsageResponse, provider: UsageProvider): string {
	const windows = getWindows(usage);
	if (windows.length === 0) {
		throw new UsageError("The ChatGPT usage response did not contain any Codex usage windows.");
	}

	const plan = usage.plan_type ? ` (${usage.plan_type})` : "";
	return [`Codex usage${plan}`, `Provider: ${provider}`, ...windows.map(formatWindow)].join("\n");
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
	let refreshInFlight: Promise<UsageSnapshot> | undefined;
	let latestUsage: UsageSnapshot | undefined;
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
		else if (age >= STALE_AFTER_MS) publishFooterStatus(ctx, renderFooterStatus(ctx, latestUsage.usage, true));
		// For short outages, leave the recent successful value unchanged.
	}

	async function refresh(ctx: ExtensionContext): Promise<UsageSnapshot> {
		latestCtx = ctx;
		if (refreshInFlight) return refreshInFlight;

		requestController = new AbortController();
		const task = fetchUsage(ctx, requestController.signal);
		refreshInFlight = task;
		try {
			const usage = await task;
			latestUsage = usage;
			latestUsageAt = Date.now();
			if (sessionActive) publishFooterStatus(ctx, renderFooterStatus(ctx, usage.usage));
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
				const snapshot = await refresh(ctx);
				ctx.ui.notify(formatUsage(snapshot.usage, snapshot.provider), "info");
			} catch (error) {
				const message = error instanceof UsageError ? error.message : "Could not refresh Codex usage.";
				ctx.ui.notify(`pi-codex-usage: ${message}`, "error");
			}
		},
	});
}
