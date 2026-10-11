import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, flush, response, usage } from "./helpers.ts";

for (const [field, value] of [
	["used_percent", -1], ["used_percent", Number.NaN], ["used_percent", Infinity], ["used_percent", 1e308],
	["limit_window_seconds", -1], ["limit_window_seconds", 0], ["limit_window_seconds", 1.5],
	["reset_at", -1], ["reset_at", 1.5], ["reset_at", Number.MAX_SAFE_INTEGER + 1],
] as const) {
	test(`rejects invalid ${field}=${value} instead of hiding the window`, async (t) => {
		const f = fixture(t);
		const body = usage(99);
		Object.assign(body.rate_limit.primary_window, { [field]: value });
		f.setFetch(async () => {
			const res = response();
			t.mock.method(res, "json", async () => body);
			return res;
		});
		f.start();
		await flush();
		assert.equal(f.status(), "initial:warning:C ?");
		await f.command();
		assert.match(f.notices[0].message, /invalid primary_window/);
	});
}

for (const body of [
	null, [], "unexpected", { rate_limit: [] }, { rate_limit: "unexpected" },
	{ ...usage(), plan_type: {} }, { ...usage(), plan_type: "plus\nSYNTHETIC_INJECTED_LINE" },
	{ ...usage(), plan_type: "\x1b[31mplus" }, { ...usage(), plan_type: "x".repeat(81) },
]) {
	test(`rejects malformed response shape: ${JSON.stringify(body)}`, async (t) => {
		const f = fixture(t);
		f.setFetch(async () => response(body));
		await f.command();
		assert.equal(f.notices[0].type, "error");
		assert.match(f.notices[0].message, /unexpected format/);
	});
}

test("rejects an invalid secondary window as well", async (t) => {
	const f = fixture(t);
	f.setFetch(async () => response({ ...usage(), rate_limit: { ...usage().rate_limit, secondary_window: {} } }));
	await f.command();
	assert.match(f.notices[0].message, /invalid secondary_window/);
});

test("accepts null windows, unfamiliar durations and usage above 100%", async (t) => {
	const f = fixture(t);
	f.setFetch(async () => response({ rate_limit: { primary_window: null, secondary_window: {
		used_percent: 103.5, limit_window_seconds: 1800, reset_at: 1_900_010_000,
	} } }));
	f.start();
	await flush();
	assert.equal(f.status(), "initial:error:C 30m103.5%");
	await f.command();
	assert.match(f.notices[0].message, /30m: 103.5% used/);
});

for (const body of [{}, { rate_limit: null }, { rate_limit: {} }, { rate_limit: { primary_window: null, secondary_window: null } }]) {
	test(`reports missing windows: ${JSON.stringify(body)}`, async (t) => {
		const f = fixture(t);
		f.setFetch(async () => response(body));
		await f.command();
		assert.match(f.notices[0].message, /did not contain any Codex usage windows/);
	});
}

test("JSON parser failures never expose response-body fragments", async (t) => {
	const f = fixture(t);
	f.setFetch(async () => new Response("SYNTHETIC_PRIVATE_BACKEND_BODY"));
	await f.command();
	assert.match(f.notices[0].message, /not valid JSON/);
	assert.doesNotMatch(f.notices[0].message, /PRIVATE_BACKEND_BODY|Unexpected token/);
});

test("transport failures never expose credential-like error details", async (t) => {
	const f = fixture(t);
	f.setFetch(async () => { throw new Error("SYNTHETIC_PRIVATE_TRANSPORT_DETAILS"); });
	await f.command();
	assert.match(f.notices[0].message, /Could not reach the ChatGPT usage endpoint/);
	assert.doesNotMatch(f.notices[0].message, /PRIVATE_TRANSPORT/);
});

test("HTTP failures discard their bodies and report only status", async (t) => {
	const f = fixture(t);
	const res = response({ detail: "SYNTHETIC_PRIVATE_ERROR_BODY" }, 429);
	const cancel = t.mock.method(res.body!, "cancel");
	f.setFetch(async () => res);
	await f.command();
	assert.equal(cancel.mock.callCount(), 1);
	assert.match(f.notices[0].message, /HTTP 429/);
	assert.doesNotMatch(f.notices[0].message, /PRIVATE_ERROR_BODY/);
});
