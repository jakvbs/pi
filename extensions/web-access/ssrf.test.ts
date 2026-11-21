import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { assertPublicUrl, guardedFetch, isBlockedAddress, type Lookup } from "./ssrf.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const publicLookup: Lookup = async () => [{ address: "93.184.215.14", family: 4 }];

test("internal IPv4, IPv6 and IPv4-mapped addresses are blocked; public ones are not", () => {
	for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "198.18.0.1", "224.0.0.1", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "not-an-ip"]) {
		assert.equal(isBlockedAddress(address), true, address);
	}
	for (const address of ["93.184.215.14", "8.8.8.8", "2606:4700:4700::1111"]) assert.equal(isBlockedAddress(address), false, address);
});

test("assertPublicUrl refuses other schemes, localhost, internal literals and hosts that resolve inward", async () => {
	await assert.rejects(assertPublicUrl(new URL("file:///etc/passwd")), /Only HTTP and HTTPS/);
	await assert.rejects(assertPublicUrl(new URL("http://localhost:3000/")), /Blocked internal hostname/);
	await assert.rejects(assertPublicUrl(new URL("http://app.localhost/")), /Blocked internal hostname/);
	await assert.rejects(assertPublicUrl(new URL("http://[::1]/")), /Blocked internal address/);
	await assert.rejects(assertPublicUrl(new URL("http://169.254.169.254/latest")), /Blocked internal address/);
	const mixed: Lookup = async () => [{ address: "93.184.215.14", family: 4 }, { address: "10.0.0.5", family: 4 }];
	await assert.rejects(assertPublicUrl(new URL("https://rebind.example/"), mixed), /Blocked internal address for rebind.example: 10.0.0.5/);
	await assert.rejects(assertPublicUrl(new URL("https://none.example/"), async () => []), /no addresses returned/);
	await assertPublicUrl(new URL("https://example.com/"), publicLookup);
});

test("guardedFetch checks every redirect hop and returns the final URL", async () => {
	const requested: string[] = [];
	globalThis.fetch = async (input) => {
		const url = String(input);
		requested.push(url);
		if (url === "https://example.com/start") return new Response(null, { status: 302, headers: { location: "/next" } });
		return new Response("done", { status: 200 });
	};
	const { response, url } = await guardedFetch(new URL("https://example.com/start"), {}, publicLookup);
	assert.equal(await response.text(), "done");
	assert.equal(url.href, "https://example.com/next");
	assert.deepEqual(requested, ["https://example.com/start", "https://example.com/next"]);

	globalThis.fetch = async () => new Response(null, { status: 301, headers: { location: "http://127.0.0.1:8080/admin" } });
	await assert.rejects(guardedFetch(new URL("https://example.com/"), {}, publicLookup), /Blocked internal address: 127.0.0.1/);

	globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: "/loop" } });
	await assert.rejects(guardedFetch(new URL("https://example.com/"), {}, publicLookup), /Too many redirects/);
});
