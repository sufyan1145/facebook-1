/* Mobile bottom tab bar (phones only, <= 860px).
   - Does nothing on desktop and on pages without the sidebar (login, register...).
   - Reads the links already rendered in the sidebar (#nav), so hidden sections stay hidden.
   - "More" simply opens the existing sidebar menu.
   Remove this file's <script> loader line from app.js to go back to the old layout. */
(function () {
  if (window.__mobileNavLoaded) return;
  window.__mobileNavLoaded = true;

  var sidebar = document.querySelector('.sidebar');
  var navBox = document.getElementById('nav');
  if (!sidebar || !navBox) return;

  var css = [
    '#mobTabBar{display:none}',
    '@media (max-width:860px){',
    '  #mobTabBar{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:14;',
    '    background:var(--panel,#121922);border-top:1px solid var(--border,#232D3A);',
    '    padding:6px 4px calc(6px + env(safe-area-inset-bottom,0px));box-shadow:0 -4px 18px rgba(0,0,0,.35)}',
    '  #mobTabBar a,#mobTabBar button{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;',
    '    min-height:48px;padding:4px 2px;background:none;border:0;border-radius:10px;cursor:pointer;',
    '    color:var(--text-muted,#8B98A8);text-decoration:none;font:inherit;font-size:11px;line-height:1.1;-webkit-tap-highlight-color:transparent}',
    '  #mobTabBar .mt-ic{font-size:19px;line-height:1}',
    '  #mobTabBar .mt-lb{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '  #mobTabBar a.active{color:var(--signal-green,#3ED9A0);background:var(--signal-green-dim,rgba(62,217,160,.12))}',
    '  body.mt-kbd #mobTabBar{display:none}',
    '  .content{padding-bottom:calc(84px + env(safe-area-inset-bottom,0px)) !important}',
    '  body.mt-kbd .content{padding-bottom:16px !important}',
    '  .topbar{position:sticky;top:0;z-index:12;background:var(--bg,#0B0F14)}',
    '  .btn{min-height:40px}',
    '  .menu-toggle{width:40px;height:40px}',
    '  #aiChatBtn{bottom:calc(74px + env(safe-area-inset-bottom,0px)) !important}',
    '  #aiChatPanel{bottom:calc(136px + env(safe-area-inset-bottom,0px)) !important;height:min(520px,calc(100vh - 190px)) !important}',
    '}'
  ].join('\n');
  var style = document.createElement('style');
  style.id = 'mobTabStyle';
  style.textContent = css;
  document.head.appendChild(style);

  // Preferred tabs, in order. Only the ones that exist in the sidebar are used.
  var PREFERRED = [
    ['dashboard.html', 'Home'],
    ['schedule.html', 'Schedules'],
    ['queue.html', 'Queue'],
    ['videoedit.html', 'Editor'],
    ['drive.html', 'Drive'],
    ['history.html', 'History']
  ];

  var bar = document.createElement('nav');
  bar.id = 'mobTabBar';
  bar.setAttribute('aria-label', 'Main');
  document.body.appendChild(bar);

  function base(href) { return (href || '').split('?')[0].split('#')[0].split('/').pop().toLowerCase(); }

  function build() {
    var links = Array.prototype.slice.call(navBox.querySelectorAll('a'));
    if (!links.length) return; // sidebar not rendered yet
    var byFile = {};
    links.forEach(function (a) { byFile[base(a.getAttribute('href'))] = a; });

    var picked = [];
    PREFERRED.forEach(function (p) {
      if (picked.length < 4 && byFile[p[0]]) picked.push({ a: byFile[p[0]], label: p[1] });
    });
    // If some were hidden for this user, fill from the first remaining links.
    links.forEach(function (a) {
      if (picked.length < 4 && !picked.some(function (x) { return x.a === a; })) {
        picked.push({ a: a, label: (a.textContent || '').trim().split(/\s+/)[0] });
      }
    });

    var html = picked.map(function (p) {
      var icon = p.a.querySelector('.nav-icon');
      var active = p.a.classList.contains('active') ? ' active' : '';
      return '<a href="' + p.a.getAttribute('href') + '" class="' + active.trim() + '">' +
        '<span class="mt-ic">' + (icon ? icon.textContent : '•') + '</span>' +
        '<span class="mt-lb"></span></a>';
    }).join('') +
      '<button type="button" id="mobTabMore" aria-label="More"><span class="mt-ic">☰</span><span class="mt-lb">More</span></button>';
    bar.innerHTML = html;
    // Set labels with textContent (no HTML injection from link text).
    var lbs = bar.querySelectorAll('a .mt-lb');
    picked.forEach(function (p, i) { if (lbs[i]) lbs[i].textContent = p.label; });
  }

  bar.addEventListener('click', function (e) {
    var more = e.target.closest && e.target.closest('#mobTabMore');
    if (!more) return;
    var toggle = document.querySelector('.menu-toggle');
    if (toggle) toggle.click();
    else { sidebar.classList.toggle('open'); }
  });

  build();
  // The sidebar links are rendered after login check; rebuild when they appear/change.
  new MutationObserver(build).observe(navBox, { childList: true, subtree: false });

  // Hide the bar while typing so it does not jump above the keyboard.
  document.addEventListener('focusin', function (e) {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) document.body.classList.add('mt-kbd');
  });
  document.addEventListener('focusout', function () {
    setTimeout(function () {
      var t = document.activeElement && document.activeElement.tagName;
      if (!/^(INPUT|TEXTAREA|SELECT)$/.test(t || '')) document.body.classList.remove('mt-kbd');
    }, 50);
  });
})();
