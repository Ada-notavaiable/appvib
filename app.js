/**
 * Birdsexy Connect — PWA Bluetooth controller
 * Compatibile con dispositivi che seguono il protocollo ASCII Lovense
 * (comandi tipo "Vibrate:X;", "Battery;" terminati con ";" via GATT BLE).
 *
 * Generazioni supportate (UUID verificati contro buttplug.io stpihkal):
 *   - Gen 1:        service fff0..., RX notify fff1..., TX write fff2...
 *   - Gen 2 (NUS):  service 6e400001-b5a3-..., TX 6e400002-..., RX 6e400003-...
 *   - Gen 3+ (XY):  service XY300001-002Z-4bd4-bbd5-a6920e4c5653,
 *                   TX XY300002-002Z-..., RX notify XY300003-002Z-...
 *                   dove X = 4..5, Y = 0..f, Z = 3..4.
 *
 * I moderni dispositivi Lovense-compatibili trasmettono come prefisso nome "LVS-".
 */

(() => {
  "use strict";

  // Pattern caratteristiche note dei cloni BLE per adult-toy.
  // Tutti i cloni 7320-class rispettano il pattern service 0xXXy0,
  // write 0xXXy2, notify 0xXXy1 — quindi enumeriamo l'intera gamma.
  // L'ordine è importante: viene provato prima il più probabile.
  const KNOWN_PROFILES = [
    {
      name: "Gen2 (Nordic UART)",
      service: "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
      write:   "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
      notify:  "6e400003-b5a3-f393-e0a9-e50e24dcca9e",
    },
    {
      name: "Clone FFE0 (Birdsexy 7320, I-Vibe, Piper)",
      service: "0000ffe0-0000-1000-8000-00805f9b34fb",
      write:   "0000ffe2-0000-1000-8000-00805f9b34fb",
      notify:  "0000ffe1-0000-1000-8000-00805f9b34fb",
    },
    {
      name: "Gen1 (Legacy Lovense, We-Vibe, Kiiroo, SVAKOM)",
      service: "0000fff0-0000-1000-8000-00805f9b34fb",
      write:   "0000fff2-0000-1000-8000-00805f9b34fb",
      notify:  "0000fff1-0000-1000-8000-00805f9b34fb",
    },
    {
      name: "Clone FFB0 (Satisfyer BT, Rocks Off 2.x)",
      service: "0000ffb0-0000-1000-8000-00805f9b34fb",
      write:   "0000ffb2-0000-1000-8000-00805f9b34fb",
      notify:  "0000ffb1-0000-1000-8000-00805f9b34fb",
    },
    {
      name: "Clone FFC0 (OhMiBod 1.x, Lovelife)",
      service: "0000ffc0-0000-1000-8000-00805f9b34fb",
      write:   "0000ffc2-0000-1000-8000-00805f9b34fb",
      notify:  "0000ffc1-0000-1000-8000-00805f9b34fb",
    },
    {
      name: "Clone FFD0 (Tamatox, Bathmate, Ravenii)",
      service: "0000ffd0-0000-1000-8000-00805f9b34fb",
      write:   "0000ffd2-0000-1000-8000-00805f9b34fb",
      notify:  "0000ffd1-0000-1000-8000-00805f9b34fb",
    },
    {
      name: "Clone FFA0 (AliExpress generici)",
      service: "0000ffa0-0000-1000-8000-00805f9b34fb",
      write:   "0000ffa2-0000-1000-8000-00805f9b34fb",
      notify:  "0000ffa1-0000-1000-8000-00805f9b34fb",
    },
    {
      name: "Clone FF90",
      service: "0000ff90-0000-1000-8000-00805f9b34fb",
      write:   "0000ff92-0000-1000-8000-00805f9b34fb",
      notify:  "0000ff91-0000-1000-8000-00805f9b34fb",
    },
    {
      name: "Clone FF80",
      service: "0000ff80-0000-1000-8000-00805f9b34fb",
      write:   "0000ff82-0000-1000-8000-00805f9b34fb",
      notify:  "0000ff81-0000-1000-8000-00805f9b34fb",
    },
    {
      name: "Clone FF70",
      service: "0000ff70-0000-1000-8000-00805f9b34fb",
      write:   "0000ff72-0000-1000-8000-00805f9b34fb",
      notify:  "0000ff71-0000-1000-8000-00805f9b34fb",
    },
    {
      name: "Clone FF60",
      service: "0000ff60-0000-1000-8000-00805f9b34fb",
      write:   "0000ff62-0000-1000-8000-00805f9b34fb",
      notify:  "0000ff61-0000-1000-8000-00805f9b34fb",
    },
    {
      name: "Clone FF50",
      service: "0000ff50-0000-1000-8000-00805f9b34fb",
      write:   "0000ff52-0000-1000-8000-00805f9b34fb",
      notify:  "0000ff51-0000-1000-8000-00805f9b34fb",
    },
  ];

  // Lista completa dei servizi da dichiarare come optionalServices per il chooser
  // BLE. Usata sia dai bottoni "Connetti" esistenti sia dai bottoni "Per modello"
  // della griglia: dare al browser TUTTI questi UUID significa che, dopo lo
  // scan, potremo chiedere `getPrimaryService(...)` su qualsiasi servizio noto.
  const COMPREHENSIVE_OPTIONAL_SERVICES = [
    ...KNOWN_PROFILES.map((p) => p.service),
    "0000180f-0000-1000-8000-00805f9b34fb", // battery_service (standard SIG)
    "0000180a-0000-1000-8000-00805f9b34fb", // device_information (per nome/modello)
  ];

  // Bottoni della griglia "Prova per modello". Ogni bottone apre il chooser
  // BLE con un sottoinsieme specifico di optionalServices per sbloccare la
  // lettura del profilo GATT del clone corrispondente. Tutti convergono poi
  // sull'unico probe Lovense ASCII (`Vibrate:1;` → `Vibrate:0;`).
  const KNOWN_MODELS = [
    {
      key: "lovense-original",
      label: "Lovense",
      description: "Filtra nomi LVS-*. Per Hush, Nora, Max, Lush originali.",
      filters: [{ namePrefix: "LVS-" }],
      optionalServices: [
        "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
        "0000fff0-0000-1000-8000-00805f9b34fb",
      ],
    },
    {
      key: "ffe0-clone",
      label: "Clone cinese 7320",
      description: "Servizio FFE0. Il più probabile per il Toy ID 7320 del QR code.",
      filters: null,
      optionalServices: [
        "0000ffe0-0000-1000-8000-00805f9b34fb",
        "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
      ],
    },
    {
      key: "ffb0-clone",
      label: "Satisfyer / FFB0",
      description: "Satisfyer BT, Rocks Off 2.x, cloni AliExpress 'Satisfyer-like'.",
      filters: null,
      optionalServices: [
        "0000ffb0-0000-1000-8000-00805f9b34fb",
        "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
      ],
    },
    {
      key: "fff0-legacy",
      label: "SVAKOM / Kiiroo",
      description: "We-Vibe, SVAKOM, Kiiroo, ROMP (servizio 0xfff0 legacy).",
      filters: null,
      optionalServices: [
        "0000fff0-0000-1000-8000-00805f9b34fb",
      ],
    },
    {
      key: "ffc0-ohmibod",
      label: "OhMiBod / Lovelife",
      description: "Vecchi OhMiBod, Lovelife, cloni Lovelife.",
      filters: null,
      optionalServices: [
        "0000ffc0-0000-1000-8000-00805f9b34fb",
      ],
    },
    {
      key: "try-all",
      label: "Prova TUTTI",
      description: "Scansione aggressiva: ogni BLE, ogni servizio noto.",
      filters: null,
      optionalServices: COMPREHENSIVE_OPTIONAL_SERVICES,
    },
  ];
  const KNOWN_MODELS_BY_KEY = Object.fromEntries(KNOWN_MODELS.map((m) => [m.key, m]));

  // Regex per Gen3: XY300001-002Z-4bd4-bbd5-a6920e4c5653
  const GEN3_PATTERN = /^([0-9a-f]{2})300001-002([0-9a-f])-4bd4-bbd5-a6920e4c5653$/i;

  // 3 velocità mappate sulla scala 0-20 del protocollo Lovense.
  const SPEEDS = {
    low: 7,    // ~35%
    mid: 13,   // ~65%
    high: 20,  // 100%
  };

  // Stato applicativo
  const state = {
    device: null,
    server: null,
    profile: null,
    writeChar: null,
    notifyChar: null,
    activeSpeed: null,
    batteryTimer: null,
    batteryTimeout: null,
    textDecoder: new TextDecoder(),
    textEncoder: new TextEncoder(),
  };

  // Elementi DOM
  const els = {
    consentScreen: document.getElementById("consent"),
    acceptBtn: document.getElementById("acceptBtn"),
    exitBtn: document.getElementById("exitBtn"),
    connectBtn: document.getElementById("connectBtn"),
    connectAllBtn: document.getElementById("connectAllBtn"),
    disconnectBtn: document.getElementById("disconnectBtn"),
    stopBtn: document.getElementById("stopBtn"),
    controlsSection: document.getElementById("controlsSection"),
    speedsEl: document.getElementById("speeds"),
    deviceCard: document.getElementById("deviceCard"),
    deviceName: document.getElementById("deviceName"),
    batteryText: document.getElementById("batteryText"),
    batteryFill: document.getElementById("batteryFill"),
    status: document.getElementById("status"),
    statusText: document.getElementById("statusText"),
    toast: document.getElementById("toast"),
    debugSection: document.getElementById("debugSection"),
    modelsSection: document.getElementById("modelsSection"),
    modelsGrid: document.getElementById("modelsGrid"),
  };

  const debugEls = {
    btn: document.getElementById("debugBtn"),
    result: document.getElementById("debugResult"),
    copyBtn: document.getElementById("debugCopyBtn"),
    actions: document.getElementById("debugActions"),
  };

  const speedButtons = Array.from(document.querySelectorAll(".btn--speed"));

  // --- Helpers ---
  function setStatus(stateName, text) {
    els.status.dataset.state = stateName;
    els.statusText.textContent = text;
  }

  let toastTimer = null;
  function showToast(message, variant = "") {
    els.toast.textContent = message;
    els.toast.className = "toast show" + (variant ? " " + variant : "");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.classList.remove("show");
    }, 4000);
  }

  function setUIConnected(connected) {
    if (connected) {
      els.connectBtn.hidden = true;
      els.disconnectBtn.hidden = false;
      els.speedsEl.hidden = false;
      els.deviceCard.hidden = false;
    } else {
      els.connectBtn.hidden = false;
      els.disconnectBtn.hidden = true;
      els.speedsEl.hidden = true;
      els.deviceCard.hidden = true;
      speedButtons.forEach((b) => b.classList.remove("active"));
      state.activeSpeed = null;
    }
  }

  function setConsented(consented) {
    els.consentScreen.hidden = consented;
    els.controlsSection.hidden = !consented;
    els.modelsSection.hidden = !consented;
    els.debugSection.hidden = !consented;
  }

  function lower(s) { return s.toLowerCase(); }

  // --- Bluetooth ---
  function isWebBluetoothSupported() {
    return typeof navigator !== "undefined" && "bluetooth" in navigator;
  }

  /**
   * Cerca un servizio Lovense sul server GATT. Ritorna sempre
   * la stessa shape: { profile, service, writeChar, notifyChar }.
   * notifyChar può essere null su device che non espongono notify.
   */
  async function findLovenseService(server) {
    // 1) Profili statici noti
    for (const profile of KNOWN_PROFILES) {
      try {
        const service = await server.getPrimaryService(lower(profile.service));
        const writeChar = await service.getCharacteristic(lower(profile.write));
        let notifyChar = null;
        try {
          notifyChar = await service.getCharacteristic(lower(profile.notify));
        } catch {
          // alcuni cloni espongono solo write
        }
        return { profile, service, writeChar, notifyChar };
      } catch {
        // continua
      }
    }

    // 2) Fallback: enumera tutti i servizi e cerca pattern Gen3
    let services = [];
    try {
      services = await server.getPrimaryServices();
    } catch {
      return null;
    }

    for (const service of services) {
      const m = service.uuid.match(GEN3_PATTERN);
      if (!m) continue;
      const [, xy, z] = m;
      const profile = {
        name: `Gen3 (${xy.toUpperCase()}…)`,
        service: lower(service.uuid),
        write:   lower(`${xy}300002-002${z}-4bd4-bbd5-a6920e4c5653`),
        notify:  lower(`${xy}300003-002${z}-4bd4-bbd5-a6920e4c5653`),
      };
      try {
        const writeChar = await service.getCharacteristic(profile.write);
        let notifyChar = null;
        try {
          notifyChar = await service.getCharacteristic(profile.notify);
        } catch {}
        return { profile, service, writeChar, notifyChar };
      } catch {
        continue;
      }
    }
    return null;
  }

  async function connect(acceptAll = false) {
    if (!isWebBluetoothSupported()) {
      showToast("Web Bluetooth non supportato da questo browser", "error");
      return;
    }

    setStatus("connecting", acceptAll ? "Scansione completa…" : "Ricerca dispositivo…");

    try {
      const device = await navigator.bluetooth.requestDevice({
        ...(acceptAll
          ? { acceptAllDevices: true }
          : { filters: [{ namePrefix: "LVS-" }] }),
        optionalServices: COMPREHENSIVE_OPTIONAL_SERVICES.map(lower),
      });

      device.addEventListener("gattserverdisconnected", onDisconnected);

      const displayName = device.name || "Dispositivo LVS";

      setStatus("connecting", `Connessione a ${displayName}…`);
      const server = await device.gatt.connect();

      const found = await findLovenseService(server);
      if (!found) {
        try { server.disconnect(); } catch {}
        throw new Error(
          "Profilo Lovense non riconosciuto. Accendi il dispositivo e mettilo in modalità pairing."
        );
      }

      state.device = device;
      state.server = server;
      state.profile = found.profile;
      state.writeChar = found.writeChar;
      state.notifyChar = found.notifyChar;

      els.deviceName.textContent = displayName;

      if (state.notifyChar) {
        try {
          await state.notifyChar.startNotifications();
          state.notifyChar.addEventListener("characteristicvaluechanged", onNotify);
        } catch (e) {
          console.warn("Notifiche non abilitate:", e);
        }
      }

      setStatus("connected", `Connesso · ${found.profile.name}`);
      setUIConnected(true);
      showToast(`Connesso a ${displayName}`, "success");

      await sendCommand("Vibrate:0;");
      requestBattery();
      startBatteryPolling();
    } catch (err) {
      console.error("Errore di connessione:", err);
      setStatus("error", "Connessione fallita");
      let msg;
      if (err && err.name === "NotFoundError") {
        msg = "Nessun dispositivo selezionato";
      } else if (err && err.name === "SecurityError") {
        msg = "Bluetooth negato dal browser (HTTPS richiesto fuori da localhost)";
      } else if (err && err.message) {
        msg = err.message;
      } else {
        msg = "Impossibile connettersi";
      }
      showToast(msg, "error");
    }
  }

  /**
   * Avvia una connessione "modello-specifica": apre il chooser BLE con un
   * sottoinsieme di optionalServices ristretto al marchio (es. solo FFE0 per
   * i cloni 7320), per poi applicare il probe Lovense ASCII condiviso
   * (`Vibrate:1;` → `Vibrate:0;`) per verificare il command-set.
   */
  async function connectByModel(modelKey) {
    if (!isWebBluetoothSupported()) {
      showToast("Web Bluetooth non supportato da questo browser", "error");
      return;
    }
    const cfg = KNOWN_MODELS_BY_KEY[modelKey];
    if (!cfg) {
      showToast("Modello sconosciuto", "error");
      return;
    }

    setStatus("connecting", `Ricerca ${cfg.label}…`);

    try {
      const device = await navigator.bluetooth.requestDevice({
        ...(cfg.filters ? { filters: cfg.filters } : { acceptAllDevices: true }),
        optionalServices: (cfg.optionalServices || COMPREHENSIVE_OPTIONAL_SERVICES).map(lower),
      });

      device.addEventListener("gattserverdisconnected", onDisconnected);

      const displayName = device.name || cfg.label;
      setStatus("connecting", `Connessione a ${displayName}…`);
      const server = await device.gatt.connect();

      const found = await findLovenseService(server);
      if (!found) {
        try { server.disconnect(); } catch {}
        throw new Error(
          `Profilo BLE non riconosciuto per "${cfg.label}". ` +
          `Metti il dispositivo in modalità pairing (LED lampeggia) e riprova.`
        );
      }

      state.device = device;
      state.server = server;
      state.profile = found.profile;
      state.writeChar = found.writeChar;
      state.notifyChar = found.notifyChar;

      els.deviceName.textContent = displayName;

      let onNotifyAttached = false;
      if (state.notifyChar) {
        try {
          await state.notifyChar.startNotifications();
          state.notifyChar.addEventListener("characteristicvaluechanged", onNotify);
          onNotifyAttached = true;
        } catch (e) {
          console.warn("Notifiche non abilitate:", e);
        }
      }

      // Probe: scrive `Vibrate:1;`, attende 250 ms, scrive `Vibrate:0;`.
      // Se sul canale notify riceviamo un "OK" (o un numero di batteria),
      // il command-set Lovense ASCII è confermato. In caso contrario,
      // continuiamo comunque: molti cloni cinesi accettano la scrittura
      // ma non supportano notify.
      // Best-effort: il probe è breve (≤ 300 ms in totale) e termina sempre
      // con `Vibrate:0;`. Stacchiamo temporaneamente onNotify per non
      // confondere updateBattery() con eventuali risposte numeriche
      // (alcuni cloni 7320 rispondono alla vibrazione con un numero di
      // batteria che altrimenti popola la UI prima del valore reale).
      // onNotifyAttached protegge dal caso in cui startNotifications sia
      // fallito: in quel caso onNotify non è mai stato agganciato e ogni
      // remove/add su di esso sarebbe un no-op rumoroso.
      let acknowledged = false;
      const probeListener = (ev) => {
        const txt = state.textDecoder.decode(ev.target.value).trim();
        if (/^OK/i.test(txt) || /^\d{1,3}$/.test(txt)) acknowledged = true;
      };
      if (state.notifyChar && onNotifyAttached) {
        state.notifyChar.removeEventListener("characteristicvaluechanged", onNotify);
        state.notifyChar.addEventListener("characteristicvaluechanged", probeListener);
      }
      await sendCommand("Vibrate:0;"); // safety: spegne prima del probe
      await sendCommand("Vibrate:1;");
      await new Promise((r) => setTimeout(r, 250));
      await sendCommand("Vibrate:0;");
      if (state.notifyChar && onNotifyAttached) {
        state.notifyChar.removeEventListener("characteristicvaluechanged", probeListener);
        state.notifyChar.addEventListener("characteristicvaluechanged", onNotify);
      }

      setStatus("connected", `Connesso · ${found.profile.name}`);
      setUIConnected(true);
      const probeNote =
        acknowledged
          ? " (probe OK)"
          : state.notifyChar
            ? ""
            : " (probe silenzioso)";
      showToast(
        `Connesso a ${displayName} · ${found.profile.name}${probeNote}`,
        "success"
      );

      requestBattery();
      startBatteryPolling();
    } catch (err) {
      console.error("Errore di connessione:", err);
      setStatus("error", "Connessione fallita");
      let msg;
      if (err && err.name === "NotFoundError") msg = "Nessun dispositivo selezionato";
      else if (err && err.name === "SecurityError") msg = "Bluetooth negato dal browser (HTTPS richiesto fuori da localhost)";
      else if (err && err.message) msg = err.message;
      else msg = "Impossibile connettersi";
      showToast(msg, "error");
    }
  }

  function onDisconnected() {
    stopBatteryPolling();
    clearBatteryTimeout();
    setUIConnected(false);
    setStatus("disconnected", "Disconnesso");
    state.device = null;
    state.server = null;
    state.writeChar = null;
    state.notifyChar = null;
    state.profile = null;
    showToast("Dispositivo disconnesso");
  }

  function onNotify(event) {
    const value = event.target.value;
    if (!value) return;
    const text = state.textDecoder.decode(value).trim();
    handleResponse(text);
  }

  function handleResponse(text) {
    if (/^\d{1,3}$/.test(text)) {
      updateBattery(parseInt(text, 10));
      clearBatteryTimeout();
    } else if (/^OK/i.test(text)) {
      // ack dei comandi di vibrazione
    } else {
      console.debug("BLE risposta:", text);
    }
  }

  async function sendCommand(cmd) {
    if (!state.writeChar) return false;
    try {
      await state.writeChar.writeValue(state.textEncoder.encode(cmd));
      return true;
    } catch (err) {
      console.error("Errore invio comando", cmd, err);
      showToast("Comando non inviato", "error");
      return false;
    }
  }

  async function setSpeed(level) {
    // Aggiorna UI prima del comando: feedback immediato anche se la write è lenta.
    speedButtons.forEach((b) => {
      b.classList.toggle("active", parseInt(b.dataset.speed, 10) === level);
    });
    state.activeSpeed = level;
    const ok = await sendCommand(`Vibrate:${level};`);
    if (!ok) state.activeSpeed = null;
  }

  async function stopVibration() {
    speedButtons.forEach((b) => b.classList.remove("active"));
    const ok = await sendCommand("Vibrate:0;");
    if (ok) state.activeSpeed = null;
  }

  /**
   * Interroga la batteria via `Battery;`. Le risposte arrivano sul canale notify;
   * se dopo 3s non si riceve nulla mostriamo "n/d".
   */
  function requestBattery() {
    if (!state.writeChar) return;
    sendCommand("Battery;");
    clearBatteryTimeout();
    state.batteryTimeout = setTimeout(() => {
      if (els.batteryText.textContent === "—%") {
        els.batteryText.textContent = "n/d";
      }
    }, 3000);
  }

  function clearBatteryTimeout() {
    if (state.batteryTimeout) {
      clearTimeout(state.batteryTimeout);
      state.batteryTimeout = null;
    }
  }

  /**
   * Soft-poll ogni 5 minuti, MA solo quando la pagina è in foreground.
   * Evita traffico BLE inutile in background e protegge la privacy dell'utente.
   */
  function startBatteryPolling() {
    stopBatteryPolling();
    state.batteryTimer = setInterval(() => {
      if (document.visibilityState === "visible" && state.writeChar) {
        requestBattery();
      }
    }, 5 * 60 * 1000);
  }

  function stopBatteryPolling() {
    if (state.batteryTimer) {
      clearInterval(state.batteryTimer);
      state.batteryTimer = null;
    }
  }

  function updateBattery(percent) {
    if (!Number.isFinite(percent)) return;
    percent = Math.max(0, Math.min(100, percent));
    els.batteryText.textContent = `${percent}%`;
    const fillUnits = Math.round((percent / 100) * 14);
    if (els.batteryFill) {
      els.batteryFill.setAttribute("width", String(fillUnits));
    }
    els.battery.style.color =
      percent <= 20 ? "var(--danger)" : percent <= 40 ? "var(--warning)" : "var(--success)";
  }

  /**
   * Disconnetti PRIMA spegnendo la vibrazione (await), POI chiudendo il GATT.
   * Aspettare lo Stop prima del disconnect è importante per un'app sensibile:
   * l'utente si aspetta che il dispositivo si fermi immediatamente quando preme Stop.
   */
  async function disconnect() {
    stopBatteryPolling();
    try {
      await sendCommand("Vibrate:0;");
    } catch (e) {
      console.error("Stop durante disconnect:", e);
    }
    if (state.server && state.server.connected) {
      try {
        state.server.disconnect();
      } catch (e) {
        console.error("Errore disconnessione:", e);
      }
    }
  }

  // --- Wiring ---
  els.acceptBtn?.addEventListener("click", () => setConsented(true));
  els.exitBtn?.addEventListener("click", () => {
    try { window.close(); } catch {}
    showToast("Per uscire chiudi la scheda del browser");
  });
  els.connectBtn.addEventListener("click", () => connect(false));
  els.connectAllBtn?.addEventListener("click", () => connect(true));
  els.disconnectBtn.addEventListener("click", disconnect);
  els.stopBtn.addEventListener("click", stopVibration);
  speedButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const level = parseInt(btn.dataset.speed, 10);
      setSpeed(level);
    });
  });

  document.addEventListener("visibilitychange", () => {
    if (state.writeChar && document.visibilityState === "visible") {
      requestBattery();
    }
  });

  // --- Debug BLE ---
  // Servizi dichiarati in optionalServices. Il browser espone SOLO questi via GATT;
  // eventuali servizi con UUID non in lista restano invisibili (limitazione della
  // specifica Web Bluetooth, aggirabile solo con app native come nRF Connect).
  const DEBUG_OPTIONAL_SERVICES = [
    // Standard GATT (16-bit espansi a 128-bit)
    "00001800-0000-1000-8000-00805f9b34fb", // generic_access (universale)
    "00001801-0000-1000-8000-00805f9b34fb", // generic_attribute
    "00001802-0000-1000-8000-00805f9b34fb", // immediate_alert
    "00001803-0000-1000-8000-00805f9b34fb", // link_loss
    "00001804-0000-1000-8000-00805f9b34fb", // tx_power
    "00001805-0000-1000-8000-00805f9b34fb", // current_time
    "00001807-0000-1000-8000-00805f9b34fb", // next_dst_change
    "00001808-0000-1000-8000-00805f9b34fb", // local_time
    "00001809-0000-1000-8000-00805f9b34fb", // dst_change
    "0000180a-0000-1000-8000-00805f9b34fb", // device_information
    "0000180d-0000-1000-8000-00805f9b34fb", // heart_rate
    "0000180f-0000-1000-8000-00805f9b34fb", // battery_service
    "00001810-0000-1000-8000-00805f9b34fb", // blood_pressure
    "00001811-0000-1000-8000-00805f9b34fb", // alert_notification
    "00001812-0000-1000-8000-00805f9b34fb", // human_interface_device
    // Nordic UART (NUS) — adottato da molti toy BLE economici
    "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
    // Lovense Gen1 / We-Vibe legacy / SVAKOM (tutti usano lo stesso prefisso 0xfff0)
    "0000fff0-0000-1000-8000-00805f9b34fb",
    // Range adottati da innumerevoli toy "no-brand" cinesi (AliExpress-class).
    // Sono il de facto standard dei cloni 7320-class, Rocks Off, Satisfyer BT,
    // OhMiBod vecchi, ROMP, Pipedream, Cell O Sex, ecc. — coprire l'intera
    // gamma 0xFF00..0xFFEF costa pochi UUID e sblocca la maggior parte dei
    // dispositivi "sconosciuti" che il browser altrimenti nasconde.
    "0000ffe0-0000-1000-8000-00805f9b34fb", // I-Vibe / Piper / Rocks Off
    "0000ffd0-0000-1000-8000-00805f9b34fb", // Tamatox / Bathmate / Ravenii
    "0000ffc0-0000-1000-8000-00805f9b34fb", // OhMiBod 1.x / Clone-A
    "0000ffb0-0000-1000-8000-00805f9b34fb", // Satisfyer BT / Rocks Off 2.x
    "0000ffa0-0000-1000-8000-00805f9b34fb", // Cloni cinesi generici
    "0000ff90-0000-1000-8000-00805f9b34fb", // Cloni cinesi generici
    "0000ff80-0000-1000-8000-00805f9b34fb", // Cloni cinesi generici
    "0000ff70-0000-1000-8000-00805f9b34fb", // Cloni cinesi generici
    "0000ff60-0000-1000-8000-00805f9b34fb", // Cloni cinesi generici
    "0000ff50-0000-1000-8000-00805f9b34fb", // Cloni cinesi generici
  ];

  let lastDebugReport = null;

  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]
    ));
  }

  // Popola la griglia "Prova per modello" dai metadati KNOWN_MODELS.
  // Posizionato qui (dopo escHtml) per evitare di duplicare l'escape.
  if (els.modelsGrid) {
    for (const m of KNOWN_MODELS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "btn btn--ghost model-btn" +
        (m.key === "try-all" ? " model-btn--accent" : "");
      btn.dataset.modelKey = m.key;
      btn.innerHTML =
        `<span class="model-name">${escHtml(m.label)}</span>` +
        `<span class="model-desc">${escHtml(m.description)}</span>`;
      btn.addEventListener("click", () => connectByModel(m.key));
      els.modelsGrid.appendChild(btn);
    }
  }

  // Mappa nomi BLE ⇒ etichette più compatte per il riquadro di output.
  function prettyProps(char) {
    const labels = {
      read: "read",
      write: "write",
      writeWithoutResponse: "writeNoResp",
      notify: "notify",
      indicate: "indicate",
      broadcast: "broadcast",
      authenticatedSignedWrites: "signWrites",
      reliableWrite: "reliableWrite",
      writableAuxiliaries: "auxWrite",
    };
    return (char.properties || []).map((p) => labels[p] || p).join(", ");
  }

  // Formatta un'eccezione (Error DOM o plain object) come stringa breve.
  function errText(e) {
    const name = (e && e.name) || "";
    const msg = (e && e.message) || String(e);
    return name ? name + " " + msg : msg;
  }

  async function debugConnect() {
    if (!isWebBluetoothSupported()) {
      showToast("Web Bluetooth non supportato", "error");
      return;
    }

    // Chiude qualunque sessione Lovense precedente per evitare leak di connessioni GATT.
    try { await disconnect(); } catch (_) { /* ignorato: debug è modalità diagnostica */ }

    setStatus("connecting", "Debug: seleziona un dispositivo…");
    debugEls.result.hidden = true;
    debugEls.result.textContent = "";
    debugEls.actions.hidden = true;
    lastDebugReport = null;

    try {
      const device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: DEBUG_OPTIONAL_SERVICES,
      });

      device.addEventListener("gattserverdisconnected", () => {
        // Silenzioso: l'utente può chiudere il debug in qualsiasi momento dal telefono.
      });

      setStatus("connecting", `Connessione debug a ${device.name || "(sconosciuto)"}…`);
      const server = await device.gatt.connect();

      const report = {
        name: device.name || "(senza nome)",
        id: device.id || "—",
        paired: !!device.paired,
        gattConnected: !!server.connected,
        services: [],
        servicesError: null,
      };

      // getPrimaryServices() può lanciare NotFoundError se nessun servizio della
      // optionalServices list è presente sul dispositivo: consideriamolo un caso
      // valido (il browser ha correttamente filtrato, non è un bug).
      let services = [];
      try {
        services = await server.getPrimaryServices();
      } catch (e) {
        report.servicesError = errText(e);
      }

      for (const service of services) {
        const svc = { uuid: service.uuid, characteristics: [] };
        try {
          const chars = await service.getCharacteristics();
          for (const c of chars) {
            const ch = {
              uuid: c.uuid,
              properties: Array.from(c.properties || []),
            };
            // Solo le characteristic con bit "read" vengono lette: le altre
            // restituiscono NotPermitted/GATT error inutile.
            if (c.properties && c.properties.read) {
              try {
                const v = await c.readValue();
                // byteOffset/byteLength: alcuni build di Chromium restituiscono
                // una DataView su un ArrayBuffer condiviso; senza slice può
                // anteporre byte "fratelli".
                ch.valueHex = Array.from(
                  new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
                )
                  .map((b) => b.toString(16).padStart(2, "0"))
                  .join(" ");
                try {
                  ch.valueText = new TextDecoder("utf-8", { fatal: false }).decode(v);
                } catch (_) { /* non testuale */ }
              } catch (e) {
                ch.readError = errText(e);
              }
            }
            svc.characteristics.push(ch);
          }
        } catch (e) {
          svc.error = errText(e);
        }
        report.services.push(svc);
      }

      lastDebugReport = report;
      renderDebugReport(report);
      setStatus("connected", `Debug · ${report.name}`);
      showToast(
        `Debug OK · ${report.services.length} servizio/i`,
        report.services.length ? "success" : ""
      );
    } catch (err) {
      console.error("Errore debug:", err);
      setStatus("error", "Debug fallito");
      let msg;
      if (err && err.name === "NotFoundError") msg = "Nessun dispositivo selezionato";
      else if (err && err.message) msg = err.message;
      else msg = "Errore debug";
      showToast(msg, "error");
    }
  }

  function renderDebugReport(report) {
    const lines = [];

    lines.push(`<div class="row"><strong>Nome:</strong> ${escHtml(report.name)}</div>`);
    lines.push(`<div class="row"><strong>ID:</strong> ${escHtml(report.id)}</div>`);
    lines.push(
      `<div class="row"><strong>Paired:</strong> ${report.paired ? "sì" : "no"}` +
        ` · <strong>GATT:</strong> ${report.gattConnected ? "ok" : "—"}</div>`
    );

    if (report.servicesError) {
      lines.push(`<div class="row err">Servizi: ${escHtml(report.servicesError)}</div>`);
    }

    if (!report.services.length) {
      lines.push(
        `<div class="row err" style="margin-top:10px;">⚠ Nessun servizio esposto dal browser.</div>`
      );
      lines.push(
        `<div class="row" style="color:var(--muted);">` +
          `Connesso a <em>${escHtml(report.name)}</em>, ma il browser ha nascosto i servizi perché` +
          ` usano UUID proprietari non dichiarati nella lista <code>optionalServices</code>.` +
          ` Per vedere il profilo GATT completo usa <strong>nRF Connect</strong>.` +
          `</div>`
      );
    } else {
      lines.push(
        `<div class="row" style="margin-top:10px;">` +
          `<strong>Servizi esposti (${report.services.length}):</strong></div>`
      );
      for (const svc of report.services) {
        lines.push(`<div class="svc">▸ Service ${escHtml(svc.uuid)}</div>`);
        if (svc.error) {
          lines.push(`<div class="l err">errore: ${escHtml(svc.error)}</div>`);
          continue;
        }
        if (!svc.characteristics.length) {
          lines.push(`<div class="l">(nessuna caratteristica)</div>`);
          continue;
        }
        for (const c of svc.characteristics) {
          lines.push(`<div class="ch">· Char ${escHtml(c.uuid)}</div>`);
          lines.push(`<div class="l">props: ${escHtml(prettyProps(c))}</div>`);
          if ("valueHex" in c) {
            lines.push(`<div class="l ok">value (hex): ${escHtml(c.valueHex)}</div>`);
            if (
              "valueText" in c &&
              c.valueText &&
              /^[\x09\x0A\x0D\x20-\x7E]*$/.test(c.valueText)
            ) {
              lines.push(
                `<div class="l">value (txt): <em>${escHtml(c.valueText)}</em></div>`
              );
            }
          }
          if (c.readError) {
            lines.push(`<div class="l err">read err: ${escHtml(c.readError)}</div>`);
          }
        }
      }
    }

    debugEls.result.innerHTML = lines.join("");
    debugEls.result.hidden = false;
    debugEls.actions.hidden = false;
  }

  debugEls.btn?.addEventListener("click", debugConnect);
  debugEls.copyBtn?.addEventListener("click", async () => {
    if (!lastDebugReport) return;
    const json = JSON.stringify(lastDebugReport, null, 2);
    let copied = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(json);
        copied = true;
      }
    } catch (_) { }
    if (copied) {
      showToast("JSON copiato negli appunti", "success");
    } else if (navigator.share) {
      try {
        await navigator.share({ text: json });
      } catch (_) {
        showToast("Copia fallita, riprova", "error");
      }
    } else {
      showToast("Copia non supportata qui, apri il debug sul telefono", "error");
    }
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("sw.js")
        .catch((err) => console.warn("SW registration failed:", err));
    });
  }
})();
