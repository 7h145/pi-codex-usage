import assert from "node:assert/strict";
import { test } from "node:test";
import { deferred, fixture, flush, MINUTE, oauth, response, usage } from "./helpers.ts";

for (const provider of ["openai", "anthropic", "custom", "openai-codex-other", undefined]) {
	test(`no footer or automatic requests for an unsupported model provider: ${provider}`, async (t) => {
		const f = fixture(t);
		f.setProvider(provider);
		f.start();
		f.emit("agent_settled");
		f.emit("model_select");
		await f.tick(6 * MINUTE);
		assert.equal(f.authCalls.length, 0);
		assert.equal(f.requests.length, 0);
		assert.equal(f.statuses.length, 0);
		assert.equal(f.notices.length, 0);
	});

	test(`command retrieves legacy usage without showing a footer for: ${provider}`, async (t) => {
		const f = fixture(t);
		f.setProvider(provider);
		f.setAuth(async (id) => {
			assert.equal(id, "openai-codex", "must not resolve any other provider's credentials");
			return oauth();
		});
		f.start();
		await f.command();
		assert.equal(f.requests.length, 1);
		assert.equal(f.notices[0].type, "info");
		assert.match(f.notices[0].message, /Provider: openai-codex\n/);
		assert.equal(f.statuses.length, 0);
		await f.tick(6 * MINUTE);
		assert.equal(f.requests.length, 1, "command must not start background polling for unsupported models");
		assert.equal(f.statuses.length, 0);
	});
}

test("each completed command fetches new usage even with a recent cache and unrelated model", async (t) => {
	const f = fixture(t);
	f.setProvider("anthropic");
	f.start();
	let percent = 12;
	f.setFetch(async () => response(usage(percent++)));
	await f.command();
	await f.command();
	assert.equal(f.requests.length, 2);
	assert.deepEqual(f.authCalls, ["openai-codex", "openai-codex"]);
	assert.match(f.notices[0].message, /5h: 12% used/);
	assert.match(f.notices[1].message, /5h: 13% used/);
	assert.equal(f.statuses.length, 0);
});

test("switching to an unsupported model clears status immediately and stops background requests", async (t) => {
	const f = fixture(t);
	f.start();
	await flush();
	assert.equal(f.status(), "initial:dim:C 5h23% W48%");
	f.setProvider("openai");
	f.emit("model_select");
	assert.equal(f.status(), undefined);
	const writes = f.statuses.length;
	f.emit("agent_settled");
	await f.tick(6 * MINUTE);
	assert.equal(f.requests.length, 1);
	assert.equal(f.statuses.length, writes);
	await f.command();
	assert.equal(f.requests.length, 2);
	assert.equal(f.statuses.length, writes);
	assert.equal(f.notices[0].type, "info");
});

test("switching back to a supported model resumes footer refresh", async (t) => {
	const f = fixture(t);
	f.setProvider("openai");
	f.start();
	await f.command();
	assert.equal(f.statuses.length, 0);
	f.setFetch(async () => response(usage(35)));
	f.setProvider("openai-codex");
	f.emit("model_select");
	await flush();
	assert.equal(f.requests.length, 2);
	assert.equal(f.status(), "initial:dim:C 5h35% W48%");
	await f.tick(5 * MINUTE);
	assert.equal(f.requests.length, 3);
});

test("a failing command on an unsupported model still reports errors without footer output", async (t) => {
	const f = fixture(t);
	f.setProvider("openai");
	f.start();
	f.setFetch(async () => response({}, 503));
	await f.command();
	assert.equal(f.notices[0].type, "error");
	assert.match(f.notices[0].message, /HTTP 503/);
	assert.equal(f.statuses.length, 0);
});

test("a pending background result cannot restore status after switching away", async (t) => {
	const f = fixture(t);
	const pending = deferred<Response>();
	f.setFetch(() => pending.promise);
	f.start();
	await flush();
	f.setProvider("anthropic");
	f.emit("model_select");
	const writes = f.statuses.length;
	pending.resolve(response());
	await flush();
	assert.equal(f.status(), undefined);
	assert.equal(f.statuses.length, writes);
	assert.equal(f.notices.length, 0);
});

test("concurrent commands on unrelated models share fresh legacy usage, never cached output", async (t) => {
	const f = fixture(t);
	f.setProvider("anthropic");
	f.start();
	await f.command();
	const pending = deferred<Response>();
	f.setFetch(() => pending.promise);
	const first = f.command();
	const second = f.command();
	await flush();
	assert.equal(f.requests.length, 2);
	assert.equal(f.notices.length, 1, "commands must wait for the new request instead of returning cached usage");
	pending.resolve(response(usage(42)));
	await Promise.all([first, second]);
	assert.equal(f.notices.length, 3);
	assert.ok(f.notices.slice(1).every((notice) => /5h: 42% used/.test(notice.message)));
	assert.equal(f.statuses.length, 0);
});

test("repeated startup on an unsupported model clears a previously published footer", async (t) => {
	const f = fixture(t);
	f.start();
	await flush();
	assert.equal(f.status(), "initial:dim:C 5h23% W48%");
	f.setProvider("openai");
	f.start();
	assert.equal(f.status(), undefined);
	await f.tick(6 * MINUTE);
	assert.equal(f.requests.length, 1);
});
