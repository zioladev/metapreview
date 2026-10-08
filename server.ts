// metapreview — see your link card before you share it.
// One tool: Bun fetches the page, parses the tags, renders the cards.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 600_000;
const MAX_REDIRECTS = 5;
const PUBLIC_DIR = `${import.meta.dir}/public`;

type Tags = {
  title?: string;
  description?: string;
  canonical?: string;
  favicon?: string;
  lang?: string;
  og: Record<string, string>;
  twitter: Record<string, string>;
};

type Diagnostic = { level: "ok" | "warn" | "bad"; message: string };

// Only start listening when run directly, so the tests can import the helpers.
if (import.meta.main) {
  const server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/api/preview") {
        return handlePreview(url.searchParams.get("url")?.trim() ?? "");
      }

      const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
      // prevent path traversal
      if (pathname.includes("..")) return new Response("Not found", { status: 404 });
      // Resolve against this file, not the working directory.
      const file = Bun.file(`${PUBLIC_DIR}${pathname}`);
      if (await file.exists()) return new Response(file);
      return new Response("Not found", { status: 404 });
    },
  });

  console.log(`metapreview listening on http://localhost:${server.port}`);
}

const BLOCKED = "Nope — metapreview doesn't fetch local or private addresses.";

export async function handlePreview(target: string): Promise<Response> {
  if (!target) return json({ ok: false, error: "Paste a URL first." }, 400);

  let current: URL;
  try {
    current = new URL(target.includes("://") ? target : `https://${target}`);
    if (!/^https?:$/.test(current.protocol)) throw new Error("bad protocol");
  } catch {
    return json({ ok: false, error: "That doesn't look like an http(s) URL." }, 400);
  }

  // One deadline covers every redirect hop and the body download, so a page
  // that trickles bytes can't hold a request open forever.
  const started = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    // Follow redirects by hand so every hop gets the same private-address
    // check; with redirect: "follow", a public URL could bounce to localhost.
    let res: Response;
    for (let hop = 0; ; hop++) {
      if (await isBlockedHost(current.hostname)) return json({ ok: false, error: BLOCKED }, 400);
      res = await fetch(current, {
        signal: ctrl.signal,
        redirect: "manual",
        headers: {
          "user-agent": "metapreview/1.0 (+https://www.ziola.dev) - link-card previewer",
          accept: "text/html,application/xhtml+xml",
        },
      });
      const location = res.headers.get("location");
      if (res.status < 300 || res.status >= 400 || !location) break;
      await res.body?.cancel();
      if (hop >= MAX_REDIRECTS) {
        return json({ ok: false, error: `That URL redirected more than ${MAX_REDIRECTS} times.` }, 502);
      }
      current = new URL(location, current);
      if (!/^https?:$/.test(current.protocol)) {
        return json({ ok: false, error: "That URL redirected somewhere that isn't http(s)." }, 502);
      }
    }

    if (!res.ok) {
      await res.body?.cancel();
      return json(
        { ok: false, error: `That URL answered HTTP ${res.status} ${res.statusText}. Nothing to preview.` },
        502,
      );
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(contentType) && contentType !== "") {
      await res.body?.cancel();
      return json(
        { ok: false, error: `That URL served “${contentType}”, not HTML. metapreview only reads pages.` },
        422,
      );
    }

    const html = await readCapped(res, MAX_HTML_BYTES);
    const ms = Math.round(performance.now() - started);
    const tags = extractTags(html, current.href);
    const diagnostics = diagnose(tags);
    const tagCount =
      Object.keys(tags.og).length + Object.keys(tags.twitter).length + (tags.title ? 1 : 0) + (tags.description ? 1 : 0);

    return json({ ok: true, url: current.href, status: res.status, ms, tagCount, tags, diagnostics });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (ctrl.signal.aborted || /aborted|abort/i.test(msg)) {
      return json({ ok: false, error: "Timed out fetching that URL (8s limit). It might be slow or blocking bots." }, 504);
    }
    return json({ ok: false, error: `Couldn't fetch that URL (${msg}). Check the address and try again.` }, 502);
  } finally {
    clearTimeout(timer);
  }
}

// Read at most `limit` bytes of the body, then stop downloading. The tags
// live in <head>, so there's no reason to pull a multi-megabyte page.
async function readCapped(res: Response, limit: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  const buf = new Uint8Array(Math.min(size, limit));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, buf.length - offset);
    buf.set(part, offset);
    offset += part.length;
    if (offset >= buf.length) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

// True when the host is, or resolves to, anything that isn't the public
// internet: loopback, private ranges, link-local, cloud metadata, and
// single-label names (which on Render can reach other private services).
export async function isBlockedHost(hostname: string): Promise<boolean> {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h || h === "localhost" || h.endsWith(".localhost")) return true;
  if (isIP(h)) return isPrivateAddress(h);
  if (!h.includes(".")) return true;
  let addresses: { address: string }[];
  try {
    addresses = await lookup(h, { all: true, verbatim: true });
  } catch {
    return false; // doesn't resolve; let the fetch fail with a normal error
  }
  return addresses.some((a) => isPrivateAddress(a.address));
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return isPrivateV4(ip);
  const groups = expandV6(ip);
  if (!groups) return true;
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96) wrap an IPv4 address.
  const mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  const nat64 = groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0);
  if (mapped || nat64) {
    return isPrivateV4(`${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`);
  }
  if (groups.slice(0, 7).every((g) => g === 0)) return true; // :: and ::1
  const first = groups[0];
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xff00) === 0xff00 || // ff00::/8 multicast
    (first === 0x2001 && groups[1] === 0x0db8) // 2001:db8::/32 documentation
  );
}

function isPrivateV4(ip: string): boolean {
  const [a, b, c] = ip.split(".").map(Number);
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0]!;
  // Fold a trailing dotted IPv4 part into two hex groups.
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const [a, b, c, d] = v4[1]!.split(".").map(Number);
    s = s.slice(0, -v4[1]!.length) + `${((a! << 8) | b!).toString(16)}:${((c! << 8) | d!).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (s.includes("::") ? missing < 0 : missing !== 0) return null;
  const groups = [...left, ...Array(s.includes("::") ? missing : 0).fill("0"), ...right].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) {
    const name = m[1].toLowerCase();
    attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

// One pass, so "&amp;lt;" decodes to "&lt;" rather than "<".
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent: string) => {
    if (ent[0] !== "#") return NAMED_ENTITIES[ent.toLowerCase()] ?? whole;
    const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : Number(ent.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

function resolveUrl(maybeRelative: string, base: string): string {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return maybeRelative;
  }
}

export function extractTags(html: string, base: string): Tags {
  const tags: Tags = { og: {}, twitter: {} };
  const headEnd = html.search(/<\/head\s*>/i);
  const head = headEnd === -1 ? html.slice(0, 200_000) : html.slice(0, headEnd);

  const metaRe = /<meta\s+([^>]*?)>/gi;
  let m: RegExpExecArray | null;
  while ((m = metaRe.exec(head))) {
    const attrs = parseAttrs(m[1]);
    const key = (attrs.property || attrs.name || "").toLowerCase();
    const content = attrs.content;
    if (!key || content == null || content === "") continue;
    if (key.startsWith("og:")) {
      const k = key.slice(3);
      if (!(k in tags.og)) tags.og[k] = content;
    } else if (key.startsWith("twitter:")) {
      const k = key.slice(8);
      if (!(k in tags.twitter)) tags.twitter[k] = content;
    } else if (key === "description" && !tags.description) {
      tags.description = content;
    }
  }

  const titleM = head.match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i);
  if (titleM) tags.title = decodeEntities(titleM[1].replace(/\s+/g, " ").trim());

  const canonM = head.match(/<link\s+[^>]*rel=["']canonical["'][^>]*>/i);
  if (canonM) {
    const href = parseAttrs(canonM[0]).href;
    if (href) tags.canonical = resolveUrl(href, base);
  }

  const iconM = head.match(/<link\s+[^>]*rel=["'](?:shortcut\s+)?icon["'][^>]*>/i);
  if (iconM) {
    const href = parseAttrs(iconM[0]).href;
    if (href) tags.favicon = resolveUrl(href, base);
  }

  const langM = html.match(/<html[^>]*\slang=["']?([^"'\s>]+)/i);
  if (langM) tags.lang = langM[1];

  for (const k of ["image", "image:url", "image:secure_url"]) {
    if (tags.og[k]) tags.og[k] = resolveUrl(tags.og[k], base);
  }
  for (const k of ["image", "image:src"]) {
    if (tags.twitter[k]) tags.twitter[k] = resolveUrl(tags.twitter[k], base);
  }
  return tags;
}

export function diagnose(tags: Tags): Diagnostic[] {
  const out: Diagnostic[] = [];
  const title = tags.og.title || tags.twitter.title || tags.title || "";
  const desc = tags.og.description || tags.twitter.description || tags.description || "";
  const image = tags.og.image || tags.twitter.image || "";

  if (!tags.og.title && !tags.twitter.title) {
    out.push({
      level: tags.title ? "warn" : "bad",
      message: tags.title
        ? "No og:title — platforms fall back to your <title>, which isn't written for sharing."
        : "No title found at all — not even a <title> tag. Cards will show the bare URL.",
    });
  }
  if (title.length > 70) {
    out.push({ level: "warn", message: `Title is ${title.length} characters — X truncates display titles around 70.` });
  }
  if (!tags.og.description && !tags.twitter.description) {
    out.push({
      level: tags.description ? "warn" : "bad",
      message: tags.description
        ? "No og:description — platforms fall back to your meta description."
        : "No description found — cards will render with no summary text.",
    });
  }
  if (desc.length > 200) {
    out.push({ level: "warn", message: `Description is ${desc.length} characters — most platforms clamp around 160–200.` });
  }
  if (!image) {
    out.push({ level: "bad", message: "No og:image — cards render with no thumbnail on X, Slack, and LinkedIn. This is the big one." });
  } else if (!/^https:/i.test(image)) {
    out.push({ level: "warn", message: "og:image isn't https — several platforms refuse to render non-secure images." });
  }
  if (!tags.twitter.card) {
    out.push({ level: "warn", message: "No twitter:card — X falls back to a small summary card. Set summary_large_image for the big one." });
  }
  if (!tags.favicon) {
    out.push({ level: "warn", message: "No favicon found — small thing, but it shows up in tabs and some compact previews." });
  }
  if (out.length === 0) {
    out.push({ level: "ok", message: "All the essentials are here — title, description, image, and card type." });
  }
  return out;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}
