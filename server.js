/**
 * Openbot — multi-provider AI chat proxy.
 *
 * Exposes:
 *   POST /api/validate  { provider, apiKey }                     -> { live, balance?, error? }
 *   POST /api/models    { provider, apiKey }                     -> { models: [...] }
 *   POST /api/chat      { provider, apiKey, model, messages,
 *                         attachments?, system? }                -> SSE: {delta} / {done} / {error}
 */

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

/* --------------------------------- helpers -------------------------------- */

function sseInit(res) {
  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
}

function sseSend(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sseClose(res) {
  try { res.end(); } catch (_) {}
}

/**
 * Iterate an SSE byte stream line-by-line, yielding "data: ..." payloads.
 */
async function* iterSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
  if (buf.startsWith('data:')) yield buf.slice(5).trim();
}

/**
 * Convert generic messages + attachments into provider-specific shape.
 *  - text attachments are prepended into the last user message as a code-fence
 *  - image attachments are attached as vision parts (provider-specific)
 */
function attachToLastUser(messages, attachments, mode) {
  if (!attachments || !attachments.length) return messages;
  const out = messages.map(m => ({ ...m }));
  let lastUserIdx = -1;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === 'user') { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) return out;

  const textBlobs = [];
  const images = [];
  for (const a of attachments) {
    if (a.text != null) {
      textBlobs.push(`\n\n[Attached file: ${a.name}]\n\`\`\`\n${a.text}\n\`\`\`\n`);
    } else if (a.dataUrl && a.type && a.type.startsWith('image/')) {
      images.push(a);
    }
  }

  const baseText = (typeof out[lastUserIdx].content === 'string'
    ? out[lastUserIdx].content
    : '') + textBlobs.join('');

  if (mode === 'openai') {
    const parts = [{ type: 'text', text: baseText || ' ' }];
    for (const img of images) parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
    out[lastUserIdx].content = images.length ? parts : (baseText || '');
  } else if (mode === 'anthropic') {
    const parts = [];
    for (const img of images) {
      const m = /^data:([^;]+);base64,(.+)$/.exec(img.dataUrl);
      if (m) parts.push({
        type: 'image',
        source: { type: 'base64', media_type: m[1], data: m[2] },
      });
    }
    if (baseText) parts.push({ type: 'text', text: baseText });
    out[lastUserIdx].content = parts.length ? parts : (baseText || ' ');
  } else if (mode === 'gemini') {
    // gemini messages handled in caller, not here
    out[lastUserIdx].__text = baseText;
    out[lastUserIdx].__images = images;
  }
  return out;
}

/* --------------------------------- OpenAI --------------------------------- */
async function openaiValidate(key) {
  try {
    const r = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!r.ok) {
      const t = await r.text();
      return { live: false, error: r.status === 401 ? 'Invalid API key' : `HTTP ${r.status}: ${t.slice(0, 120)}` };
    }
    return { live: true };
  } catch (e) {
    return { live: false, error: e.message };
  }
}
async function openaiModels(key) {
  const r = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.data || [])
    .map(m => m.id)
    .filter(id => /^(gpt-|o1|o3|o4|chatgpt)/i.test(id))
    .sort();
}
async function openaiChat({ key, model, messages, attachments, system, signal }, res, baseURL = 'https://api.openai.com/v1') {
  const msgs = attachToLastUser(messages, attachments, 'openai');
  if (system) msgs.unshift({ role: 'system', content: system });

  const r = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: msgs, stream: true }),
    signal,
  });
  if (!r.ok) {
    const t = await r.text();
    sseSend(res, { error: `HTTP ${r.status}: ${t.slice(0, 300)}` });
    return sseClose(res);
  }
  for await (const data of iterSse(r)) {
    if (data === '[DONE]') break;
    try {
      const j = JSON.parse(data);
      const delta = j.choices?.[0]?.delta?.content;
      if (delta) sseSend(res, { delta });
    } catch (_) {}
  }
  sseSend(res, { done: true });
  sseClose(res);
}

/* -------------------------------- Anthropic ------------------------------- */
async function anthropicValidate(key) {
  try {
    const r = await fetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    });
    if (!r.ok) {
      const t = await r.text();
      return { live: false, error: r.status === 401 ? 'Invalid API key' : `HTTP ${r.status}: ${t.slice(0, 120)}` };
    }
    return { live: true };
  } catch (e) {
    return { live: false, error: e.message };
  }
}
async function anthropicModels(key) {
  const r = await fetch('https://api.anthropic.com/v1/models', {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
  });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.data || []).map(m => m.id).sort();
}
async function anthropicChat({ key, model, messages, attachments, system, signal }, res) {
  const msgs = attachToLastUser(messages, attachments, 'anthropic');
  const body = {
    model,
    max_tokens: 4096,
    stream: true,
    messages: msgs.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
  };
  if (system) body.system = system;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok) {
    const t = await r.text();
    sseSend(res, { error: `HTTP ${r.status}: ${t.slice(0, 300)}` });
    return sseClose(res);
  }
  for await (const data of iterSse(r)) {
    try {
      const j = JSON.parse(data);
      if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') {
        sseSend(res, { delta: j.delta.text });
      } else if (j.type === 'message_stop') {
        break;
      } else if (j.type === 'error') {
        sseSend(res, { error: j.error?.message || 'anthropic error' });
        return sseClose(res);
      }
    } catch (_) {}
  }
  sseSend(res, { done: true });
  sseClose(res);
}

/* --------------------------------- Gemini --------------------------------- */
async function geminiValidate(key) {
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
    if (!r.ok) {
      const t = await r.text();
      return { live: false, error: r.status === 400 || r.status === 403 ? 'Invalid API key' : `HTTP ${r.status}: ${t.slice(0, 120)}` };
    }
    return { live: true };
  } catch (e) {
    return { live: false, error: e.message };
  }
}
async function geminiModels(key) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
  if (!r.ok) return [];
  const j = await r.json();
  return (j.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace(/^models\//, ''))
    .sort();
}
async function geminiChat({ key, model, messages, attachments, system, signal }, res) {
  // gemini wants role: 'user' | 'model' and 'parts'
  const msgs = attachToLastUser(messages, attachments, 'gemini');
  const contents = msgs.map((m, i) => {
    const isLastUser = m.role === 'user' && i === msgs.length - 1 && m.__images;
    const parts = [];
    if (isLastUser) {
      if (m.__text) parts.push({ text: m.__text });
      for (const img of m.__images) {
        const mm = /^data:([^;]+);base64,(.+)$/.exec(img.dataUrl);
        if (mm) parts.push({ inline_data: { mime_type: mm[1], data: mm[2] } });
      }
    } else {
      parts.push({ text: typeof m.content === 'string' ? m.content : (m.__text || '') });
    }
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  });

  const body = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok) {
    const t = await r.text();
    sseSend(res, { error: `HTTP ${r.status}: ${t.slice(0, 300)}` });
    return sseClose(res);
  }
  for await (const data of iterSse(r)) {
    try {
      const j = JSON.parse(data);
      const parts = j.candidates?.[0]?.content?.parts || [];
      for (const p of parts) {
        if (p.text) sseSend(res, { delta: p.text });
      }
    } catch (_) {}
  }
  sseSend(res, { done: true });
  sseClose(res);
}

/* ---------------------------------- Groq ---------------------------------- */
async function groqValidate(key) {
  try {
    const r = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!r.ok) {
      const t = await r.text();
      return { live: false, error: r.status === 401 ? 'Invalid API key' : `HTTP ${r.status}: ${t.slice(0, 120)}` };
    }
    return { live: true };
  } catch (e) {
    return { live: false, error: e.message };
  }
}
async function groqModels(key) {
  const r = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.data || []).map(m => m.id).sort();
}
function groqChat(ctx, res) {
  return openaiChat(ctx, res, 'https://api.groq.com/openai/v1');
}

/* -------------------------------- DeepSeek -------------------------------- */
async function deepseekValidate(key) {
  try {
    const r = await fetch('https://api.deepseek.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!r.ok) {
      const t = await r.text();
      return { live: false, error: r.status === 401 ? 'Invalid API key' : `HTTP ${r.status}: ${t.slice(0, 120)}` };
    }
    // balance
    let balance = null;
    try {
      const b = await fetch('https://api.deepseek.com/user/balance', {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (b.ok) {
        const bj = await b.json();
        const info = bj.balance_infos?.[0];
        if (info) {
          balance = `${info.currency || ''} ${info.total_balance}`.trim();
        }
      }
    } catch (_) {}
    return { live: true, balance };
  } catch (e) {
    return { live: false, error: e.message };
  }
}
async function deepseekModels(key) {
  const r = await fetch('https://api.deepseek.com/v1/models', {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.data || []).map(m => m.id).sort();
}
function deepseekChat(ctx, res) {
  return openaiChat(ctx, res, 'https://api.deepseek.com/v1');
}

/* ------------------------------- OpenRouter ------------------------------- */
async function openrouterValidate(key) {
  try {
    const r = await fetch('https://openrouter.ai/api/v1/auth/key', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!r.ok) {
      const t = await r.text();
      return { live: false, error: r.status === 401 ? 'Invalid API key' : `HTTP ${r.status}: ${t.slice(0, 120)}` };
    }
    const j = await r.json();
    const d = j.data || {};
    let balance = null;
    if (d.limit != null && d.usage != null) {
      const remaining = Number(d.limit) - Number(d.usage);
      balance = `$${remaining.toFixed(4)} left`;
    } else if (d.usage != null) {
      balance = `$${Number(d.usage).toFixed(4)} used`;
    }
    return { live: true, balance };
  } catch (e) {
    return { live: false, error: e.message };
  }
}
async function openrouterModels(key) {
  const r = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.data || []).map(m => m.id).sort();
}
function openrouterChat(ctx, res) {
  return openaiChat(ctx, res, 'https://openrouter.ai/api/v1');
}

/* ------------------------------ Provider map ------------------------------ */
const PROVIDERS = {
  openai:     { validate: openaiValidate,     models: openaiModels,     chat: openaiChat,     defaultModels: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4-turbo'] },
  anthropic:  { validate: anthropicValidate,  models: anthropicModels,  chat: anthropicChat,  defaultModels: ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest', 'claude-3-opus-latest'] },
  gemini:     { validate: geminiValidate,     models: geminiModels,     chat: geminiChat,     defaultModels: ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash'] },
  groq:       { validate: groqValidate,       models: groqModels,       chat: groqChat,       defaultModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'] },
  deepseek:   { validate: deepseekValidate,   models: deepseekModels,   chat: deepseekChat,   defaultModels: ['deepseek-chat', 'deepseek-reasoner'] },
  openrouter: { validate: openrouterValidate, models: openrouterModels, chat: openrouterChat, defaultModels: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet', 'google/gemini-flash-1.5'] },
};

/* --------------------------------- routes --------------------------------- */
app.get('/api/providers', (_req, res) => {
  res.json({
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({
      id,
      defaultModels: p.defaultModels,
    })),
  });
});

app.post('/api/validate', async (req, res) => {
  const { provider, apiKey } = req.body || {};
  if (!provider || !apiKey) return res.status(400).json({ live: false, error: 'provider and apiKey required' });
  const p = PROVIDERS[provider];
  if (!p) return res.status(400).json({ live: false, error: 'unknown provider' });
  try {
    const r = await p.validate(apiKey);
    res.json(r);
  } catch (e) {
    res.json({ live: false, error: e.message });
  }
});

app.post('/api/models', async (req, res) => {
  const { provider, apiKey } = req.body || {};
  const p = PROVIDERS[provider];
  if (!p) return res.status(400).json({ models: [] });
  if (!apiKey) return res.json({ models: p.defaultModels });
  try {
    const models = await p.models(apiKey);
    res.json({ models: models.length ? models : p.defaultModels });
  } catch (e) {
    res.json({ models: p.defaultModels, error: e.message });
  }
});

app.post('/api/chat', async (req, res) => {
  const { provider, apiKey, model, messages, attachments, system } = req.body || {};
  if (!provider || !apiKey || !model || !Array.isArray(messages)) {
    res.status(400).json({ error: 'provider, apiKey, model, messages[] required' });
    return;
  }
  const p = PROVIDERS[provider];
  if (!p) {
    res.status(400).json({ error: 'unknown provider' });
    return;
  }

  sseInit(res);

  const ac = new AbortController();
  // Only abort upstream when the *response* is closed prematurely (client disconnected).
  // `req.on('close')` fires after body is fully read in some Node versions, which
  // would kill the upstream fetch before it returns. `res.on('close')` is safer:
  // it fires only when the response stream itself ends (either by us or by client).
  let finished = false;
  res.on('close', () => { if (!finished) ac.abort(); });

  try {
    await p.chat(
      { key: apiKey, model, messages, attachments, system, signal: ac.signal },
      res,
    );
  } catch (e) {
    if (e.name !== 'AbortError') {
      sseSend(res, { error: e.message });
    }
    sseClose(res);
  } finally {
    finished = true;
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`\n  Openbot running → http://localhost:${PORT}\n`);
});
