import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, flush, MINUTE, modernOAuth, oauth } from "./helpers.ts";

test("legacy fallback from API-key auth is explicit in command and footer", async (t) => {
	const f = fixture(t);
	f.setProvider("openai");
	f.setAuth(async (id) => id === "openai"
		? { source: "OPENAI_API_KEY", auth: { apiKey: "synthetic-platform-key" } }
		: oauth());
	f.start();
	await flush();
	assert.equal(f.status(), "initial:dim:C 5h23% W48% [legacy]");
	await f.command();
	assert.match(f.notices[0].message, /Provider: openai-codex\n/);
	assert.match(f.notices[0].message, /Using openai-codex usage credentials because openai did not resolve to ChatGPT OAuth/);
	assert.match(f.notices[0].message, /may be using an API key/);
	assert.match(f.notices[0].message, /Switching models does not migrate logins/);
	assert.match(f.notices[0].message, /not proof of the selected model's remaining budget/);
	assert.doesNotMatch(JSON.stringify(f.notices), /synthetic-platform-key/);
	assert.ok(f.requests.every((req) => !(req.init.headers as Record<string, string>).Authorization.includes("synthetic-platform-key")));
});

test("missing-login fallback is explicit and the marker survives aging", async (t) => {
	const f = fixture(t);
	f.setProvider("openai");
	f.start();
	await flush();
	await f.command();
	assert.match(f.notices[0].message, /because openai has no resolved login/);
	assert.equal(f.status(), "initial:dim:C 5h23% W48% [legacy]");
	f.setIdle(false);
	f.jump(15 * MINUTE);
	await f.tick(1000);
	assert.equal(f.status(), "initial:warning:C 5h23% W48%? [legacy]");
});

test("fallback in the other direction identifies modern credentials", async (t) => {
	const f = fixture(t);
	f.setAuth(async (id) => id === "openai" ? modernOAuth() : undefined);
	f.start();
	await flush();
	await f.command();
	assert.match(f.notices[0].message, /Provider: openai\n/);
	assert.match(f.notices[0].message, /because openai-codex has no resolved login/);
	assert.equal(f.status(), "initial:dim:C 5h23% W48% [openai]");
});

test("a successful preferred login removes the fallback marker", async (t) => {
	const f = fixture(t);
	f.setProvider("openai");
	f.start();
	await flush();
	assert.match(f.status() ?? "", /\[legacy\]/);
	f.setAuth(async () => modernOAuth());
	await f.command();
	assert.equal(f.status(), "initial:dim:C 5h23% W48%");
	assert.doesNotMatch(f.notices[0].message, /Note:|because/);
});
