# Openbot

A graphical, bring-your-own-key chat UI for the popular AI providers. No more terminal — pick a provider, paste your key, send messages, drop files in, watch the response stream back.

![Openbot](https://img.shields.io/badge/node-%3E%3D18-ff1493) ![PHP](https://img.shields.io/badge/php-%3E%3D8.0-ff1493) ![License](https://img.shields.io/badge/license-MIT-ff1493)

## Features

- **Multi-provider**: OpenAI, Anthropic (Claude), Google Gemini, Groq, DeepSeek, OpenRouter
- **Key health check** — live ✓ / dead ✗ indicator the moment you paste a key
- **Balance display** for providers that expose it (DeepSeek, OpenRouter)
- **Streaming responses** via Server-Sent Events — normalized across providers
- **File uploads** — text files are embedded into the prompt, images are sent as vision input when the model supports it
- **Chat history** stored in your browser (`localStorage`) — multiple conversations, rename, delete
- **New chat** button, model picker, dark glass UI with hot-pink accents
- **Cursor falling-star trail** — for vibes
- **Two backends in one repo**: Node (`server.js`) for local dev, PHP (`api.php`) for shared / cPanel hosting

## Local (Node.js)

```bash
npm install
npm start
# open http://localhost:3000
```

Paste your API key in the sidebar, pick a provider/model, type something, hit **Send**.

## Deploy to cPanel / shared hosting (PHP)

cPanel hosts don't usually run Node, but they all run PHP — `api.php` is a drop-in replacement for `server.js` and supports the exact same endpoints.

1. In cPanel **File Manager**, open your domain's web root (usually `public_html/`).
2. Upload **all of the following files into the web root** (i.e. they should sit next to each other, not in a subfolder):
   - `index.html`
   - `styles.css`
   - `app.js`
   - `stars.js`
   - `api.php`
   - `.htaccess` *(optional — only used if your host enables `mod_rewrite`)*
3. Visit `https://yourdomain.com/` — the chat UI should appear.

That's it. The frontend automatically probes both `/api/<action>` (Apache-with-rewrites) and `api.php?action=<action>` (no-rewrites) at boot and uses whichever responds; you'll see the active backend in the bottom of the sidebar.

### Verify it's wired up

Hit these directly in your browser to sanity-check the PHP backend:

- `https://yourdomain.com/api.php?action=ping` → `{"ok":true,"runtime":"php","php":"8.x.x"}`
- `https://yourdomain.com/api.php?action=providers` → list of supported providers

If you instead get an HTML error page, your host is missing PHP 8.0+ or the `curl` extension (rare; most cPanel hosts have both — switch via **MultiPHP Manager** in cPanel if needed).

### Cloudflare (orange cloud) ⚠️

If your domain is proxied through Cloudflare, the validate / models endpoints will work fine but **chat streaming will look frozen until the full reply finishes** — Cloudflare buffers HTTP responses by default and `text/event-stream` is no exception. Pick one:

- **Easiest**: set the DNS record for your domain to **DNS-only** (grey cloud) so requests bypass Cloudflare's proxy. Streaming works immediately.
- **Keep the proxy on**: add a **Configuration Rule** for `/api.php*` (or `/api/chat*`) and turn off these features for matching requests:
  - *Auto Minify*: off
  - *Rocket Loader*: off
  - *Browser Cache TTL*: respect existing headers
  - *Cache Level*: bypass
  Then add a **Cache Rule** for the same path with **Bypass Cache** enabled.
- **Cloudflare Workers / Pro**: a Pro plan supports a "Response Buffering: Off" Page Rule, but it's not a guarantee for arbitrarily long streams. Grey-clouding the API is still the most reliable.

If you don't disable buffering, the chat still works — you just won't see words appear one at a time; the full message arrives at the end.

### LiteSpeed / FastCGI hosts

If your host runs LiteSpeed or PHP-FPM (most modern cPanel installations do), the PHP runtime settings in `.htaccess` are ignored. Create a sibling file called **`.user.ini`** with:

```ini
output_buffering = 0
zlib.output_compression = 0
max_execution_time = 0
post_max_size = 32M
upload_max_filesize = 16M
```

It will be picked up automatically within a few minutes (controlled by `user_ini.cache_ttl`).

## Supported endpoints

| Provider     | Validate                              | Balance | Streaming |
|--------------|---------------------------------------|---------|-----------|
| OpenAI       | `GET /v1/models`                      | —       | ✓         |
| Anthropic    | `GET /v1/models`                      | —       | ✓         |
| Gemini       | `GET /v1beta/models`                  | —       | ✓         |
| Groq         | `GET /openai/v1/models`               | —       | ✓         |
| DeepSeek     | `GET /v1/models`                      | ✓       | ✓         |
| OpenRouter   | `GET /api/v1/auth/key`                | ✓       | ✓         |

## Security note

API keys are kept in your browser's `localStorage` and forwarded to the chosen provider through the local proxy (Node or PHP). Don't host this on a public URL with someone else's key.

## License

MIT
