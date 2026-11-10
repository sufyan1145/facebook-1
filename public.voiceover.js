// Voice Over page: Text to Speech (voice picker) + Voice Cloner + history.
let voices = [];            // [name, lang, 'M'|'F', family, short]
let mode = 'tts';           // 'tts' | 'clone'
let selected = null;        // selected tts voice row
let clones = [];
let selectedClone = null;
let pollTimer = null;
let previewAudio = null;
const rec = { ref: null, con: null };   // { base64 }

const $ = (id) => document.getElementById(id);
const FAMILY_LABEL = { Gemini: 'Gemini · emotion & style', 'Chirp3-HD': 'Premium · Chirp 3 HD', 'Chirp-HD': 'Premium · Chirp HD', Studio: 'Studio', Neural2: 'Neural2', Polyglot: 'Polyglot', News: 'News', Casual: 'Casual', Wavenet: 'WaveNet', Standard: 'Standard', Other: 'Other' };
let langNames = null;
function langLabel(code) {
  try {
    if (!langNames) langNames = new Intl.DisplayNames(['en'], { type: 'language' });
    const n = langNames.of(code);
    return n && n !== code ? `${n} (${code})` : code;
  } catch (_) { return code; }
}
function say(el, text, bad) { el.textContent = text || ''; el.style.color = bad ? 'var(--signal-red)' : 'var(--signal-green)'; }

// ---- script check + emotion style (mirrors the server) ----------------------------------------
const STYLE_OPTIONS = [['natural', 'Natural storyteller'], ['warm', 'Warm & emotional'], ['excited', 'Excited & energetic'], ['calm', 'Calm & soothing'], ['serious', 'Serious / news'], ['dramatic', 'Dramatic & gripping'], ['sad', 'Sad & heavy']];
const NATIVE_SCRIPT = { ur: /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g, pa: /[\u0A00-\u0A7F]/g, hi: /[\u0900-\u097F]/g };
const SCRIPT_LABEL = { ur: 'Urdu', pa: 'Gurmukhi', hi: 'Devanagari' };
function currentLang() { return mode === 'tts' ? (selected ? selected[1] : '') : ((clones.find((x) => x.id === selectedClone) || {}).language_code || ''); }
function scriptIssue() {
  const lang = currentLang(); const base = lang.split('-')[0]; const t = $('vText').value;
  const latin = (t.match(/[A-Za-z]/g) || []).length; const ar = (t.match(/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length;
  const gu = (t.match(/[\u0A00-\u0A7F]/g) || []).length; const de = (t.match(/[\u0900-\u097F]/g) || []).length;
  const total = latin + ar + gu + de;
  if (!lang || total < 8) return null;
  const re = NATIVE_SCRIPT[base];
  if (!re) return ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'tr', 'id', 'vi'].includes(base) && (ar + gu + de) / total >= 0.5
    ? { msg: 'The text is in Urdu / Punjabi / Hindi letters, but the selected voice speaks another language. Pick a voice of the text\'s language in the Language list.', convert: false } : null;
  const own = (t.match(re) || []).length;
  if (own / total >= 0.5) return null;
  if (latin / total >= 0.5) return { msg: `This text is in English letters (Roman). A voice reading Roman text sounds like an English speaker. Convert it to ${SCRIPT_LABEL[base]} script first.`, convert: true };
  if (base === 'pa' && ar / total >= 0.5) return { msg: 'This Punjabi is in Shahmukhi (Urdu letters). Google Punjabi voices read Gurmukhi only. Convert it to Gurmukhi, or pick an Urdu voice.', convert: true };
  return { msg: `This text is not in ${SCRIPT_LABEL[base]} script.`, convert: true };
}
function updateScriptWarn() {
  const i = scriptIssue();
  $('vScriptWarn').style.display = i ? 'block' : 'none';
  if (i) { $('vScriptMsg').textContent = i.msg; $('vConvert').style.display = i.convert ? 'inline-block' : 'none'; }
}
function updateStyleUI() {
  const on = mode === 'tts' && selected && selected[3] === 'Gemini';
  $('styleField').style.display = on ? 'block' : 'none';
}
function styleBody() {
  return mode === 'tts' && selected && selected[3] === 'Gemini' ? { style: $('vStyle').value, styleCustom: $('vStyleCustom').value } : {};
}
async function convertText() {
  const lang = currentLang(); const btn = $('vConvert'); const old = btn.textContent;
  btn.disabled = true; btn.textContent = 'Converting…'; say($('vMsg'), '');
  try {
    const r = await apiFetch('/voiceover/convert-script', { method: 'POST', body: JSON.stringify({ text: $('vText').value, languageCode: lang }) });
    $('vText').value = r.data.text; updateCounter();
    say($('vMsg'), 'Converted. Read it once to check the spelling, then create the voice-over.');
  } catch (err) { say($('vMsg'), err.message, true); }
  btn.disabled = false; btn.textContent = old;
}

// ---- voices ---------------------------------------------------------------------
function loadVoiceFilters() {
  const counts = {};
  voices.forEach((v) => { counts[v[1]] = (counts[v[1]] || 0) + 1; });
  const codes = Object.keys(counts).sort((a, b) => langLabel(a).localeCompare(langLabel(b)));
  $('vLang').innerHTML = codes.map((c) => `<option value="${c}">${escapeHtml(langLabel(c))} — ${counts[c]}</option>`).join('');
  const males = voices.filter((v) => v[2] === 'M').length;
  $('voiceTotals').textContent = `${voices.length} voices (${males} male, ${voices.length - males} female) in ${codes.length} languages`;
  $('vLang').value = codes.includes('en-US') ? 'en-US' : codes[0];
}

function refreshFamilies() {
  const lang = $('vLang').value;
  const fams = [...new Set(voices.filter((v) => v[1] === lang).map((v) => v[3]))];
  const cur = $('vFamily').value;
  $('vFamily').innerHTML = '<option value="">All types</option>' + fams.map((f) => `<option value="${f}">${escapeHtml(FAMILY_LABEL[f] || f)}</option>`).join('');
  if (fams.includes(cur)) $('vFamily').value = cur;
}

function visibleVoices() {
  const lang = $('vLang').value; const g = $('vGender').value; const fam = $('vFamily').value;
  const q = $('vSearch').value.trim().toLowerCase();
  return voices.filter((v) => v[1] === lang && (!g || v[2] === g) && (!fam || v[3] === fam) && (!q || v[4].toLowerCase().includes(q) || v[0].toLowerCase().includes(q)));
}

function renderVoices() {
  const list = visibleVoices();
  $('voiceCount').textContent = `${list.length} voice${list.length === 1 ? '' : 's'} shown`;
  $('voiceList').innerHTML = list.length ? list.map((v) => {
    const sel = selected && selected[0] === v[0] && selected[1] === v[1];
    const nm = v[3] === 'Chirp3-HD' || v[3] === 'Chirp-HD' || v[3] === 'Gemini' ? v[4] : `${v[3]} ${v[4]}`;
    return `<div class="vo-voice${sel ? ' selected' : ''}" data-name="${escapeHtml(v[0])}">
      <span class="vo-g ${v[2] === 'M' ? 'm' : 'f'}" title="${v[2] === 'M' ? 'Male' : 'Female'}">${v[2] === 'M' ? '♂' : '♀'}</span>
      <span class="nm">${escapeHtml(nm)}<small>${v[2] === 'M' ? 'Male' : 'Female'} · ${escapeHtml(FAMILY_LABEL[v[3]] || v[3])}</small></span>
      <button type="button" class="btn xs" data-play="${escapeHtml(v[0])}">▶</button></div>`;
  }).join('') : '<div class="empty" style="padding:14px;">No voice matches these filters.</div>';
  $('voiceList').querySelectorAll('.vo-voice').forEach((row) => row.addEventListener('click', (e) => {
    const name = row.dataset.name;
    const v = voices.find((x) => x[0] === name && x[1] === $('vLang').value);
    if (e.target.closest('[data-play]')) { playPreview({ voiceName: name, languageCode: v[1], sample: true }, e.target.closest('button')); return; }
    selected = v; renderVoices();
  }));
  updateStyleUI(); updateScriptWarn();
}

// the voice that is picked automatically when a language is chosen (never keep a voice of another language)
function defaultVoiceFor(lang) {
  const all = voices.filter((v) => v[1] === lang);
  return all.find((v) => v[3] === 'Gemini' && v[2] === 'M') || all.find((v) => v[3] === 'Chirp3-HD' && v[2] === 'M') || all[0] || null;
}

// ---- preview ---------------------------------------------------------------------
async function playPreview({ voiceName, languageCode, cloneId, sample }, btn) {
  const old = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const res = await fetch('/api/voiceover/preview', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voiceName, languageCode, cloneId, text: sample ? '' : $('vText').value, speakingRate: Number($('vRate').value), pitch: mode === 'tts' ? Number($('vPitch').value) : 0, ...styleBody() }),
    });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.message || 'Preview failed'); }
    const url = URL.createObjectURL(await res.blob());
    if (previewAudio) previewAudio.pause();
    previewAudio = new Audio(url); await previewAudio.play();
  } catch (err) { say($('vMsg'), err.message, true); }
  if (btn) { btn.disabled = false; btn.textContent = old; }
}

// ---- text counter --------------------------------------------------------------------
function updateCounter() {
  const chars = $('vText').value.length; const rate = Number($('vRate').value);
  const mins = chars / (900 * rate); const limit = 100;
  const el = $('vCounter');
  el.textContent = `${chars.toLocaleString('en-US')} characters ≈ ${mins < 1 ? '<1' : mins.toFixed(mins < 10 ? 1 : 0)} min of speech (max ${limit} min)`;
  el.style.color = mins > limit ? 'var(--signal-red)' : 'var(--text-faint)';
  $('vRateLabel').textContent = `${rate.toFixed(2).replace(/0$/, '')}×`;
  const p = Number($('vPitch').value);
  $('vPitchLabel').textContent = p === 0 ? 'Natural' : `${p < 0 ? 'Deeper' : 'Brighter'} (${p > 0 ? '+' : ''}${p})`;
}

// ---- create job --------------------------------------------------------------------------
async function createJob() {
  say($('vMsg'), '');
  const body = { text: $('vText').value, title: $('vTitle').value, speakingRate: Number($('vRate').value), pitch: mode === 'tts' ? Number($('vPitch').value) : 0, ...styleBody() };
  if (mode === 'tts') {
    if (!selected) return say($('vMsg'), 'Choose a voice from the list first.', true);
    body.voiceName = selected[0]; body.languageCode = selected[1];
  } else {
    if (!selectedClone) return say($('vMsg'), 'Choose one of your cloned voices first.', true);
    body.cloneId = selectedClone;
  }
  const btn = $('vCreate'); btn.disabled = true;
  try {
    await apiFetch('/voiceover/jobs', { method: 'POST', body: JSON.stringify(body) });
    say($('vMsg'), 'Started. It appears in "My voice-overs" below and finishes on its own - you can leave this page.');
    await loadHistory();
  } catch (err) { say($('vMsg'), err.message, true); }
  btn.disabled = false;
}

// ---- history ---------------------------------------------------------------------------------
function fmtDur(sec) {
  sec = Math.round(Number(sec) || 0);
  const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60); const s = sec % 60;
  return h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${s}s`;
}

function renderHistory(jobs) {
  const box = $('vHistory');
  if (!jobs.length) { box.innerHTML = '<span class="empty">No voice-overs yet.</span>'; return; }
  box.innerHTML = jobs.map((j) => {
    const active = j.status === 'pending' || j.status === 'processing';
    const pct = j.chunks_total ? Math.round((j.chunks_done / j.chunks_total) * 100) : 0;
    const badge = j.status === 'completed' ? 'success' : j.status === 'failed' ? 'failed' : 'pending';
    const label = j.status === 'pending' ? 'Waiting' : j.status === 'processing' ? `Making voice… ${pct}%` : j.status === 'completed' ? 'Ready' : 'Failed';
    let body = '';
    if (active) body = `<div class="vo-prog"><div style="width:${pct}%"></div></div><div style="font-size:11px; color:var(--text-faint); margin-top:4px;">${j.chunks_done}/${j.chunks_total || '…'} parts · about ${j.est_minutes} min of speech</div>`;
    else if (j.status === 'completed' && j.file_path) body = `<div style="font-size:12px; color:var(--text-faint); margin-top:4px;">${fmtDur(j.duration_seconds)} · ${(Number(j.file_bytes) / 1048576).toFixed(1)} MB</div>
      <audio class="vo-hist-audio" controls preload="none" src="/api/voiceover/jobs/${j.id}/file"></audio>
      <div style="margin-top:6px;"><a class="btn xs" href="/api/voiceover/jobs/${j.id}/file?download=1">Download MP3</a></div>`;
    else if (j.status === 'completed') body = '<div style="font-size:12px; color:var(--signal-amber); margin-top:4px;">This file expired (files are kept 7 days). Create it again to get a new one.</div>';
    else body = `<div style="font-size:12px; color:var(--signal-red); margin-top:4px;">${escapeHtml(j.error_message || 'Failed')}</div>`;
    return `<div style="padding:12px 0; border-bottom:1px solid var(--border, #2a3340);">
      <div class="flex-between"><div><b>${escapeHtml(j.title || 'Voice-over')}</b>
        <div style="font-size:12px; color:var(--text-faint);">${escapeHtml(j.voice_label || '')} · ${escapeHtml(j.language_code)} · ${Number(j.speaking_rate).toFixed(2)}× · ${timeAgo(j.created_at)}</div></div>
        <div style="white-space:nowrap;"><span class="badge ${badge}">${label}</span> <button class="btn xs danger" data-del="${j.id}">✕</button></div></div>${body}</div>`;
  }).join('');
  box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this voice-over?')) return;
    await apiFetch(`/voiceover/jobs/${b.dataset.del}`, { method: 'DELETE' });
    loadHistory();
  }));
}

async function loadHistory() {
  clearTimeout(pollTimer);
  try {
    const { data } = await apiFetch('/voiceover/jobs');
    // do not rebuild while someone is listening (it would stop the player)
    const playing = Array.from(document.querySelectorAll('.vo-hist-audio')).some((a) => !a.paused);
    const active = data.some((j) => j.status === 'pending' || j.status === 'processing');
    if (!playing || active) renderHistory(data);
    if (active) pollTimer = setTimeout(loadHistory, 4000);
  } catch (err) { $('vHistory').innerHTML = `<span class="empty">${escapeHtml(err.message)}</span>`; }
}

// ---- cloner ---------------------------------------------------------------------------------------
let cloneLangs = [];
function renderClones() {
  $('cloneEmpty').style.display = clones.length ? 'none' : 'block';
  $('cloneList').style.display = clones.length ? 'block' : 'none';
  $('cloneList').innerHTML = clones.map((c) => `<div class="vo-voice${selectedClone === c.id ? ' selected' : ''}" data-id="${c.id}">
    <span class="vo-g">🎙</span><span class="nm">${escapeHtml(c.name)}<small>${escapeHtml(langLabel(c.language_code))}</small></span>
    <button type="button" class="btn xs" data-play="${c.id}">▶</button> <button type="button" class="btn xs danger" data-rm="${c.id}">✕</button></div>`).join('');
  $('cloneList').querySelectorAll('.vo-voice').forEach((row) => row.addEventListener('click', async (e) => {
    const id = row.dataset.id;
    if (e.target.closest('[data-rm]')) {
      if (!confirm('Delete this cloned voice?')) return;
      await apiFetch(`/voiceover/clones/${id}`, { method: 'DELETE' });
      if (selectedClone === id) selectedClone = null;
      return loadClones();
    }
    if (e.target.closest('[data-play]')) { const c = clones.find((x) => x.id === id); return playPreview({ cloneId: id, languageCode: c.language_code, sample: true }, e.target.closest('button')); }
    selectedClone = id; renderClones();
  }));
}

async function loadClones() {
  clones = (await apiFetch('/voiceover/clones')).data;
  if (!clones.find((c) => c.id === selectedClone)) selectedClone = clones[0] ? clones[0].id : null;
  renderClones();
}

function updateScript() {
  const l = cloneLangs.find((x) => x.code === $('cLang').value);
  $('cScript').textContent = l ? l.script : '';
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('Could not read the file'));
    fr.readAsDataURL(file);
  });
}

function setupRecorder(key, recBtn, fileInput, audioEl, timerEl) {
  let mr = null; let timer = null; let chunks = [];
  const show = (dataUrl) => { rec[key] = dataUrl; audioEl.src = dataUrl; audioEl.style.display = 'block'; };
  fileInput.addEventListener('change', async () => { if (fileInput.files[0]) show(await fileToBase64(fileInput.files[0])); });
  recBtn.addEventListener('click', async () => {
    if (mr && mr.state === 'recording') { mr.stop(); return; }
    if (!navigator.mediaDevices || !window.MediaRecorder) return say($('cMsg'), 'Recording is not supported in this browser. Upload an audio file instead.', true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = []; mr = new MediaRecorder(stream);
      mr.ondataavailable = (e) => chunks.push(e.data);
      mr.onstop = async () => {
        clearInterval(timer); stream.getTracks().forEach((t) => t.stop());
        recBtn.textContent = '● Record again'; timerEl.textContent = '';
        show(await fileToBase64(new Blob(chunks, { type: mr.mimeType || 'audio/webm' })));
      };
      mr.start(); recBtn.textContent = '■ Stop';
      let s = 0; timerEl.textContent = '0s / 10s';
      timer = setInterval(() => { s += 1; timerEl.textContent = `${s}s / 10s`; if (s >= 10) mr.stop(); }, 1000);
    } catch (err) { say($('cMsg'), 'Microphone access was blocked. Allow the microphone, or upload a file.', true); }
  });
}

async function createClone() {
  say($('cMsg'), '');
  if (!$('cOwner').checked) return say($('cMsg'), 'Please confirm the voice is yours or you have permission.', true);
  if (!rec.ref || !rec.con) return say($('cMsg'), 'Add both recordings: the reference voice and the consent sentence.', true);
  const btn = $('cCreate'); btn.disabled = true; btn.textContent = 'Creating… (up to a minute)';
  try {
    const { data } = await apiFetch('/voiceover/clones', {
      method: 'POST',
      body: JSON.stringify({ name: $('cName').value, languageCode: $('cLang').value, referenceAudio: rec.ref, consentAudio: rec.con, ownerConfirmed: true }),
    });
    say($('cMsg'), 'Cloned voice created. Select it above, write your text on the right and create the voice-over.');
    selectedClone = data.id; await loadClones();
  } catch (err) { say($('cMsg'), err.message, true); }
  btn.disabled = false; btn.textContent = 'Create cloned voice';
}

function setMode(m) {
  mode = m;
  $('tabTts').classList.toggle('active', m === 'tts'); $('tabClone').classList.toggle('active', m === 'clone');
  $('ttsPanel').style.display = m === 'tts' ? 'block' : 'none';
  $('clonePanel').style.display = m === 'clone' ? 'block' : 'none';
  $('pitchField').style.display = m === 'tts' ? 'block' : 'none';
  say($('vMsg'), '');
  updateStyleUI(); updateScriptWarn();
}

(async function init() {
  const user = await requireAuthOrRedirect();
  if (!user) return;
  renderNav('voiceover');
  $('tabTts').addEventListener('click', () => setMode('tts'));
  $('tabClone').addEventListener('click', () => { setMode('clone'); });
  ['vLang'].forEach((id) => $(id).addEventListener('change', () => { refreshFamilies(); selected = defaultVoiceFor($('vLang').value); renderVoices(); }));
  ['vGender', 'vFamily'].forEach((id) => $(id).addEventListener('change', renderVoices));
  $('vSearch').addEventListener('input', renderVoices);
  ['vText', 'vRate', 'vPitch'].forEach((id) => $(id).addEventListener('input', updateCounter));
  $('vText').addEventListener('input', updateScriptWarn);
  $('vConvert').addEventListener('click', convertText);
  $('vStyle').innerHTML = STYLE_OPTIONS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
  $('vCreate').addEventListener('click', createJob);
  $('vRefresh').addEventListener('click', loadHistory);
  $('vPreview').addEventListener('click', (e) => {
    if (mode === 'tts') { if (!selected) return say($('vMsg'), 'Choose a voice first.', true); playPreview({ voiceName: selected[0], languageCode: selected[1], sample: false }, e.target); }
    else { if (!selectedClone) return say($('vMsg'), 'Choose a cloned voice first.', true); const c = clones.find((x) => x.id === selectedClone); playPreview({ cloneId: c.id, languageCode: c.language_code, sample: false }, e.target); }
  });
  setupRecorder('ref', $('refRec'), $('refFile'), $('refAudio'), $('refTimer'));
  setupRecorder('con', $('conRec'), $('conFile'), $('conAudio'), $('conTimer'));
  $('cLang').addEventListener('change', updateScript);
  $('cCreate').addEventListener('click', createClone);
  updateCounter();

  try {
    voices = (await apiFetch('/voiceover/voices')).data;
    loadVoiceFilters(); refreshFamilies();
    // a good default: first Premium male voice of the language
    selected = defaultVoiceFor($('vLang').value);
    renderVoices();
  } catch (err) { $('voiceTotals').textContent = `Could not load voices: ${err.message}`; $('voiceTotals').style.color = 'var(--signal-red)'; }
  try {
    cloneLangs = (await apiFetch('/voiceover/clone/languages')).data;
    $('cLang').innerHTML = cloneLangs.map((l) => `<option value="${l.code}">${escapeHtml(langLabel(l.code))}</option>`).join('');
    $('cLang').value = 'en-US'; updateScript();
    await loadClones();
  } catch (_) { /* cloner section just stays empty */ }
  loadHistory();
})();
