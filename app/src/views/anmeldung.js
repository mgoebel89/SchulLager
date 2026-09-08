(function () {
  'use strict';
  window.SL = window.SL || {};
  SL.views = SL.views || {};

  const { el, feld, input, toast } = SL.ui;

  // Diese Ansicht deckt drei verwandte Zustände ab, weil sie dieselbe Bühne
  // teilen (zentrierte Karte vor leerem Hintergrund) und der Nutzer zwischen
  // ihnen hin und her rutscht:
  //
  //   ersteinrichtung  es gibt noch keinen einzigen Benutzer
  //   anmeldung        der Normalfall
  //   passwortwechsel  angemeldet, aber Startpasswort noch nicht geändert
  //
  // Rückgabe an den Router: nichts. Nach Erfolg lädt app.js neu.

  function buehne(titel, untertitel, inhalt) {
    const wrap = el('div', { class: 'anmeldung-buehne' });
    const karte = el('form', { class: 'card anmeldung-karte' });
    karte.appendChild(el('div', { class: 'anmeldung-kopf' }, [
      el('h2', {}, titel),
      untertitel ? el('p', { class: 'muted' }, untertitel) : null,
    ]));
    for (const c of inhalt) if (c) karte.appendChild(c);
    wrap.appendChild(karte);
    return { wrap, karte };
  }

  function fehlerZeile() {
    return el('p', { class: 'anmeldung-fehler', hidden: 'hidden' });
  }
  function zeigeFehler(zeile, text) {
    zeile.textContent = text || '';
    zeile.hidden = !text;
  }

  // --- Anmeldung ------------------------------------------------------------
  function renderAnmeldung(mount, opts = {}) {
    const nutzer = input({ name: 'benutzername', autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', required: 'required' });
    const pass = input({ type: 'password', name: 'passwort', autocomplete: 'current-password', required: 'required' });
    const fehler = fehlerZeile();
    const knopf = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Anmelden');

    const { wrap, karte } = buehne(
      'Anmelden',
      'Lagerverwaltung der David-Roentgen-Schule',
      [
        fehler,
        feld('Benutzername', nutzer),
        feld('Passwort', pass),
        el('div', { class: 'btn-reihe' }, [knopf]),
        opts.zurueckZumLesen === false ? null : el('p', { class: 'muted anmeldung-fuss' }, [
          'Zum Nachschauen (Suche und Lagerort) ist keine Anmeldung nötig — ',
          el('a', { href: '#/' }, 'weiter ohne Anmeldung'),
          '.',
        ]),
      ],
    );

    karte.addEventListener('submit', async (e) => {
      e.preventDefault();
      zeigeFehler(fehler, '');
      knopf.disabled = true;
      knopf.textContent = 'Melde an…';
      try {
        await SL.store.anmelden(nutzer.value, pass.value);
        // Ziel merken: wer per QR auf einen Artikel wollte und unterwegs zur
        // Anmeldung geschickt wurde, soll dort landen und nicht auf der
        // Übersicht.
        location.hash = opts.weiterZu || '#/';
        SL.app.neuZeichnen();
      } catch (err) {
        zeigeFehler(fehler, err.message || 'Anmeldung fehlgeschlagen.');
        pass.value = '';
        pass.focus();
      } finally {
        knopf.disabled = false;
        knopf.textContent = 'Anmelden';
      }
    });

    mount.appendChild(wrap);
    nutzer.focus();
  }

  // --- Ersteinrichtung ------------------------------------------------------
  function renderErsteinrichtung(mount) {
    const name = input({ name: 'name', autocomplete: 'name', required: 'required' });
    const nutzer = input({ name: 'benutzername', autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', required: 'required' });
    const pass = input({ type: 'password', name: 'passwort', autocomplete: 'new-password', required: 'required' });
    const pass2 = input({ type: 'password', name: 'passwort2', autocomplete: 'new-password', required: 'required' });
    const fehler = fehlerZeile();
    const knopf = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Konto anlegen und starten');

    const { wrap, karte } = buehne(
      'Ersteinrichtung',
      'Es gibt noch kein Konto. Bitte den ersten Administrator anlegen — danach ist dieser Weg geschlossen.',
      [
        fehler,
        feld('Ihr Name', name),
        feld('Benutzername', nutzer),
        feld('Passwort (mindestens 8 Zeichen)', pass),
        feld('Passwort wiederholen', pass2),
        el('div', { class: 'btn-reihe' }, [knopf]),
      ],
    );

    karte.addEventListener('submit', async (e) => {
      e.preventDefault();
      zeigeFehler(fehler, '');
      if (pass.value !== pass2.value) {
        zeigeFehler(fehler, 'Die beiden Passwörter stimmen nicht überein.');
        return;
      }
      knopf.disabled = true;
      try {
        await SL.store.ersteinrichtung({ name: name.value, benutzername: nutzer.value, passwort: pass.value });
        toast('Willkommen! Als Nächstes den Homebox-Zugang eintragen.');
        location.hash = '#/einstellungen';
        SL.app.neuZeichnen();
      } catch (err) {
        zeigeFehler(fehler, err.message || 'Das hat nicht geklappt.');
        knopf.disabled = false;
      }
    });

    mount.appendChild(wrap);
    name.focus();
  }

  // --- Passwortwechsel ------------------------------------------------------
  // Erzwungen nach dem ersten Anmelden mit einem vom Admin vergebenen Kennwort.
  // Solange er aussteht, lässt das Backend nichts anderes zu — die Ansicht ist
  // deshalb ohne Ausweg (kein „später").
  function renderPasswortWechsel(mount) {
    const alt = input({ type: 'password', autocomplete: 'current-password', required: 'required' });
    const neu = input({ type: 'password', autocomplete: 'new-password', required: 'required' });
    const neu2 = input({ type: 'password', autocomplete: 'new-password', required: 'required' });
    const fehler = fehlerZeile();
    const knopf = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Passwort ändern');

    const { wrap, karte } = buehne(
      'Passwort ändern',
      'Das Startpasswort kennt der Administrator. Bitte jetzt ein eigenes vergeben.',
      [
        fehler,
        feld('Bisheriges Passwort', alt),
        feld('Neues Passwort (mindestens 8 Zeichen)', neu),
        feld('Neues Passwort wiederholen', neu2),
        el('div', { class: 'btn-reihe' }, [
          knopf,
          el('button', {
            class: 'btn', type: 'button',
            onclick: async () => { await SL.store.abmelden(); SL.app.neuZeichnen(); },
          }, 'Abmelden'),
        ]),
      ],
    );

    karte.addEventListener('submit', async (e) => {
      e.preventDefault();
      zeigeFehler(fehler, '');
      if (neu.value !== neu2.value) {
        zeigeFehler(fehler, 'Die beiden Passwörter stimmen nicht überein.');
        return;
      }
      knopf.disabled = true;
      try {
        await SL.store.passwortAendern(alt.value, neu.value);
        toast('Passwort geändert.');
        SL.app.neuZeichnen();
      } catch (err) {
        zeigeFehler(fehler, err.message || 'Das hat nicht geklappt.');
        knopf.disabled = false;
      }
    });

    mount.appendChild(wrap);
    alt.focus();
  }

  SL.views.renderAnmeldung = renderAnmeldung;
  SL.views.renderErsteinrichtung = renderErsteinrichtung;
  SL.views.renderPasswortWechsel = renderPasswortWechsel;
})();
