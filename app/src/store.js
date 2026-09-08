(function () {
  'use strict';
  window.SL = window.SL || {};

  // Zustand der Oberfläche. Anders als in den Schwesterprojekten gibt es hier
  // KEINEN Bestands-Cache: der Bestand liegt in Homebox und wird bei Bedarf
  // frisch geholt. Ein zwischengespeicherter Bestand wäre im Lager schlimmer
  // als gar keiner — zwei Leute am Regal sähen unterschiedliche Zahlen.
  const state = {
    benutzer: null,        // null = nicht angemeldet (= Gast, darf lesen)
    eingerichtet: true,    // false = es gibt noch keinen Benutzer
    settings: SL.models.defaultSettings(),
    backendDa: true,
    lager: { eingerichtet: false, ok: false, sammlung: '', hinweis: '' },
  };

  const zuhoerer = [];
  function onChange(fn) { zuhoerer.push(fn); return () => { const i = zuhoerer.indexOf(fn); if (i >= 0) zuhoerer.splice(i, 1); }; }
  function melden() { for (const fn of zuhoerer) { try { fn(state); } catch (e) { console.warn(e); } } }

  // --- Start ---------------------------------------------------------------
  async function bootstrap() {
    try {
      const antwort = await SL.api.ich();
      state.benutzer = antwort.benutzer;
      state.eingerichtet = antwort.eingerichtet;
      state.backendDa = true;
    } catch (_) {
      state.backendDa = false;
      state.benutzer = null;
    }
    await settingsLaden();
    await lagerZustandLaden();
    return state;
  }

  async function settingsLaden() {
    // Ohne Anmeldung liefert der Server die Einstellungen nicht (401). Das ist
    // kein Fehler, sondern der Normalfall für Gäste — dann bleiben die
    // Voreinstellungen stehen.
    if (!state.benutzer) { state.settings = SL.models.defaultSettings(); return; }
    try {
      state.settings = SL.models.mergeSettingsDefaults(await SL.api.getSettings());
    } catch (_) {
      state.settings = SL.models.defaultSettings();
    }
  }

  async function lagerZustandLaden() {
    try {
      const h = await SL.api.lagerHealth();
      state.lager = {
        eingerichtet: !!h.eingerichtet,
        ok: !!h.ok,
        sammlung: h.sammlung || '',
        mehrereSammlungen: !!h.mehrereSammlungen,
        hinweis: h.hinweis || '',
      };
    } catch (e) {
      state.lager = { eingerichtet: true, ok: false, sammlung: '', hinweis: e.message || 'Homebox antwortet nicht.' };
    }
  }

  // --- Anmeldung -----------------------------------------------------------
  async function anmelden(benutzername, passwort) {
    const { benutzer } = await SL.api.anmelden(benutzername, passwort);
    state.benutzer = benutzer;
    state.eingerichtet = true;
    await settingsLaden();
    await lagerZustandLaden();
    melden();
    return benutzer;
  }

  async function ersteinrichtung(daten) {
    const { benutzer } = await SL.api.ersteinrichtung(daten);
    state.benutzer = benutzer;
    state.eingerichtet = true;
    await settingsLaden();
    melden();
    return benutzer;
  }

  async function abmelden() {
    try { await SL.api.abmelden(); } catch (_) { /* Sitzung war schon hinüber */ }
    state.benutzer = null;
    state.settings = SL.models.defaultSettings();
    melden();
  }

  async function passwortAendern(alt, neu) {
    const { benutzer } = await SL.api.passwortAendern(alt, neu);
    state.benutzer = benutzer;
    await settingsLaden();
    melden();
    return benutzer;
  }

  // --- Einstellungen -------------------------------------------------------
  async function settingsSpeichern(s) {
    const gespeichert = await SL.api.putSettings(s);
    state.settings = SL.models.mergeSettingsDefaults(gespeichert);
    melden();
    return state.settings;
  }

  // --- Rechte --------------------------------------------------------------
  // Eine einzige Stelle, an der Rechte beantwortet werden — die Ansichten
  // sollen nicht selbst Rollen vergleichen. Das ist reine Bequemlichkeit für
  // die Anzeige: durchgesetzt werden die Rechte im Backend.
  const istAngemeldet = () => !!state.benutzer;
  const istAdmin = () => !!state.benutzer && state.benutzer.rolle === 'admin';
  const mussPasswortWechseln = () => !!state.benutzer && !!state.benutzer.mussWechseln;
  const darfBuchen = () => istAngemeldet() && !mussPasswortWechseln();

  function applyServerMessage(msg) {
    if (!msg || !msg.type) return;
    if (msg.type === 'settings:save' && msg.origin !== SL.api.clientId) {
      state.settings = SL.models.mergeSettingsDefaults(msg.settings);
      melden();
    }
  }

  SL.store = {
    state,
    onChange,
    bootstrap, settingsLaden, lagerZustandLaden,
    anmelden, ersteinrichtung, abmelden, passwortAendern,
    settingsSpeichern,
    istAngemeldet, istAdmin, mussPasswortWechseln, darfBuchen,
    applyServerMessage,
  };
})();
