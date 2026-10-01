import { describe, it, expect } from "vitest";
import { UrlPolicyError, assertPublicHttpsUrl, canonicalizeUrl, redactSecretsInUrl } from "../../../src/research/web/index.ts";

function codeOf(url: string): string {
  try {
    assertPublicHttpsUrl(url);
  } catch (error) {
    if (error instanceof UrlPolicyError) return error.code;
    throw error;
  }
  return "allowed";
}

describe("assertPublicHttpsUrl", () => {
  it("allows public https URLs and returns the normalized form", () => {
    expect(assertPublicHttpsUrl("https://Shop.Example.com/coat?size=m")).toBe("https://shop.example.com/coat?size=m");
    expect(codeOf("https://shop.example.com:443/coat")).toBe("allowed");
    expect(codeOf("https://93.184.216.34/")).toBe("allowed");
    expect(codeOf("https://[2606:4700:4700::1111]/")).toBe("allowed");
  });

  it("rejects unparseable URLs, other schemes, user information and other ports", () => {
    expect(codeOf("not a url")).toBe("invalid_url");
    expect(codeOf("http://shop.example.com/")).toBe("scheme_not_https");
    expect(codeOf("file:///etc/passwd")).toBe("scheme_not_https");
    expect(codeOf("https://user:pw@shop.example.com/")).toBe("userinfo_not_allowed");
    expect(codeOf("https://user@shop.example.com/")).toBe("userinfo_not_allowed");
    expect(codeOf("https://shop.example.com:8443/")).toBe("port_not_allowed");
  });

  it("rejects local and internal host names", () => {
    for (const url of [
      "https://localhost/",
      "https://LOCALHOST./",
      "https://printer.local/",
      "https://db.internal/",
      "https://app.localhost/",
      "https://intranet/",
    ]) {
      expect(codeOf(url), url).toBe("host_not_public");
    }
  });

  it("rejects private, loopback, link-local, CGNAT and metadata IPv4 addresses", () => {
    for (const url of [
      "https://127.0.0.1/",
      "https://10.1.2.3/",
      "https://172.16.0.1/",
      "https://172.31.255.255/",
      "https://192.168.1.1/",
      "https://169.254.169.254/latest/meta-data/",
      "https://169.254.1.1/",
      "https://100.64.0.1/",
      "https://100.127.255.254/",
      "https://0.0.0.0/",
    ]) {
      expect(codeOf(url), url).toBe("ip_not_public");
    }
    expect(codeOf("https://172.32.0.1/")).toBe("allowed");
    expect(codeOf("https://100.128.0.1/")).toBe("allowed");
  });

  it("rejects decimal, hex and octal spellings that normalize to non-public IPv4", () => {
    for (const url of [
      "https://2130706433/", // 127.0.0.1 as one decimal number
      "https://0x7f000001/", // 127.0.0.1 as one hex number
      "https://017700000001/", // 127.0.0.1 as one octal number
      "https://0x7f.0.0.1/",
      "https://0177.0.0.1/",
      "https://0xa9.0xfe.0xa9.0xfe/", // 169.254.169.254
      "https://2852039166/", // 169.254.169.254
      "https://10.1/", // 10.0.0.1
    ]) {
      expect(codeOf(url), url).toBe("ip_not_public");
    }
  });

  it("rejects loopback, unique-local, link-local and IPv4-mapped IPv6 addresses", () => {
    for (const url of [
      "https://[::1]/",
      "https://[::]/",
      "https://[fc00::1]/",
      "https://[fd12:3456:789a::1]/",
      "https://[fe80::1]/",
      "https://[febf::1]/",
      "https://[::ffff:127.0.0.1]/",
      "https://[::ffff:10.0.0.1]/",
      "https://[::ffff:a9fe:a9fe]/",
      "https://[64:ff9b::192.168.0.1]/",
    ]) {
      expect(codeOf(url), url).toBe("ip_not_public");
    }
    expect(codeOf("https://[::ffff:93.184.216.34]/")).toBe("allowed");
  });
});

describe("canonicalizeUrl", () => {
  it("lowercases the host, drops fragment and tracking parameters, sorts parameters and strips the trailing slash", () => {
    expect(canonicalizeUrl("https://Shop.Example.com/Item/?utm_source=x&b=2&a=1&gclid=9&UTM_Medium=mail#reviews")).toBe(
      "https://shop.example.com/Item?a=1&b=2",
    );
    expect(canonicalizeUrl("https://shop.example.com/")).toBe("https://shop.example.com");
  });

  it("maps differently decorated links to the same source", () => {
    const a = canonicalizeUrl("https://shop.example.com/coat?colour=navy&size=m&fbclid=abc&ref=newsletter");
    const b = canonicalizeUrl("https://SHOP.example.com/coat/?size=m&colour=navy&mc_cid=1&mc_eid=2#top");
    expect(a).toBe(b);
    expect(canonicalizeUrl("https://shop.example.com/coat?colour=black&size=m")).not.toBe(a);
  });

  it("throws a UrlPolicyError for unparseable input", () => {
    expect(() => canonicalizeUrl("::::")).toThrow(UrlPolicyError);
  });
});

describe("redactSecretsInUrl", () => {
  it("removes user information and replaces key-bearing parameter values", () => {
    const redacted = redactSecretsInUrl("https://user:pw@mcp.tavily.com/mcp/?tavilyApiKey=tvly-SECRET&q=coat");
    expect(redacted).toBe("https://mcp.tavily.com/mcp/?tavilyApiKey=REDACTED&q=coat");
    expect(redacted).not.toContain("tvly-SECRET");
    expect(redacted).not.toContain("pw");
  });

  it("matches key names case-insensitively and covers every listed name", () => {
    const names = ["api_key", "APIKEY", "Key", "token", "Access_Token", "auth", "secret", "signature", "exaApiKey", "TAVILYAPIKEY"];
    for (const name of names) {
      const redacted = redactSecretsInUrl(`https://api.example.com/v1?${name}=s3cr3tvalue&page=2`);
      expect(redacted, name).not.toContain("s3cr3tvalue");
      expect(redacted, name).toContain(`${name}=REDACTED`);
      expect(redacted, name).toContain("page=2");
    }
  });

  it("leaves ordinary URLs unchanged and redacts unparseable text best-effort", () => {
    expect(redactSecretsInUrl("https://shop.example.com/coat?size=m")).toBe("https://shop.example.com/coat?size=m");
    expect(redactSecretsInUrl("/relative/path?token=abc123&x=1")).toBe("/relative/path?token=REDACTED&x=1");
  });
});
