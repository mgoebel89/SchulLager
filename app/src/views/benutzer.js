(function () {
  'use strict';
  window.SL = window.SL || {};
  SL.views = SL.views || {};

  const { el, karte, feld, input, select, modal, toast, confirmDialog } = SL.ui;
  const { ROLLEN, ROLLE_LABEL } = SL.models;

  // Benutzerverwaltung — nur für Administratoren. Kollegen bekommen ihr Konto
  // hier angelegt und wechseln das Startpasswort beim ersten Anmelden selbst.
  async function renderBenutzer(mount) {
    if (!SL.store.istAdmin()) {
      mount.appendChild(karte('Kein Zugriff', el('p', { class: 'muted' }, 'Die Benutzerverwaltung ist Administratoren vorbehalten.')));
      return;
    }

    mount.appendChild(el('div', { class: 'toolbar' }, [
      el('h1', {}, 'Benutzer'),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn btn-primary', type: 'button', onclick: () => anlegenDialog(mount) }, '+ Benutzer'),
    ]));

    const inhalt = el('div');
    mount.appendChild(karte(null, inhalt));

    let liste = [];
    try {
      liste = await SL.api.listBenutzer();
    } catch (e) {
      inhalt.appendChild(el('p', { class: 'anmeldung-fehler' }, e.message || 'Die Liste konnte nicht geladen werden.'));
      return;
    }

    if (!liste.length) {
      inhalt.appendChild(el('p', { class: 'muted' }, 'Noch keine weiteren Benutzer.'));
      return;
    }

    const tabelle = el('div', { class: 'liste' });
    for (const b of liste) tabelle.appendChild(zeile(b, mount));
    inhalt.appendChild(tabelle);
  }

  function zeile(b, mount) {
    const eigenes = SL.store.state.benutzer && SL.store.state.benutzer.id === b.id;
    const kopf = el('div', { class: 'benutzer-kopf' }, [
      el('strong', {}, b.name),
      el('span', { class: 'tag' }, ROLLE_LABEL[b.rolle] || b.rolle),
      !b.aktiv ? el('span', { class: 'tag tag-warn' }, 'gesperrt') : null,
      b.mussWechseln ? el('span', { class: 'tag tag-warn' }, 'Passwortwechsel offen') : null,
      eigenes ? el('span', { class: 'muted' }, '(Sie selbst)') : null,
    ]);

    const meta = el('div', { class: 'muted' }, [
      `Benutzername: ${b.benutzername}`,
      b.letzterLogin ? ` · zuletzt angemeldet: ${datumZeit(b.letzterLogin)}` : ' · noch nie angemeldet',
    ].join(''));

    const knoepfe = el('div', { class: 'btn-reihe' }, [
      el('button', { class: 'btn btn-sm', type: 'button', onclick: () => bearbeitenDialog(b, mount) }, 'Bearbeiten'),
      el('button', { class: 'btn btn-sm', type: 'button', onclick: () => passwortDialog(b, mount) }, 'Passwort zurücksetzen'),
      eigenes ? null : el('button', {
        class: 'btn btn-sm btn-danger', type: 'button',
        onclick: async () => {
          if (!confirmDialog(`„${b.name}" wirklich löschen? Ausleihen bleiben erhalten, verlieren aber die Zuordnung.`)) return;
          try {
            await SL.api.benutzerLoeschen(b.id);
            toast('Benutzer gelöscht.');
            SL.app.neuZeichnen();
          } catch (e) { toast(e.message || 'Löschen fehlgeschlagen.'); }
        },
      }, 'Löschen'),
    ]);

    return el('div', { class: 'eintrag' }, [kopf, meta, knoepfe]);
  }

  // --- Dialoge --------------------------------------------------------------
  function anlegenDialog(mount) {
    const name = input({ autocomplete: 'off' });
    const nutzer = input({ autocomplete: 'off', autocapitalize: 'none' });
    const pass = input({ type: 'text', autocomplete: 'off' });   // sichtbar: der Admin muss es weitergeben
    let rolle = 'lehrkraft';

    // Vorschlag statt leerem Feld — ein Startpasswort soll niemand erfinden
    // müssen, und „Schule2024" wäre genau das, was dabei herauskäme.
    pass.value = startpasswort();

    const dlg = modal('Benutzer anlegen', [
      feld('Name', name),
      feld('Benutzername', nutzer),
      feld('Rolle', select(ROLLEN.map(r => ({ wert: r.wert, label: r.label })), rolle, v => { rolle = v; }, { leerLabel: false })),
      feld('Startpasswort', pass),
      el('p', { class: 'muted' }, 'Das Startpasswort dem Kollegen mitteilen — beim ersten Anmelden muss er es ändern.'),
    ], {
      fuss: [
        el('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Abbrechen'),
        el('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: async () => {
            try {
              await SL.api.benutzerAnlegen({ name: name.value, benutzername: nutzer.value, rolle, passwort: pass.value });
              dlg.close();
              toast('Benutzer angelegt.');
              SL.app.neuZeichnen();
            } catch (e) { toast(e.message || 'Anlegen fehlgeschlagen.'); }
          },
        }, 'Anlegen'),
      ],
    });
    name.focus();
  }

  function bearbeitenDialog(b, mount) {
    const name = input({ value: b.name });
    let rolle = b.rolle;
    let aktiv = b.aktiv;
    const aktivBox = el('input', { type: 'checkbox', class: 'chk', checked: aktiv, onchange: (e) => { aktiv = e.target.checked; } });

    const dlg = modal(`Benutzer: ${b.name}`, [
      feld('Name', name),
      feld('Rolle', select(ROLLEN.map(r => ({ wert: r.wert, label: r.label })), rolle, v => { rolle = v; }, { leerLabel: false })),
      el('label', { class: 'feld' }, [
        el('span', { class: 'feld-label' }, 'Konto aktiv'),
        el('span', {}, [aktivBox, ' Anmelden erlaubt']),
      ]),
      el('p', { class: 'muted' }, 'Ein gesperrtes Konto wird sofort abgemeldet, bleibt aber mit seinen Ausleihen erhalten.'),
    ], {
      fuss: [
        el('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Abbrechen'),
        el('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: async () => {
            try {
              await SL.api.benutzerSpeichern(b.id, { name: name.value, rolle, aktiv });
              dlg.close();
              toast('Gespeichert.');
              SL.app.neuZeichnen();
            } catch (e) { toast(e.message || 'Speichern fehlgeschlagen.'); }
          },
        }, 'Speichern'),
      ],
    });
  }

  function passwortDialog(b, mount) {
    const pass = input({ type: 'text', value: startpasswort() });
    const dlg = modal(`Passwort zurücksetzen: ${b.name}`, [
      feld('Neues Startpasswort', pass),
      el('p', { class: 'muted' }, 'Alle Sitzungen dieses Kontos werden beendet, und beim nächsten Anmelden muss das Passwort geändert werden.'),
    ], {
      fuss: [
        el('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Abbrechen'),
        el('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: async () => {
            try {
              await SL.api.benutzerPasswort(b.id, pass.value);
              dlg.close();
              toast('Passwort zurückgesetzt.');
              SL.app.neuZeichnen();
            } catch (e) { toast(e.message || 'Zurücksetzen fehlgeschlagen.'); }
          },
        }, 'Zurücksetzen'),
      ],
    });
  }

  // Aussprechbares Startpasswort: es wird einmal mündlich oder auf einem Zettel
  // weitergegeben und danach sofort gewechselt. Zufällige Sonderzeichen würden
  // hier nur Übertragungsfehler erzeugen.
  function startpasswort() {
    const silben = ['ba', 'de', 'fi', 'go', 'lu', 'ma', 'ne', 'ro', 'si', 'ta', 've', 'zu'];
    const zufall = (n) => Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * n);
    let s = '';
    for (let i = 0; i < 4; i++) s += silben[zufall(silben.length)];
    return s.charAt(0).toUpperCase() + s.slice(1) + (10 + zufall(90));
  }

  function datumZeit(iso) {
    try {
      return new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (_) { return iso; }
  }

  SL.views.renderBenutzer = renderBenutzer;
})();
