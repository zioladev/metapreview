# metapreview

URL → link cards, instantly.

Paste a URL. See exactly how its link preview will render on X, Slack, and
LinkedIn — and what's missing — before you share it.

## Run it

```sh
bun server.ts
```

Then open http://localhost:3000.

## What it does

- Fetches the page server-side (no CORS issues) with an 8s timeout
- Parses Open Graph, Twitter Card, and standard meta tags
- Renders the link card the way X, Slack/iMessage, and LinkedIn would
- Diagnoses what's missing: no `og:image` (the big one), no `twitter:card`,
  over-long titles, insecure image URLs, missing favicon, and more
- Shows every extracted tag for inspection

## Notes

- One tool: Bun fetches the page, parses the tags, renders the cards.
- Won't fetch local/private addresses: every redirect hop is checked, and
  hostnames are resolved first, so a public URL can't bounce or resolve to
  localhost, a private network, or a cloud metadata endpoint.
- Reads at most 600 KB of each page, and the 8s limit covers the whole fetch.
- Some sites (e.g. github.com) block bots — metapreview says so instead of
  pretending.

## Test

```sh
bun test
```

## Deploy (Render, Docker)

1. New **Web Service** from `Ugly-Tool/ziola`, language **Docker**,
   **Root Directory** `metapreview`.
2. No environment variables or disk needed — it stores nothing.
3. The server listens on `$PORT`, which Render sets.
