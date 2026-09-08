(function () {
  'use strict';

  const mount = document.getElementById('app');
  const shell = document.getElementById('appShell');

  // ---------- Navigation (neues Modul = ein Eintrag) ----------
  // `admin: true` blendet den Punkt für alle anderen aus. Das ist Kosmetik —
  // durchgesetzt werden die Rechte im Backend.
  const NAV = [
    { items: [
      { path: '/', label: 'Übersicht', icon: 'home' },
    ] },
    { label: 'Lager', items: [
      { path: '/artikel', label: 'Artikel', icon: 'box' },
      { path: '/orte', label: 'Lagerorte', icon: 'pin' },
      { path: '/scannen', label: 'Scannen', icon: 'scan' },
    ] },
    { label: 'Ausgabe', items: [
      { path: '/ausleihe', label: 'Ausleihe', icon: 'hand' },
      { path: '/etiketten', label: 'Etiketten', icon: 'tag' },
    ] },
    { footer: true, items: [
      { path: '/benutzer', label: 'Benutzer', icon: 'user', admin: true },
      { path: '/einstellungen', label: 'Einstellungen', icon: 'gear', admin: true },
    ] },
  ];

  const ICONS = {
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
    box: '<path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/>',
    pin: '<path d="M12 21s7-6.4 7-11a7 7 0 10-14 0c0 4.6 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
    scan: '<path d="M4 8V5a1 1 0 011-1h3M16 4h3a1 1 0 011 1v3M20 16v3a1 1 0 01-1 1h-3M8 20H5a1 1 0 01-1-1v-3"/><path d="M4 12h16"/>',
    hand: '<path d="M8 13V5a1.5 1.5 0 013 0v6M11 11V4a1.5 1.5 0 013 0v7M14 11V6a1.5 1.5 0 013 0v8a6 6 0 01-6 6h-1a5 5 0 01-5-5v-3l-1.5-1.5a1.5 1.5 0 012-2L8 13"/>',
    tag: '<path d="M3 11V4a1 1 0 011-1h7l9 9-8 8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
  };

  function icon(name) {
    return `<svg viewBox="0 0 24 24" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  }

  function parseHash() {
    const h = (location.hash || '#/').replace(/^#/, '');
    const [path, query] = h.split('?');
    const params = Object.fromEntries(new URLSearchParams(query || ''));
    return { path, params };
  }

  function buildSidebar() {
    const nav = document.getElementById('sidebarNav');
    if (!nav) return;
    nav.innerHTML = '';
    const admin = SL.store.istAdmin();
    for (const group of NAV) {
      const sichtbar = group.items.filter(i => !i.admin || admin);
      if (!sichtbar.length) continue;
      const wrap = document.createElement('div');
      if (group.footer) wrap.className = 'nav-spacer';
      if (group.label) {
        const gl = document.createElement('div');
        gl.className = 'nav-group-label';
        gl.textContent = group.label;
        wrap.appendChild(gl);
      }
      for (const item of sichtbar) {
        const a = document.createElement('a');
        a.className = 'nav-item';
        a.href = '#' + item.path;
        a.setAttribute('data-route', item.path);
        a.title = item.label;
        a.innerHTML = `<span class="nav-icon">${icon(item.icon)}</span><span class="nav-label">${item.label}</span>`;
        // Drawer auf dem Handy schließen, sonst verdeckt er die Zielseite.
        a.addEventListener('click', () => shell && shell.classList.remove('nav-open'));
        wrap.appendChild(a);
      }
      nav.appendChild(wrap);
    }
  }

  function setActiveNav(path) {
    document.querySelectorAll('.sidebar-nav .nav-item').forEach(a => {
      const route = a.getAttribute('data-route');
      const active = route === '/' ? (path === '/' || path === '') : path.startsWith(route);
      a.classList.toggle('active', active);
    });
  }

  function bindShellControls() {
    const collapseBtn = document.getElementById('sidebarCollapse');
    const menuBtn = document.getElementById('menuToggle');
    const backdrop = document.getElementById('sidebarBackdrop');
    try { if (localStorage.getItem('sl.sidebarCollapsed') === '1') shell.classList.add('sidebar-collapsed'); } catch (_) {}
    if (collapseBtn) collapseBtn.addEventListener('click', () => {
      const c = shell.classList.toggle('sidebar-collapsed');
      try { localStorage.setItem('sl.sidebarCollapsed', c ? '1' : '0'); } catch (_) {}
    });
    if (menuBtn) menuBtn.addEventListener('click', () => shell.classList.toggle('nav-open'));
    if (backdrop) backdrop.addEventListener('click', () => shell.classList.remove('nav-open'));
  }

  // Anmeldezustand unten in der Seitenleiste — die Frage „unter welchem Namen
  // buche ich gerade?" muss von jeder Seite aus beantwortbar sein.
  function renderKonto() {
    const fuss = document.getElementById('kontoLeiste');
    if (!fuss) return;
    fuss.innerHTML = '';
    const b = SL.store.state.benutzer;
    if (!b) {
      const a = document.createElement('a');
      a.className = 'btn btn-sm';
      a.href = '#/anmelden';
      a.textContent = 'Anmelden';
      fuss.appendChild(a);
      const hinweis = document.createElement('div');
      hinweis.className = 'muted konto-hinweis';
      hinweis.textContent = 'Nur Lesezugriff';
      fuss.appendChild(hinweis);
      return;
    }
    const name = document.createElement('div');
    name.className = 'konto-name';
    name.textContent = b.name;
    const ab = document.createElement('button');
    ab.className = 'btn btn-sm';
    ab.type = 'button';
    ab.textContent = 'Abmelden';
    ab.addEventListener('click', async () => {
      await SL.store.abmelden();
      location.hash = '#/';
      neuZeichnen();
    });
    fuss.appendChild(name);
    fuss.appendChild(ab);
  }

  // ---------- Router ----------
  function router() {
    const { path, params } = parseHash();
    mount.innerHTML = '';
    mount.scrollTop = 0;
    setActiveNav(path);
    renderKonto();

    const s = SL.store.state;

    if (!s.backendDa) {
      return platzhalter('Backend nicht erreichbar',
        'Der Dienst antwortet nicht. Im Container hilft meist: systemctl restart schullager-backend');
    }

    // Diese beiden Zustände haben Vorrang vor jeder Route — sonst landet man in
    // einer Ansicht, die das Backend ohnehin abweist.
    if (!s.eingerichtet) return SL.views.renderErsteinrichtung(mount);
    if (SL.store.mussPasswortWechseln()) return SL.views.renderPasswortWechsel(mount);

    if (path === '/' || path === '') return SL.views.renderUebersicht(mount);
    if (path === '/anmelden') {
      if (SL.store.istAngemeldet()) { location.hash = '#/'; return; }
      return SL.views.renderAnmeldung(mount, { weiterZu: params.weiter });
    }
    if (path === '/benutzer') return SL.views.renderBenutzer(mount);
    if (path === '/einstellungen') return SL.views.renderEinstellungen(mount, params);

    // Ab Phase 1/3/4. Bewusst als benannte Platzhalter und nicht als „Seite
    // nicht gefunden": die Navigationspunkte stehen schon da, und ein
    // Fehlertext dahinter sähe nach Defekt aus.
    if (path === '/artikel') return platzhalter('Artikel', 'Suche und Artikeldetails kommen in der nächsten Ausbaustufe.');
    if (path === '/orte') return platzhalter('Lagerorte', 'Der Lagerortbaum kommt in der nächsten Ausbaustufe.');
    if (path === '/scannen') return platzhalter('Scannen', 'Der Kamera-Scanner kommt in der nächsten Ausbaustufe.');
    if (path === '/ausleihe') return platzhalter('Ausleihe', 'Ausleihe und Rückgabe kommen in einer späteren Ausbaustufe.');
    if (path === '/etiketten') return platzhalter('Etiketten', 'Etikettendruck kommt in einer späteren Ausbaustufe.');

    return platzhalter('Seite nicht gefunden', 'Diese Adresse gibt es nicht.');
  }

  function platzhalter(titel, text) {
    const k = SL.ui.karte(titel, [
      SL.ui.el('p', { class: 'muted' }, text),
      SL.ui.el('p', {}, [SL.ui.el('a', { href: '#/' }, '← Zur Übersicht')]),
    ]);
    mount.appendChild(k);
  }

  // Vollständiger Neuaufbau inklusive Zustandsabgleich mit dem Server. Nach
  // Anmeldung, Abmeldung und Rollenwechsel nötig, weil sich dabei auch die
  // Navigation ändert.
  async function neuZeichnen() {
    await SL.store.bootstrap();
    buildSidebar();
    router();
  }

  async function startApp() {
    bindShellControls();
    if (SL.api.subscribe) {
      SL.api.subscribe(msg => SL.store.applyServerMessage(msg));
      SL.api.connectWs();
    }
    await SL.store.bootstrap();
    buildSidebar();
    router();
    // Nur bei Änderungen ANDERER Geräte neu zeichnen — eigene Eingaben würden
    // sonst mitten im Tippen den Cursor verlieren.
    SL.store.onChange(() => { buildSidebar(); renderKonto(); });
  }

  window.SL = window.SL || {};
  SL.app = { neuZeichnen, router };

  window.addEventListener('hashchange', router);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startApp);
  } else {
    startApp();
  }
})();
