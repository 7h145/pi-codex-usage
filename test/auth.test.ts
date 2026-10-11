import assert from "node:assert/strict";
import { test } from "node:test";
import { deferred, fixture, flush, oauth, response, token, usage } from "./helpers.ts";

test("always uses legacy OAuth even when openai is selected and both logins exist", async (t) => {
	const f = fixture(t);
	f.setProvider("openai");
	f.setAuth(async (id) => oauth(`synthetic-${id}`));
	await f.command();
	assert.deepEqual(f.authCalls, ["openai-codex"]);
	assert.equal(f.requests[0].url, "https://chatgpt.com/backend-api/wham/usage");
	assert.deepEqual(f.requests[0].init.headers, {
		Authorization: `Bearer ${token("synthetic-openai-codex")}`,
		"ChatGPT-Account-Id": "synthetic-openai-codex", Accept: "application/json", Originator: "pi-codex-usage",
	});
	assert.equal(f.requests[0].init.redirect, "error");
	assert.match(f.notices[0].message, /Provider: openai-codex\n/);
	assert.equal(f.statuses.length, 0);
});

for (const source of [undefined, "OPENAI_API_KEY"]) {
	test(`missing legacy OAuth (${source}) never falls back to a modern login`, async (t) => {
		const f = fixture(t);
		f.setProvider("openai");
		f.setAuth(async (id) => id === "openai" ? oauth() : source ? { source, auth: { apiKey: token("synthetic-key") } } : undefined);
		await f.command();
		assert.deepEqual(f.authCalls, ["openai-codex"]);
		assert.equal(f.requests.length, 0);
		assert.match(f.notices[0].message, /No openai-codex ChatGPT OAuth login.*Run \/login and choose OpenAI Codex \(legacy\)/);
		assert.doesNotMatch(f.notices[0].message, /Sign in with ChatGPT|OpenAI →/);
		assert.equal(f.statuses.length, 0);
	});
}

test("reports credential resolution failure without exposing SDK error details", async (t) => {
	const f = fixture(t);
	f.setAuth(async () => { throw new Error("SYNTHETIC_PRIVATE_REFRESH_BODY"); });
	await f.command();
	assert.deepEqual(f.authCalls, ["openai-codex"]);
	assert.match(f.notices[0].message, /Pi could not resolve openai-codex credentials/);
	assert.doesNotMatch(f.notices[0].message, /PRIVATE_REFRESH|not logged in/);
	assert.match(f.notices[0].message, /Run \/login and choose OpenAI Codex \(legacy\)/);
});

test("rejected legacy credentials never cause a modern usage request", async (t) => {
	const f = fixture(t);
	f.setProvider("anthropic");
	f.setAuth(async () => oauth());
	f.setFetch(async () => response({}, 403));
	await f.command();
	assert.deepEqual(f.authCalls, ["openai-codex"]);
	assert.equal(f.requests.length, 1);
	assert.match(f.notices[0].message, /rejected the openai-codex credentials \(HTTP 403\)/);
	assert.match(f.notices[0].message, /Run \/login and choose OpenAI Codex \(legacy\)/);
	assert.equal(f.statuses.length, 0);
});

for (const invalidToken of ["not-a-jwt", "synthetic.!.signature", "synthetic.bnVsbA.signature", "synthetic.e30.signature", token("unsafe\nheader")]) {
	test(`rejects unusable legacy OAuth claims without a request: ${JSON.stringify(invalidToken)}`, async (t) => {
		const f = fixture(t);
		f.setAuth(async () => ({ source: "OAuth", auth: { apiKey: invalidToken } }));
		await f.command();
		assert.equal(f.requests.length, 0);
		assert.equal(f.notices[0].type, "error");
	});
}

test("the deadline covers stalled credential resolution and releases the shared refresh", async (t) => {
	const f = fixture(t);
	const pending = deferred<ReturnType<typeof oauth> | undefined>();
	f.setAuth(() => pending.promise);
	const first = f.command();
	await flush();
	await f.tick(15_000);
	await first;
	assert.match(f.notices[0].message, /timed out after 15 seconds/);
	assert.equal(f.requests.length, 0);
	f.setAuth(async () => oauth());
	await f.command();
	assert.equal(f.notices.at(-1)?.type, "info");
	pending.reject(new Error("SYNTHETIC_LATE_REFRESH_ERROR"));
	await flush();
	assert.equal(f.requests.length, 1);
	assert.equal(f.notices.length, 2);
});

test("the deadline covers HTTP even if the transport ignores cancellation", async (t) => {
	const f = fixture(t);
	const pending = deferred<Response>();
	f.setFetch(() => pending.promise);
	const task = f.command();
	await flush();
	await f.tick(15_000);
	await task;
	assert.match(f.notices[0].message, /timed out/);
	assert.equal(f.requests[0].init.signal?.aborted, true);
	pending.resolve(response());
	await flush();
	assert.equal(f.notices.length, 1);
});

test("the deadline also covers response-body parsing and is cleared on success", async (t) => {
	const f = fixture(t);
	const pending = deferred<unknown>();
	const res = response();
	t.mock.method(res, "json", () => pending.promise);
	f.setFetch(async () => res);
	const task = f.command();
	await flush();
	await f.tick(15_000);
	await task;
	assert.match(f.notices[0].message, /timed out/);
	pending.resolve(usage());
	await flush();
	f.setFetch(async () => response());
	await f.command();
	assert.equal(f.timers.size, 0);
});
