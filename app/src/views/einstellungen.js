(function () {
  'use strict';
  window.SL = window.SL || {};
  SL.views = SL.views || {};

  const { el, karte, feld, input, select, toast } = SL.ui;

  // Einstellungen mit Kategorie-Unternavigation — dieselbe Form wie in der
  // Gemeindeverwaltung, damit man sich zwischen den Anwendungen nicht umgewöhnt.
  async function renderEinstellungen(mount, params = {}) {
    if (!SL.store.istAdmin()) {
      mount.appendChild(karte('Kein Zugriff', el('p', { class: 'muted' }, 'Die Einrichtung ist Administratoren vorbehalten.')));
      return;
    }

    const kategorien = [
      { id: 'homebox', label: 'Homebox', render: renderHomebox },
      { id: 'paperless', label: 'Paperless', render: renderPaperless },
      { id: 'allgemein', label: 'Allgemein', render: renderAllgemein },
      { id: 'benutzer', label: 'Benutzer', render: renderBenutzerHinweis },
    ];
    const aktiv = kategorien.find(k => k.id === params.kat) || kategorien[0];

    mount.appendChild(el('div', { class: 'toolbar' }, [el('h1', {}, 'Einstellungen')]));

    const layout = el('div', { class: 'settings-layout' });
    const nav = el('div', { class: 'settings-nav' });
    for (const k of kategorien) {
      nav.appendChild(el('a', {
        class: 'settings-nav-btn' + (k.id === aktiv.id ? ' active' : ''),
        href: `#/einstellungen?kat=${k.id}`,
      }, k.label));
    }
    const inhalt = el('div', { class: 'settings-inhalt' });
    layout.appendChild(nav);
    layout.appendChild(inhalt);
    mount.appendChild(layout);

    await aktiv.render(inhalt);
  }

  // --- Homebox --------------------------------------------------------------
  async function renderHomebox(mount) {
    let cfg = null;
    try {
      cfg = await SL.api.lagerConfig();
    } catch (e) {
      mount.appendChild(karte('Homebox', el('p', { class: 'anmeldung-fehler' }, e.message)));
      return;
    }

    const url = input({ value: cfg.url || '', placeholder: 'http://192.168.1.21:7745' });
    const nutzer = input({ value: cfg.username || '', autocapitalize: 'none' });
    // Leer lassen = bestehendes Passwort behalten. Das ist der Grund, warum
    // hier nie ein Wert vorbelegt wird: der Server gibt es nicht heraus.
    const pass = input({ type: 'password', placeholder: cfg.hasPassword ? '(gesetzt — leer lassen zum Behalten)' : '' });

    const status = el('p', { class: 'muted' });
    const sammlungBox = el('div');

    const zustandZeigen = async () => {
      status.textContent = 'Prüfe Verbindung…';
      status.className = 'muted';
      sammlungBox.innerHTML = '';
      try {
        const h = await SL.api.lagerHealth();
        if (!h.eingerichtet) {
          status.textContent = 'Noch nicht eingerichtet.';
          return;
        }
        status.textContent = `Verbunden (API-Stil: ${h.apiStil || 'unbekannt'})${h.sammlung ? ` · Sammlung: ${h.sammlung}` : ''}`;
        status.className = 'hinweis-ok';
        await sammlungAuswahl(sammlungBox);
      } catch (e) {
        status.textContent = e.message || 'Homebox antwortet nicht.';
        status.className = 'anmeldung-fehler';
      }
    };

    const speichern = el('button', {
      class: 'btn btn-primary', type: 'button',
      onclick: async () => {
        try {
          await SL.api.putLagerConfig({ url: url.value, username: nutzer.value, password: pass.value });
          pass.value = '';
          toast('Zugang gespeichert.');
          await SL.store.lagerZustandLaden();
          await zustandZeigen();
        } catch (e) { toast(e.message || 'Speichern fehlgeschlagen.'); }
      },
    }, 'Speichern');

    mount.appendChild(karte('Homebox-Zugang', [
      el('p', { class: 'muted' }, 'Homebox hält den Bestand — diese App zeigt und bucht ihn nur. '
        + 'Homebox kennt keine dauerhaften Zugangsschlüssel, deshalb Benutzername und Passwort. '
        + 'Beides bleibt auf dem Server und wird nie an den Browser ausgeliefert.'),
      feld('Adresse', url),
      feld('Benutzername', nutzer),
      feld('Passwort', pass),
      el('div', { class: 'btn-reihe' }, [
        speichern,
        el('button', { class: 'btn', type: 'button', onclick: zustandZeigen }, 'Verbindung prüfen'),
      ]),
      status,
    ]));

    mount.appendChild(sammlungBox);
    await zustandZeigen();
  }

  // Sammlungen (Homebox-Collections): ein Konto kann mehrere vollständig
  // getrennte Bestände haben. Die Auswahl gehört sichtbar hierher — bucht man
  // versehentlich in den falschen Bestand, merkt es lange niemand.
  async function sammlungAuswahl(mount) {
    mount.innerHTML = '';
    let liste = [];
    let cfg = null;
    try {
      [liste, cfg] = await Promise.all([SL.api.lagerSammlungen(), SL.api.lagerConfig()]);
    } catch (_) {
      return;   // ältere Homebox ohne Sammlungen — dann gibt es nichts zu wählen
    }
    if (!liste.length) return;

    // Eine gespeicherte, aber nicht mehr zugängliche Sammlung bleibt sichtbar
    // stehen, statt still auf „Standard" zu fallen: sonst bucht die App
    // unbemerkt in einen anderen Bestand.
    const optionen = liste.map(g => ({ wert: g.id, label: g.name }));
    if (cfg.groupId && !liste.some(g => g.id === cfg.groupId)) {
      optionen.push({ wert: cfg.groupId, label: `${cfg.groupName || cfg.groupId} (nicht mehr zugänglich)` });
    }

    let gewaehlt = cfg.groupId || '';
    const auswahl = select(optionen, gewaehlt, v => { gewaehlt = v; }, { leerLabel: 'Standard-Sammlung des Kontos' });

    mount.appendChild(karte('Sammlung', [
      el('p', { class: 'muted' }, liste.length > 1
        ? 'Dieses Konto sieht mehrere getrennte Bestände. Bitte den der Schule wählen.'
        : 'Dieses Konto sieht genau einen Bestand.'),
      feld('Aktive Sammlung', auswahl),
      el('div', { class: 'btn-reihe' }, [
        el('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: async () => {
            const g = liste.find(x => x.id === gewaehlt);
            try {
              await SL.api.putLagerConfig({ groupId: gewaehlt, groupName: g ? g.name : '' });
              toast('Sammlung gewechselt.');
              // Die Lagerorte gehören zur Sammlung — der Zwischenspeicher wäre
              // sonst der Baum des vorigen Bestands.
              SL.store.orteVergessen();
              await SL.store.lagerZustandLaden();
              SL.app.neuZeichnen();
            } catch (e) { toast(e.message || 'Wechsel fehlgeschlagen.'); }
          },
        }, 'Übernehmen'),
      ]),
    ]));
  }

  // --- Paperless ------------------------------------------------------------
  // Ablage für Lieferscheine und Rechnungen. Die Schule betreibt Paperless
  // bereits; diese App legt dort nichts an und räumt dort nichts auf — sie
  // schiebt Belege hinein und merkt sich die Nummer am Vorgang.
  //
  // Anders als im Unterrichtstool gilt der Zugang für die ganze Schule und
  // nicht je Lehrkraft: das Lager hat EIN Paperless.
  async function renderPaperless(mount) {
    let cfg = null;
    try {
      cfg = await SL.api.paperlessConfig();
    } catch (e) {
      mount.appendChild(karte('Paperless', el('p', { class: 'anmeldung-fehler' }, e.message)));
      return;
    }

    const url = input({ value: cfg.url || '', placeholder: 'https://paperless.schule.local' });
    // Wie beim Homebox-Passwort: der Server gibt den Token nie heraus, leer
    // lassen heißt behalten. Sonst müsste man ihn für jede Änderung an den
    // Tags neu aus Paperless heraussuchen.
    const token = input({ type: 'password', placeholder: cfg.hasToken ? '(gesetzt — leer lassen zum Behalten)' : 'API-Token aus dem Paperless-Profil' });

    const status = el('p', { class: 'muted' });
    const listenBox = el('div');

    // Die Auswahllisten kommen aus Paperless selbst — die App erfindet keine
    // Tags und keine Ablagepfade, sie benutzt die vorhandenen.
    async function listenZeigen() {
      listenBox.innerHTML = '';
      if (!cfg.hasToken || !cfg.url) return;
      let stamm = null;
      try {
        stamm = await SL.api.paperlessStammlisten();
      } catch (e) {
        listenBox.appendChild(karte('Zuordnung', el('p', { class: 'anmeldung-fehler' }, e.message)));
        return;
      }
      const gewaehlt = { ...cfg };
      const tagWahl = select(stamm.tags.map(t => ({ wert: t.id, label: t.name })), gewaehlt.uploadTagId,
        v => { gewaehlt.uploadTagId = Number(v) || 0; }, { leerLabel: '— kein Tag —' });
      const pfadWahl = select(stamm.ablagepfade.map(t => ({ wert: t.id, label: t.name })), gewaehlt.ablagepfadId,
        v => { gewaehlt.ablagepfadId = Number(v) || 0; }, { leerLabel: '— Standard —' });
      const typL = select(stamm.dokumenttypen.map(t => ({ wert: t.id, label: t.name })), gewaehlt.typLieferscheinId,
        v => { gewaehlt.typLieferscheinId = Number(v) || 0; }, { leerLabel: '— kein Typ —' });
      const typR = select(stamm.dokumenttypen.map(t => ({ wert: t.id, label: t.name })), gewaehlt.typRechnungId,
        v => { gewaehlt.typRechnungId = Number(v) || 0; }, { leerLabel: '— kein Typ —' });
      const typA = select(stamm.dokumenttypen.map(t => ({ wert: t.id, label: t.name })), gewaehlt.typAngebotId,
        v => { gewaehlt.typAngebotId = Number(v) || 0; }, { leerLabel: '— kein Typ —' });

      listenBox.appendChild(karte('Zuordnung', [
        el('p', { class: 'muted' }, 'Das ist die VORBELEGUNG des Upload-Fensters: Tag, Ablagepfad und Dokumenttyp stehen '
          + 'beim Hochladen schon da und lassen sich dort für den einzelnen Beleg ändern. '
          + 'So bleiben die Lagerbelege in Paperless auffindbar, ohne dass jemand nachsortieren muss.'),
        feld('Tag für Uploads', tagWahl),
        feld('Ablagepfad', pfadWahl),
        feld('Dokumenttyp Lieferschein', typL),
        feld('Dokumenttyp Rechnung', typR),
        feld('Dokumenttyp Angebot', typA),
        el('div', { class: 'btn-reihe' }, [
          el('button', {
            class: 'btn btn-primary', type: 'button',
            onclick: async () => {
              try {
                cfg = await SL.api.putPaperlessConfig({
                  uploadTagId: gewaehlt.uploadTagId,
                  ablagepfadId: gewaehlt.ablagepfadId,
                  typLieferscheinId: gewaehlt.typLieferscheinId,
                  typRechnungId: gewaehlt.typRechnungId,
                  typAngebotId: gewaehlt.typAngebotId,
                });
                toast('Zuordnung gespeichert.');
              } catch (e) { toast(e.message || 'Speichern fehlgeschlagen.'); }
            },
          }, 'Zuordnung speichern'),
        ]),
      ]));
    }

    async function zustandZeigen() {
      status.textContent = 'Prüfe Verbindung…';
      status.className = 'muted';
      if (!cfg.eingerichtet) {
        status.textContent = 'Noch nicht eingerichtet — ohne Paperless lassen sich keine Belege ablegen.';
        listenBox.innerHTML = '';
        return;
      }
      try {
        const t = await SL.api.paperlessTest();
        status.textContent = `Verbunden${t.dokumente != null ? ` · ${t.dokumente} Dokumente im Archiv` : ''}`;
        status.className = 'hinweis-ok';
        await listenZeigen();
      } catch (e) {
        status.textContent = e.message || 'Paperless antwortet nicht.';
        status.className = 'anmeldung-fehler';
        listenBox.innerHTML = '';
      }
    }

    mount.appendChild(karte('Paperless-Zugang', [
      el('p', { class: 'muted' }, 'Lieferscheine und Rechnungen liegen in Paperless, nicht in dieser App. '
        + 'Den API-Token findest du in Paperless unter „Mein Profil". Er bleibt auf dem Server und wird nie an den Browser ausgeliefert.'),
      feld('Adresse', url),
      feld('API-Token', token),
      el('div', { class: 'btn-reihe' }, [
        el('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: async () => {
            try {
              cfg = await SL.api.putPaperlessConfig({ url: url.value, token: token.value });
              token.value = '';
              toast('Zugang gespeichert.');
              await zustandZeigen();
            } catch (e) { toast(e.message || 'Speichern fehlgeschlagen.'); }
          },
        }, 'Speichern'),
        el('button', { class: 'btn', type: 'button', onclick: zustandZeigen }, 'Verbindung prüfen'),
      ]),
      status,
    ]));

    mount.appendChild(listenBox);
    await zustandZeigen();
  }

  // --- Allgemein ------------------------------------------------------------
  async function renderAllgemein(mount) {
    const s = SL.store.state.settings;
    const schule = input({ value: s.schule || '' });
    // Klassen als eine Zeile pro Eintrag — eine Liste, die sich jedes Schuljahr
    // ändert, pflegt sich so schneller als über Einzelfelder.
    const klassen = el('textarea', { class: 'inp', rows: 6 });
    klassen.value = (s.klassen || []).join('\n');

    const marke = input({ value: s.demonstratorMarke || 'Demonstrator' });
    const netzMarke = input({ value: s.netzgeraetMarke || 'Netzgerät' });
    // Vergabegrenze der Schule. Steht hier und nicht im Code: eine
    // Verwaltungsvorgabe ändert sich, ohne dass jemand die App neu ausrollt.
    const schwelle = input({ type: 'number', min: '0', step: '100', value: String(s.angebotSchwelle) });
    const anzahl = input({ type: 'number', min: '1', step: '1', value: String(s.angebotAnzahl) });
    const mwst = input({ type: 'number', min: '0', step: '0.1', value: String(s.mwstSatz) });

    mount.appendChild(karte('Allgemein', [
      feld('Schule', schule),
      feld('Klassen und Gruppen (eine je Zeile)', klassen, { breit: true }),
      el('p', { class: 'muted' }, 'Die Klassenliste wird bei Ausleihe und Ausgabe angeboten, damit erkennbar bleibt, in welchem Projekt etwas steckt.'),
      feld('Homebox-Tag für Demonstratoren', marke),
      feld('Homebox-Tag für einzelne Netzgeräte', netzMarke),
      el('p', { class: 'muted' },
        'Woran erkennt die App ein Gerät? An diesen Tags in Homebox. Artikel mit einem der '
        + 'beiden Tags lassen sich ausleihen und können Netzangaben tragen; alles andere gilt '
        + 'als Verbrauchsmaterial und wird ausgegeben. Die Tags entstehen beim Anlegen von '
        + 'selbst und lassen sich in Homebox auch vorhandenen Artikeln zuweisen.'),
      el('h3', { class: 'abschnitt' }, 'Beschaffung'),
      el('div', { class: 'form-grid' }, [
        feld('Angebote nötig ab (€ brutto)', schwelle),
        feld('Anzahl Angebote', anzahl),
        feld('Mehrwertsteuer (%)', mwst),
      ]),
      el('p', { class: 'muted' },
        'Ab diesem BRUTTO-Bestellwert verlangt die Schule Vergleichsangebote. Die App warnt dann '
        + 'am Vorgang und auf der Bestellanforderung — sie blockiert nicht, denn es gibt begründete '
        + 'Ausnahmen (Alleinanbieter, Ersatzteil zum vorhandenen Gerät). Der Steuersatz wird '
        + 'gebraucht, weil Bestellungen netto ODER brutto erfasst werden können, die Grenze aber '
        + 'immer brutto gilt.'),
      el('div', { class: 'btn-reihe' }, [
        el('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: async () => {
            // Ein leerer Tagname würde jeden Artikel zum Demonstrator machen.
            if (!marke.value.trim() || !netzMarke.value.trim()) { toast('Bitte beide Tag-Namen angeben.'); return; }
            if (marke.value.trim().toLowerCase() === netzMarke.value.trim().toLowerCase()) {
              // Gleiche Tags hieße: die Unterscheidung gibt es nicht mehr, und
              // jedes Netzgerät wäre plötzlich ein Demonstrator.
              toast('Die beiden Tags müssen sich unterscheiden.'); return;
            }
            try {
              await SL.store.settingsSpeichern({
                ...s,
                schule: schule.value.trim(),
                klassen: klassen.value.split('\n').map(z => z.trim()).filter(Boolean),
                demonstratorMarke: marke.value.trim(),
                netzgeraetMarke: netzMarke.value.trim(),
                angebotSchwelle: Number(schwelle.value) || 0,
                angebotAnzahl: Number(anzahl.value) || 0,
                mwstSatz: Number(mwst.value) || 0,
              });
              toast('Gespeichert.');
            } catch (e) { toast(e.message || 'Speichern fehlgeschlagen.'); }
          },
        }, 'Speichern'),
      ]),
    ]));
  }

  function renderBenutzerHinweis(mount) {
    mount.appendChild(karte('Benutzer', [
      el('p', { class: 'muted' }, 'Konten werden in der eigenen Ansicht verwaltet.'),
      el('div', { class: 'btn-reihe' }, [el('a', { class: 'btn btn-primary', href: '#/benutzer' }, 'Zur Benutzerverwaltung')]),
    ]));
  }

  SL.views.renderEinstellungen = renderEinstellungen;
})();
