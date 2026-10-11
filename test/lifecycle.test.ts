import assert from "node:assert/strict";
import { test } from "node:test";
import { deferred, fixture, flush, MINUTE, oauth, response, usage } from "./helpers.ts";

test("repeated startup owns one timer and shutdown is idempotent", async (t) => {
	const f = fixture(t);
	f.start();
	await flush();
	f.start();
	await flush();
	assert.equal(f.timers.size, 1);
	f.stop();
	assert.equal(f.timers.size, 0);
	assert.equal(f.status(), undefined);
	const writes = f.statuses.length;
	f.invalidate();
	f.stop();
	f.emit("agent_settled");
	f.emit("model_select");
	await f.command();
	assert.equal(f.statuses.length, writes);
});

test("shutdown stops waiting for OAuth without accessing disposed context", async (t) => {
	const f = fixture(t);
	const pending = deferred<ReturnType<typeof oauth> | undefined>();
	f.setAuth(() => pending.promise);
	f.start();
	const command = f.command();
	await flush();
	f.stop();
	f.invalidate();
	await assert.doesNotReject(command);
	pending.resolve(oauth());
	await flush();
	assert.equal(f.requests.length, 0);
	assert.equal(f.notices.length, 0);
	assert.equal(f.timers.size, 0);
});

test("late HTTP success after shutdown cannot notify or republish", async (t) => {
	const f = fixture(t);
	const pending = deferred<Response>();
	f.setFetch(() => pending.promise);
	f.start();
	const command = f.command();
	await flush();
	f.stop();
	f.invalidate();
	await assert.doesNotReject(command);
	pending.resolve(response(usage(99)));
	await flush();
	assert.equal(f.notices.length, 0);
	assert.equal(f.status(), undefined);
	assert.equal(f.requests[0].init.signal?.aborted, true);
});

test("late body parsing after shutdown cannot notify", async (t) => {
	const f = fixture(t);
	const pending = deferred<unknown>();
	const res = response();
	t.mock.method(res, "json", () => pending.promise);
	f.setFetch(async () => res);
	const command = f.command();
	await flush();
	f.stop();
	f.invalidate();
	await assert.doesNotReject(command);
	pending.reject(new Error("SYNTHETIC_LATE_BODY_ERROR"));
	await flush();
	assert.equal(f.notices.length, 0);
});

test("shutdown during an immediately resolving body parse is also safe", async (t) => {
	const f = fixture(t);
	const res = response();
	t.mock.method(res, "json", () => {
		f.stop();
		f.invalidate();
		return Promise.resolve(usage());
	});
	f.setFetch(async () => res);
	await assert.doesNotReject(f.command());
	assert.equal(f.notices.length, 0);
	assert.equal(f.status(), undefined);
});

test("an older task cannot clear a newer request's controller", async (t) => {
	const f = fixture(t);
	const first = deferred<Response>();
	const second = deferred<Response>();
	let calls = 0;
	f.setFetch(() => ++calls === 1 ? first.promise : second.promise);
	f.start();
	await flush();
	f.start();
	await flush();
	assert.equal(f.requests.length, 2);
	assert.equal(f.requests[0].init.signal?.aborted, true);
	const command = f.command();
	await flush();
	assert.equal(f.requests.length, 2, "the command must join the newer request");
	f.stop();
	assert.equal(f.requests[1].init.signal?.aborted, true);
	await command;
	first.resolve(response(usage(99)));
	second.resolve(response(usage(75)));
	await flush();
	assert.equal(f.notices.length, 0);
	assert.equal(f.status(), undefined);
});

test("an old command cannot notify in a restarted session", async (t) => {
	const f = fixture(t);
	const pending = deferred<Response>();
	f.setFetch(() => pending.promise);
	f.start();
	const oldCommand = f.command();
	await flush();
	f.stop();
	f.setFetch(async () => response(usage(30)));
	f.start();
	await oldCommand;
	await flush();
	pending.resolve(response(usage(99)));
	await flush();
	assert.equal(f.status(), "initial:dim:C 5h30% W48%");
	assert.equal(f.notices.length, 0);
});

test("cached values age while busy, independently of requests", async (t) => {
	const f = fixture(t);
	f.start();
	await flush();
	f.setIdle(false);
	f.jump(15 * MINUTE - 1000);
	await f.tick(1000);
	assert.equal(f.status(), "initial:warning:C 5h23% W48%?");
	f.jump(45 * MINUTE - 1000);
	await f.tick(1000);
	assert.equal(f.status(), "initial:warning:C ?");
	assert.equal(f.requests.length, 1);
});

test("theme changes restyle recent cached values during failures", async (t) => {
	const f = fixture(t);
	f.start();
	await flush();
	f.setTheme("updated");
	f.setFetch(async () => response({}, 503));
	await f.command();
	assert.equal(f.status(), "updated:dim:C 5h23% W48%");
});

test("display ticks restyle while busy without fetching or redundant UI writes", async (t) => {
	const f = fixture(t);
	f.start();
	await flush();
	f.setIdle(false);
	f.setTheme("updated");
	await f.tick(1000);
	assert.equal(f.status(), "updated:dim:C 5h23% W48%");
	const writes = f.statuses.length;
	await f.tick(10_000);
	assert.equal(f.statuses.length, writes);
	assert.equal(f.requests.length, 1);
});

test("idle polling keeps its five-minute cadence after settled refreshes", async (t) => {
	const f = fixture(t);
	f.start();
	await flush();
	await f.tick(5 * MINUTE - 1);
	assert.equal(f.requests.length, 1);
	await f.tick(1);
	assert.equal(f.requests.length, 2);
	f.emit("agent_settled");
	await flush();
	assert.equal(f.requests.length, 3);
	await f.tick(5 * MINUTE - 1);
	assert.equal(f.requests.length, 3);
	await f.tick(1);
	assert.equal(f.requests.length, 4);
});

test("background and concurrent commands share one complete refresh", async (t) => {
	const f = fixture(t);
	const pending = deferred<Response>();
	f.setFetch(() => pending.promise);
	f.start();
	const first = f.command();
	const second = f.command();
	await flush();
	assert.equal(f.requests.length, 1);
	pending.resolve(response());
	await Promise.all([first, second]);
	assert.equal(f.notices.length, 2);
	assert.ok(f.notices.every((notice) => notice.type === "info"));
	assert.equal(f.status(), "initial:dim:C 5h23% W48%");
});

test("a changed OAuth account clears old usage before a failed request", async (t) => {
	const f = fixture(t);
	f.start();
	await flush();
	f.setAuth(async () => oauth("synthetic-new-account"));
	const pending = deferred<Response>();
	f.setFetch(() => pending.promise);
	const command = f.command();
	await flush();
	assert.equal(f.status(), "initial:warning:C ?");
	pending.resolve(response({}, 503));
	await command;
	assert.equal(f.status(), "initial:warning:C ?");
});

test("model selection replaces a legacy request with the modern provider", async (t) => {
	const f = fixture(t);
	f.setAuth(async (id) => oauth(`synthetic-${id}`));
	const pending = deferred<Response>();
	f.setFetch(() => pending.promise);
	f.start();
	const oldCommand = f.command();
	await flush();
	f.setProvider("openai");
	f.setFetch(async () => response(usage(31)));
	f.emit("model_select");
	await oldCommand;
	await flush();
	assert.equal(f.requests[0].init.signal?.aborted, true);
	assert.equal((f.requests[1].init.headers as Record<string, string>)["ChatGPT-Account-Id"], "synthetic-openai");
	assert.equal(f.status(), "initial:dim:C 5h31% W48%");
	assert.equal(f.notices.length, 0);
	pending.resolve(response(usage(99)));
	await flush();
	assert.equal(f.status(), "initial:dim:C 5h31% W48%");
});

for (const mode of ["print", "json"] as const) {
	test(`${mode} commands fail visibly before resolving credentials or fetching`, async (t) => {
		const f = fixture(t, mode);
		f.start();
		await assert.rejects(f.command(), /requires TUI or RPC mode; no usage request was made/);
		assert.equal(f.authCalls.length, 0);
		assert.equal(f.requests.length, 0);
		assert.equal(f.timers.size, 0);
		assert.equal(f.notices.length, 0);
		assert.equal(f.statuses.length, 0);
	});
}
