// Guards every page fetch against server-side request forgery: a URL from the model or from a
// redirect must not reach loopback, private, link-local or other internal addresses.
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type Lookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const blocked = new BlockList();
for (const [network, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["224.0.0.0", 3],
] as const) {
	blocked.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
	["::", 128],
	["::1", 128],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
] as const) {
	blocked.addSubnet(network, prefix, "ipv6");
}

const defaultLookup: Lookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/** True for addresses a fetch must not reach. BlockList also matches IPv4-mapped IPv6 addresses against the IPv4 rules. */
export function isBlockedAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 0) return true;
	return blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** Throws unless `url` is an http(s) URL whose host resolves only to public addresses. */
export async function assertPublicUrl(url: URL, lookup: Lookup = defaultLookup): Promise<void> {
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP and HTTPS URLs can be fetched");
	const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (!hostname) throw new Error("URL must include a hostname");
	if (hostname === "localhost" || hostname.endsWith(".localhost")) throw new Error(`Blocked internal hostname: ${hostname}`);
	if (isIP(hostname)) {
		if (isBlockedAddress(hostname)) throw new Error(`Blocked internal address: ${hostname}`);
		return;
	}
	let addresses: Array<{ address: string }>;
	try {
		addresses = await lookup(hostname);
	} catch (err) {
		throw new Error(`Failed to resolve ${hostname}: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (addresses.length === 0) throw new Error(`Failed to resolve ${hostname}: no addresses returned`);
	for (const { address } of addresses) {
		if (isBlockedAddress(address)) throw new Error(`Blocked internal address for ${hostname}: ${address}`);
	}
}

/** GET that checks the target and every redirect hop with assertPublicUrl. Returns the final URL with the response. */
export async function guardedFetch(
	url: URL,
	init: RequestInit,
	lookup: Lookup = defaultLookup,
): Promise<{ response: Response; url: URL }> {
	let current = url;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		await assertPublicUrl(current, lookup);
		const response = await fetch(current, { ...init, redirect: "manual" });
		const location = response.headers.get("location");
		if (!REDIRECT_STATUSES.has(response.status) || !location) return { response, url: current };
		await response.body?.cancel();
		current = new URL(location, current);
	}
	throw new Error(`Too many redirects fetching ${url.href}`);
}
