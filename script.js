/* ==========================================================
   SPEEDTEST CONFIGURATION
   ========================================================== */
const SPEEDTEST_CONFIG = {
  testDuration: 8000,       // durasi download test (ms); upload = 3/4 nilai ini
  pingCount: 5,             // jumlah ping untuk ping/jitter
  concurrentDownloads: 4,
  concurrentUploads: 2,
  uploadChunkBytes: 1024 * 1024,   // 1 MB per request upload
  downloadBytes: 25 * 1000 * 1000  // 25 MB per request download
};

/* ==========================================================
   SPEEDTEST SERVER CONFIGURATION
   Tambahkan server Anda di sini. Sistem akan ping semua server
   yang punya pingUrl lalu memilih latency terendah.

   Syarat endpoint (wajib kirim header CORS):
   - pingUrl     : GET, respons kecil
   - downloadUrl : GET, menerima ?bytes=JUMLAH dan mengirim data sebesar itu
   - uploadUrl   : POST, menerima body bebas

   Selama semua URL KOSONG, website memakai endpoint publik
   Cloudflare sebagai mode demo (lihat DEMO_ENDPOINTS). Nama server
   di bawah tetap tampil, tapi pengukuran sebenarnya ke Cloudflare.
   ========================================================== */
const SPEEDTEST_SERVERS = [
  {
    name: "Putra Tunggal.net",
    location: "Banjarnegara, Jawa Tengah",
    pingUrl: "",
    downloadUrl: "",
    uploadUrl: ""
  },
  {
    name: "NGETIK.ID Server",
    location: "Jakarta",
    pingUrl: "",
    downloadUrl: "",
    uploadUrl: ""
  }
];

const DEMO_ENDPOINTS = {
  pingUrl: "https://speed.cloudflare.com/__down?bytes=0",
  downloadUrl: "https://speed.cloudflare.com/__down",
  uploadUrl: "https://speed.cloudflare.com/__up",
  metaUrl: "https://speed.cloudflare.com/meta"
};

/* ========================================================== */
const $ = (id) => document.getElementById(id);
const LAST_KEY = "ngetik_last_test";
let activeServer = null;   // server terpilih (dengan endpoint final)
let demoMode = false;
let running = false;

const bust = (u) => u + (u.includes("?") ? "&" : "?") + "t=" + Date.now() + Math.random();
const hasEndpoints = (s) => s.pingUrl && s.downloadUrl && s.uploadUrl;

/* ----- Gauge ----- */
function setGauge(mbps) {
  const pct = Math.min(1, Math.log10(1 + mbps) / Math.log10(1001)); // skala log 0-1000 Mbps
  $("gaugeFill").style.strokeDasharray = `${pct * 75} 100`;
  $("speedValue").textContent = mbps.toFixed(2);
}

/* ----- Ping & jitter ----- */
async function measurePing(url, count) {
  const times = [];
  for (let i = 0; i < count; i++) {
    const t0 = performance.now();
    await fetch(bust(url), { cache: "no-store" });
    times.push(performance.now() - t0);
  }
  return times;
}
function pingStats(times) {
  const t = times.length > 2 ? times.slice(1) : times; // buang request pertama (DNS/TLS)
  const ping = Math.min(...t);
  let jitter = 0;
  for (let i = 1; i < t.length; i++) jitter += Math.abs(t[i] - t[i - 1]);
  return { ping, jitter: t.length > 1 ? jitter / (t.length - 1) : 0 };
}

/* ----- Pemilihan server otomatis ----- */
async function findFastestServer() {
  setStatus("Finding fastest server...", "");
  let candidates = SPEEDTEST_SERVERS.filter(hasEndpoints);
  demoMode = candidates.length === 0;
  if (demoMode) {
    // Mode demo: pakai server pertama sebagai label, endpoint Cloudflare
    candidates = [{ ...SPEEDTEST_SERVERS[0], ...DEMO_ENDPOINTS }];
  }
  const results = [];
  for (const s of candidates) {
    try {
      const times = await measurePing(s.pingUrl, 3);
      results.push({ server: s, ping: Math.min(...times.slice(1)) });
    } catch (e) { /* server tidak tersedia, lewati */ }
  }
  if (!results.length) {
    activeServer = null;
    setStatus("Server tidak terjangkau", "fail");
    return false;
  }
  results.sort((a, b) => a.ping - b.ping);
  activeServer = results[0].server;
  showServer(activeServer, results[0].ping);
  return true;
}

function setStatus(text, cls) {
  const el = $("sStatus");
  el.textContent = text;
  el.className = "status " + cls;
}
function showServer(s, ping) {
  $("sName").textContent = s.name;
  $("sLoc").textContent = s.location;
  $("iServer").textContent = s.name;
  $("iLoc").textContent = s.location;
  setStatus(`Fastest server found · Ping ${Math.round(ping)} ms · Connected`, "ok");
  $("sNote").hidden = !demoMode;
  $("sNote").textContent = "Mode demo: pengukuran memakai endpoint publik. Isi SPEEDTEST_SERVERS di script.js.";
}

/* ----- Download ----- */
async function testDownload(s) {
  const ctrl = new AbortController();
  const start = performance.now();
  let bytes = 0;
  const tick = setInterval(() => {
    const sec = (performance.now() - start) / 1000;
    if (sec > 0.5) setGauge(bytes * 8 / sec / 1e6);
  }, 200);
  const stop = setTimeout(() => ctrl.abort(), SPEEDTEST_CONFIG.testDuration);
  const worker = async () => {
    while (!ctrl.signal.aborted) {
      const res = await fetch(bust(`${s.downloadUrl}?bytes=${SPEEDTEST_CONFIG.downloadBytes}`), { cache: "no-store", signal: ctrl.signal });
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: SPEEDTEST_CONFIG.concurrentDownloads }, () => worker().catch(() => {})));
  } finally { clearInterval(tick); clearTimeout(stop); }
  if (!bytes) throw new Error("download");
  return bytes * 8 / ((performance.now() - start) / 1000) / 1e6;
}

/* ----- Upload ----- */
async function testUpload(s) {
  const chunk = new Blob([new Uint8Array(SPEEDTEST_CONFIG.uploadChunkBytes)]);
  const start = performance.now();
  const end = start + SPEEDTEST_CONFIG.testDuration * 0.75;
  let bytes = 0;
  const tick = setInterval(() => {
    const sec = (performance.now() - start) / 1000;
    if (sec > 0.5) setGauge(bytes * 8 / sec / 1e6);
  }, 200);
  const worker = async () => {
    while (performance.now() < end) {
      await fetch(bust(s.uploadUrl), { method: "POST", body: chunk, cache: "no-store" });
      bytes += chunk.size;
    }
  };
  try {
    await Promise.all(Array.from({ length: SPEEDTEST_CONFIG.concurrentUploads }, worker));
  } finally { clearInterval(tick); }
  return bytes * 8 / ((performance.now() - start) / 1000) / 1e6;
}

/* ----- Alur test ----- */
async function runTest() {
  if (running) return;
  running = true;
  const btn = $("startBtn");
  btn.disabled = true;
  btn.textContent = "TESTING...";
  $("error").hidden = true;
  ["rDown", "rUp", "rPing", "rJitter"].forEach((id) => ($(id).textContent = "-"));
  setGauge(0);

  try {
    if (!activeServer && !(await findFastestServer())) throw new Error("server");

    $("phase").textContent = "Ping";
    const { ping, jitter } = pingStats(await measurePing(activeServer.pingUrl, SPEEDTEST_CONFIG.pingCount));
    $("rPing").textContent = Math.round(ping);
    $("rJitter").textContent = Math.round(jitter);

    $("phase").textContent = "Download";
    const down = await testDownload(activeServer);
    setGauge(down);
    $("rDown").textContent = down.toFixed(2);

    $("phase").textContent = "Upload";
    setGauge(0);
    const up = await testUpload(activeServer);
    setGauge(up);
    $("rUp").textContent = up.toFixed(2);

    $("phase").textContent = "Selesai";
    saveLast({ down, up, ping });
    btn.textContent = "TEST AGAIN";
  } catch (e) {
    $("phase").textContent = "Gagal";
    $("error").textContent = "Test gagal. Periksa koneksi internet atau konfigurasi server di script.js.";
    $("error").hidden = false;
    btn.textContent = "TEST AGAIN";
  }
  btn.disabled = false;
  running = false;
}

/* ----- Last test ----- */
function saveLast(r) {
  try { localStorage.setItem(LAST_KEY, JSON.stringify(r)); } catch (e) {}
  renderLast();
}
function renderLast() {
  let r = null;
  try { r = JSON.parse(localStorage.getItem(LAST_KEY)); } catch (e) {}
  if (!r) return;
  $("last").innerHTML =
    `<div><dt>Download</dt><dd>${r.down.toFixed(2)} Mbps</dd></div>
     <div><dt>Upload</dt><dd>${r.up.toFixed(2)} Mbps</dd></div>
     <div><dt>Ping</dt><dd>${Math.round(r.ping)} ms</dd></div>`;
}

/* ----- Info koneksi (IP & ISP) ----- */
async function loadConnection() {
  try {
    const m = await (await fetch(DEMO_ENDPOINTS.metaUrl)).json();
    $("iIp").textContent = m.clientIp || "-";
    $("iIsp").textContent = m.asOrganization || "-";
  } catch (e) { /* biarkan "-" */ }
}

/* ----- Init ----- */
renderLast();
loadConnection();
findFastestServer();
$("startBtn").addEventListener("click", runTest);
