/** pi-codex-usage
 *
 * Purpose: show current ChatGPT-backed Codex usage windows through
 * `/codex-usage` and publish a compact value for pi-footer-compositor.
 *
 * Strategy: reuse Pi's openai-codex OAuth access token to query the
 * undocumented ChatGPT `/wham/usage` endpoint. Refresh at TUI startup, after
 * the agent settles, and periodically while idle, only for openai-codex models.
 * The command queries the same source regardless of model. Validate responses
 * before publishing and age cached values independently of refresh attempts.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (5.6)
 * License: MIT
 * Version: 0.1
 * Date: 2026-07-16
 * Last verified with Pi: 1.1.0 (automated; mocked auth/HTTP)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const USAGE_PROVIDER = "openai-codex";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const AUTH_CLAIM = "https://api.openai.com/auth";
const REQUEST_TIMEOUT_MS = 15_000;
const BACKGROUND_REFRESH_INTERVAL_MS = 5 * 60_000;
const DISPLAY_REFRESH_INTERVAL_MS = 1_000;
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

interface UsageSnapshot {
	usage: UsageResponse;
	accountId: string;
}

class UsageError extends Error {}
class RefreshCancelled extends Error {}

function isFooterModel(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === USAGE_PROVIDER;
}

function extractAccountId(token: string): string {
	const parts = token.split(".");
	if (parts.length !== 3) {
		throw new UsageError(`The ${USAGE_PROVIDER} credential is not a ChatGPT OAuth token. Run /login again.`);
	}

	let payload: unknown;
	try {
		payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
	} catch {
		throw new UsageError(`Could not decode the ${USAGE_PROVIDER} ChatGPT OAuth token.`);
	}

	const claim = payload && typeof payload === "object" ? (payload as Record<string, unknown>)[AUTH_CLAIM] : undefined;
	const accountId = claim && typeof claim === "object" ? (claim as Record<string, unknown>).chatgpt_account_id : undefined;
	if (typeof accountId !== "string" || !accountId || /[^\x21-\x7e]/.test(accountId)) {
		throw new UsageError(`The ${USAGE_PROVIDER} OAuth token does not contain a usable ChatGPT account ID.`);
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

async function resolveChatGPTAuth(registry: ExtensionContext["modelRegistry"], signal: AbortSignal) {
	signal.throwIfAborted();
	const loginAdvice = "Run /login and choose OpenAI Codex (legacy).";
	if (!registry.getProvider(USAGE_PROVIDER)) {
		throw new UsageError("The openai-codex provider is unavailable in Pi.");
	}
	let auth;
	try {
		auth = await withAbort(registry.getProviderAuth(USAGE_PROVIDER), signal);
	} catch {
		if (signal.aborted) throw signal.reason;
		throw new UsageError(`Pi could not resolve openai-codex credentials. ${loginAdvice}`);
	}
	if (auth?.source !== "OAuth") {
		throw new UsageError(`No openai-codex ChatGPT OAuth login is available for Codex usage. ${loginAdvice}`);
	}
	const token = auth.auth.apiKey;
	if (!token) throw new UsageError("Pi did not provide a ChatGPT access token for openai-codex.");
	return { token, accountId: extractAccountId(token) };
}

async function fetchUsage(
	ctx: ExtensionContext,
	signal: AbortSignal,
	onAccount: (accountId: string) => void,
): Promise<UsageSnapshot> {
	const registry = ctx.modelRegistry;
	const deadline = new AbortController();
	const requestSignal = AbortSignal.any([signal, deadline.signal]);
	const timeout = setTimeout(() => deadline.abort(), REQUEST_TIMEOUT_MS);
	timeout.unref();
	try {
		const { token, accountId } = await resolveChatGPTAuth(registry, requestSignal);
		requestSignal.throwIfAborted();
		onAccount(accountId);
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
				throw new UsageError(`ChatGPT rejected the openai-codex credentials (HTTP ${response.status}). Run /login and choose OpenAI Codex (legacy).`);
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
		return { usage: parseUsage(payload), accountId };
	} catch (error) {
		if (signal.aborted) throw new RefreshCancelled("Codex usage refresh cancelled.");
		if (deadline.signal.aborted) throw new UsageError("Codex usage refresh timed out after 15 seconds.");
		throw error instanceof UsageError ? error : new UsageError("Could not reach the ChatGPT usage endpoint.");
	} finally {
		clearTimeout(timeout);
	}
}

function getWindows(usage: UsageResponse): UsageWindow[] {
	return [usage.rate_limit?.primary_window, usage.rate_limit?.secondary_window].filter(assertWindow);
}

function formatUsage(snapshot: UsageSnapshot): string {
	const { usage } = snapshot;
	const windows = getWindows(usage);
	if (windows.length === 0) {
		throw new UsageError("The ChatGPT usage response did not contain any Codex usage windows.");
	}

	const plan = usage.plan_type ? ` (${usage.plan_type})` : "";
	return [`Codex usage${plan}`, `Provider: ${USAGE_PROVIDER}`, ...windows.map(formatWindow)].join("\n");
}

function compactWindow(window: UsageWindow): string {
	const used = Math.round(window.used_percent * 10) / 10;
	if (window.limit_window_seconds === 5 * 60 * 60) return `5h${used}%`;
	if (window.limit_window_seconds === 7 * 24 * 60 * 60) return `W${used}%`;
	return `${windowName(window.limit_window_seconds)}${used}%`;
}

function renderFooterStatus(ctx: ExtensionContext, snapshot: UsageSnapshot, stale = false): string | undefined {
	if (ctx.mode !== "tui") return undefined;
	const windows = getWindows(snapshot.usage);
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
	let closed = false;
	let generation = 0;
	let latestCtx: ExtensionContext | undefined;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let nextRefreshAt = 0;
	let latestUsage: UsageSnapshot | undefined;
	let latestUsageAt = 0;
	let footerStatusPublished = false;
	let publishedFooterStatus: string | undefined;
	type Request = {
		controller: AbortController;
		generation: number;
		task?: Promise<UsageSnapshot>;
	};
	let inFlight: Request | undefined;

	function isCurrent(request: Request): boolean {
		return !closed && generation === request.generation && inFlight === request;
	}

	function publishFooterStatus(ctx: ExtensionContext, value: string | undefined): void {
		if (footerStatusPublished && publishedFooterStatus === value) return;
		footerStatusPublished = true;
		publishedFooterStatus = value;
		ctx.ui.setStatus(FOOTER_STATUS_KEY, value);
	}

	function publishCachedStatus(ctx: ExtensionContext): void {
		if (closed || ctx.mode !== "tui") return;
		if (!isFooterModel(ctx)) {
			if (footerStatusPublished && publishedFooterStatus !== undefined) publishFooterStatus(ctx, undefined);
			return;
		}
		const age = Date.now() - latestUsageAt;
		const value = !latestUsage || age >= UNKNOWN_AFTER_MS
			? renderUnknownFooterStatus(ctx)
			: renderFooterStatus(ctx, latestUsage, age >= STALE_AFTER_MS);
		// Rebuild styling from the current theme, including during outages and
		// busy agent turns. Only changed output causes a UI update.
		publishFooterStatus(ctx, value);
	}

	function clearCache(): void {
		latestUsage = undefined;
		latestUsageAt = 0;
	}

	function refresh(ctx: ExtensionContext): Promise<UsageSnapshot> {
		if (closed) return Promise.reject(new RefreshCancelled());
		latestCtx = ctx;
		if (inFlight?.task) return inFlight.task;
		publishCachedStatus(ctx);
		nextRefreshAt = Date.now() + BACKGROUND_REFRESH_INTERVAL_MS;
		const request: Request = { controller: new AbortController(), generation };
		inFlight = request;
		request.task = (async () => {
			try {
				const snapshot = await fetchUsage(ctx, request.controller.signal, (accountId) => {
					if (!isCurrent(request)) return;
					if (latestUsage && latestUsage.accountId !== accountId) {
						clearCache();
						publishCachedStatus(latestCtx ?? ctx);
					}
				});
				if (!isCurrent(request)) throw new RefreshCancelled();
				latestUsage = snapshot;
				latestUsageAt = Date.now();
				publishCachedStatus(latestCtx ?? ctx);
				return snapshot;
			} catch (error) {
				if (isCurrent(request)) publishCachedStatus(latestCtx ?? ctx);
				throw error;
			} finally {
				// An older task must not clear a newer request's controller or task.
				if (inFlight === request) inFlight = undefined;
			}
		})();
		return request.task;
	}

	function refreshInBackground(ctx: ExtensionContext): void {
		if (!isFooterModel(ctx)) return;
		void refresh(ctx).catch(() => {
			// The footer reflects failures; only explicit commands notify.
		});
	}

	function resetSession(): void {
		generation++;
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = undefined;
		inFlight?.controller.abort();
		inFlight = undefined;
		latestCtx = undefined;
		clearCache();
		footerStatusPublished = false;
		publishedFooterStatus = undefined;
	}

	pi.on("session_start", (_event, ctx) => {
		const hadFooter = footerStatusPublished && publishedFooterStatus !== undefined;
		resetSession();
		closed = false;
		if (ctx.mode !== "tui") return;
		latestCtx = ctx;
		if (hadFooter && !isFooterModel(ctx)) publishFooterStatus(ctx, undefined);
		refreshInBackground(ctx);
		refreshTimer = setInterval(() => {
			const ctx = latestCtx;
			if (closed || !ctx) return;
			publishCachedStatus(ctx);
			if (isFooterModel(ctx) && !inFlight && Date.now() >= nextRefreshAt && ctx.isIdle()) refreshInBackground(ctx);
		}, DISPLAY_REFRESH_INTERVAL_MS);
		refreshTimer.unref();
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!closed && ctx.mode === "tui") refreshInBackground(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		if (closed || ctx.mode !== "tui") return;
		latestCtx = ctx;
		publishCachedStatus(ctx);
		refreshInBackground(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (closed) return;
		const hadFooter = footerStatusPublished;
		closed = true;
		resetSession();
		if (hadFooter && ctx.mode === "tui") ctx.ui.setStatus(FOOTER_STATUS_KEY, undefined);
	});

	pi.registerCommand("codex-usage", {
		description: "Show current ChatGPT Codex usage windows",
		handler: async (_args, ctx) => {
			if (closed) return;
			if (!ctx.hasUI) throw new UsageError("/codex-usage requires TUI or RPC mode; no usage request was made.");
			const scope = generation;
			try {
				const snapshot = await refresh(ctx);
				if (closed || generation !== scope) return;
				ctx.ui.notify(formatUsage(snapshot), "info");
			} catch (error) {
				if (closed || generation !== scope || error instanceof RefreshCancelled) return;
				const message = error instanceof UsageError ? error.message : "Could not refresh Codex usage.";
				ctx.ui.notify(`pi-codex-usage: ${message}`, "error");
			}
		},
	});
}
