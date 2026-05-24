/* ============================================================
   Openbot — frontend logic
   - multi-provider key management (per-provider in localStorage)
   - chat history (localStorage)
   - streaming via fetch+SSE
   - file attachments (text inlined, images as vision parts)
   ============================================================ */

(() => {
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const uid = () => Math.random().toString(36).slice(2, 10);
const now = () => Date.now();

const LS = {
  chats: 'openbot:chats:v1',
  current: 'openbot:current',
  provider: 'openbot:provider',
  model: (p) => `openbot:model:${p}`,
  key: (p) => `openbot:key:${p}`,
};

const DEFAULT_MODELS = {
  openai:     ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4-turbo'],
  anthropic:  ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest', 'claude-3-opus-latest'],
  gemini:     ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash'],
  groq:       ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
  deepseek:   ['deepseek-chat', 'deepseek-reasoner'],
  openrouter: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet', 'google/gemini-flash-1.5'],
};

const PROVIDER_LABEL = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  groq: 'Groq',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
};

/* ---------------------------- DOM refs ---------------------------- */
const elProvider   = $('#provider');
const elApiKey     = $('#api-key');
const elToggleKey  = $('#toggle-key');
const elKeyStatus  = $('#key-status');
const elBalance    = $('#balance');
const elCheckKey   = $('#check-key');
const elModel      = $('#model');
const elNewChat    = $('#new-chat');
const elChats      = $('#chats');
const elMessages   = $('#messages');
const elComposer   = $('#composer');
const elPrompt     = $('#prompt');
const elSend       = $('#send');
const elStop       = $('#stop');
const elFileInput  = $('#file-input');
const elAttachBtn  = $('#attach-btn');
const elAttachRow  = $('#attachments');
const elChatTitle  = $('#chat-title');
const elMetaProv   = $('#meta-provider');
const elMetaModel  = $('#meta-model');
const elToast      = $('#toast');

/* ---------------------------- state ----------------------------- */
let chats = [];
let currentId = null;
let attachments = [];   // pending uploads for next send
let abortCtl = null;    // active stream

/* ---------------------------- storage --------------------------- */
function loadChats() {
  try { chats = JSON.parse(localStorage.getItem(LS.chats) || '[]'); }
  catch { chats = []; }
}
function saveChats() {
  localStorage.setItem(LS.chats, JSON.stringify(chats));
}
function currentChat() {
  return chats.find(c => c.id === currentId);
}

/* ---------------------------- toast ----------------------------- */
function toast(msg, ms = 2400) {
  elToast.textContent = msg;
  elToast.hidden = false;
  elToast.classList.remove('show');
  // force reflow
  void elToast.offsetWidth;
  elToast.classList.add('show');
  setTimeout(() => { elToast.hidden = true; }, ms);
}

/* ---------------------------- markdown -------------------------- */
function renderMarkdown(text) {
  if (window.marked && window.DOMPurify) {
    const html = window.marked.parse(text, { gfm: true, breaks: true });
    return window.DOMPurify.sanitize(html);
  }
  // Tiny fallback: escape + paragraph + linebreaks
  const esc = (text || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc
    .replace(/```([\s\S]*?)```/g, (_, c) => `<pre><code>${c}</code></pre>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

/* ----------------------- provider / key ------------------------- */
function getKey(provider) { return localStorage.getItem(LS.key(provider)) || ''; }
function setKey(provider, key) { localStorage.setItem(LS.key(provider), key); }

function syncKeyInputToProvider() {
  const prov = elProvider.value;
  elApiKey.value = getKey(prov);
  elBalance.textContent = '';
  setStatus('unknown', 'not set');
  if (elApiKey.value) validateKeyDebounced();
  loadModelsForProvider();
}

function setStatus(kind, label) {
  elKeyStatus.className = 'status status-' + kind;
  const dot = { unknown: '●', checking: '◌', live: '●', dead: '●' }[kind] || '●';
  elKeyStatus.textContent = `${dot} ${label}`;
}

let validateTimer = null;
function validateKeyDebounced() {
  clearTimeout(validateTimer);
  validateTimer = setTimeout(validateKey, 500);
}

async function validateKey() {
  const provider = elProvider.value;
  const apiKey = elApiKey.value.trim();
  if (!apiKey) { setStatus('unknown', 'not set'); elBalance.textContent = ''; return; }
  setStatus('checking', 'checking…');
  elBalance.textContent = '';
  try {
    const r = await fetch('/api/validate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, apiKey }),
    });
    const j = await r.json();
    if (j.live) {
      setStatus('live', 'live');
      elBalance.textContent = j.balance ? `Balance: ${j.balance}` : '';
      // refresh model list now that we know the key works
      loadModelsForProvider();
    } else {
      setStatus('dead', j.error || 'dead');
      elBalance.textContent = '';
    }
  } catch (e) {
    setStatus('dead', 'network error');
  }
}

async function loadModelsForProvider() {
  const provider = elProvider.value;
  const apiKey = elApiKey.value.trim();
  const stored = localStorage.getItem(LS.model(provider));
  let models = DEFAULT_MODELS[provider] || [];
  if (apiKey) {
    try {
      const r = await fetch('/api/models', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, apiKey }),
      });
      const j = await r.json();
      if (Array.isArray(j.models) && j.models.length) models = j.models;
    } catch (_) {}
  }
  // dedupe + preserve order
  models = Array.from(new Set(models));
  elModel.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m; opt.textContent = m;
    elModel.appendChild(opt);
  }
  elModel.value = stored && models.includes(stored) ? stored : models[0] || '';
  updateMeta();
}

elProvider.addEventListener('change', () => {
  localStorage.setItem(LS.provider, elProvider.value);
  syncKeyInputToProvider();
});

elApiKey.addEventListener('input', () => {
  setKey(elProvider.value, elApiKey.value.trim());
  validateKeyDebounced();
});

elToggleKey.addEventListener('click', () => {
  elApiKey.type = elApiKey.type === 'password' ? 'text' : 'password';
});

elCheckKey.addEventListener('click', validateKey);

elModel.addEventListener('change', () => {
  localStorage.setItem(LS.model(elProvider.value), elModel.value);
  updateMeta();
  const cc = currentChat();
  if (cc) { cc.model = elModel.value; cc.provider = elProvider.value; saveChats(); }
});

function updateMeta() {
  elMetaProv.textContent  = PROVIDER_LABEL[elProvider.value] || elProvider.value;
  elMetaModel.textContent = elModel.value || '—';
}

/* --------------------------- chats UI --------------------------- */
function renderChats() {
  elChats.innerHTML = '';
  // hide empty chats that aren't the current one — keeps the list clean
  const visible = chats.filter(c => c.messages.length > 0 || c.id === currentId);
  const sorted = [...visible].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const c of sorted) {
    const div = document.createElement('div');
    div.className = 'chat-item' + (c.id === currentId ? ' active' : '');
    div.innerHTML = `<span class="title-text"></span><button class="del" title="delete">✕</button>`;
    div.querySelector('.title-text').textContent = c.title || 'Untitled';
    div.addEventListener('click', () => openChat(c.id));
    div.querySelector('.del').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteChat(c.id);
    });
    elChats.appendChild(div);
  }
}

function newChat() {
  // reuse current chat if it's still empty — avoids piling up "New chat" entries
  const cur = currentChat();
  if (cur && cur.messages.length === 0) {
    cur.title = 'New chat';
    cur.provider = elProvider.value;
    cur.model = elModel.value;
    cur.updatedAt = now();
    saveChats();
    renderChats();
    renderMessages();
    elChatTitle.textContent = cur.title;
    elPrompt.focus();
    return;
  }
  const c = {
    id: uid(),
    title: 'New chat',
    provider: elProvider.value,
    model: elModel.value,
    messages: [],
    createdAt: now(),
    updatedAt: now(),
  };
  chats.unshift(c);
  currentId = c.id;
  localStorage.setItem(LS.current, currentId);
  saveChats();
  renderChats();
  renderMessages();
  elChatTitle.textContent = c.title;
  elPrompt.focus();
}

async function openChat(id) {
  const c = chats.find(x => x.id === id);
  if (!c) return;
  currentId = id;
  localStorage.setItem(LS.current, currentId);
  if (c.provider && c.provider !== elProvider.value) {
    elProvider.value = c.provider;
    elApiKey.value = getKey(c.provider);
    setStatus('unknown', 'not set');
    elBalance.textContent = '';
    if (elApiKey.value) validateKeyDebounced();
    await loadModelsForProvider();
  }
  if (c.model) {
    if (![...elModel.options].some(o => o.value === c.model)) {
      const opt = document.createElement('option');
      opt.value = c.model; opt.textContent = c.model;
      elModel.appendChild(opt);
    }
    elModel.value = c.model;
  }
  updateMeta();
  elChatTitle.textContent = c.title;
  renderChats();
  renderMessages();
}

function deleteChat(id) {
  chats = chats.filter(c => c.id !== id);
  if (currentId === id) {
    currentId = chats[0]?.id || null;
    if (!currentId) newChat();
  }
  saveChats();
  renderChats();
  if (currentId) {
    const c = currentChat();
    elChatTitle.textContent = c.title;
    renderMessages();
  }
}

elNewChat.addEventListener('click', newChat);

elChatTitle.addEventListener('blur', () => {
  const c = currentChat();
  if (!c) return;
  const t = elChatTitle.textContent.trim().slice(0, 80) || 'Untitled';
  elChatTitle.textContent = t;
  c.title = t;
  c.updatedAt = now();
  saveChats();
  renderChats();
});
elChatTitle.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); elChatTitle.blur(); }
});

/* -------------------------- messages UI ------------------------- */
function renderMessages() {
  elMessages.innerHTML = '';
  const c = currentChat();
  if (!c || c.messages.length === 0) {
    elMessages.innerHTML = `
      <div class="welcome">
        <h2>Hello, traveller. <span class="hi">✦</span></h2>
        <p>Paste an API key in the sidebar, pick a model, drop a file in if you want, and send.</p>
        <div class="chips">
          <button class="chip" data-prompt="Explain quantum entanglement like I'm 12.">Explain quantum entanglement</button>
          <button class="chip" data-prompt="Write a haiku about a CRT monitor at 3am.">Haiku · CRT @ 3am</button>
          <button class="chip" data-prompt="Refactor this Python snippet for readability:">Refactor Python</button>
          <button class="chip" data-prompt="Summarise the attached file in 5 bullets.">Summarise file</button>
        </div>
      </div>`;
    bindChips();
    return;
  }
  for (const m of c.messages) appendMessageEl(m);
  scrollToBottom();
}

function bindChips() {
  $$('.chip').forEach(ch => ch.addEventListener('click', () => {
    elPrompt.value = ch.dataset.prompt + ' ';
    elPrompt.focus();
    autoResize();
  }));
}

function appendMessageEl(m) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + m.role;
  wrap.dataset.id = m.id;
  const initials = m.role === 'user' ? 'YOU' : '✦';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  // attachments preview (user messages)
  if (m.role === 'user' && m.attachments && m.attachments.length) {
    for (const a of m.attachments) {
      if (a.type && a.type.startsWith('image/') && a.dataUrl) {
        const img = document.createElement('img');
        img.src = a.dataUrl;
        bubble.appendChild(img);
      } else {
        const chip = document.createElement('div');
        chip.className = 'attach-chip';
        chip.innerHTML = `<span class="ext">📄</span><span>${a.name}</span>`;
        bubble.appendChild(chip);
      }
    }
  }
  const body = document.createElement('div');
  body.className = 'md';
  body.innerHTML = renderMarkdown(m.content || '');
  bubble.appendChild(body);

  if (m.error) {
    const err = document.createElement('div');
    err.className = 'msg-error';
    err.textContent = m.error;
    bubble.appendChild(err);
  }

  wrap.innerHTML = `<div class="avatar">${initials}</div>`;
  wrap.appendChild(bubble);
  elMessages.appendChild(wrap);
  return body;
}

function scrollToBottom() {
  elMessages.scrollTop = elMessages.scrollHeight;
}

/* ------------------------- attachments -------------------------- */
elAttachBtn.addEventListener('click', () => elFileInput.click());

elFileInput.addEventListener('change', async (e) => {
  for (const f of e.target.files) await ingestFile(f);
  elFileInput.value = '';
  renderAttachments();
});

// drag & drop on the whole app
['dragenter', 'dragover'].forEach(ev =>
  document.addEventListener(ev, (e) => {
    if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); document.body.classList.add('drop'); }
  })
);
['dragleave', 'drop'].forEach(ev =>
  document.addEventListener(ev, (e) => { document.body.classList.remove('drop'); })
);
document.addEventListener('drop', async (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  for (const f of e.dataTransfer.files) await ingestFile(f);
  renderAttachments();
});

async function ingestFile(file) {
  if (file.size > 8 * 1024 * 1024) { toast(`"${file.name}" is too large (>8MB)`); return; }
  const isImage = (file.type || '').startsWith('image/');
  try {
    const data = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(r.error);
      if (isImage) r.readAsDataURL(file);
      else r.readAsText(file);
    });
    attachments.push(isImage
      ? { name: file.name, type: file.type, dataUrl: data, size: file.size }
      : { name: file.name, type: file.type || 'text/plain', text: String(data).slice(0, 200_000), size: file.size }
    );
  } catch (e) {
    toast(`Failed to read ${file.name}`);
  }
}

function renderAttachments() {
  elAttachRow.innerHTML = '';
  attachments.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    if (a.dataUrl && a.type.startsWith('image/')) {
      chip.innerHTML = `<img src="${a.dataUrl}" alt=""><span>${a.name}</span><button class="x" title="remove">✕</button>`;
    } else {
      chip.innerHTML = `<span class="ext">📄</span><span>${a.name}</span><button class="x" title="remove">✕</button>`;
    }
    chip.querySelector('.x').addEventListener('click', () => {
      attachments.splice(i, 1);
      renderAttachments();
    });
    elAttachRow.appendChild(chip);
  });
}

/* ---------------------------- send ----------------------------- */
elComposer.addEventListener('submit', (e) => { e.preventDefault(); send(); });

elPrompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

elPrompt.addEventListener('input', autoResize);
function autoResize() {
  elPrompt.style.height = 'auto';
  elPrompt.style.height = Math.min(200, elPrompt.scrollHeight) + 'px';
}

elStop.addEventListener('click', () => {
  if (abortCtl) abortCtl.abort();
});

async function send() {
  const text = elPrompt.value.trim();
  if (!text && attachments.length === 0) return;
  if (abortCtl) return toast('Still streaming the previous reply…');

  const provider = elProvider.value;
  const apiKey   = elApiKey.value.trim();
  const model    = elModel.value;

  if (!apiKey) { toast('Add an API key first'); elApiKey.focus(); return; }
  if (!model)  { toast('Pick a model first'); return; }

  let c = currentChat();
  if (!c) { newChat(); c = currentChat(); }

  // remove welcome card on first message
  if (c.messages.length === 0) {
    elMessages.innerHTML = '';
    if (!c.title || c.title === 'New chat') {
      c.title = text.slice(0, 48).replace(/\s+/g, ' ') || 'Untitled';
      elChatTitle.textContent = c.title;
    }
  }

  const userMsg = {
    id: uid(),
    role: 'user',
    content: text,
    attachments: attachments.slice(),
    ts: now(),
  };
  c.messages.push(userMsg);
  c.provider = provider;
  c.model = model;
  c.updatedAt = now();
  appendMessageEl(userMsg);

  // reset composer
  elPrompt.value = '';
  attachments = [];
  renderAttachments();
  autoResize();
  scrollToBottom();
  saveChats();
  renderChats();

  // assistant placeholder
  const assistant = { id: uid(), role: 'assistant', content: '', ts: now() };
  c.messages.push(assistant);
  const body = appendMessageEl(assistant);
  body.classList.add('cursor-blink');
  scrollToBottom();

  // strip dataUrls down to what backend needs, keep text content fully
  const wireAttachments = userMsg.attachments.map(a => ({
    name: a.name, type: a.type,
    dataUrl: a.dataUrl, text: a.text,
  }));

  // build message history for the wire (strip non-protocol fields)
  const wireMessages = c.messages
    .filter(m => m.id !== assistant.id)
    .map(m => ({ role: m.role, content: m.content || '' }));

  abortCtl = new AbortController();
  setSending(true);

  let accumulated = '';
  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider,
        apiKey,
        model,
        messages: wireMessages,
        attachments: wireAttachments,
      }),
      signal: abortCtl.signal,
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`HTTP ${r.status}: ${t.slice(0, 300)}`);
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let streamErr = null;
    let streamDone = false;
    while (!streamDone) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = block.split('\n').find(l => l.startsWith('data:'));
        if (!line) continue;
        let j;
        try { j = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (j.error) { streamErr = j.error; streamDone = true; break; }
        if (j.done)  { streamDone = true; break; }
        if (j.delta) {
          accumulated += j.delta;
          body.innerHTML = renderMarkdown(accumulated);
          scrollToBottom();
        }
      }
    }
    if (streamErr) throw new Error(streamErr);
  } catch (e) {
    if (e.name === 'AbortError') {
      accumulated += accumulated ? '\n\n_[stopped]_' : '_[stopped]_';
      body.innerHTML = renderMarkdown(accumulated);
    } else {
      assistant.error = e.message;
      const err = document.createElement('div');
      err.className = 'msg-error';
      err.textContent = e.message;
      body.parentElement.appendChild(err);
    }
  } finally {
    body.classList.remove('cursor-blink');
    assistant.content = accumulated;
    c.updatedAt = now();
    saveChats();
    renderChats();
    abortCtl = null;
    setSending(false);
    scrollToBottom();
  }
}

function setSending(on) {
  elSend.disabled = on;
  elStop.hidden = !on;
}

/* --------------------------- bootstrap --------------------------- */
function bootstrap() {
  loadChats();

  const lastProvider = localStorage.getItem(LS.provider) || 'openai';
  if ([...elProvider.options].some(o => o.value === lastProvider)) {
    elProvider.value = lastProvider;
  }

  elApiKey.value = getKey(elProvider.value);
  if (elApiKey.value) validateKeyDebounced();
  loadModelsForProvider();

  const lastCurrent = localStorage.getItem(LS.current);
  if (lastCurrent && chats.some(c => c.id === lastCurrent)) {
    openChat(lastCurrent);
  } else if (chats.length) {
    openChat(chats[0].id);
  } else {
    newChat();
  }
  renderChats();
  updateMeta();
  bindChips();
  autoResize();
}

document.addEventListener('DOMContentLoaded', bootstrap);
})();
