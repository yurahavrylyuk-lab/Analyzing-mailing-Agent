import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  NetworkTargetError,
  normalizeNetworkUrl,
  type NetworkTargetErrorCode,
} from "../../src/network-safety";

function rejectsWithCode(input: unknown, code: NetworkTargetErrorCode): void {
  assert.throws(
    () => normalizeNetworkUrl(input),
    (error: unknown) => error instanceof NetworkTargetError && error.code === code,
  );
}

test("normalizes public HTTP and HTTPS URLs deterministically", () => {
  assert.equal(
    normalizeNetworkUrl("  HTTP://ExAmPle.COM:80/a/b?x=1#section  "),
    "http://example.com/a/b?x=1",
  );
  assert.equal(
    normalizeNetworkUrl("https://bücher.example:443/catalog?q=one"),
    "https://xn--bcher-kva.example/catalog?q=one",
  );

  const normalized = normalizeNetworkUrl("https://example.com/path?query=yes#ignored");
  assert.equal(normalizeNetworkUrl(normalized), normalized);
});

test("rejects relative, malformed, backslashed, controlled, and oversized inputs", () => {
  for (const input of [
    "/relative",
    "example.com/path",
    "http:example.com",
    "http://exa mple.com",
    "http://example.com\\private",
    "http://example.com/line\nbreak",
    `http://example.com/${"x".repeat(8192)}`,
    "",
    42,
  ]) {
    rejectsWithCode(input, "INVALID_URL");
  }
});

test("rejects unsupported URL schemes", () => {
  for (const input of [
    "file:///etc/passwd",
    "ftp://example.com/file",
    "data:text/plain,test",
    "javascript:alert(1)",
    "gopher://example.com/1",
  ]) {
    rejectsWithCode(input, "UNSUPPORTED_SCHEME");
  }
});

test("rejects all authority userinfo including empty userinfo", () => {
  for (const input of [
    "https://user@example.com/",
    "https://user:password@example.com/",
    "https://@example.com/",
    "https://:password@example.com/",
  ]) {
    rejectsWithCode(input, "CREDENTIALS_NOT_ALLOWED");
  }
});

test("accepts explicit default ports and rejects every alternate port", () => {
  assert.equal(normalizeNetworkUrl("http://example.com:80/"), "http://example.com/");
  assert.equal(normalizeNetworkUrl("https://example.com:443/"), "https://example.com/");
  rejectsWithCode("http://example.com:443/", "PORT_NOT_ALLOWED");
  rejectsWithCode("https://example.com:8443/", "PORT_NOT_ALLOWED");
});

test("enforces DNS hostname structure and blocks obvious local names", () => {
  for (const input of [
    "http://-bad.example/",
    "http://bad-.example/",
    `http://${"a".repeat(64)}.example/`,
    `http://${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}/`,
  ]) {
    rejectsWithCode(input, "INVALID_URL");
  }

  for (const input of [
    "http://localhost/",
    "http://api.localhost/",
    "http://printer.local/",
    "http://service.internal/",
    "http://router.home.arpa/",
    "http://LOCALHOST./",
  ]) {
    rejectsWithCode(input, "BLOCKED_HOST");
  }
});

test("rejects unsafe direct IPv4 destinations and alternate loopback notation", () => {
  for (const address of [
    "127.0.0.1",
    "127.1",
    "2130706433",
    "0x7f000001",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "100.64.0.1",
    "192.0.2.1",
    "224.0.0.1",
    "255.255.255.255",
  ]) {
    rejectsWithCode(`http://${address}/`, "BLOCKED_ADDRESS");
  }
});

test("rejects unsafe IPv6 and accepts representative public IP addresses", () => {
  for (const address of [
    "::1",
    "::",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:8.8.8.8",
  ]) {
    rejectsWithCode(`http://[${address}]/`, "BLOCKED_ADDRESS");
  }

  rejectsWithCode("http://[fe80::1%25en0]/", "INVALID_URL");
  assert.equal(normalizeNetworkUrl("http://93.184.216.34/"), "http://93.184.216.34/");
  assert.equal(
    normalizeNetworkUrl("https://[2606:4700:4700::1111]/dns-query"),
    "https://[2606:4700:4700::1111]/dns-query",
  );
});

test("network target errors never reflect URL data", () => {
  const secret = "do-not-reflect-this";
  assert.throws(
    () => normalizeNetworkUrl(`https://user:${secret}@example.com/private?token=${secret}`),
    (error: unknown) =>
      error instanceof NetworkTargetError && !error.message.includes(secret),
  );
});
