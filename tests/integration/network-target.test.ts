import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  NetworkTargetError,
  normalizeNetworkUrl,
  resolveSafeRedirect,
  resolveSafeTarget,
  type DnsAddressRecord,
  type DnsResolver,
  type NetworkTargetErrorCode,
} from "../../src/network-safety";

const publicIpv4: DnsAddressRecord = { address: "93.184.216.34", family: 4 };
const publicIpv6: DnsAddressRecord = {
  address: "2606:4700:4700::1111",
  family: 6,
};

class FakeResolver implements DnsResolver {
  readonly calls: string[] = [];

  constructor(
    private readonly responses: readonly (
      | readonly DnsAddressRecord[]
      | Error
    )[],
  ) {}

  async resolve(hostname: string): Promise<readonly DnsAddressRecord[]> {
    this.calls.push(hostname);
    const response = this.responses[Math.min(this.calls.length - 1, this.responses.length - 1)];
    if (response instanceof Error) {
      throw response;
    }
    return response ?? [];
  }
}

async function rejectsWithCode(
  operation: () => Promise<unknown>,
  code: NetworkTargetErrorCode,
): Promise<void> {
  await assert.rejects(
    operation,
    (error: unknown) => error instanceof NetworkTargetError && error.code === code,
  );
}

test("accepts, canonicalizes, and deduplicates public DNS results", async () => {
  const resolver = new FakeResolver([
    [publicIpv4, publicIpv6, publicIpv4, { address: "2606:4700:4700:0::1111", family: 6 }],
  ]);

  const target = await resolveSafeTarget("HTTPS://Example.COM:443/path?q=1#fragment", resolver);
  assert.deepEqual(target, {
    url: "https://example.com/path?q=1",
    hostname: "example.com",
    port: 443,
    addresses: [publicIpv4, publicIpv6],
  });
  assert.deepEqual(resolver.calls, ["example.com"]);
});

test("rejects private-only and mixed public/private DNS answers", async () => {
  for (const records of [
    [{ address: "10.1.2.3", family: 4 }],
    [publicIpv4, { address: "192.168.1.1", family: 4 }],
    [publicIpv6, { address: "fe80::1", family: 6 }],
  ] as const) {
    await rejectsWithCode(
      () => resolveSafeTarget("https://example.com/", new FakeResolver([records])),
      "BLOCKED_ADDRESS",
    );
  }
});

test("rejects empty, malformed, mismatched-family, and failed DNS results", async () => {
  for (const response of [
    [],
    [{ address: "not-an-ip", family: 4 }],
    [{ address: "93.184.216.34", family: 6 }],
    [{ address: "127.1", family: 4 }],
  ] as readonly (readonly DnsAddressRecord[])[]) {
    await rejectsWithCode(
      () => resolveSafeTarget("https://example.com/", new FakeResolver([response])),
      "DNS_RESOLUTION_FAILED",
    );
  }

  await rejectsWithCode(
    () => resolveSafeTarget("https://example.com/", new FakeResolver([new Error("raw DNS error")])),
    "DNS_RESOLUTION_FAILED",
  );
});

test("blocks local hostnames before DNS and validates direct IPs without DNS", async () => {
  const resolver = new FakeResolver([[publicIpv4]]);
  await rejectsWithCode(
    () => resolveSafeTarget("http://api.localhost/", resolver),
    "BLOCKED_HOST",
  );
  assert.deepEqual(resolver.calls, []);

  const target = await resolveSafeTarget("https://93.184.216.34/resource", resolver);
  assert.deepEqual(target.addresses, [publicIpv4]);
  assert.deepEqual(resolver.calls, []);
});

test("returns immutable target data and approved addresses", async () => {
  const target = await resolveSafeTarget(
    "https://example.com/",
    new FakeResolver([[publicIpv4, publicIpv6]]),
  );

  assert.ok(Object.isFrozen(target));
  assert.ok(Object.isFrozen(target.addresses));
  assert.ok(target.addresses.every(Object.isFrozen));
  assert.throws(() => {
    (target as { hostname: string }).hostname = "changed.example";
  });
  assert.throws(() => {
    (target.addresses as DnsAddressRecord[]).push(publicIpv4);
  });
});

test("normalization performs no DNS resolution", () => {
  const resolver = new FakeResolver([[publicIpv4]]);
  assert.equal(normalizeNetworkUrl("https://example.com/a"), "https://example.com/a");
  assert.deepEqual(resolver.calls, []);
});

test("accepts relative and absolute redirects after complete fresh validation", async () => {
  const resolver = new FakeResolver([[publicIpv4]]);
  const initial = await resolveSafeTarget("https://example.com/start", resolver);
  const relative = await resolveSafeRedirect(initial, "../next?q=1#ignored", resolver);
  const absolute = await resolveSafeRedirect(
    relative,
    "https://other.example/final",
    resolver,
  );

  assert.equal(relative.url, "https://example.com/next?q=1");
  assert.equal(absolute.url, "https://other.example/final");
  assert.notEqual(relative, initial);
  assert.deepEqual(resolver.calls, ["example.com", "example.com", "other.example"]);
});

test("rejects redirects to local, private, metadata, credentialed, or alternate-port targets", async () => {
  const initial = await resolveSafeTarget(
    "https://example.com/start",
    new FakeResolver([[publicIpv4]]),
  );
  const resolver = new FakeResolver([[publicIpv4]]);

  await rejectsWithCode(
    () => resolveSafeRedirect(initial, "//localhost/admin", resolver),
    "BLOCKED_HOST",
  );
  await rejectsWithCode(
    () => resolveSafeRedirect(initial, "http://10.0.0.1/", resolver),
    "BLOCKED_ADDRESS",
  );
  await rejectsWithCode(
    () => resolveSafeRedirect(initial, "http://169.254.169.254/latest", resolver),
    "BLOCKED_ADDRESS",
  );
  await rejectsWithCode(
    () => resolveSafeRedirect(initial, "https://user:pass@example.com/", resolver),
    "CREDENTIALS_NOT_ALLOWED",
  );
  await rejectsWithCode(
    () => resolveSafeRedirect(initial, "https://example.com:8443/", resolver),
    "PORT_NOT_ALLOWED",
  );
});

test("same-host redirects reject DNS rebinding from public to private", async () => {
  const resolver = new FakeResolver([
    [publicIpv4],
    [{ address: "127.0.0.1", family: 4 }],
  ]);
  const initial = await resolveSafeTarget("https://example.com/start", resolver);

  await rejectsWithCode(
    () => resolveSafeRedirect(initial, "/next", resolver),
    "BLOCKED_ADDRESS",
  );
  assert.deepEqual(resolver.calls, ["example.com", "example.com"]);
});

test("redirect syntax rejects controls, backslashes, and empty authority userinfo", async () => {
  const resolver = new FakeResolver([[publicIpv4]]);
  const initial = await resolveSafeTarget("https://example.com/start", resolver);

  await rejectsWithCode(
    () => resolveSafeRedirect(initial, "/line\nbreak", resolver),
    "INVALID_URL",
  );
  await rejectsWithCode(
    () => resolveSafeRedirect(initial, "\\private", resolver),
    "INVALID_URL",
  );
  await rejectsWithCode(
    () => resolveSafeRedirect(initial, "//@other.example/", resolver),
    "CREDENTIALS_NOT_ALLOWED",
  );
});
