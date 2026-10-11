import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, flush, MINUTE, response, STATUS_KEY, usage } from "./helpers.ts";

test("publishes the unchanged compositor key and formats the command", async (t) => {
	const f = fixture(t);
	f.start();
	await flush();
	assert.equal(f.statuses.at(-1)?.key, STATUS_KEY);
	assert.equal(f.status(), "initial:dim:C 5h23% W48%");
	await f.command();
	assert.match(f.notices.at(-1)?.message ?? "", /Codex usage \(plus\)/);
	assert.match(f.notices.at(-1)?.message ?? "", /5h: 23% used, resets in/);
	assert.equal(f.notices.at(-1)?.type, "info");
});

test("uses warning and error thresholds", async (t) => {
	const f = fixture(t);
	f.setFetch(async () => response(usage(71)));
	f.start();
	await flush();
	assert.equal(f.status(), "initial:warning:C 5h71% W48%");
	f.setFetch(async () => response(usage(91)));
	await f.command();
	assert.equal(f.status(), "initial:error:C 5h91% W48%");
});

test("accepts an absent primary window", async (t) => {
	const f = fixture(t);
	const body = usage();
	f.setFetch(async () => response({ ...body, rate_limit: { secondary_window: body.rate_limit.secondary_window } }));
	f.start();
	await flush();
	assert.equal(f.status(), "initial:dim:C W48%");
});

test("keeps recent usage on errors and recovers after a later success", async (t) => {
	const f = fixture(t);
	f.start();
	await flush();
	f.setFetch(async () => response({}, 503));
	await f.command();
	assert.equal(f.status(), "initial:dim:C 5h23% W48%");
	assert.match(f.notices.at(-1)?.message ?? "", /HTTP 503/);
	f.jump(16 * MINUTE);
	await f.command();
	assert.equal(f.status(), "initial:warning:C 5h23% W48%?");
	f.jump(45 * MINUTE);
	await f.command();
	assert.equal(f.status(), "initial:warning:C ?");
	f.setFetch(async () => response(usage(30)));
	await f.command();
	assert.equal(f.status(), "initial:dim:C 5h30% W48%");
});

test("background failures stay quiet and shutdown clears the owned key", async (t) => {
	const f = fixture(t);
	f.setFetch(async () => response({}, 503));
	f.start();
	await flush();
	assert.equal(f.status(), "initial:warning:C ?");
	assert.equal(f.notices.length, 0);
	f.stop();
	assert.deepEqual(f.statuses.at(-1), { key: STATUS_KEY, value: undefined });
});

test("does not fetch in the extension factory or poll outside the TUI", async (t) => {
	const f = fixture(t, "rpc");
	assert.equal(f.requests.length, 0);
	assert.equal(f.timers.size, 0);
	f.start();
	await flush();
	assert.equal(f.authCalls.length, 0);
	assert.equal(f.requests.length, 0);
	await f.command();
	assert.equal(f.requests.length, 1);
	assert.equal(f.notices.at(-1)?.type, "info");
	assert.equal(f.statuses.length, 0);
});
