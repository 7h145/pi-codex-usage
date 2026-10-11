import assert from "node:assert/strict";
import { test } from "node:test";
import { deferred, fixture, flush, oauth, response, token, usage } from "./helpers.ts";

test("uses Sign in with ChatGPT credentials for the openai provider", async (t) => {
	const f = fixture(t);
	f.setProvider("openai");
	f.setAuth(async (id) => id === "openai" ? oauth("synthetic-modern") : oauth("synthetic-legacy"));
	await f.command();
	assert.deepEqual(f.authCalls, ["openai"]);
	assert.equal(f.requests[0].url, "https://chatgpt.com/backend-api/wham/usage");
	assert.deepEqual(f.requests[0].init.headers, {
		Authorization: `Bearer ${token("synthetic-modern")}`,
		"ChatGPT-Account-Id": "synthetic-modern", Accept: "application/json", Originator: "pi-codex-usage",
	});
	assert.equal(f.requests[0].init.redirect, "error");
	assert.match(f.notices[0].message, /Provider: openai\n/);
});

test("keeps legacy OAuth first for a selected legacy model", async (t) => {
	const f = fixture(t);
	f.setAuth(async (id) => oauth(`synthetic-${id}`));
	await f.command();
	assert.deepEqual(f.authCalls, ["openai-codex"]);
	assert.match(f.notices[0].message, /Provider: openai-codex/);
});

test("prefers modern OAuth when another provider's model is selected", async (t) => {
	const f = fixture(t);
	f.setProvider("anthropic");
	f.setAuth(async () => oauth());
	await f.command();
	assert.deepEqual(f.authCalls, ["openai"]);
});

test("skips API-key auth, even if the value looks like a JWT", async (t) => {
	const f = fixture(t);
	f.setProvider("openai");
	f.setAuth(async (id) => id === "openai" ? { source: "OPENAI_API_KEY", auth: { apiKey: token("synthetic-api-key") } } : oauth());
	await f.command();
	assert.deepEqual(f.authCalls, ["openai", "openai-codex"]);
	assert.equal((f.requests[0].init.headers as Record<string, string>)["ChatGPT-Account-Id"], "synthetic-account");
});

test("explains missing OAuth without making a usage request", async (t) => {
	const f = fixture(t);
	f.setProvider("openai");
	f.setAuth(async () => undefined);
	await f.command();
	assert.equal(f.requests.length, 0);
	assert.match(f.notices[0].message, /No ChatGPT OAuth login.*Sign in with ChatGPT/);
});

test("reports credential resolution failure without exposing SDK error details", async (t) => {
	const f = fixture(t);
	f.setAuth(async () => { throw new Error("SYNTHETIC_PRIVATE_REFRESH_BODY"); });
	await f.command();
	assert.match(f.notices[0].message, /Pi could not resolve openai-codex credentials/);
	assert.doesNotMatch(f.notices[0].message, /PRIVATE_REFRESH|not logged in/);
});

test("does not fall back to another account after rejection", async (t) => {
	const f = fixture(t);
	f.setProvider("openai");
	f.setAuth(async () => oauth());
	f.setFetch(async () => response({}, 403));
	await f.command();
	assert.deepEqual(f.authCalls, ["openai"]);
	assert.equal(f.requests.length, 1);
	assert.match(f.notices[0].message, /rejected the openai ChatGPT OAuth token \(HTTP 403\)/);
	assert.match(f.notices[0].message, /does not mean your model login failed/);
	assert.match(f.notices[0].message, /No legacy credentials were tried/);
	assert.doesNotMatch(f.notices[0].message, /Run \/login/);
});

for (const invalidToken of ["not-a-jwt", "synthetic.!.signature", "synthetic.bnVsbA.signature", "synthetic.e30.signature", token("unsafe\nheader")]) {
	test(`rejects unusable OAuth claims without a request: ${JSON.stringify(invalidToken)}`, async (t) => {
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
