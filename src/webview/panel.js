/* Joplin Aide - chat panel webview */

function postMsg(msg) { webviewApi.postMessage(msg); }

// True while a claude request is in flight. Sending is locked (button AND
// Enter key) until the backend reports the turn finished or errored.
var _busy = false;

function el(id) { return document.getElementById(id); }

// i18n strings serialized by the backend into data-i18n on #aide-root
function T(key) {
  if (!window._i18n) {
    var root = document.getElementById('aide-root');
    if (root && root.dataset.i18n) {
      try { window._i18n = JSON.parse(root.dataset.i18n); } catch (e) { window._i18n = {}; }
    } else {
      window._i18n = {};
    }
  }
  return window._i18n[key] || key;
}

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* Markdown rendering for assistant replies via markdown-it (loaded as a
 * separate webview script). html:false keeps raw HTML escaped (XSS-safe,
 * javascript: links are rejected by markdown-it's validateLink), linkify
 * turns bare URLs into links. Falls back to a minimal renderer if the
 * library somehow failed to load. */
var _md = null;
function getMd() {
  if (_md) return _md;
  if (typeof window.markdownit === 'function') {
    _md = window.markdownit({ html: false, linkify: true, breaks: true });
    // Joplin internal note links (:/32-hex-id) - linkify them by hand below.
  }
  return _md;
}

function renderLite(text) {
  var md = getMd();
  if (md) return md.render(String(text == null ? '' : text));
  var s = escapeHtml(text);
  s = s.replace(/```([\s\S]*?)```/g, function (m, code) {
    return '<pre class="cc-code">' + code.replace(/^\n/, '') + '</pre>';
  });
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\n/g, '<br>');
  s = s.replace(/(<\/pre>)<br>/g, '$1');
  return s;
}

function scrollToBottom() {
  var m = el('cc-messages');
  if (m) m.scrollTop = m.scrollHeight;
}

// Append keeping the working-spinner pinned as the LAST element - without
// this, anything added while busy (the user's own bubble, streaming replies)
// lands BELOW the spinner.
function appendToMessages(node) {
  var m = el('cc-messages');
  if (!m) return;
  var spinner = document.getElementById('cc-spinner');
  if (spinner && spinner.parentElement === m) m.insertBefore(node, spinner);
  else m.appendChild(node);
}

function addBubble(cls, html) {
  var m = el('cc-messages');
  if (!m) return null;
  var div = document.createElement('div');
  div.className = 'cc-msg ' + cls;
  div.innerHTML = html;
  appendToMessages(div);
  scrollToBottom();
  return div;
}

function addToolChip(text) {
  var m = el('cc-messages');
  if (!m) return;
  var last = m.lastElementChild;
  if (last && last.id === 'cc-spinner' && last.previousElementSibling) {
    last = last.previousElementSibling;
  }
  if (last && last.classList.contains('cc-tools')) {
    var chip = document.createElement('span');
    chip.className = 'cc-tool-chip';
    chip.textContent = text;
    last.appendChild(chip);
  } else {
    var div = document.createElement('div');
    div.className = 'cc-tools';
    var chip2 = document.createElement('span');
    chip2.className = 'cc-tool-chip';
    chip2.textContent = text;
    div.appendChild(chip2);
    appendToMessages(div);
  }
  scrollToBottom();
}

function setBusy(busy) {
  _busy = busy;
  var send = el('cc-send');
  var stop = el('cc-stop');
  var input = el('cc-input');
  if (send) send.style.display = busy ? 'none' : '';
  if (stop) stop.style.display = busy ? '' : 'none';
  if (input) input.disabled = false;
  var m = el('cc-messages');
  var spinner = document.getElementById('cc-spinner');
  if (busy) {
    if (!spinner && m) {
      var div = document.createElement('div');
      div.id = 'cc-spinner';
      div.className = 'cc-spinner';
      div.textContent = T('working');
      m.appendChild(div);
      scrollToBottom();
    }
  } else if (spinner) {
    spinner.remove();
  }
}

function sendText(text) {
  if (_busy) return;
  text = String(text || '').trim();
  if (!text) return;
  setBusy(true);
  attachMsgFooter(addBubble('cc-user', escapeHtml(text).replace(/\n/g, '<br>')), text, Date.now());
  scrollToBottom(); // the footer wrap adds height after addBubble's scroll
  postMsg({ name: 'send', text: text });
}

function sendCurrent() {
  if (_busy) return; // a request is running - keep the draft, ignore the send
  var input = el('cc-input');
  if (!input) return;
  var text = input.value.trim();
  if (!text) return;
  // Lock immediately (before the backend's busy event arrives) so a rapid
  // double-Enter cannot fire two requests.
  setBusy(true);
  input.value = '';
  var bubbleHtml = escapeHtml(text).replace(/\n/g, '<br>');
  var chips = document.querySelectorAll('#cc-attachments .cc-att-chip');
  if (chips.length) {
    var names = [];
    for (var ci = 0; ci < chips.length; ci++) names.push(escapeHtml(chips[ci].dataset.name || ''));
    bubbleHtml += '<div class="cc-msg-atts">\uD83D\uDCCE ' + names.join(' \u00B7 ') + '</div>';
  }
  attachMsgFooter(addBubble('cc-user', bubbleHtml), text, Date.now());
  scrollToBottom(); // the footer wrap adds height after addBubble's scroll
  postMsg({ name: 'send', text: text });
}

// ---- conversation attachments ----
function sendFileToBackend(file) {
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) {
    addBubble('cc-error', escapeHtml(file.name) + ' (>8MB)');
    return;
  }
  var reader = new FileReader();
  reader.onload = function () {
    var result = String(reader.result || '');
    var comma = result.indexOf(',');
    postMsg({ name: 'attachFile', fileName: file.name, data: comma >= 0 ? result.slice(comma + 1) : result });
  };
  reader.readAsDataURL(file);
}

function handleFiles(fileList) {
  for (var i = 0; i < fileList.length && i < 5; i++) sendFileToBackend(fileList[i]);
}

// Paste images (e.g. screenshots) straight from the clipboard as attachments.
// Text paste is left untouched.
document.addEventListener('paste', function (e) {
  if (!e.clipboardData) return;
  var files = [];
  var items = e.clipboardData.items || [];
  for (var i = 0; i < items.length; i++) {
    if (items[i].kind === 'file') {
      var f = items[i].getAsFile();
      if (f) files.push(f);
    }
  }
  if (!files.length) return;
  e.preventDefault();
  for (var j = 0; j < files.length && j < 5; j++) {
    var pf = files[j];
    // Pasted screenshots come in with generic names - stamp them.
    if (!pf.name || pf.name === 'image.png') {
      var ext = (pf.type && pf.type.indexOf('/') >= 0) ? pf.type.split('/')[1] : 'png';
      pf = new File([pf], 'paste-' + Date.now() + '-' + j + '.' + ext, { type: pf.type || 'image/png' });
    }
    sendFileToBackend(pf);
  }
});

document.addEventListener('dragover', function (e) { e.preventDefault(); });
document.addEventListener('drop', function (e) {
  e.preventDefault();
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
    handleFiles(e.dataTransfer.files);
  }
});

document.addEventListener('change', function (e) {
  if (e.target && e.target.id === 'cc-file' && e.target.files) {
    handleFiles(e.target.files);
    e.target.value = '';
  }
  if (e.target && e.target.id === 'cc-backend') {
    postMsg({ name: 'setBackend', value: e.target.value });
  }
});

document.addEventListener('click', function (e) {
  var t = e.target;
  if (!t) return;
  // Markdown links: never navigate the webview itself - hand the URL to the
  // backend, which opens http(s) in the system browser.
  var link = t.closest ? t.closest('.cc-msg a[href]') : null;
  if (link) {
    e.preventDefault();
    postMsg({ name: 'openUrl', url: link.getAttribute('href') });
    return;
  }
  // Restart button: first click pops the confirm pill, clicking the pill
  // executes, any other click dismisses it.
  var restartBtn = t.closest ? t.closest('.cc-restart') : null;
  if (restartBtn) {
    var rWrap = restartBtn.closest('.cc-msg-wrap');
    var oldPop = document.querySelector('.cc-restart-pop');
    if (oldPop) {
      var samePop = oldPop.parentElement === rWrap;
      oldPop.remove();
      if (samePop) return; // toggle off
    }
    var pop = document.createElement('div');
    pop.className = 'cc-restart-pop';
    var pb = document.createElement('button');
    pb.textContent = T('restartHere');
    pop.appendChild(pb);
    if (rWrap) rWrap.appendChild(pop);
    return;
  }
  var restartGo = t.closest ? t.closest('.cc-restart-pop') : null;
  if (restartGo) {
    var gWrap = restartGo.closest('.cc-msg-wrap');
    var gBubble = gWrap ? gWrap.querySelector('.cc-msg') : null;
    postMsg({
      name: 'restartFrom',
      ts: Number((gWrap && gWrap.dataset.ts) || 0),
      text: gBubble && gBubble._ccRaw ? gBubble._ccRaw : '',
    });
    restartGo.remove();
    return;
  }
  var strayPop = document.querySelector('.cc-restart-pop');
  if (strayPop) strayPop.remove();

  var copyBtn = t.closest ? t.closest('.cc-copy') : null;
  if (copyBtn) {
    var copyWrap = copyBtn.closest('.cc-msg-wrap');
    var copyBubble = copyWrap ? copyWrap.querySelector('.cc-msg') : null;
    var rawText = copyBubble && copyBubble._ccRaw ? copyBubble._ccRaw : (copyBubble ? copyBubble.innerText : '');
    var flashDone = function() {
      copyBtn.innerHTML = CC_CHECK_SVG;
      setTimeout(function() { copyBtn.innerHTML = CC_COPY_SVG; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(rawText).then(flashDone, function() {
        postMsg({ name: 'copyText', text: rawText });
        flashDone();
      });
    } else {
      postMsg({ name: 'copyText', text: rawText });
      flashDone();
    }
    return;
  }
  if (t.id === 'cc-send') { sendCurrent(); return; }
  if (t.id === 'cc-attach') {
    var fi = el('cc-file');
    if (fi) fi.click();
    return;
  }
  var qBtn = t.closest ? t.closest('.cc-q-option') : null;
  if (qBtn) {
    var qCard = qBtn.closest('.cc-question-card');
    if (qCard) {
      var btns = qCard.querySelectorAll('.cc-q-option');
      for (var qb = 0; qb < btns.length; qb++) btns[qb].disabled = true;
      qCard.classList.add('cc-q-answered');
      qBtn.classList.add('cc-q-chosen');
    }
    var reqId = qCard ? qCard.dataset.requestId : '';
    if (reqId) {
      // ask_user tool: the answer goes back as the tool result (same turn)
      postMsg({ name: 'questionAnswer', requestId: reqId, value: qBtn.dataset.value });
    } else {
      // legacy fallback (built-in AskUserQuestion): answer as a new message
      sendText(qBtn.dataset.value);
    }
    return;
  }
  var attDel = t.closest ? t.closest('.cc-att-del') : null;
  if (attDel) {
    postMsg({ name: 'removeAttachment', id: attDel.dataset.id });
    return;
  }
  if (t.id === 'cc-stop') { postMsg({ name: 'stop' }); return; }
  if (t.id === 'cc-history') {
    var ov = el('cc-history-overlay');
    if (ov) { ov.remove(); return; }
    postMsg({ name: 'listHistory' });
    return;
  }
  var histDel = t.closest ? t.closest('.cc-hist-del') : null;
  if (histDel) {
    postMsg({ name: 'deleteConversation', id: histDel.dataset.id });
    return;
  }
  var histItem = t.closest ? t.closest('.cc-hist-item') : null;
  if (histItem) {
    postMsg({ name: 'loadConversation', id: histItem.dataset.id });
    return;
  }
  if (t.id === 'cc-history-overlay') {
    t.remove();
    return;
  }
  if (t.id === 'cc-new') {
    postMsg({ name: 'newSession' });
    _histMsgs = null; _histShown = 0; _histConvId = ''; _histSegNext = -1; _histFetching = false;
    var m = el('cc-messages');
    if (m) m.innerHTML = '';
    var c = el('cc-confirm');
    if (c) c.innerHTML = '';
    return;
  }
  var btn = t.closest ? t.closest('.cc-confirm-btn') : null;
  if (btn) {
    var card = btn.closest('.cc-confirm-card');
    postMsg({
      name: 'confirmResult',
      requestId: btn.dataset.requestId,
      approved: btn.dataset.approved === '1',
      always: btn.dataset.always === '1',
    });
    if (card) card.remove();
    return;
  }
});

document.addEventListener('keydown', function (e) {
  if (e.target && e.target.id === 'cc-input' && e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendCurrent();
  }
});

// ---- chunked history rendering (seamless scroll-up pagination) ----
var _histMsgs = null;    // in-memory transcript of the loaded conversation
var _histShown = 0;      // how many entries from the tail are in the DOM
var _histConvId = '';    // conversation the archive segments belong to
var _histSegNext = -1;   // next archive segment to fetch (newest first), -1 = none
var _histFetching = false;

function fmtMsgTime(ts) {
  if (!ts) return '';
  var d = new Date(ts);
  var now = new Date();
  var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  if (d.toDateString() === now.toDateString()) return hm;
  return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + hm;
}

// Copy / check icons for the hover footer (Claude-desktop style).
var CC_COPY_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
var CC_CHECK_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
var CC_RESTART_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>';

// Hover footer BELOW the bubble (outside it, Claude-desktop style): the
// bubble is moved into a .cc-msg-wrap and the footer (borderless icon
// button + time) sits under it, revealed on hover of the whole wrap.
// The raw text rides the bubble as a JS property (not an attribute) so
// big messages don't bloat the DOM. Returns the wrap so callers building
// detached nodes can insert it instead of the bare bubble.
function attachMsgFooter(bubble, rawText, ts) {
  if (!bubble) return bubble;
  bubble._ccRaw = rawText;
  var p = bubble.parentElement;
  var wrap = (p && p.classList && p.classList.contains('cc-msg-wrap')) ? p : null;
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'cc-msg-wrap ' + (bubble.classList.contains('cc-user') ? 'cc-wrap-user' : 'cc-wrap-assistant');
    if (p) p.insertBefore(wrap, bubble); // take the bubble's place in the list
    wrap.appendChild(bubble);
  }
  var old = wrap.querySelector('.cc-msg-footer');
  if (old) old.remove();
  var foot = document.createElement('div');
  foot.className = 'cc-msg-footer';
  // User messages with a timestamp can be a rewind point (Claude-desktop
  // style "restart conversation from here").
  if (bubble.classList.contains('cc-user') && ts) {
    wrap.dataset.ts = String(ts);
    var rbtn = document.createElement('button');
    rbtn.className = 'cc-restart';
    rbtn.title = T('titleRestart');
    rbtn.innerHTML = CC_RESTART_SVG;
    foot.appendChild(rbtn);
  }
  var btn = document.createElement('button');
  btn.className = 'cc-copy';
  btn.title = T('titleCopy');
  btn.innerHTML = CC_COPY_SVG;
  foot.appendChild(btn);
  var when = fmtMsgTime(ts);
  if (when) {
    var timeEl = document.createElement('span');
    timeEl.className = 'cc-msg-time';
    timeEl.textContent = when;
    foot.appendChild(timeEl);
  }
  wrap.appendChild(foot);
  return wrap;
}

function buildMsgNode(one) {
  var div = document.createElement('div');
  if (one.role === 'user') {
    div.className = 'cc-msg cc-user';
    div.innerHTML = escapeHtml(one.text).replace(/\n/g, '<br>');
    return attachMsgFooter(div, one.text, one.ts);
  } else if (one.role === 'assistant') {
    div.className = 'cc-msg cc-assistant';
    div.innerHTML = renderLite(one.text);
    return attachMsgFooter(div, one.text, one.ts);
  }
  else if (one.role === 'tool') {
    div.className = 'cc-tools';
    var chip = document.createElement('span');
    chip.className = 'cc-tool-chip';
    chip.textContent = '⚙ ' + one.text;
    div.appendChild(chip);
  } else { div.className = 'cc-msg cc-error'; div.innerHTML = escapeHtml(one.text); }
  return div;
}

// Prepends the next older in-memory chunk (newest chunk on the first call).
function renderHistoryChunk() {
  var m = el('cc-messages');
  if (!m || !_histMsgs) return;
  var CHUNK = 100;
  var end = _histMsgs.length - _histShown;
  var start = Math.max(0, end - CHUNK);
  if (end <= start) return;
  var frag = document.createDocumentFragment();
  for (var i = start; i < end; i++) frag.appendChild(buildMsgNode(_histMsgs[i]));
  m.insertBefore(frag, m.firstChild);
  _histShown += (end - start);
}

// Called when the user nears the top: first drain the in-memory transcript,
// then pull archived segments from the backend (newest segment first). The
// scroll position is re-anchored after prepending so the view doesn't jump.
function maybeLoadEarlier() {
  var m = el('cc-messages');
  if (!m) return;
  if (_histMsgs && _histShown < _histMsgs.length) {
    var prevH = m.scrollHeight;
    renderHistoryChunk();
    m.scrollTop += m.scrollHeight - prevH;
  } else if (_histSegNext >= 0 && !_histFetching) {
    _histFetching = true;
    postMsg({ name: 'loadOlder', id: _histConvId, seq: _histSegNext });
  }
}

document.addEventListener('scroll', function (e) {
  if (e.target && e.target.id === 'cc-messages' && e.target.scrollTop < 40) {
    maybeLoadEarlier();
  }
}, true);

// Live streaming bubble state (token-level deltas)
var _streamBubble = null;
var _streamRaw = '';

function endStreamBubble() {
  _streamBubble = null;
  _streamRaw = '';
}

webviewApi.onMessage(function (msg) {
  if (!msg || !msg.message) return;
  var m = msg.message;

  if (m.name === 'assistantStart') {
    _streamRaw = '';
    _streamBubble = addBubble('cc-assistant', '');
    return;
  }
  if (m.name === 'assistantDelta') {
    if (!_streamBubble) { _streamRaw = ''; _streamBubble = addBubble('cc-assistant', ''); }
    _streamRaw += m.text;
    _streamBubble.innerHTML = renderLite(_streamRaw);
    scrollToBottom();
    return;
  }

  if (m.name === 'historyList') {
    var old2 = el('cc-history-overlay');
    if (old2) old2.remove();
    var overlay = document.createElement('div');
    overlay.id = 'cc-history-overlay';
    var box = document.createElement('div');
    box.className = 'cc-hist-box';
    if (!m.items || !m.items.length) {
      box.innerHTML = '<div class="cc-hist-empty">' + escapeHtml(T('noHistory')) + '</div>';
    } else {
      for (var i = 0; i < m.items.length; i++) {
        var it = m.items[i];
        var d = it.updated ? new Date(it.updated) : null;
        var when = d ? (d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2)) : '';
        var row = document.createElement('div');
        row.className = 'cc-hist-item';
        row.dataset.id = it.id;
        row.innerHTML = '<div class="cc-hist-main"><div class="cc-hist-title">' + escapeHtml(it.title) + '</div>'
          + '<div class="cc-hist-date">' + when + '</div></div>'
          + '<button class="cc-hist-del" data-id="' + it.id + '" title="' + escapeHtml(T('titleDelete')) + '">&#x2715;</button>';
        box.appendChild(row);
      }
    }
    overlay.appendChild(box);
    document.getElementById('aide-root').appendChild(overlay);
  } else if (m.name === 'setInput') {
    var siEl = el('cc-input');
    if (siEl) { siEl.value = m.text || ''; siEl.focus(); }
  } else if (m.name === 'conversationLoaded') {
    var ov3 = el('cc-history-overlay');
    if (ov3) ov3.remove();
    var mm = el('cc-messages');
    if (mm) mm.innerHTML = '';
    var cf = el('cc-confirm');
    if (cf) cf.innerHTML = '';
    // Long transcripts: render only the newest chunk; scrolling to the top
    // pages in older chunks (then archived segments) seamlessly.
    _histMsgs = m.messages || [];
    _histShown = 0;
    _histConvId = m.id || '';
    _histSegNext = (m.archiveSegments || 0) - 1;
    _histFetching = false;
    renderHistoryChunk();
    scrollToBottom();
    setBusy(false);
  } else if (m.name === 'attached') {
    var attWrap = el('cc-attachments');
    if (attWrap) {
      var chip = document.createElement('span');
      chip.className = 'cc-att-chip';
      chip.dataset.id = m.id;
      chip.dataset.name = m.fileName;
      chip.innerHTML = '\uD83D\uDCCE ' + escapeHtml(m.fileName)
        + ' <button class="cc-att-del" data-id="' + m.id + '">\u2715</button>';
      attWrap.appendChild(chip);
    }
  } else if (m.name === 'attachmentRemoved') {
    var gone = document.querySelector('.cc-att-chip[data-id="' + m.id + '"]');
    if (gone) gone.remove();
  } else if (m.name === 'attachmentsCleared') {
    var wrap2 = el('cc-attachments');
    if (wrap2) wrap2.innerHTML = '';
  } else if (m.name === 'olderMessages') {
    _histFetching = false;
    if (m.id !== _histConvId) return; // stale reply after switching
    if (m.messages && m.messages.length) {
      var om = el('cc-messages');
      var prevOH = om ? om.scrollHeight : 0;
      var ofrag = document.createDocumentFragment();
      for (var ok = 0; ok < m.messages.length; ok++) ofrag.appendChild(buildMsgNode(m.messages[ok]));
      if (om) {
        om.insertBefore(ofrag, om.firstChild);
        om.scrollTop += om.scrollHeight - prevOH;
      }
      _histSegNext = (typeof m.seq === 'number' ? m.seq : _histSegNext) - 1;
    } else {
      _histSegNext = -1; // missing/empty segment - stop asking
    }
  } else if (m.name === 'backendState') {
    var bb = el('cc-backend');
    var label = m.backend === 'copilot' ? 'Copilot' : 'Claude';
    if (bb) {
      bb.value = m.backend === 'copilot' ? 'copilot' : 'claude';
      bb.classList.toggle('cc-backend-copilot', m.backend === 'copilot');
    }
    if (m.switched) {
      // Own row per switch - addToolChip would glue repeated switches (and
      // later tool chips) onto one line.
      var note = document.createElement('div');
      note.className = 'cc-switch-note';
      note.textContent = '⇄ ' + T('backendSwitched').replace('{name}', label);
      appendToMessages(note);
      scrollToBottom();
    }
  } else if (m.name === 'noteContext') {
    var nc = el('cc-note-context');
    if (nc) nc.textContent = m.title ? '\uD83D\uDCC4 ' + m.title : '';
  } else if (m.name === 'assistantText') {
    // Final authoritative text: replace the live streaming bubble if open,
    // otherwise plain append (fallback when deltas are unavailable).
    if (_streamBubble) {
      _streamBubble.innerHTML = renderLite(m.text);
      attachMsgFooter(_streamBubble, m.text, Date.now());
      endStreamBubble();
      scrollToBottom();
    } else {
      attachMsgFooter(addBubble('cc-assistant', renderLite(m.text)), m.text, Date.now());
      scrollToBottom();
    }
  } else if (m.name === 'userQuestion') {
    endStreamBubble();
    var qs = m.questions || [];
    for (var qi = 0; qi < qs.length; qi++) {
      var q = qs[qi];
      var card = document.createElement('div');
      card.className = 'cc-question-card';
      if (m.requestId) card.dataset.requestId = m.requestId;
      var html = '<div class="cc-q-text">' + escapeHtml(q.question || '') + '</div><div class="cc-q-options">';
      var opts = q.options || [];
      for (var oi = 0; oi < opts.length; oi++) {
        var label = typeof opts[oi] === 'string' ? opts[oi] : (opts[oi].label || '');
        html += '<button class="cc-q-option" data-value="' + escapeHtml(label) + '">' + escapeHtml(label) + '</button>';
      }
      html += '</div>';
      card.innerHTML = html;
      appendToMessages(card);
    }
    scrollToBottom();
  } else if (m.name === 'questionGone') {
    var goneCard = document.querySelector('.cc-question-card[data-request-id="' + m.requestId + '"]');
    if (goneCard) {
      var goneBtns = goneCard.querySelectorAll('.cc-q-option');
      for (var gb = 0; gb < goneBtns.length; gb++) goneBtns[gb].disabled = true;
      goneCard.classList.add('cc-q-answered');
    }
  } else if (m.name === 'toolUse') {
    endStreamBubble();
    addToolChip('⚙ ' + m.tool);
  } else if (m.name === 'toolDone') {
    addToolChip('✔ ' + m.text);
  } else if (m.name === 'busy') {
    setBusy(m.busy === true);
  } else if (m.name === 'turnDone') {
    endStreamBubble();
    setBusy(false);
  } else if (m.name === 'error') {
    endStreamBubble();
    addBubble('cc-error', escapeHtml(m.text));
    setBusy(false);
  } else if (m.name === 'confirmWrite') {
    var c = el('cc-confirm');
    if (!c) return;
    var card = document.createElement('div');
    card.className = 'cc-confirm-card';
    card.innerHTML = '<div class="cc-confirm-text">⚠ ' + escapeHtml(m.summary) + '</div>'
      + '<div class="cc-confirm-actions">'
      + '<button class="cc-confirm-btn cc-approve" data-request-id="' + m.requestId + '" data-approved="1">' + escapeHtml(T('approve')) + '</button>'
      + '<button class="cc-confirm-btn cc-always" data-request-id="' + m.requestId + '" data-approved="1" data-always="1">' + escapeHtml(T('alwaysAllow')) + '</button>'
      + '<button class="cc-confirm-btn cc-decline" data-request-id="' + m.requestId + '" data-approved="0">' + escapeHtml(T('decline')) + '</button>'
      + '</div>';
    c.appendChild(card);
    scrollToBottom();
  } else if (m.name === 'confirmGone') {
    var btns = document.querySelectorAll('.cc-confirm-btn[data-request-id="' + m.requestId + '"]');
    if (btns.length) {
      var card2 = btns[0].closest('.cc-confirm-card');
      if (card2) card2.remove();
    }
  }
});

// Announce readiness so the backend can restore the current conversation
// after any webview reload (layout change, hide/show, app resume).
postMsg({ name: 'ready' });
