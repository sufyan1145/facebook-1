/* AI support chat widget - floating button on every logged-in dashboard page.
   Replies in whatever language the user writes in (handled server-side). */
(function () {
  const page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  if (/^(login|register|forgot-password|reset-password|index|become-tester|privacy|terms|data-deletion)/.test(page) || page === '') return;
  if (window.__aiChatLoaded) return;
  window.__aiChatLoaded = true;

  const css = `
  #aiChatBtn{position:fixed;right:18px;bottom:18px;z-index:9998;width:52px;height:52px;border-radius:50%;border:0;cursor:pointer;
    background:var(--signal-green,#3ED9A0);color:#06130d;font-size:24px;box-shadow:0 6px 20px rgba(0,0,0,.4)}
  #aiChatPanel{position:fixed;right:18px;bottom:80px;z-index:9998;width:min(380px,calc(100vw - 24px));height:min(520px,calc(100vh - 110px));
    display:none;flex-direction:column;background:var(--panel,#121922);border:1px solid var(--border,#232D3A);border-radius:14px;
    box-shadow:0 12px 40px rgba(0,0,0,.5);overflow:hidden;color:var(--text,#E7ECF2);font-size:13px}
  #aiChatPanel.open{display:flex}
  #aiChatHead{padding:10px 12px;border-bottom:1px solid var(--border,#232D3A);display:flex;justify-content:space-between;align-items:center;font-weight:600}
  #aiChatHead button{background:none;border:0;color:var(--text-muted,#8B98A8);cursor:pointer;font-size:12px;margin-left:8px}
  #aiChatLog{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
  .aiMsg{max-width:88%;padding:8px 10px;border-radius:10px;white-space:pre-wrap;word-break:break-word;line-height:1.5}
  .aiMsg.u{align-self:flex-end;background:var(--panel-2,#182230);border:1px solid var(--border,#232D3A)}
  .aiMsg.b{align-self:flex-start;background:rgba(62,217,160,.10);border:1px solid rgba(62,217,160,.25)}
  .aiMsg.e{align-self:flex-start;background:var(--signal-red-dim,rgba(240,85,90,.14));color:var(--signal-red,#F0555A)}
  #aiChatForm{display:flex;gap:6px;padding:10px;border-top:1px solid var(--border,#232D3A)}
  #aiChatInput{flex:1;resize:none;height:38px;max-height:90px;background:var(--bg,#0B0F14);color:inherit;border:1px solid var(--border,#232D3A);border-radius:8px;padding:8px;font:inherit}
  #aiChatSend{background:var(--signal-green,#3ED9A0);color:#06130d;border:0;border-radius:8px;padding:0 14px;font-weight:600;cursor:pointer}
  #aiChatSend:disabled{opacity:.5;cursor:default}`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const btn = document.createElement('button');
  btn.id = 'aiChatBtn'; btn.title = 'AI Help'; btn.setAttribute('aria-label', 'AI Help'); btn.textContent = '💬';
  const panel = document.createElement('div');
  panel.id = 'aiChatPanel';
  panel.innerHTML = `<div id="aiChatHead"><span>AI Help</span><span><button id="aiChatClear">Clear</button><button id="aiChatClose">✕</button></span></div>
    <div id="aiChatLog"></div>
    <form id="aiChatForm"><textarea id="aiChatInput" rows="1" placeholder="Apna sawal likhein... / Ask anything"></textarea><button id="aiChatSend" type="submit">Send</button></form>`;
  document.body.append(btn, panel);

  const log = panel.querySelector('#aiChatLog');
  const input = panel.querySelector('#aiChatInput');
  const send = panel.querySelector('#aiChatSend');
  const KEY = 'aiChatHistory_v1';
  let messages = [];
  try { messages = JSON.parse(sessionStorage.getItem(KEY) || '[]'); } catch (_) { messages = []; }

  function add(role, text) {
    const d = document.createElement('div');
    d.className = 'aiMsg ' + role;
    d.textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }
  function save() { try { sessionStorage.setItem(KEY, JSON.stringify(messages.slice(-20))); } catch (_) {} }
  function render() {
    log.innerHTML = '';
    if (!messages.length) add('b', 'Salam! 👋 Main aapki app ka AI helper hoon. Koi error ya sawal ho to jis zaban mein chahein poochein.');
    messages.forEach((m) => add(m.role === 'user' ? 'u' : 'b', m.content));
  }

  async function ask(text, errorText) {
    if (!text.trim()) return;
    messages.push({ role: 'user', content: text });
    add('u', text); save();
    send.disabled = true;
    const typing = add('b', '…');
    try {
      const res = await fetch('/api/chat', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: messages.slice(-12), page, errorText: errorText || '' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) throw new Error(data.message || `Request failed (${res.status})`);
      typing.textContent = data.data.reply;
      messages.push({ role: 'assistant', content: data.data.reply });
      save();
    } catch (err) {
      typing.className = 'aiMsg e';
      typing.textContent = err.message;
      messages.pop(); save(); // keep history valid (ends with assistant/none)
    } finally {
      send.disabled = false;
      log.scrollTop = log.scrollHeight;
    }
  }

  function open() { panel.classList.add('open'); input.focus(); }
  btn.onclick = () => (panel.classList.contains('open') ? panel.classList.remove('open') : open());
  panel.querySelector('#aiChatClose').onclick = () => panel.classList.remove('open');
  panel.querySelector('#aiChatClear').onclick = () => { messages = []; save(); render(); };
  panel.querySelector('#aiChatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const t = input.value; input.value = '';
    ask(t);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); panel.querySelector('#aiChatForm').requestSubmit(); }
  });

  // Called by "AI se poochein" buttons on error popups.
  window.openAiChat = function (errorText, question) {
    open();
    ask(question || 'Is error ka kya matlab hai aur ise kaise theek karun?', errorText || '');
  };

  render();
})();
