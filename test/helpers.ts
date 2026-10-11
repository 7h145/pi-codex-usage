import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import type { TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import extension from "../pi-codex-usage.ts";

export const STATUS_KEY = "footer-compositor:right:20:codex-usage";
export const MINUTE = 60_000;
export const flush = () => setImmediate();
export function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}
export function token(accountId = "synthetic-account"): string {
	return `synthetic.${Buffer.from(JSON.stringify({
		"https://api.openai.com/auth": { chatgpt_account_id: accountId },
	})).toString("base64url")}.signature`;
}
export function oauth(accountId = "synthetic-account") {
	return { source: "OAuth", auth: { apiKey: token(accountId) } };
}
export function modernOAuth(subject = "synthetic-modern-user") {
	const payload = { iss: "https://auth.openai.com", aud: "https://api.openai.com/v1", sub: subject };
	return { source: "OAuth", auth: { apiKey: `synthetic.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature` } };
}
export function usage(percent = 23) {
	return {
		plan_type: "plus",
		rate_limit: {
			primary_window: { used_percent: percent, limit_window_seconds: 18_000, reset_at: 1_900_010_000 },
			secondary_window: { used_percent: 48, limit_window_seconds: 604_800, reset_at: 1_900_400_000 },
		},
	};
}
export const response = (body: unknown = usage(), status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Timer = { callback: () => void; at: number; interval: number; unref: () => Timer };
export function fixture(t: TestContext, mode: "tui" | "rpc" | "print" | "json" = "tui") {
	let now = 1_900_000_000_000;
	const timers = new Set<Timer>();
	const schedule = (callback: () => void, ms = 0, interval = 0): Timer => {
		const timer: Timer = { callback, at: now + ms, interval, unref: () => timer };
		timers.add(timer);
		return timer;
	};
	t.mock.method(Date, "now", () => now);
	t.mock.method(globalThis, "setTimeout", (callback: () => void, ms: number) => schedule(callback, ms));
	t.mock.method(globalThis, "setInterval", (callback: () => void, ms: number) => schedule(callback, ms, ms));
	t.mock.method(globalThis, "clearTimeout", (timer: Timer) => timers.delete(timer));
	t.mock.method(globalThis, "clearInterval", (timer: Timer) => timers.delete(timer));
	// Node's AbortSignal.timeout uses internal timers, outside the fake clock.
	t.mock.method(AbortSignal, "timeout", (ms: number) => {
		const controller = new AbortController();
		schedule(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
		return controller.signal;
	});

	let alive = true;
	let idle = true;
	let provider: string = "openai-codex";
	let theme = "initial";
	let stopped = false;
	const assertAlive = () => assert.ok(alive, "accessed a disposed Pi context");
	const statuses: Array<{ key: string; value: string | undefined }> = [];
	const notices: Array<{ message: string; type: string }> = [];
	const authCalls: string[] = [];
	const requests: Array<{ url: string; init: RequestInit }> = [];
	let resolveAuth: (provider: string) => Promise<ReturnType<typeof oauth> | undefined> = async (id) =>
		id === "openai-codex" ? oauth() : undefined;
	let fetchResponse: (init: RequestInit) => Promise<Response> = async () => response();
	const registry = {
		getProvider: (id: string) => ({ id }),
		getProviderAuth: async (id: string) => { authCalls.push(id); return resolveAuth(id); },
		getApiKeyForProvider: async (id: string) => {
			authCalls.push(id);
			try { return (await resolveAuth(id))?.auth.apiKey; } catch { return undefined; }
		},
	};
	const ui = {
		get theme() { assertAlive(); return { fg: (color: string, value: string) => `${theme}:${color}:${value}` }; },
		setStatus: (key: string, value: string | undefined) => { assertAlive(); statuses.push({ key, value }); },
		notify: (message: string, type = "info") => { assertAlive(); notices.push({ message, type }); },
	};
	const ctx = {
		get mode() { assertAlive(); return mode; },
		get hasUI() { assertAlive(); return mode === "tui" || mode === "rpc"; },
		get model() { assertAlive(); return { provider }; },
		get modelRegistry() { assertAlive(); return registry; },
		get ui() { assertAlive(); return ui; },
		isIdle: () => { assertAlive(); return idle; },
	} as unknown as ExtensionCommandContext;
	t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
		requests.push({ url, init });
		return fetchResponse(init);
	});
	const handlers = new Map<string, (_event: unknown, ctx: ExtensionCommandContext) => unknown>();
	let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	const pi = {
		on: (name: string, handler: (_event: unknown, ctx: ExtensionCommandContext) => unknown) => {
			handlers.set(name, handler);
		},
		registerCommand: (name: string, options: { handler: typeof command }) => {
			assert.equal(name, "codex-usage");
			command = options.handler;
		},
	} as unknown as ExtensionAPI;
	extension(pi);
	const emit = (name: string) => handlers.get(name)?.({}, ctx);
	const stop = () => { emit("session_shutdown"); stopped = true; };
	t.after(() => { if (!stopped && alive) stop(); });
	return {
		ctx, statuses, notices, authCalls, requests, timers,
		start: () => { stopped = false; emit("session_start"); },
		stop, emit, command: () => command("", ctx),
		invalidate: () => { alive = false; },
		setIdle: (value: boolean) => { idle = value; },
		setTheme: (value: string) => { theme = value; },
		setProvider: (value: string) => { provider = value; },
		setAuth: (fn: typeof resolveAuth) => { resolveAuth = fn; },
		setFetch: (fn: typeof fetchResponse) => { fetchResponse = fn; },
		status: () => statuses.at(-1)?.value,
		jump: (ms: number) => { now += ms; },
		async tick(ms: number) {
			const end = now + ms;
			for (;;) {
				const next = [...timers].filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
				if (!next) break;
				now = Math.max(now, next.at);
				if (next.interval) next.at = now + next.interval;
				else timers.delete(next);
				next.callback();
				await flush();
			}
			now = end;
			await flush();
		},
	};
}
