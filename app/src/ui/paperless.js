(function () {
  'use strict';
  window.SL = window.SL || {};
  SL.ui = SL.ui || {};

  const { el, feld, input, select, modal, toast, leer } = SL.ui;

  // Das Fenster für die Belegablage.
  //
  // Vorher gingen Belege wortlos nach Paperless: Titel und Datum vergab die App,
  // Tag und Ablagepfad kamen aus den Einstellungen, einen Korrespondenten gab es
  // gar nicht. In Paperless landete dadurch ein Stapel gleich aussehender
  // Dokumente ohne Absender. Deshalb fragt die App jetzt beim Hochladen — wie
  // in der Gemeindeverwaltung.
  //
  // Die Einstellungen sind damit nicht überflüssig: sie sind die VORBELEGUNG.
  // Wer nichts ändert, bekommt genau das bisherige Verhalten, nur mit Absender.

  // Die Stammlisten ändern sich selten und werden in einer Sitzung mehrfach
  // gebraucht. Ein neu angelegter Tag wird direkt eingehängt, statt die Liste
  // erneut zu holen.
  let stammMerker = null;
  async function stammlisten(frisch = false) {
    if (frisch) stammMerker = null;
    if (!stammMerker) stammMerker = await SL.api.paperlessStammlisten();
    return stammMerker;
  }
  function stammVergessen() { stammMerker = null; }

  // Namen wie Paperless sie vergleichen würde: „Igus" und „igus GmbH" sind
  // NICHT gleich, „Igus " und „igus" schon. Mehr Ähnlichkeit zu raten wäre
  // Anmaßung — deshalb fragt der Dialog nach, statt zu entscheiden.
  const flach = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

  // Doubletten-Warnung: gleicher erster Wortteil, aber nicht derselbe Name.
  // „igus GmbH" neben „Igus" ist genau der Fall, den die Verwaltung später
  // nicht mehr auseinanderhält. Gewarnt, nicht verboten — wie überall in
  // dieser App.
  function aehnlicher(liste, name) {
    const anfang = flach(name).split(' ')[0];
    if (anfang.length < 3) return null;
    return liste.find(o => flach(o.name) !== flach(name)
      && (flach(o.name).startsWith(anfang) || flach(name).startsWith(flach(o.name)))) || null;
  }

  // Auswahlliste mit einem „+ Neu"-Knopf daneben. `anlegen` ist die
  // API-Funktion, die den Eintrag in Paperless erzeugt.
  //
  // Das Eingabefeld erscheint IM Dialog statt als window.prompt: ein
  // Browser-Prompt über einem Modal ist am Handy unschön und wird von manchen
  // Browsern gar nicht mehr angezeigt.
  function wahlMitNeu({ optionen, wert, leerLabel, onChange, anlegen, was }) {
    const box = el('div', { class: 'wahl-neu' });
    const liste = optionen.slice();
    let gewaehlt = wert || 0;

    const sel = select(liste.map(o => ({ wert: o.id, label: o.name })), gewaehlt,
      v => { gewaehlt = Number(v) || 0; onChange(gewaehlt); }, { leerLabel });

    const neuFeld = input({ placeholder: `Name des neuen ${was}en` });
    const zeile = el('div', { class: 'wahl-neu-zeile', hidden: true });

    async function anlegenJetzt() {
      const sauber = neuFeld.value.trim();
      if (!sauber) return;
      const doppelt = aehnlicher(liste, sauber);
      if (doppelt && !SL.ui.confirmDialog(
        `In Paperless gibt es schon „${doppelt.name}". Trotzdem „${sauber}" neu anlegen?`)) return;
      try {
        const neu = await anlegen(sauber);
        if (!liste.some(o => o.id === neu.id)) {
          liste.push({ id: neu.id, name: neu.name });
          sel.appendChild(el('option', { value: String(neu.id) }, neu.name));
        }
        sel.value = String(neu.id);
        gewaehlt = neu.id;
        onChange(gewaehlt);
        stammVergessen();
        neuFeld.value = '';
        zeile.hidden = true;
        toast(neu.vorhanden ? `„${neu.name}" gab es schon — ausgewählt.` : `„${neu.name}" angelegt.`);
      } catch (e) {
        toast(e.message || 'Anlegen fehlgeschlagen.', 4500);
      }
    }

    neuFeld.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); anlegenJetzt(); }
    });
    zeile.appendChild(neuFeld);
    zeile.appendChild(el('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: anlegenJetzt }, 'Anlegen'));

    const oeffnen = el('button', {
      class: 'btn btn-sm', type: 'button',
      title: `${was} in Paperless neu anlegen`,
      onclick: () => {
        zeile.hidden = !zeile.hidden;
        if (!zeile.hidden) setTimeout(() => neuFeld.focus(), 30);
      },
    }, '+ Neu');

    box.appendChild(el('div', { class: 'wahl-neu-kopf' }, [sel, oeffnen]));
    box.appendChild(zeile);
    return box;
  }

  // Tags als Chips: auf dem Handy weit angenehmer als eine Mehrfachliste, und
  // man sieht das Gewählte auf einen Blick. `.chip`/`.chip-aktiv` — die Klassen
  // dieses Stylesheets, nicht die der Gemeindeverwaltung.
  function tagWahl(alleTags, gewaehltIds, onChange) {
    const box = el('div');
    const chips = el('div', { class: 'chips' });
    const tags = alleTags.slice();
    const gewaehlt = new Set(gewaehltIds || []);

    const neuFeld = input({ placeholder: 'Name des neuen Tags' });
    const zeile = el('div', { class: 'wahl-neu-zeile', hidden: true });
    async function tagAnlegen() {
      const sauber = neuFeld.value.trim();
      if (!sauber) return;
      const doppelt = aehnlicher(tags, sauber);
      if (doppelt && !SL.ui.confirmDialog(
        `In Paperless gibt es schon den Tag „${doppelt.name}". Trotzdem „${sauber}" anlegen?`)) return;
      try {
        const neu = await SL.api.paperlessTagAnlegen(sauber);
        if (!tags.some(t => t.id === neu.id)) {
          tags.push({ id: neu.id, name: neu.name });
          tags.sort((a, b) => String(a.name).localeCompare(String(b.name), 'de'));
        }
        gewaehlt.add(neu.id);
        onChange([...gewaehlt]);
        stammVergessen();
        neuFeld.value = '';
        zeile.hidden = true;
        zeichnen();
        toast(neu.vorhanden ? `Tag „${neu.name}" gab es schon — ausgewählt.` : `Tag „${neu.name}" angelegt.`);
      } catch (e) { toast(e.message || 'Anlegen fehlgeschlagen.', 4500); }
    }
    neuFeld.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); tagAnlegen(); } });
    zeile.appendChild(neuFeld);
    zeile.appendChild(el('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: tagAnlegen }, 'Anlegen'));

    function zeichnen() {
      chips.innerHTML = '';
      if (!tags.length) chips.appendChild(leer('Paperless kennt noch keine Tags.'));
      for (const t of tags) {
        const aktiv = gewaehlt.has(t.id);
        chips.appendChild(el('button', {
          class: 'chip' + (aktiv ? ' chip-aktiv' : ''),
          type: 'button',
          onclick: () => {
            if (gewaehlt.has(t.id)) gewaehlt.delete(t.id); else gewaehlt.add(t.id);
            onChange([...gewaehlt]);
            zeichnen();
          },
        }, t.name));
      }
      chips.appendChild(el('button', {
        class: 'chip', type: 'button',
        onclick: () => {
          zeile.hidden = !zeile.hidden;
          if (!zeile.hidden) setTimeout(() => neuFeld.focus(), 30);
        },
      }, '+ Neuer Tag'));
    }
    zeichnen();
    box.appendChild(chips);
    box.appendChild(zeile);
    return box;
  }

  // --- Das Upload-Fenster ---------------------------------------------------
  //
  // Liefert { taskId, dokumentId, titel } oder null (abgebrochen). Es wartet
  // auf die Dokumentnummer, statt sie dem Zufall zu überlassen: sonst steht in
  // der Liste „wird verarbeitet…" und niemand weiß, ob das noch stimmt.
  async function belegDialog({
    datei = null,
    kopf = 'Beleg ablegen',
    titelVorschlag = '',
    datum = '',
    korrespondentName = '',
    typId = 0,
    dateiWahl = 'application/pdf,image/*',
    kamera = false,
  } = {}) {
    let f = datei;
    if (!f) {
      f = await SL.ui.pickFile(dateiWahl, kamera ? 'environment' : null);
      if (!f) return null;
    }

    let cfg = {};
    try { cfg = await SL.api.paperlessConfig(); } catch (_) { cfg = {}; }
    let stamm;
    try {
      stamm = await stammlisten();
    } catch (e) {
      toast(e.message || 'Paperless antwortet nicht.', 5000);
      return null;
    }

    // Vorbelegung: der Lieferant des Vorgangs als Korrespondent, sofern
    // Paperless ihn schon kennt. Neu angelegt wird nichts ungefragt.
    const treffer = korrespondentName
      ? (stamm.korrespondenten || []).find(k => flach(k.name) === flach(korrespondentName))
      : null;

    const wahl = {
      titel: titelVorschlag,
      erstellt: datum || SL.models.heuteIso(),
      korrespondentId: treffer ? treffer.id : 0,
      typId: typId || 0,
      ablagepfadId: cfg.ablagepfadId || 0,
      tagIds: cfg.uploadTagId ? [cfg.uploadTagId] : [],
    };

    const titelFeld = input({ value: wahl.titel, placeholder: 'Titel in Paperless' });
    const datumFeld = input({ type: 'date', value: wahl.erstellt });
    const meldung = el('p', { class: 'muted' });

    // Kein Korrespondent vorbelegt, obwohl wir einen Namen haben: darauf soll
    // man hingewiesen werden, sonst legt niemand ihn je an. Sobald einer
    // gewählt ist, verschwindet der Hinweis — sonst steht die Aufforderung noch
    // da, nachdem man ihr gefolgt ist.
    const hinweis = (korrespondentName && !treffer)
      ? el('p', { class: 'muted' }, `Paperless kennt „${korrespondentName}" noch nicht. Mit „+ Neu" anlegen — dann findet die Verwaltung später alle Belege dieses Lieferanten beisammen.`)
      : null;

    const korrBox = wahlMitNeu({
      optionen: stamm.korrespondenten || [], wert: wahl.korrespondentId,
      leerLabel: '— kein Korrespondent —', was: 'Korrespondent',
      anlegen: (n) => SL.api.paperlessKorrespondentAnlegen(n),
      onChange: (v) => { wahl.korrespondentId = v; if (hinweis) hinweis.hidden = !!v; },
    });
    const typBox = select((stamm.dokumenttypen || []).map(t => ({ wert: t.id, label: t.name })), wahl.typId,
      v => { wahl.typId = Number(v) || 0; }, { leerLabel: '— kein Typ —' });
    const pfadBox = select((stamm.ablagepfade || []).map(t => ({ wert: t.id, label: t.name })), wahl.ablagepfadId,
      v => { wahl.ablagepfadId = Number(v) || 0; }, { leerLabel: '— Standard —' });
    const tags = tagWahl(stamm.tags || [], wahl.tagIds, (ids) => { wahl.tagIds = ids; });

    return new Promise((fertig) => {
      let entschieden = false;
      const schliessen = (wert) => { if (!entschieden) { entschieden = true; fertig(wert); } };

      const senden = el('button', { class: 'btn btn-primary', type: 'button' }, 'Hochladen');
      const abbrechen = el('button', { class: 'btn', type: 'button', onclick: () => { dlg.close(); } }, 'Abbrechen');

      const dlg = modal(kopf, [
        el('p', { class: 'muted' }, `Datei: ${f.name || 'Beleg'}`),
        el('div', { class: 'form-grid' }, [
          feld('Titel', titelFeld),
          feld('Dokumentdatum', datumFeld),
          feld('Korrespondent', korrBox),
          feld('Dokumenttyp', typBox),
          feld('Ablagepfad', pfadBox),
        ]),
        hinweis,
        feld('Tags', tags, { breit: true }),
        meldung,
      ], {
        fuss: [el('span', { class: 'spacer' }), abbrechen, senden],
        onClose: () => schliessen(null),
      });

      senden.onclick = async () => {
        senden.disabled = true;
        abbrechen.disabled = true;
        meldung.className = 'muted';
        meldung.textContent = 'Datei wird übertragen…';
        let taskId = '';
        try {
          const klein = await SL.ui.resizeImageFile(f, { maxPx: 2000, quality: 0.85 });
          const antwort = await SL.api.belegHochladen(klein, {
            titel: titelFeld.value.trim(),
            erstellt: datumFeld.value,
            typId: wahl.typId,
            korrespondentId: wahl.korrespondentId,
            ablagepfadId: wahl.ablagepfadId,
            tagIds: wahl.tagIds,
          });
          taskId = antwort.taskId;
        } catch (e) {
          meldung.className = 'anmeldung-fehler';
          meldung.textContent = e.message || 'Hochladen fehlgeschlagen.';
          senden.disabled = false;
          abbrechen.disabled = false;
          return;
        }

        // Ab hier ist die Datei in Paperless. Ein Abbruch darf sie jetzt nicht
        // mehr verlieren — deshalb wird der Vorgang mit der Task-Kennung auch
        // dann zurückgegeben, wenn das Warten abgebrochen wird.
        const titel = titelFeld.value.trim();
        abbrechen.textContent = 'Im Hintergrund fertig verarbeiten';
        abbrechen.disabled = false;
        abbrechen.onclick = () => { schliessen({ taskId, dokumentId: null, titel }); dlg.close(); };
        senden.remove();
        meldung.textContent = 'Paperless verarbeitet den Beleg (Texterkennung)…';

        const dokumentId = await aufTaskWarten(taskId, (t) => {
          meldung.textContent = t;
        });
        if (dokumentId && dokumentId.fehler) {
          meldung.className = 'anmeldung-fehler';
          meldung.textContent = dokumentId.fehler;
          abbrechen.textContent = 'Schließen';
          abbrechen.onclick = () => { schliessen({ taskId, dokumentId: null, titel, fehler: dokumentId.fehler }); dlg.close(); };
          return;
        }
        schliessen({ taskId, dokumentId: dokumentId ? dokumentId.id : null, titel });
        dlg.close();
      };

      setTimeout(() => titelFeld.focus(), 50);
    });
  }

  // Wartet auf die Dokumentnummer. Gibt { id } zurück, { fehler } bei einem
  // Fehlschlag in Paperless, oder null, wenn es zu lange dauert — das ist kein
  // Fehler, OCR darf dauern. Der Aufrufer merkt sich dann die Task-Kennung.
  async function aufTaskWarten(taskId, melden, sekunden = 45) {
    const ende = Date.now() + sekunden * 1000;
    let versuch = 0;
    while (Date.now() < ende) {
      // Erst kurz, dann länger: die meisten Belege sind nach zwei Sekunden da,
      // ein mehrseitiger Scan braucht eine halbe Minute.
      await new Promise(r => setTimeout(r, versuch < 5 ? 1200 : 3000));
      versuch++;
      let t;
      try { t = await SL.api.paperlessTask(taskId); } catch (_) { continue; }
      if (t.dokumentId) return { id: t.dokumentId };
      if (t.fehler) return { fehler: t.fehler };
      if (melden && versuch === 6) melden('Paperless braucht noch — das Fenster darf zu, es läuft weiter.');
    }
    return null;
  }

  // --- Angaben nachbessern --------------------------------------------------
  // Für Belege, die schon in Paperless liegen. Ändert dort das Dokument selbst.
  async function belegAendernDialog(dokumentId, fertig) {
    let dok, stamm;
    try {
      [dok, stamm] = await Promise.all([SL.api.paperlessDokument(dokumentId), stammlisten()]);
    } catch (e) {
      toast(e.message || 'Beleg nicht abrufbar.', 4500);
      return;
    }

    const wahl = {
      titel: dok.titel, erstellt: dok.erstellt,
      korrespondentId: dok.korrespondentId || 0,
      typId: dok.typId || 0,
      ablagepfadId: dok.ablagepfadId || 0,
      tagIds: dok.tagIds || [],
    };
    const titelFeld = input({ value: wahl.titel });
    const datumFeld = input({ type: 'date', value: wahl.erstellt });
    const korrBox = wahlMitNeu({
      optionen: stamm.korrespondenten || [], wert: wahl.korrespondentId,
      leerLabel: '— kein Korrespondent —', was: 'Korrespondent',
      anlegen: (n) => SL.api.paperlessKorrespondentAnlegen(n),
      onChange: (v) => { wahl.korrespondentId = v; },
    });
    const typBox = select((stamm.dokumenttypen || []).map(t => ({ wert: t.id, label: t.name })), wahl.typId,
      v => { wahl.typId = Number(v) || 0; }, { leerLabel: '— kein Typ —' });
    const pfadBox = select((stamm.ablagepfade || []).map(t => ({ wert: t.id, label: t.name })), wahl.ablagepfadId,
      v => { wahl.ablagepfadId = Number(v) || 0; }, { leerLabel: '— Standard —' });
    const tags = tagWahl(stamm.tags || [], wahl.tagIds, (ids) => { wahl.tagIds = ids; });

    const dlg = modal('Angaben in Paperless ändern', [
      el('div', { class: 'form-grid' }, [
        feld('Titel', titelFeld),
        feld('Dokumentdatum', datumFeld),
        feld('Korrespondent', korrBox),
        feld('Dokumenttyp', typBox),
        feld('Ablagepfad', pfadBox),
      ]),
      feld('Tags', tags, { breit: true }),
      el('p', { class: 'muted' }, 'Geändert wird das Dokument in Paperless selbst. Die Datei bleibt, wie sie ist.'),
    ], {
      fuss: [
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Abbrechen'),
        el('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: async () => {
            try {
              await SL.api.paperlessDokumentAendern(dokumentId, {
                titel: titelFeld.value.trim(),
                erstellt: datumFeld.value,
                typId: wahl.typId,
                korrespondentId: wahl.korrespondentId,
                ablagepfadId: wahl.ablagepfadId,
                tagIds: wahl.tagIds,
              });
              dlg.close();
              toast('Angaben in Paperless geändert.');
              if (fertig) fertig();
            } catch (e) { toast(e.message || 'Ändern fehlgeschlagen.', 4500); }
          },
        }, 'Speichern'),
      ],
    });
  }

  // --- Hängengebliebene Belege ----------------------------------------------
  // Belege, die vor dieser Fassung hochgeladen wurden, stehen dauerhaft auf
  // „wird verarbeitet". Zwei Gründe sind möglich: die Verarbeitung läuft
  // wirklich noch, oder Paperless kennt die alte Vorgangsnummer nicht mehr.
  // Im zweiten Fall hilft nur die Suche über den Titel — die Datei selbst
  // liegt ja längst da.
  //
  // `zuordnen(dokumentId)` trägt die gefundene Nummer beim Aufrufer ein.
  async function nachschauen(beleg, zuordnen) {
    let t = null;
    try { t = await SL.api.paperlessTask(beleg.taskId); } catch (e) {
      toast(e.message || 'Paperless antwortet nicht.', 4500);
      return;
    }
    if (t.dokumentId) { await zuordnen(t.dokumentId); toast('Beleg gefunden und verknüpft.'); return; }
    if (t.fehler) { toast(t.fehler, 6000); return; }

    // Nichts gefunden: über den Titel suchen, den die App selbst vergeben hat.
    let treffer = [];
    try { treffer = await SL.api.paperlessSuche(beleg.titel || ''); } catch (_) {}
    if (!treffer.length) {
      toast(t.unbekannt
        ? 'Paperless kennt diesen Vorgang nicht mehr und findet auch kein Dokument mit diesem Titel.'
        : 'Paperless verarbeitet den Beleg noch. Später noch einmal nachschauen.', 6000);
      return;
    }

    const liste = el('div');
    for (const d of treffer) {
      liste.appendChild(el('div', { class: 'doc-zeile' }, [
        el('span', { class: 'doc-titel' }, [
          el('strong', {}, d.titel || `Dokument ${d.id}`),
          el('div', { class: 'muted' }, [d.erstellt ? SL.ui.formatDatum(d.erstellt) : '', d.dateiname].filter(Boolean).join(' · ')),
        ]),
        el('a', { class: 'btn btn-sm', href: SL.api.paperlessDateiUrl(d.id, 'preview'), target: '_blank', rel: 'noopener' }, 'Ansehen'),
        el('button', {
          class: 'btn btn-sm btn-primary', type: 'button',
          onclick: async () => { dlg.close(); await zuordnen(d.id); toast('Beleg verknüpft.'); },
        }, 'Das ist es'),
      ]));
    }

    const dlg = modal('Beleg in Paperless suchen', [
      el('p', {}, 'Die Vorgangsnummer führt zu nichts mehr — Paperless vergisst erledigte Uploads nach einer Weile. '
        + 'Diese Dokumente passen zum Titel des Belegs:'),
      liste,
      el('p', { class: 'muted' }, 'Ist nichts dabei, lade den Beleg neu hoch und löse die alte Verknüpfung.'),
    ], { fuss: [el('span', { class: 'spacer' }), el('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Schließen')] });
  }

  SL.ui.paperless = {
    belegDialog, belegAendernDialog, nachschauen,
    stammlisten, stammVergessen, aufTaskWarten,
  };
})();
