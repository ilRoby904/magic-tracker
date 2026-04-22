// ─── Storage keys ───────────────────────────────────────────────
const K = {
  cards:   "mtg_cards",
  history: "mtg_history",
  notifs:  "mtg_notifs",
  thresh:  "mtg_threshold",
  currency:"mtg_currency",
};

// ─── State ──────────────────────────────────────────────────────
let state = {
  cards:      [],
  history:    {},
  notifs:     [],
  thresh:     10,
  currency:   "USD",
  eurRate:    1,
  loading:    false,
  selectedId: null,
  errors:     [],
};

// ─── Persist ────────────────────────────────────────────────────
const load = () => {
  try {
    state.cards    = JSON.parse(localStorage.getItem(K.cards))    || [];
    state.history  = JSON.parse(localStorage.getItem(K.history))  || {};
    state.notifs   = JSON.parse(localStorage.getItem(K.notifs))   || [];
    state.thresh   = parseFloat(localStorage.getItem(K.thresh))   || 10;
    state.currency = localStorage.getItem(K.currency)             || "USD";
  } catch(e) {}
};
const persist = () => {
  localStorage.setItem(K.cards,    JSON.stringify(state.cards));
  localStorage.setItem(K.history,  JSON.stringify(state.history));
  localStorage.setItem(K.notifs,   JSON.stringify(state.notifs));
  localStorage.setItem(K.thresh,   state.thresh);
  localStorage.setItem(K.currency, state.currency);
};

// ─── EUR rate ────────────────────────────────────────────────────
async function fetchEurRate() {
  try {
    const r = await fetch("https://api.frankfurter.app/latest?from=USD&to=EUR");
    const d = await r.json();
    state.eurRate = d.rates?.EUR || 0.92;
  } catch(e) {
    state.eurRate = 0.92;
  }
}

const toDisplay = (usd) => {
  if (state.currency === "EUR") return `€${(usd * state.eurRate).toFixed(2)}`;
  return `$${usd.toFixed(2)}`;
};

// ─── Scryfall ───────────────────────────────────────────────────
const today = () => new Date().toISOString().split("T")[0];

async function fetchCardExact(name, set) {
  try {
    const q = set ? `!"${name}" e:${set}` : `!"${name}"`;
    const r = await fetch(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&order=usd`);
    const d = await r.json();
    if (!d.data?.length) return null;
    return mapScryfall(d.data[0]);
  } catch(e) { return null; }
}

async function fetchCardFuzzy(name) {
  try {
    const r = await fetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`);
    if (!r.ok) return null;
    const d = await r.json();
    return mapScryfall(d);
  } catch(e) { return null; }
}

function mapScryfall(c) {
  return {
    id:   c.id,
    name: c.name,
    set:  c.set_name,
    code: c.set,
    img:  c.image_uris?.normal || c.card_faces?.[0]?.image_uris?.normal || "",
    usd:  parseFloat(c.prices?.usd)      || 0,
    foil: parseFloat(c.prices?.usd_foil) || 0,
  };
}

async function fetchCard(name, set) {
  // 1. Ricerca esatta
  let info = await fetchCardExact(name, set);
  if (info) return { ...info, matchType: "exact" };
  await sleep(100);
  // 2. Ricerca esatta senza edizione
  if (set) {
    info = await fetchCardExact(name, "");
    if (info) return { ...info, matchType: "no-set" };
    await sleep(100);
  }
  // 3. Ricerca fuzzy
  info = await fetchCardFuzzy(name);
  if (info) return { ...info, matchType: "fuzzy" };
  return null;
}

// ─── CSV Parsers ─────────────────────────────────────────────────

// Rileva se è un CSV Moxfield analizzando l'header
function detectFormat(txt) {
  const firstLine = txt.trim().split("\n")[0].toLowerCase();
  if (firstLine.includes("count") && firstLine.includes("name") && firstLine.includes("edition")) return "moxfield";
  if (firstLine.includes("quantity") && firstLine.includes("name")) return "moxfield-alt";
  return "simple";
}

function parseSimpleCSV(txt) {
  return txt.trim().split("\n")
    .filter(l => l.trim() && !l.startsWith("#"))
    .map(l => {
      const parts = splitCSVLine(l);
      return { qty: parseInt(parts[0]) || 1, name: parts[1]?.trim(), set: parts[2]?.trim() || "" };
    })
    .filter(c => c.name);
}

function parseMoxfieldCSV(txt) {
  const lines = txt.trim().split("\n");
  const header = lines[0].split(",").map(h => h.replace(/"/g,"").trim().toLowerCase());
  const idx = {
    qty:  header.findIndex(h => ["count","quantity","qty"].includes(h)),
    name: header.findIndex(h => h === "name"),
    set:  header.findIndex(h => ["edition","set","set code","setcode"].includes(h)),
    foil: header.findIndex(h => h === "foil"),
  };
  return lines.slice(1)
    .filter(l => l.trim())
    .map(l => {
      const parts = splitCSVLine(l);
      return {
        name: parts[idx.name]?.replace(/"/g,"").trim() || "",
        qty:  parseInt(parts[idx.qty]) || 1,
        set:  idx.set >= 0 ? parts[idx.set]?.replace(/"/g,"").trim() : "",
        foil: idx.foil >= 0 ? parts[idx.foil]?.toLowerCase().includes("true") : false,
      };
    })
    .filter(c => c.name);
}

// Gestisce virgole dentro le virgolette
function splitCSVLine(line) {
  const res = [];
  let cur = "", inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === "," && !inQ) { res.push(cur); cur = ""; continue; }
    cur += ch;
  }
  res.push(cur);
  return res;
}

function parseAnyCSV(txt) {
  const fmt = detectFormat(txt);
  if (fmt === "moxfield" || fmt === "moxfield-alt") return { cards: parseMoxfieldCSV(txt), fmt };
  return { cards: parseSimpleCSV(txt), fmt };
}

// ─── Helpers ────────────────────────────────────────────────────
const totalValue = () => state.cards.reduce((s, c) => s + c.usd * c.qty, 0);
const unreadCount = () => state.notifs.filter(n => !n.read).length;
const cardHistory = id => state.history[id] || [];

function addPricePoint(id, price) {
  if (!state.history[id]) state.history[id] = [];
  const hist = state.history[id];
  const last = hist.slice(-1)[0];
  if (last?.date === today()) { last.price = price; return; }
  if (last && last.price > 0 && price > 0) {
    const pct = ((price - last.price) / last.price) * 100;
    if (Math.abs(pct) >= state.thresh) {
      const cardName = state.cards.find(c => c.id === id)?.name || id;
      state.notifs.unshift({
        id: Date.now() + Math.random(),
        text: `${cardName}: ${pct > 0 ? "▲" : "▼"} ${Math.abs(pct).toFixed(1)}% → ${toDisplay(price)}`,
        date: today(),
        read: false,
      });
      state.notifs = state.notifs.slice(0, 50);
    }
  }
  hist.push({ date: today(), price });
}

// ─── SVG Sparkline ──────────────────────────────────────────────
function sparkline(hist, w=110, h=36) {
  if (hist.length < 2) return `<span class="hint">–</span>`;
  const prices = hist.map(h => h.price);
  const mn = Math.min(...prices), mx = Math.max(...prices), rng = mx - mn || 1;
  const pts = prices.map((p, i) =>
    `${(i/(prices.length-1))*w},${h - ((p-mn)/rng)*h}`
  ).join(" ");
  const color = prices.at(-1) >= prices[0] ? "#22c55e" : "#ef4444";
  return `<svg class="sparkline" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/>
  </svg>`;
}

// ─── Render ──────────────────────────────────────────────────────

function renderHeader() {
  document.getElementById("header-sub").textContent =
    `${state.cards.length} carte · Valore: ${toDisplay(totalValue())}`;
}

function renderTabs() {
  const uc = unreadCount();
  document.querySelector('[data-tab="notifications"]').textContent =
    `🔔 Avvisi${uc ? ` (${uc})` : ""}`;
}

function renderDashboard() {
  const top5 = [...state.cards].sort((a,b) => b.usd*b.qty - a.usd*a.qty).slice(0,5);
  const maxUsd = state.cards.length ? Math.max(...state.cards.map(c => c.usd)) : 0;

  document.getElementById("stats-grid").innerHTML = [
    { l:"Carte uniche",  v: state.cards.length,                              col:"#60a5fa" },
    { l:"Copie totali",  v: state.cards.reduce((s,c) => s+c.qty, 0),         col:"#a78bfa" },
    { l:"Valore totale", v: toDisplay(totalValue()),                          col:"#22c55e" },
    { l:"Carta più cara",v: state.cards.length ? toDisplay(maxUsd) : "–",    col:"#f59e0b" },
  ].map(s => `
    <div class="stat-card">
      <div class="stat-label">${s.l}</div>
      <div class="stat-value" style="color:${s.col}">${s.v}</div>
    </div>`).join("");

  const ranks = ["#f59e0b","#94a3b8","#cd7c3a","#60a5fa","#a78bfa"];
  document.getElementById("top-cards").innerHTML = top5.length
    ? top5.map((c, i) => `
        <div class="card card-row" style="cursor:pointer" onclick="goCollection('${c.id}')">
          <div class="rank-badge" style="color:${ranks[i]}">&#35;${i+1}</div>
          ${c.img ? `<img class="card-thumb" src="${c.img}" alt="${c.name}">` : ""}
          <div class="card-info">
            <div class="card-name">${c.name}</div>
            <div class="card-set">${c.set} · x${c.qty}</div>
          </div>
          <div class="card-price">
            <div class="card-total">${toDisplay(c.usd * c.qty)}</div>
            <div class="card-unit">${toDisplay(c.usd)}/cad.</div>
          </div>
          ${sparkline(cardHistory(c.id))}
        </div>`).join("")
    : `<div class="empty-state">Nessuna carta.<br>Vai su <b>Importa</b> per iniziare!</div>`;
}

function renderCollection() {
  const sorted = [...state.cards].sort((a,b) => b.usd - a.usd);
  document.getElementById("collection-list").innerHTML = sorted.length
    ? sorted.map(c => {
        const sel = state.selectedId === c.id;
        const hist = cardHistory(c.id);
        const cmUrl = `https://www.cardmarket.com/it/Magic/Products/Search?searchString=${encodeURIComponent(c.name)}`;
        const mxUrl = `https://www.moxfield.com/cards/${encodeURIComponent(c.name)}`;
        return `
          <div class="card ${sel ? "selected" : ""}" onclick="toggleCard('${c.id}')">
            <div class="card-row">
              ${c.img ? `<img class="card-thumb" src="${c.img}" alt="${c.name}">` : ""}
              <div class="card-info">
                <div class="card-name">${c.name}</div>
                <div class="card-set">${c.set} · x${c.qty}</div>
              </div>
              <div class="card-price">
                <div class="card-total">${toDisplay(c.usd * c.qty)}</div>
                <div class="card-unit">${toDisplay(c.usd)}/cad.</div>
              </div>
            </div>
            ${sel ? `
              <div class="card-history">
                📈 Storico prezzi (${hist.length} rilevazioni)
                ${hist.length > 1 ? `
                  ${sparkline(hist, 260, 50)}
                  <div class="history-points">
                    ${hist.slice(-6).map(h => `
                      <div class="history-point">${h.date}: <span>${toDisplay(h.price)}</span></div>
                    `).join("")}
                  </div>` : "<p>Torna domani per vedere le variazioni!</p>"}
                <div style="display:flex;gap:12px;margin-top:8px;flex-wrap:wrap">
                  <a class="cardmarket-link" href="${cmUrl}" target="_blank">🛒 CardMarket →</a>
                  <a class="cardmarket-link" href="${mxUrl}" target="_blank">📋 Moxfield →</a>
                </div>
              </div>` : ""}
          </div>`;
      }).join("")
    : `<div class="empty-state">Nessuna carta. Importa un CSV!</div>`;
}

function renderNotifications() {
  document.getElementById("notifications-list").innerHTML = state.notifs.length
    ? state.notifs.map(n => `
        <div class="notif-item ${n.read ? "" : "unread"}">
          <span class="notif-text">${n.text}</span>
          <span class="notif-date">${n.date}</span>
        </div>`).join("")
    : `<div class="empty-state">Nessun avviso ancora.<br>Gli avvisi appaiono quando un prezzo varia più del ${state.thresh}%.</div>`;
}

function renderSettings() {
  document.getElementById("threshold-slider").value   = state.thresh;
  document.getElementById("threshold-val").textContent  = `${state.thresh}%`;
  document.getElementById("threshold-hint").textContent = state.thresh;
  document.getElementById("currency-select").value    = state.currency;
  const total = Object.values(state.history).reduce((s,h) => s+h.length, 0);
  document.getElementById("info-text").textContent =
    `Carte: ${state.cards.length} · Rilevazioni: ${total} · Tasso EUR: ${state.eurRate.toFixed(4)}`;
}

function renderErrors() {
  const el = document.getElementById("error-list");
  if (!el) return;
  el.innerHTML = state.errors.length
    ? `<div class="info-box" style="border-left:3px solid #f87171;margin-top:12px">
        <b style="color:#f87171">⚠️ Carte non trovate (${state.errors.length}):</b><br/>
        ${state.errors.map(e => `<span style="color:#94a3b8">${e}</span>`).join("<br/>")}
       </div>`
    : "";
}

function renderAll() {
  renderHeader();
  renderTabs();
  renderDashboard();
  renderCollection();
  renderNotifications();
  renderSettings();
  renderErrors();
}

// ─── Import ──────────────────────────────────────────────────────

async function importCards() {
  const txt = document.getElementById("csv-input").value;
  if (!txt.trim()) { showMsg("⚠️ Incolla il contenuto CSV.", false); return; }

  const { cards: parsed, fmt } = parseAnyCSV(txt);
  if (!parsed.length) { showMsg("⚠️ Nessuna carta valida trovata.", false); return; }

  showMsg(`📄 Formato rilevato: ${fmt === "moxfield" || fmt === "moxfield-alt" ? "Moxfield CSV" : "CSV semplice"} · ${parsed.length} righe`, true);
  setLoading(true, parsed.length);
  state.errors = [];

  const newCards = [];
  for (let i = 0; i < parsed.length; i++) {
    updateProgress(i+1, parsed.length);
    const { name, qty, set } = parsed[i];
    const info = await fetchCard(name, set);
    await sleep(150);
    if (info) {
      const ex = state.cards.find(c => c.id === info.id);
      newCards.push({ ...info, qty: ex ? ex.qty + qty : qty });
      addPricePoint(info.id, info.usd);
      if (info.matchType === "fuzzy") {
        // Segnala che il nome è stato trovato approssimativamente
        state.errors.push(`"${name}" → trovata come "${info.name}" (fuzzy)`);
      }
    } else {
      state.errors.push(`"${name}" — non trovata`);
    }
  }

  const importedIds = newCards.map(c => c.id);
  state.cards = [...state.cards.filter(c => !importedIds.includes(c.id)), ...newCards];
  persist();
  setLoading(false);

  const notFound = state.errors.filter(e => e.includes("non trovata")).length;
  const fuzzy    = state.errors.filter(e => e.includes("fuzzy")).length;
  showMsg(
    `✅ ${newCards.length} carte importate` +
    (fuzzy    ? ` · ⚠️ ${fuzzy} trovate approssimativamente` : "") +
    (notFound ? ` · ❌ ${notFound} non trovate` : ""),
    true
  );
  renderAll();
  if (newCards.length > 0) setTimeout(() => switchTab("dashboard"), 1500);
}

// ─── Refresh prices ──────────────────────────────────────────────

async function refreshPrices() {
  if (!state.cards.length) return;
  setLoading(true, state.cards.length);
  await fetchEurRate();
  const updated = [];

  for (let i = 0; i < state.cards.length; i++) {
    updateProgress(i+1, state.cards.length);
    const card = state.cards[i];
    const info = await fetchCard(card.name, card.code);
    await sleep(150);
    if (info) {
      addPricePoint(info.id, info.usd);
      updated.push({ ...card, usd: info.usd, img: info.img });
    } else {
      updated.push(card);
    }
  }

  state.cards = updated;
  persist();
  setLoading(false);
  showNotifBanner();
  renderAll();
}

// ─── UI helpers ──────────────────────────────────────────────────

window.toggleCard  = id => { state.selectedId = state.selectedId === id ? null : id; renderCollection(); };
window.goCollection = id => { state.selectedId = id; switchTab("collection"); };

const sleep = ms => new Promise(r => setTimeout(r, ms));

function setLoading(on, total=0) {
  state.loading = on;
  document.getElementById("import-btn").disabled  = on;
  document.getElementById("refresh-btn").disabled = on;
  const prog = document.getElementById("import-progress");
  if (on) { prog.classList.remove("hidden"); updateProgress(0, total); }
  else    { prog.classList.add("hidden");    updateProgress(0, 0); }
}

function updateProgress(cur, tot) {
  document.getElementById("progress-label").textContent  = `${cur}/${tot}`;
  document.getElementById("progress-fill").style.width   = tot ? `${(cur/tot)*100}%` : "0%";
}

function showMsg(txt, ok) {
  const el = document.getElementById("import-msg");
  el.textContent = txt;
  el.className   = ok ? "msg-ok" : "msg-err";
}

function showNotifBanner() {
  const uc = unreadCount();
  const banner = document.getElementById("notif-banner");
  if (uc > 0) {
    banner.textContent = `🔔 ${uc} nuov${uc===1?"o":"i"} avvis${uc===1?"o":"i"} di prezzo!`;
    banner.classList.remove("hidden");
    setTimeout(() => banner.classList.add("hidden"), 5000);
  }
}

function switchTab(id) {
  document.querySelectorAll(".tab").forEach(t  => t.classList.toggle("active",  t.dataset.tab === id));
  document.querySelectorAll(".page").forEach(p => p.classList.toggle("active", p.id === `tab-${id}`));
  if (id === "notifications") {
    state.notifs = state.notifs.map(n => ({ ...n, read: true }));
    persist();
    renderTabs();
  }
}

// ─── Event listeners ────────────────────────────────────────────

document.querySelectorAll(".tab").forEach(btn =>
  btn.addEventListener("click", () => switchTab(btn.dataset.tab))
);

document.getElementById("refresh-btn").addEventListener("click", refreshPrices);
document.getElementById("import-btn").addEventListener("click", importCards);

document.getElementById("mark-read-btn").addEventListener("click", () => {
  state.notifs = state.notifs.map(n => ({ ...n, read: true }));
  persist(); renderAll();
});

document.getElementById("threshold-slider").addEventListener("input", e => {
  state.thresh = parseFloat(e.target.value);
  localStorage.setItem(K.thresh, state.thresh);
  document.getElementById("threshold-val").textContent  = `${state.thresh}%`;
  document.getElementById("threshold-hint").textContent = state.thresh;
});

document.getElementById("currency-select").addEventListener("change", async e => {
  state.currency = e.target.value;
  localStorage.setItem(K.currency, state.currency);
  if (state.currency === "EUR" && state.eurRate === 1) await fetchEurRate();
  renderAll();
});

document.getElementById("clear-btn").addEventListener("click", () => {
  if (!confirm("Vuoi davvero cancellare tutta la collezione?")) return;
  state.cards = []; state.history = {}; state.notifs = []; state.errors = [];
  persist(); renderAll();
});

// ─── Service Worker ──────────────────────────────────────────────
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// ─── Boot ────────────────────────────────────────────────────────
load();
fetchEurRate().then(renderAll);