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

  const KNOWN_PROFILES = [
    {
      name: "Gen2 (Nordic UART)",
      service: "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
      write:   "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
      notify:  "6e400003-b5a3-f393-e0a9-e50e24dcca9e",
    },
    {
      name: "Gen1 (Legacy)",
      service: "0000fff0-0000-1000-8000-00805f9b34fb",
      write:   "0000fff2-0000-1000-8000-00805f9b34fb",
      notify:  "0000fff1-0000-1000-8000-00805f9b34fb",
    },
  ];

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
        optionalServices: KNOWN_PROFILES.map((p) => lower(p.service)),
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

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("sw.js")
        .catch((err) => console.warn("SW registration failed:", err));
    });
  }
})();
