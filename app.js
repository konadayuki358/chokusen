"use strict";

// 直線距離ログ。: external requests and location-history logging are deliberately absent.
// During a measurement only, start coordinates are stored locally to survive power-off.
(() => {
  const STORAGE_KEY = "chokusen-kyori-log-state-v1";
  const EARTH_RADIUS_METERS = 6371008.8;
  const MINIMUM_RECORD_DISTANCE_METERS = 10;
  const GEO_OPTIONS = { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 };
  const CODE_PREFIX = "CDL1";

  const el = (id) => document.getElementById(id);
  const startButton = el("start-button");
  const endButton = el("end-button");
  const settingsButton = el("settings-open");
  const overlay = el("settings-overlay");
  const dialog = overlay.querySelector(".settings-dialog");
  const exportCode = el("export-code");
  const importCode = el("import-code");
  const copyButton = el("copy-button");
  const transferMessage = el("transfer-message");
  const statusMessage = el("status-message");

  let state;
  let busy = false;
  let storageBroken = false;
  let returnFocusTo = null;
  // Display-only choice: never rounds or changes the values saved in meters.
  let distanceUnit = "m";

  function isDate(s) {
    return typeof s === "string" && /^\d{4}-\d{2}-\d{2}T/.test(s) && Number.isFinite(Date.parse(s));
  }
  function isCoordinate(v, min, max) {
    return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
  }
  function isRecord(r) {
    return r && typeof r === "object" && isDate(r.startAt) && isDate(r.endAt) &&
      Number.isFinite(r.meters) && r.meters > MINIMUM_RECORD_DISTANCE_METERS && r.meters < 50000000;
  }
  function isPending(p) {
    return p === null || (p && typeof p === "object" && isDate(p.startAt) &&
      isCoordinate(p.latitude, -90, 90) && isCoordinate(p.longitude, -180, 180));
  }
  function validState(s) {
    return s && s.version === 1 && Number.isFinite(s.totalMeters) && s.totalMeters >= 0 &&
      Array.isArray(s.records) && s.records.length <= 10 && s.records.every(isRecord) &&
      isPending(s.pending) && s.totalMeters + .000001 >= s.records.reduce((n, r) => n + r.meters, 0);
  }
  function initialState() {
    return { version: 1, totalMeters: 0, records: [], pending: null };
  }
  function loadState() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return initialState();
    const parsed = JSON.parse(raw);
    if (!validState(parsed)) throw new Error("保存されたデータの形式を確認できませんでした。");
    return parsed;
  }
  function commit(next) {
    if (!validState(next)) throw new Error("保存するデータが正しくありません。");
    // Single-key replacement: no intermediate state where records and total diverge.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    state = next;
    render();
  }
  function formatDistance(meters) {
    if (distanceUnit === "m") return `${Math.round(meters).toLocaleString("ja-JP")} m`;
    return `${(meters / 1000).toLocaleString("ja-JP", { maximumFractionDigits: 3 })} km`;
  }
  function toggleDistanceUnit() {
    distanceUnit = distanceUnit === "m" ? "km" : "m";
    render();
  }
  function dateTime(s) {
    return new Date(s).toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  }
  function shortTime(s) {
    return new Date(s).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  function announce(message, type = "neutral") {
    statusMessage.hidden = !message;
    statusMessage.textContent = message;
    statusMessage.className = `status-message ${type}`;
  }
  function transferNotice(message, error = false) {
    transferMessage.hidden = !message;
    transferMessage.textContent = message;
    transferMessage.className = `transfer-message${error ? " error" : ""}`;
  }
  function render() {
    const totalDistance = el("total-distance");
    totalDistance.textContent = formatDistance(state.totalMeters);
    totalDistance.setAttribute("aria-label", `累計直線距離 ${formatDistance(state.totalMeters)}。タップして${distanceUnit === "m" ? "km" : "m"}表示に切り替え`);
    const pending = !!state.pending;
    el("measurement-state").classList.toggle("active", pending);
    el("measurement-state-text").textContent = pending ? "開始地点を記録済みです" : "開始地点は未記録です";
    startButton.disabled = pending || busy || storageBroken;
    endButton.disabled = !pending || busy || storageBroken;
    settingsButton.disabled = busy;
    startButton.textContent = busy && !pending ? "位置情報を取得しています…" : "開始地点を記録";
    endButton.textContent = busy && pending ? "位置情報を取得しています…" : "終了地点を記録";
    const list = el("history-list");
    list.replaceChildren();
    el("history-empty").hidden = state.records.length > 0;
    list.hidden = state.records.length === 0;
    for (const rec of state.records) {
      const li = document.createElement("li");
      li.className = "history-item";
      const head = document.createElement("div");
      head.className = "history-item-head";
      const date = document.createElement("span");
      date.className = "history-item-date";
      date.textContent = new Date(rec.endAt).toLocaleDateString("ja-JP");
      const distance = document.createElement("button");
      distance.type = "button";
      distance.className = "history-item-distance";
      distance.textContent = formatDistance(rec.meters);
      distance.setAttribute("aria-label", `直線距離 ${formatDistance(rec.meters)}。タップして${distanceUnit === "m" ? "km" : "m"}表示に切り替え`);
      head.append(date, distance);
      const period = document.createElement("div");
      period.className = "history-item-period";
      period.textContent = `開始：${dateTime(rec.startAt)}  ／  終了：${dateTime(rec.endAt)}`;
      li.append(head, period);
      list.append(li);
    }
  }
  function getCurrentPosition() {
    return new Promise((resolve, reject) => {
      if (!window.isSecureContext || !navigator.geolocation) {
        reject(new Error("位置情報を利用できません。HTTPSの公開URLから開き、ブラウザの位置情報設定を確認してください。"));
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, reject, GEO_OPTIONS);
    });
  }
  function positionErrorMessage(err) {
    if (err && err.code === 1) return "位置情報へのアクセスが許可されていません。Chromeと端末の位置情報設定で許可してください。";
    if (err && err.code === 2) return "現在地を取得できませんでした。位置情報をオンにして、受信しやすい場所で再度お試しください。";
    if (err && err.code === 3) return "位置情報の取得が時間切れになりました。場所を変えるなどして、もう一度お試しください。";
    return (err && err.message) || "処理に失敗しました。もう一度お試しください。";
  }
  function haversine(a, b) {
    const rad = (n) => n * Math.PI / 180;
    const dLat = rad(b.latitude - a.latitude);
    const dLon = rad(b.longitude - a.longitude);
    const lat1 = rad(a.latitude);
    const lat2 = rad(b.latitude);
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(Math.min(1, Math.max(0, x))));
  }
  async function measure(kind) {
    if (busy || storageBroken) return;
    if (kind === "start" && state.pending) return;
    if (kind === "end" && !state.pending) return;
    busy = true;
    render();
    announce("現在地を取得しています。しばらくお待ちください。");
    try {
      const pos = await getCurrentPosition();
      const latitude = pos.coords.latitude;
      const longitude = pos.coords.longitude;
      if (!isCoordinate(latitude, -90, 90) || !isCoordinate(longitude, -180, 180)) {
        throw new Error("正しい位置情報を取得できませんでした。もう一度お試しください。");
      }
      // The acquisition moment, not the button-press moment, is recorded.
      const acquiredAt = new Date(pos.timestamp || Date.now()).toISOString();
      if (kind === "start") {
        commit({ ...state, pending: { latitude, longitude, startAt: acquiredAt } });
        announce("開始地点を記録しました。移動後に「終了地点を記録」を押してください。", "success");
      } else {
        const meters = haversine(state.pending, { latitude, longitude });
        if (meters <= MINIMUM_RECORD_DISTANCE_METERS) {
          commit({ ...state, pending: null });
          announce("直線距離が10m以下のため、記録しませんでした。", "neutral");
        } else {
          const record = { startAt: state.pending.startAt, endAt: acquiredAt, meters };
          commit({ version: 1, totalMeters: state.totalMeters + meters, records: [record, ...state.records].slice(0, 10), pending: null });
          // No separate result page; total and latest record update in place.
          announce("計測を記録しました。累計直線距離を更新しました。", "success");
        }
      }
    } catch (err) {
      // On end-point failure, the start point remains saved for retry.
      announce(positionErrorMessage(err), "error");
    } finally {
      busy = false;
      render();
    }
  }

  // Lightweight corruption detection only; not encryption or anti-tampering.
  function checksum(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; ++i) {
      h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }
  function makeCode() {
    const data = JSON.stringify({ version: 1, totalMeters: state.totalMeters, records: state.records });
    const encoded = btoa(data).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    return `${CODE_PREFIX}.${encoded}.${checksum(data)}`;
  }
  function parseCode(code) {
    const cleaned = code.trim().replace(/\s+/g, "");
    if (cleaned.length > 16000) throw new Error("コードが長すぎます。正しいコードを貼り付けてください。");
    const m = /^CDL1\.([A-Za-z0-9_-]+)\.([a-f0-9]{8})$/.exec(cleaned);
    if (!m) throw new Error("引き継ぎコードの形式が正しくありません。");
    const base64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    if (checksum(decoded) !== m[2]) throw new Error("コードが壊れているか、途中で欠けています。");
    const data = JSON.parse(decoded);
    const next = { version: 1, totalMeters: data.totalMeters, records: data.records, pending: null };
    if (data.version !== 1 || !validState(next)) throw new Error("引き継ぎデータが正しくありません。");
    return next;
  }
  function openSettings() {
    returnFocusTo = document.activeElement;
    overlay.hidden = false;
    document.body.style.overflow = "hidden";
    el("settings-close").focus();
  }
  function closeSettings() {
    overlay.hidden = true;
    document.body.style.overflow = "";
    if (returnFocusTo && returnFocusTo.focus) returnFocusTo.focus();
  }
  el("total-distance").addEventListener("click", toggleDistanceUnit);
  el("history-list").addEventListener("click", (event) => {
    if (event.target.closest(".history-item-distance")) toggleDistanceUnit();
  });
  startButton.addEventListener("click", () => measure("start"));
  endButton.addEventListener("click", () => measure("end"));
  settingsButton.addEventListener("click", openSettings);
  el("settings-close").addEventListener("click", closeSettings);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) closeSettings(); });
  document.addEventListener("keydown", (event) => {
    if (overlay.hidden) return;
    if (event.key === "Escape") { closeSettings(); return; }
    if (event.key === "Tab") {
      const focusable = [...dialog.querySelectorAll('button:not(:disabled), summary, textarea:not(:disabled)')].filter((node) => node.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  el("export-button").addEventListener("click", () => {
    exportCode.value = makeCode();
    copyButton.disabled = false;
    transferNotice("コードを発行しました。コピーして新しい端末へ移してください。");
  });
  copyButton.addEventListener("click", async () => {
    if (!exportCode.value) return;
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(exportCode.value);
      transferNotice("コードをコピーしました。");
    } catch (_) {
      exportCode.focus(); exportCode.select();
      transferNotice("自動コピーできませんでした。選択されたコードを長押ししてコピーしてください。", true);
    }
  });
  el("import-button").addEventListener("click", () => {
    if (busy) return;
    try {
      const next = parseCode(importCode.value);
      if (!window.confirm("この端末の累計距離・過去の記録を引き継ぎデータで上書きします。計測中の開始地点も消去されます。よろしいですか？")) return;
      commit(next);
      exportCode.value = "";
      copyButton.disabled = true;
      importCode.value = "";
      transferNotice("データを復元しました。");
      announce("引き継いだデータを表示しています。", "success");
    } catch (err) {
      transferNotice(err.message || "コードを読み取れませんでした。", true);
    }
  });

  try {
    state = loadState();
  } catch (_) {
    state = initialState();
    storageBroken = true;
  }
  render();
  if (storageBroken) {
    announce("保存データを読み取れませんでした。既存データを保護するため計測を停止しています。Chromeのサイトデータや保存設定をご確認ください。", "error");
  } else if (state.pending) {
    announce("開始地点が保存されています。移動後に「終了地点を記録」を押してください。", "neutral");
  }
  if ("serviceWorker" in navigator && window.isSecureContext) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {
        // Online usage remains available even if offline setup fails.
      });
    });
  }
})();
