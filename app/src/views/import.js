(function () {
  'use strict';
  window.SL = window.SL || {};
  SL.views = SL.views || {};

  const { el, karte, toast } = SL.ui;

  // Komponenten aus einer CSV-Datei übernehmen.
  //
  // Der Weg ist bewusst dreistufig: Vorlage holen → Datei wählen → VORSCHAU →
  // importieren. Ohne Vorschau erfährt man von einer falsch zugeordneten Spalte
  // erst, wenn achtzig Datensätze schon in der Datenbank stehen.

  // --- CSV zerlegen ---------------------------------------------------------
  // Eigener Parser statt einer Bibliothek: eine Zeile mit Semikolon in
  // Anführungszeichen („Rack 0; Slot 2") muss richtig ankommen, und mehr
  // braucht es hier nicht.
  function csvZerlegen(text) {
    // BOM entfernen — Excel schreibt sie, und sonst hieße die erste Spalte
    // "﻿Geraet" und würde nicht zugeordnet.
    let t = String(text || '').replace(/^﻿/, '');

    // Trennzeichen aus der Kopfzeile erraten: deutsches Excel nimmt Semikolon,
    // englische Programme das Komma.
    const kopfzeile = t.split(/\r?\n/)[0] || '';
    const trenner = (kopfzeile.split(';').length > kopfzeile.split(',').length) ? ';' : ',';

    const zeilen = [];
    let feld = '';
    let zeile = [];
    let inAnfuehrung = false;

    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (inAnfuehrung) {
        if (c === '"') {
          if (t[i + 1] === '"') { feld += '"'; i++; }   // verdoppeltes " = ein "
          else inAnfuehrung = false;
        } else feld += c;
        continue;
      }
      if (c === '"') { inAnfuehrung = true; continue; }
      if (c === trenner) { zeile.push(feld); feld = ''; continue; }
      if (c === '\r') continue;
      if (c === '\n') { zeile.push(feld); zeilen.push(zeile); zeile = []; feld = ''; continue; }
      feld += c;
    }
    if (feld !== '' || zeile.length) { zeile.push(feld); zeilen.push(zeile); }

    // Leerzeilen am Ende wegwerfen — Excel hängt gern eine an.
    return { trenner, zeilen: zeilen.filter(z => z.some(f => String(f).trim() !== '')) };
  }

  // Kopfzeile auf unsere Schlüssel abbilden. Groß-/Kleinschreibung und
  // Leerzeichen sollen egal sein; wer „IP-Adresse" schreibt, meint „IP".
  function spaltenZuordnen(kopf, spalten) {
    const norm = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9äöüß]/g, '');
    const zuordnung = [];
    for (const titel of kopf) {
      const n = norm(titel);
      const treffer = spalten.find(s => norm(s.label) === n || norm(s.schluessel) === n)
        || spalten.find(s => n && (norm(s.label).startsWith(n) || n.startsWith(norm(s.label))));
      zuordnung.push(treffer ? treffer.schluessel : null);
    }
    return zuordnung;
  }

  // --- Ansicht --------------------------------------------------------------
  async function renderImport(mount) {
    if (!SL.store.darfBuchen()) {
      mount.appendChild(karte('Anmeldung nötig', el('p', { class: 'muted' }, [
        'Zum Importieren bitte ',
        el('a', { href: '#/anmelden?weiter=' + encodeURIComponent('#/import') }, 'anmelden'),
        '.',
      ])));
      return;
    }

    mount.appendChild(el('div', { class: 'toolbar' }, [el('h1', {}, 'Komponenten importieren')]));

    let spalten = [];
    try {
      spalten = await SL.api.komponentenSpalten();
    } catch (e) {
      mount.appendChild(karte('Das hat nicht geklappt', el('p', { class: 'anmeldung-fehler' }, e.message || '')));
      return;
    }

    // Schritt 1: Vorlage
    const spaltenListe = el('dl', { class: 'daten' });
    for (const s of spalten) {
      spaltenListe.appendChild(el('div', { class: 'daten-zeile' }, [
        el('dt', {}, s.label + (s.pflicht ? ' *' : '')),
        el('dd', { class: 'muted' }, s.hinweis || ''),
      ]));
    }

    mount.appendChild(karte('1. Vorlage holen', [
      el('p', { class: 'muted' },
        'Die Beispieldatei enthält die Kopfzeile und zwei ausgefüllte Zeilen. Sie lässt sich in '
        + 'Excel oder LibreOffice öffnen, ausfüllen und wieder als CSV speichern. '
        + 'Spalten mit * müssen gefüllt sein; die Reihenfolge ist egal, und nicht gebrauchte '
        + 'Spalten dürfen fehlen.'),
      el('div', { class: 'btn-reihe' }, [
        el('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: async () => {
            try {
              const csv = await SL.api.komponentenVorlage();
              SL.ui.downloadFile('komponenten-vorlage.csv', csv, 'text/csv;charset=utf-8');
            } catch (e) { toast(e.message || 'Die Vorlage ließ sich nicht laden.', 4500); }
          },
        }, '⤓ Beispieldatei herunterladen'),
      ]),
      el('details', { class: 'aufklapp' }, [el('summary', {}, 'Welche Spalten gibt es?'), spaltenListe]),
    ]));

    // Schritt 2: Datei
    const vorschau = el('div');
    mount.appendChild(karte('2. Datei wählen', [
      el('p', { class: 'muted' },
        'Semikolon und Komma als Trennzeichen werden beide erkannt, ebenso die von Excel '
        + 'geschriebene Bytemarke. Das Gerät wird über seine Bezeichnung oder seine Kennung '
        + '(A-…) gefunden — bei zwei gleichnamigen Geräten bitte die Kennung angeben.'),
      el('div', { class: 'btn-reihe' }, [
        el('button', {
          class: 'btn', type: 'button',
          onclick: async () => {
            const datei = await SL.ui.pickFile('.csv,text/csv');
            if (!datei) return;
            try {
              const text = await SL.ui.readFileAsText(datei);
              zeigeVorschau(vorschau, text, spalten, datei.name);
            } catch (e) { toast(e.message || 'Die Datei ließ sich nicht lesen.', 4500); }
          },
        }, '📄 CSV-Datei wählen'),
      ]),
    ]));
    mount.appendChild(vorschau);
  }

  function zeigeVorschau(behaelter, text, spalten, dateiname) {
    behaelter.innerHTML = '';
    const { trenner, zeilen } = csvZerlegen(text);

    if (zeilen.length < 2) {
      behaelter.appendChild(karte('3. Vorschau', el('p', { class: 'anmeldung-fehler' },
        'Die Datei enthält keine Datenzeilen — es braucht eine Kopfzeile und mindestens eine Zeile darunter.')));
      return;
    }

    const kopf = zeilen[0];
    const zuordnung = spaltenZuordnen(kopf, spalten);
    const unbekannt = kopf.filter((t, i) => !zuordnung[i] && String(t).trim());
    const fehlendePflicht = spalten.filter(s => s.pflicht && !zuordnung.includes(s.schluessel));

    // Datenzeilen in Objekte umsetzen.
    const daten = zeilen.slice(1).map(z => {
      const o = {};
      zuordnung.forEach((schluessel, i) => { if (schluessel) o[schluessel] = (z[i] || '').trim(); });
      return o;
    });

    const kopfInfo = el('p', { class: 'muted' },
      `${dateiname} · ${daten.length} ${daten.length === 1 ? 'Zeile' : 'Zeilen'} · Trennzeichen „${trenner}"`);

    const meldungen = [];
    if (fehlendePflicht.length) {
      meldungen.push(el('p', { class: 'anmeldung-fehler' },
        'Es fehlen Pflichtspalten: ' + fehlendePflicht.map(s => s.label).join(', ')
        + '. Bitte die Beispieldatei als Ausgangspunkt nehmen.'));
    }
    if (unbekannt.length) {
      // Nicht als Fehler: eigene Zusatzspalten sind erlaubt, sie werden nur
      // nicht übernommen. Verschwiegen werden dürfen sie trotzdem nicht.
      meldungen.push(el('p', { class: 'muted' },
        'Nicht zugeordnet und daher übersprungen: ' + unbekannt.join(', ')));
    }

    // Tabelle mit den ersten Zeilen — genug, um eine verrutschte Spalte zu sehen.
    const zeigen = spalten.filter(s => zuordnung.includes(s.schluessel));
    const tab = el('table', { class: 'import-tabelle' });
    const kopfZeile = el('tr', {});
    kopfZeile.appendChild(el('th', {}, '#'));
    for (const s of zeigen) kopfZeile.appendChild(el('th', {}, s.label));
    tab.appendChild(kopfZeile);
    daten.slice(0, 10).forEach((d, i) => {
      const tr = el('tr', {});
      tr.appendChild(el('td', { class: 'muted' }, String(i + 1)));
      for (const s of zeigen) tr.appendChild(el('td', {}, d[s.schluessel] || ''));
      tab.appendChild(tr);
    });

    const ergebnisBox = el('div');
    const importKnopf = el('button', {
      class: 'btn btn-primary', type: 'button',
      disabled: fehlendePflicht.length > 0,
      onclick: async () => {
        importKnopf.disabled = true;
        importKnopf.textContent = 'Wird übernommen…';
        try {
          const antwort = await SL.api.komponentenImport(daten);
          zeigeErgebnis(ergebnisBox, antwort);
        } catch (e) {
          ergebnisBox.innerHTML = '';
          ergebnisBox.appendChild(el('p', { class: 'anmeldung-fehler' }, e.message || 'Der Import ist gescheitert.'));
        } finally {
          importKnopf.disabled = false;
          importKnopf.textContent = `${daten.length} Zeilen übernehmen`;
        }
      },
    }, `${daten.length} Zeilen übernehmen`);

    behaelter.appendChild(karte('3. Vorschau', [
      kopfInfo,
      ...meldungen,
      el('div', { class: 'tabelle-scroll' }, tab),
      daten.length > 10 ? el('p', { class: 'muted' }, `… und ${daten.length - 10} weitere Zeilen.`) : null,
      el('p', { class: 'muted' }, 'Bitte prüfen, ob die Werte in den richtigen Spalten stehen — danach wird geschrieben.'),
      el('div', { class: 'btn-reihe' }, [importKnopf]),
      ergebnisBox,
    ]));
  }

  function zeigeErgebnis(box, antwort) {
    box.innerHTML = '';
    box.appendChild(el('p', { class: antwort.fehler ? 'muted' : 'hinweis-ok' },
      `${antwort.angelegt} ${antwort.angelegt === 1 ? 'Komponente' : 'Komponenten'} angelegt`
      + (antwort.fehler ? `, ${antwort.fehler} ${antwort.fehler === 1 ? 'Zeile' : 'Zeilen'} nicht übernommen.` : '.')));

    const fehler = antwort.ergebnisse.filter(e => !e.ok);
    if (fehler.length) {
      const liste = el('div', { class: 'liste' });
      for (const f of fehler) {
        liste.appendChild(el('div', { class: 'eintrag' }, [
          el('div', { class: 'benutzer-kopf' }, [
            el('span', { class: 'ampel ampel-faellig' }, `Zeile ${f.zeile}`),
          ]),
          el('div', {}, f.fehler),
        ]));
      }
      box.appendChild(karte('Nicht übernommen', [
        el('p', { class: 'muted' }, 'Diese Zeilen bitte in der Datei berichtigen und die Datei erneut einlesen — '
          + 'die bereits übernommenen Zeilen vorher entfernen, sonst stehen sie doppelt da.'),
        liste,
      ]));
    }

    // Doppelte IPs und Gerätenamen fallen beim Import besonders leicht an:
    // eine kopierte Zeile ist schnell übersehen.
    const mitKonflikt = antwort.ergebnisse.filter(e => e.ok && e.konflikte && e.konflikte.length);
    if (mitKonflikt.length) {
      const liste = el('div', { class: 'liste' });
      for (const e of mitKonflikt) {
        for (const k of e.konflikte) {
          liste.appendChild(el('div', { class: 'eintrag' }, [
            el('div', {}, [el('strong', {}, `Zeile ${e.zeile}: `), `${k.feld} ${k.wert} steht auch bei ${k.komponenteName}`]),
            el('div', { class: 'muted' }, k.demonstratorName || ''),
          ]));
        }
      }
      box.appendChild(karte('Übernommen, aber doppelt vergeben', [
        el('p', { class: 'muted' }, 'Diese Angaben kommen mehrfach vor — im Profinet die häufigste Störungsursache.'),
        liste,
        el('div', { class: 'btn-reihe' }, [el('a', { class: 'btn', href: '#/netz' }, 'Zur Netzübersicht')]),
      ]));
    }
  }

  SL.views.renderImport = renderImport;
  // Für den Prüfstand: der Zerleger lässt sich einzeln prüfen.
  SL.views._csvZerlegen = csvZerlegen;
  SL.views._spaltenZuordnen = spaltenZuordnen;
})();
