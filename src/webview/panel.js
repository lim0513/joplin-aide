/* Joplin Claude - chat panel webview */

function postMsg(msg) { webviewApi.postMessage(msg); }

function el(id) { return document.getElementById(id); }

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* Minimal markdown-ish rendering for assistant replies: code blocks,
 * inline code, bold, line breaks. Everything else stays escaped text. */
function renderLite(text) {
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

function addBubble(cls, html) {
  var m = el('cc-messages');
  if (!m) return null;
  var div = document.createElement('div');
  div.className = 'cc-msg ' + cls;
  div.innerHTML = html;
  m.appendChild(div);
  scrollToBottom();
  return div;
}

function addToolChip(text) {
  var m = el('cc-messages');
  if (!m) return;
  var last = m.lastElementChild;
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
    m.appendChild(div);
  }
  scrollToBottom();
}

function setBusy(busy) {
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
      div.textContent = '⏳ Claude is working...';
      m.appendChild(div);
      scrollToBottom();
    }
  } else if (spinner) {
    spinner.remove();
  }
}

function sendCurrent() {
  var input = el('cc-input');
  if (!input) return;
  var text = input.value.trim();
  if (!text) return;
  input.value = '';
  addBubble('cc-user', escapeHtml(text).replace(/\n/g, '<br>'));
  postMsg({ name: 'send', text: text });
}

document.addEventListener('click', function (e) {
  var t = e.target;
  if (!t) return;
  if (t.id === 'cc-send') { sendCurrent(); return; }
  if (t.id === 'cc-stop') { postMsg({ name: 'stop' }); return; }
  if (t.id === 'cc-new') {
    postMsg({ name: 'newSession' });
    var m = el('cc-messages');
    if (m) m.innerHTML = '';
    var c = el('cc-confirm');
    if (c) c.innerHTML = '';
    return;
  }
  var btn = t.closest ? t.closest('.cc-confirm-btn') : null;
  if (btn) {
    var card = btn.closest('.cc-confirm-card');
    postMsg({ name: 'confirmResult', requestId: btn.dataset.requestId, approved: btn.dataset.approved === '1' });
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

webviewApi.onMessage(function (msg) {
  if (!msg || !msg.message) return;
  var m = msg.message;

  if (m.name === 'noteContext') {
    var nc = el('cc-note-context');
    if (nc) nc.textContent = m.title ? '\uD83D\uDCC4 ' + m.title : '';
  } else if (m.name === 'assistantText') {
    addBubble('cc-assistant', renderLite(m.text));
  } else if (m.name === 'toolUse') {
    addToolChip('⚙ ' + m.tool);
  } else if (m.name === 'toolDone') {
    addToolChip('✔ ' + m.text);
  } else if (m.name === 'busy') {
    setBusy(m.busy === true);
  } else if (m.name === 'turnDone') {
    setBusy(false);
  } else if (m.name === 'error') {
    addBubble('cc-error', escapeHtml(m.text));
    setBusy(false);
  } else if (m.name === 'confirmWrite') {
    var c = el('cc-confirm');
    if (!c) return;
    var card = document.createElement('div');
    card.className = 'cc-confirm-card';
    card.innerHTML = '<div class="cc-confirm-text">⚠ ' + escapeHtml(m.summary) + '</div>'
      + '<div class="cc-confirm-actions">'
      + '<button class="cc-confirm-btn cc-approve" data-request-id="' + m.requestId + '" data-approved="1">Approve</button>'
      + '<button class="cc-confirm-btn cc-decline" data-request-id="' + m.requestId + '" data-approved="0">Decline</button>'
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
