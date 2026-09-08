(function () {
  'use strict';
  window.SL = window.SL || {};

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'checked' || k === 'disabled' || k === 'selected') node[k] = !!v;
      else node.setAttribute(k, v);
    }
    const list = Array.isArray(children) ? children : [children];
    for (const c of list) {
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return node;
  }

  function toast(message, ms = 2200) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = message;
    t.hidden = false;
    clearTimeout(t._timer);
    t._timer = setTimeout(() => (t.hidden = true), ms);
  }

  function confirmDialog(text) { return window.confirm(text); }

  function downloadFile(filename, content, mime = 'application/octet-stream') {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
  }

  // capture: 'environment' öffnet am Handy direkt die Rückkamera. Am Desktop
  // wird das Attribut ignoriert → normaler Dateidialog.
  function pickFile(accept = '.json', capture = null) {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      if (capture) input.setAttribute('capture', capture);
      input.onchange = () => resolve(input.files?.[0] || null);
      input.click();
    });
  }

  // Zwei getrennte Knöpfe statt eines OS-Auswahldialogs: am Stand will man die
  // Kamera sofort, daheim beim Nacharbeiten die Galerie.
  function fotoPickButtons(onPick, kamLabel = '📷 Kamera') {
    const wrap = el('div', { class: 'foto-pick' });
    wrap.appendChild(el('button', {
      class: 'btn btn-sm', type: 'button',
      onclick: async () => { const f = await pickFile('image/*', 'environment'); if (f) onPick(f); },
    }, kamLabel));
    wrap.appendChild(el('button', {
      class: 'btn btn-sm', type: 'button',
      onclick: async () => { const f = await pickFile('image/*'); if (f) onPick(f); },
    }, '🖼 Galerie'));
    return wrap;
  }

  // Handy-Fotos sind 4–12 MP groß. Für Vorschau und PDF reicht die lange Kante
  // von maxPx; das spart Platz auf dem Container und Zeit beim Hochladen.
  // createImageBitmap dreht nach EXIF, sonst lägen Hochkant-Fotos quer.
  async function resizeImageFile(file, opts = {}) {
    const { maxPx = 1600, quality = 0.82 } = opts;
    if (!file || !/^image\//.test(file.type) || /svg/.test(file.type)) return file;
    let bmp;
    try {
      bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (_) {
      return file; // z. B. HEIC, das der Browser nicht dekodiert → unverändert hochladen
    }
    const scale = Math.min(1, maxPx / Math.max(bmp.width, bmp.height));
    if (scale === 1 && /jpe?g/.test(file.type)) { bmp.close(); return file; }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
    if (!blob) return file;
    const name = String(file.name || 'foto').replace(/\.[^.]+$/, '') + '.jpg';
    return new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() });
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(fr.error);
      fr.readAsText(file, 'utf-8');
    });
  }

  function formatDatum(iso) {
    if (!iso) return '';
    const [y, m, d] = String(iso).split('-');
    if (!y || !m || !d) return iso;
    return `${d}.${m}.${y}`;
  }

  function formatZahl(n, nachkomma = 1) {
    if (n === null || n === undefined || n === '') return '';
    return Number(n).toLocaleString('de-DE', { minimumFractionDigits: nachkomma, maximumFractionDigits: nachkomma });
  }

  // --- Formular-Bausteine ---------------------------------------------------
  // Ein Feld = Label + Eingabe in einem Block. Alle Views bauen ihre Formulare
  // damit, damit Abstände und Umbruchverhalten auf dem Handy überall gleich sind.
  function feld(label, control, opts = {}) {
    return el('label', { class: 'feld' + (opts.breit ? ' feld-breit' : '') }, [
      el('span', { class: 'feld-label' }, label),
      control,
    ]);
  }

  function input(attrs = {}) { return el('input', { class: 'inp', ...attrs }); }
  function textarea(attrs = {}) { return el('textarea', { class: 'inp', rows: 3, ...attrs }); }

  // options: [{wert, label}] oder [string]
  function select(options, wert, onchange, opts = {}) {
    const sel = el('select', { class: 'inp', onchange: (e) => onchange(e.target.value) });
    if (opts.leerLabel !== false) sel.appendChild(el('option', { value: '' }, opts.leerLabel || '— bitte wählen —'));
    for (const o of options) {
      const v = (typeof o === 'object') ? String(o.wert) : String(o);
      const l = (typeof o === 'object') ? o.label : String(o);
      sel.appendChild(el('option', { value: v, selected: String(wert ?? '') === v }, l));
    }
    return sel;
  }

  // Mehrfachauswahl als Chips — auf dem Handy weit angenehmer als eine
  // Multi-Select-Liste, und man sieht das Gewählte auf einen Blick.
  function chipGruppe(optionen, gewaehlt, onToggle) {
    const wrap = el('div', { class: 'chips' });
    const set = new Set(gewaehlt || []);
    for (const o of optionen) {
      const aktiv = set.has(o);
      wrap.appendChild(el('button', {
        class: 'chip' + (aktiv ? ' chip-aktiv' : ''),
        type: 'button',
        onclick: () => onToggle(o, !aktiv),
      }, o));
    }
    return wrap;
  }

  function karte(titel, inhalt, opts = {}) {
    const k = el('div', { class: 'card' + (opts.class ? ' ' + opts.class : '') });
    if (titel) {
      const kopf = el('div', { class: 'card-head' }, [el('h2', {}, titel)]);
      if (opts.aktion) kopf.appendChild(opts.aktion);
      k.appendChild(kopf);
    }
    const list = Array.isArray(inhalt) ? inhalt : [inhalt];
    for (const c of list) if (c) k.appendChild(c);
    return k;
  }

  // Vollflächiges Detail-Modal — auf dem Handy die einzige Form, in der ein
  // langes Formular bedienbar bleibt.
  function modal(titel, inhalt, opts = {}) {
    const overlay = el('div', { class: 'modal-overlay' });
    const box = el('div', { class: 'modal' });
    const kopf = el('div', { class: 'modal-head' }, [
      el('h2', {}, titel),
      el('button', { class: 'modal-close', type: 'button', 'aria-label': 'Schließen', onclick: () => close() }, '✕'),
    ]);
    const body = el('div', { class: 'modal-body' });
    const list = Array.isArray(inhalt) ? inhalt : [inhalt];
    for (const c of list) if (c) body.appendChild(c);
    box.appendChild(kopf);
    box.appendChild(body);
    if (opts.fuss) {
      const fuss = el('div', { class: 'modal-foot' });
      const fl = Array.isArray(opts.fuss) ? opts.fuss : [opts.fuss];
      for (const c of fl) if (c) fuss.appendChild(c);
      box.appendChild(fuss);
    }
    overlay.appendChild(box);
    function close() {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      if (opts.onClose) opts.onClose();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    return { overlay, body, close };
  }

  function leer(text) { return el('p', { class: 'muted' }, text); }

  SL.ui = {
    el, toast, confirmDialog, downloadFile, pickFile, fotoPickButtons, resizeImageFile,
    readFileAsText, formatDatum, formatZahl,
    feld, input, textarea, select, chipGruppe, karte, modal, leer,
  };
})();
