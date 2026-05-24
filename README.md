# Openbot

A graphical, bring-your-own-key chat UI for the popular AI providers. No more terminal — pick a provider, paste your key, send messages, drop files in, watch the response stream back.

![Openbot](https://img.shields.io/badge/node-%3E%3D18-ff1493) ![License](https://img.shields.io/badge/license-MIT-ff1493)

## Features

- **Multi-provider**: OpenAI, Anthropic (Claude), Google Gemini, Groq, DeepSeek, OpenRouter
- **Key health check** — live ✓ / dead ✗ indicator the moment you paste a key
- **Balance display** for providers that expose it (DeepSeek, OpenRouter)
- **Streaming responses** via Server-Sent Events — normalized across providers
- **File uploads** — text files are embedded into the prompt, images are sent as vision input when the model supports it
- **Chat history** stored in your browser (`localStorage`) — multiple conversations, rename, delete
- **New chat** button, model picker, dark glass UI with hot-pink accents
- **Cursor falling-star trail** — for vibes

## Run

```bash
npm install
npm start
```

Then open <http://localhost:3000>.

Paste your API key in the sidebar, pick a provider/model, type something, hit **Send**.

## Security note

API keys are kept in your browser's `localStorage` and forwarded to the chosen provider through the local Node proxy. Don't host this on a public URL with someone else's key.

## Supported endpoints

| Provider     | Validate                              | Balance | Streaming |
|--------------|---------------------------------------|---------|-----------|
| OpenAI       | `GET /v1/models`                      | —       | ✓         |
| Anthropic    | `GET /v1/models`                      | —       | ✓         |
| Gemini       | `GET /v1beta/models`                  | —       | ✓         |
| Groq         | `GET /openai/v1/models`               | —       | ✓         |
| DeepSeek     | `GET /v1/models`                      | ✓       | ✓         |
| OpenRouter   | `GET /api/v1/auth/key`                | ✓       | ✓         |

## License

MIT
