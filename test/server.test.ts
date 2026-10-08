import { describe, expect, test } from "bun:test";
import { decodeEntities, diagnose, extractTags, handlePreview, isBlockedHost, isPrivateAddress } from "../server";

describe("private-address guard", () => {
  test("blocks loopback, private, link-local and metadata IPv4", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "255.255.255.255"]) {
      expect({ ip, blocked: isPrivateAddress(ip) }).toEqual({ ip, blocked: true });
    }
  });

  test("blocks private IPv6, including IPv4-mapped forms", () => {
    for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "64:ff9b::a00:1"]) {
      expect({ ip, blocked: isPrivateAddress(ip) }).toEqual({ ip, blocked: true });
    }
  });

  test("allows public addresses", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
      expect({ ip, blocked: isPrivateAddress(ip) }).toEqual({ ip, blocked: false });
    }
  });

  test("hostnames: localhost, bracketed IPv6, and single-label names", async () => {
    expect(await isBlockedHost("localhost")).toBe(true);
    expect(await isBlockedHost("api.localhost")).toBe(true);
    expect(await isBlockedHost("[::1]")).toBe(true); // URL.hostname keeps the brackets
    expect(await isBlockedHost("[::ffff:7f00:1]")).toBe(true);
    expect(await isBlockedHost("jsontype")).toBe(true); // a Render private-network name
    expect(await isBlockedHost("8.8.8.8")).toBe(false);
  });

  test("handlePreview refuses private targets before fetching anything", async () => {
    for (const url of ["http://127.0.0.1:3000/", "http://[::1]/", "http://2130706433/", "http://0x7f.1/", "localhost:8080"]) {
      const res = await handlePreview(url);
      expect({ url, status: res.status }).toEqual({ url, status: 400 });
    }
  });
});

describe("tag parsing", () => {
  test("decodes entities once, including numeric and hex", () => {
    expect(decodeEntities("Tom &amp; Jerry &#8212; &#x27;quoted&#x27;")).toBe("Tom & Jerry — 'quoted'");
    expect(decodeEntities("&amp;lt;b&amp;gt;")).toBe("&lt;b&gt;");
    expect(decodeEntities("&#99999999; &unknown;")).toBe("&#99999999; &unknown;");
  });

  test("reads OG, Twitter and standard tags and resolves relative URLs", () => {
    const html = `<html lang="en"><head>
      <title> Hello &amp; welcome </title>
      <meta property="og:title" content="Tom &amp; Jerry">
      <meta property="og:image" content="/card.png">
      <meta name="twitter:card" content="summary_large_image">
      <meta name="description" content="A page">
      <link rel="canonical" href="/post?a=1&amp;b=2">
      <link rel="icon" href="/favicon.ico">
    </head><body><meta property="og:title" content="ignored, not in head"></body></html>`;
    const tags = extractTags(html, "https://example.com/blog/post");
    expect(tags.title).toBe("Hello & welcome");
    expect(tags.og.title).toBe("Tom & Jerry");
    expect(tags.og.image).toBe("https://example.com/card.png");
    expect(tags.twitter.card).toBe("summary_large_image");
    expect(tags.canonical).toBe("https://example.com/post?a=1&b=2");
    expect(tags.favicon).toBe("https://example.com/favicon.ico");
    expect(tags.lang).toBe("en");
  });

  test("flags a missing og:image as the big problem", () => {
    const d = diagnose(extractTags("<head><title>x</title></head>", "https://example.com/"));
    expect(d.some((x) => x.level === "bad" && x.message.includes("og:image"))).toBe(true);
  });
});
