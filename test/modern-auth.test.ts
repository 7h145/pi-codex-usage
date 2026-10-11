import assert from "node:assert/strict";
import { test } from "node:test";
import { deferred, fixture, flush, modernOAuth, oauth, response, token } from "./helpers.ts";

test("modern OAuth without Codex account metadata sends no invented account header", async (t) => {
	const f = fixture(t);
	f.setProvider("openai");
	const auth = modernOAuth();
	f.setAuth(async () => auth);
	await f.command();
	assert.deepEqual(f.authCalls, ["openai"]);
	assert.deepEqual(f.requests[0].init.headers, {
		Authorization: `Bearer ${auth.auth.apiKey}`, Accept: "application/json", Originator: "pi-codex-usage",
	});
	assert.equal(f.notices[0].type, "info");
	assert.match(f.notices[0].message, /Provider: openai\n/);
	assert.doesNotMatch(f.notices[0].message, /synthetic-modern-user|signature/);
});

test("an opaque OAuth token is left to the endpoint, not decoded as legacy JWT", async (t) => {
	const f = fixture(t);
	f.setProvider("openai");
	f.setAuth(async () => ({ source: "OAuth", auth: { apiKey: "synthetic-opaque-oauth-token" } }));
	await f.command();
	assert.equal(f.requests.length, 1);
	assert.equal((f.requests[0].init.headers as Record<string, string>)["ChatGPT-Account-Id"], undefined);
	assert.equal(f.notices[0].type, "info");
});

for (const status of [401, 403]) {
	test(`modern OAuth endpoint rejection ${status} does not imply a failed model login`, async (t) => {
		const f = fixture(t);
		f.setProvider("openai");
		f.setAuth(async (id) => id === "openai" ? modernOAuth() : oauth());
		f.setFetch(async () => response({ detail: "SYNTHETIC_PRIVATE_REJECTION" }, status));
		f.start();
		await flush();
		assert.equal(f.status(), "initial:warning:C ?");
		assert.equal(f.notices.length, 0);
		await f.command();
		assert.deepEqual(f.authCalls, ["openai", "openai"]);
		assert.equal(f.requests.length, 2);
		assert.equal(f.notices[0].type, "error");
		assert.match(f.notices[0].message, new RegExp(`HTTP ${status}`));
		assert.match(f.notices[0].message, /does not mean your model login failed/);
		assert.match(f.notices[0].message, /https:\/\/chatgpt.com\/settings\/usage/);
		assert.doesNotMatch(f.notices[0].message, /PRIVATE_REJECTION|Run \/login|account ID/);
	});
}

test("unsafe present account metadata is still rejected for modern OAuth", async (t) => {
	const f = fixture(t);
	f.setProvider("openai");
	f.setAuth(async () => ({ source: "OAuth", auth: { apiKey: token("unsafe\nheader") } }));
	await f.command();
	assert.equal(f.requests.length, 0);
	assert.match(f.notices[0].message, /usable ChatGPT account ID/);
});

test("token changes without account metadata clear old usage before a failed request", async (t) => {
	const f = fixture(t);
	f.setProvider("openai");
	f.setAuth(async () => modernOAuth("synthetic-first"));
	f.start();
	await flush();
	assert.equal(f.status(), "initial:dim:C 5h23% W48%");
	f.setAuth(async () => modernOAuth("synthetic-next"));
	const pending = deferred<Response>();
	f.setFetch(() => pending.promise);
	const task = f.command();
	await flush();
	assert.equal(f.status(), "initial:warning:C ?");
	pending.resolve(response({}, 401));
	await task;
	assert.equal(f.status(), "initial:warning:C ?");
});

test("unchanged metadata-free token retains recent cached usage during an outage", async (t) => {
	const f = fixture(t);
	f.setProvider("openai");
	f.setAuth(async () => modernOAuth());
	f.start();
	await flush();
	f.setFetch(async () => response({}, 503));
	await f.command();
	assert.equal(f.status(), "initial:dim:C 5h23% W48%");
});

test("legacy OAuth still requires its account metadata", async (t) => {
	const f = fixture(t);
	f.setAuth(async () => modernOAuth());
	await f.command();
	assert.deepEqual(f.authCalls, ["openai-codex"]);
	assert.equal(f.requests.length, 0);
	assert.match(f.notices[0].message, /openai-codex OAuth token.*account ID/);
});
