"use strict";

/* =========================================================
   PROMOSI WHATSAPP
   Akun WhatsApp biasa lewat Baileys (login kode pairing).
   Modul ini berdiri sendiri dan tidak mengubah fitur Telegram.
========================================================= */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const pino = require("pino");

// Baileys dimuat lewat import() supaya jalan untuk versi 6.x (CommonJS) maupun 7.x (ESM).
let baileysCache = null;
async function loadBaileys() {
  if (baileysCache) return baileysCache;
  const m = await import("@whiskeysockets/baileys");
  const pick = k => m[k] ?? m.default?.[k];
  const make = typeof m.makeWASocket === "function" ? m.makeWASocket
    : typeof m.default === "function" ? m.default
      : m.default?.default;
  if (typeof make !== "function") throw new Error("Baileys tidak bisa dimuat (makeWASocket tidak ditemukan)");
  baileysCache = {
    make,
    useMultiFileAuthState: pick("useMultiFileAuthState"),
    fetchLatestWaWebVersion: pick("fetchLatestWaWebVersion"),
    fetchLatestBaileysVersion: pick("fetchLatestBaileysVersion")
  };
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(__dirname, "node_modules", "@whiskeysockets", "baileys", "package.json"), "utf8"));
    console.log("WA LIB: baileys", pj.version);
  } catch (_) { /* hanya untuk log */ }
  return baileysCache;
}

const SESSION_ROOT = process.env.WA_SESSION_DIR || path.join(__dirname, "wa_sessions");
const MEDIA_ROOT = process.env.WA_MEDIA_DIR || path.join(__dirname, "wa_media");
const PAGE = 8;
const DEFAULT_INTERVAL_SEC = 30 * 60;   // jeda bawaan antar putaran (detik); bebas diubah tanpa batas minimum
const GROUP_DELAY_MIN_MS = 1000;        // jeda antar grup: 1 detik
const GROUP_DELAY_MAX_MS = 1000;
// Batas kirim per akun per hari (reset ganti hari UTC). Atur lewat env WA_DAILY_CAP; 0 = tanpa batas.
const DAILY_CAP = Number.isFinite(Number(process.env.WA_DAILY_CAP)) && process.env.WA_DAILY_CAP !== undefined && process.env.WA_DAILY_CAP !== ""
  ? Number(process.env.WA_DAILY_CAP)
  : 5000;
const FLOW_TTL_MS = 10 * 60 * 1000;
// Lama kode pairing dianggap berlaku. Lewat dari ini bot kirim pemberitahuan "kedaluwarsa".
const PAIRING_TTL_MS = Math.max(30, Number(process.env.WA_PAIRING_TTL_SEC) || 120) * 1000;
const RULE = "━━━━━━━━━━━━━━━━━━━━━━━━━━";

fs.mkdirSync(SESSION_ROOT, { recursive: true });
fs.mkdirSync(MEDIA_ROOT, { recursive: true });

// State runtime (memori). Data tetap di tabel wa_*.
const sockets = new Map(); // accountId -> { sock, open, stopping }
const tasks = new Map();   // "accountId:formatId" -> { running }
const flows = new Map();   // telegramId -> { t, accountId?, formatId?, at }
const daily = new Map();   // accountId -> { day, n }
// Cache yang dibutuhkan Baileys supaya pesan ke grup benar-benar sampai.
const groupCache = new Map(); // "accountId:groupJid" -> { at, meta } (daftar peserta grup untuk enkripsi)
const sentCache = new Map();  // "accountId:messageId" -> pesan terkirim (untuk kirim ulang bila penerima gagal dekripsi)
const GROUP_META_TTL_MS = 5 * 60 * 1000;
const SENT_CACHE_MAX = 500;
const SEND_TIMEOUT_MS = 90 * 1000;      // kirim ke satu grup tidak boleh menggantung lebih dari ini

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const newId = () => crypto.randomBytes(4).toString("hex");
const nowIso = () => new Date().toISOString();
const trunc = (s, n) => Array.from(String(s ?? "")).slice(0, n).join("");
// Jeda disimpan dalam detik (interval_seconds). Format lama hanya punya interval_minutes.
const intervalSec = fmt => {
  const s = Number(fmt?.interval_seconds);
  if (Number.isFinite(s) && s > 0) return s;
  const m = Number(fmt?.interval_minutes);
  return (Number.isFinite(m) && m > 0 ? m : DEFAULT_INTERVAL_SEC / 60) * 60;
};
const secText = sec => {
  const s = Math.max(1, Math.round(sec));
  if (s >= 86400 && s % 86400 === 0) return `${s / 86400} hari`;
  if (s >= 3600 && s % 3600 === 0) return `${s / 3600} jam`;
  if (s >= 60 && s % 60 === 0) return `${s / 60} menit`;
  if (s < 60) return `${s} detik`;
  const m = Math.floor(s / 60);
  return `${m} menit ${s % 60} detik`;
};
// "30 detik", "5 menit", "1 jam", "2 hari", "1.5 jam". Angka tanpa satuan dianggap menit.
const parseInterval = text => {
  const m = String(text || "").trim().toLowerCase().replace(",", ".")
    .match(/^(\d+(?:\.\d+)?)\s*(detik|dtk|sec|s|menit|mnt|min|m|jam|j|h|hari|d)?$/);
  if (!m) return null;
  const unit = {
    detik: 1, dtk: 1, sec: 1, s: 1,
    menit: 60, mnt: 60, min: 60, m: 60,
    jam: 3600, j: 3600, h: 3600,
    hari: 86400, d: 86400
  }[m[2] || "menit"];
  const sec = Math.round(Number(m[1]) * unit);
  return Number.isFinite(sec) && sec >= 1 ? sec : null;
};
const hours = h => (h >= 24 && h % 24 === 0 ? `${h / 24} hari` : `${h} jam`);
const dateText = v => (v ? new Date(v).toLocaleString("id-ID") : "-");
const mediaPath = (accId, fmtId, ext = "jpg") => path.join(MEDIA_ROOT, `${accId}_${fmtId}.${ext}`);
const clearMedia = (accId, fmtId) => {
  for (const ext of ["jpg", "mp4"]) fs.rmSync(mediaPath(accId, fmtId, ext), { force: true });
};
const isVideoMedia = fmt => /\.mp4$/i.test(String(fmt?.media || ""));
const sessionDir = id => path.join(SESSION_ROOT, String(id));

// Versi WhatsApp Web terbaru. Versi basi bikin WhatsApp menolak penautan (405 / "Gagal menautkan perangkat").
let waVersionCache = { at: 0, v: undefined };
async function resolveWaVersion() {
  if (waVersionCache.v && Date.now() - waVersionCache.at < 10 * 60 * 1000) return waVersionCache.v;
  const B = await loadBaileys();
  for (const fn of [B.fetchLatestWaWebVersion, B.fetchLatestBaileysVersion]) {
    if (typeof fn !== "function") continue;
    try {
      const r = await fn();
      if (r && Array.isArray(r.version) && r.isLatest !== false) {
        waVersionCache = { at: Date.now(), v: r.version };
        console.log("WA VERSION:", r.version.join("."));
        return r.version;
      }
    } catch (_) { /* coba sumber berikutnya */ }
  }
  return undefined; // pakai versi bawaan library
}

function disconnectReason(code) {
  switch (Number(code)) {
    case 401: return "WhatsApp mengeluarkan sesi ini (401).";
    case 403: return "Nomor ditolak WhatsApp (403).";
    case 405: return "WhatsApp menolak versi/metode koneksi bot (405). Biasanya library Baileys perlu diperbarui.";
    case 408: return "Koneksi ke WhatsApp timeout (408).";
    case 428: return "Koneksi ke WhatsApp terputus (428).";
    case 440: return "Sesi diganti oleh perangkat lain (440).";
    case 500: return "Sesi rusak (500).";
    case 503: return "Server WhatsApp sedang sibuk (503).";
    default: return code ? `Koneksi ditutup WhatsApp (kode ${code}).` : "Koneksi ditutup tanpa kode status.";
  }
}

function register(bot, getDeps) {
  const D = () => getDeps();
  const db = () => D().sb;
  const esc = v => D().escapeHtml(v);
  const errText = e => D().safeErrorMessage(e, 300);
  const IK = () => D().InlineKeyboard;

  /* ---------- UI helpers ---------- */

  // rows: array of rows; tiap row berisi cell [label, callbackData] atau null
  function buildKb(rows) {
    const kb = new (IK())();
    for (const row of rows) {
      const cells = row.filter(Boolean);
      if (!cells.length) continue;
      for (const [label, data] of cells) kb.text(label, data);
      kb.row();
    }
    return kb;
  }

  const show = (ctx, s) => D().sendFresh(ctx.from.id, s.text, s.kb, { parse_mode: "HTML" });
  const note = (tgId, text, kb) => D().sendFresh(tgId, text, kb, { parse_mode: "HTML" });
  const cancelKb = (accId, fmtId) => buildKb([[["❌ Batal", `wa:fmt:view:${accId}:${fmtId}`]]]);
  const backKb = buildKb([[["⬅️ Menu WhatsApp", "whatsapp:menu"]]]);
  const denied = () => ({ text: "⛔ Akun tidak ditemukan atau bukan milikmu.", kb: backKb });
  const confirmScreen = (text, yes, no) => ({ text, kb: buildKb([[["✅ Ya, hapus", yes], ["❌ Batal", no]]]) });
  const statusLabel = a =>
    a.status === "connected" ? "🟢 Terhubung"
      : a.status === "connecting" ? "🟡 Menunggu kode pairing"
        : a.status === "error" ? "🟠 Error, mencoba sambung ulang"
          : "⚪ Terputus";

  // Promosi WhatsApp hanya untuk OWNER dan ADMIN_PREMIUM.
  const canUseWhatsapp = role => role === "OWNER" || role === "ADMIN_PREMIUM";

  /* ---------- Flow input (teks/foto) ---------- */

  function setFlow(tgId, data) { flows.set(String(tgId), { ...data, at: Date.now() }); }
  function clearFlow(tgId) { flows.delete(String(tgId)); }
  function getFlow(tgId) {
    const f = flows.get(String(tgId));
    if (!f) return null;
    if (Date.now() - f.at > FLOW_TTL_MS) { flows.delete(String(tgId)); return null; }
    return f;
  }

  async function adminOfTg(tgId) {
    if (D().isOwnerId(tgId)) return { role: "OWNER", telegram_user_id: Number(tgId) };
    const { data } = await db().from("admins").select("*")
      .eq("telegram_user_id", Number(tgId)).eq("active", true).maybeSingle();
    return data || null;
  }

  /* ---------- Data akun, format, riwayat ---------- */

  async function visibleAccount(id, admin) {
    const { data, error } = await db().from("wa_accounts").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    if (admin.role !== "OWNER" && Number(data.created_by) !== Number(admin.telegram_user_id)) return null;
    return data;
  }

  async function setAccountStatus(id, status, jid, name) {
    const patch = { status, updated_at: nowIso() };
    if (jid !== undefined) patch.jid = jid;
    if (name) patch.label = name;
    await db().from("wa_accounts").update(patch).eq("id", id);
  }

  async function loadFormats(accountId) {
    const { data, error } = await db().from("wa_account_settings")
      .select("formats").eq("account_id", accountId).maybeSingle();
    if (error) throw error;
    return Array.isArray(data?.formats) ? data.formats : [];
  }

  async function saveFormats(accountId, formats) {
    const { error } = await db().from("wa_account_settings").upsert(
      { account_id: accountId, formats, updated_at: nowIso() },
      { onConflict: "account_id" }
    );
    if (error) throw error;
  }

  async function getFormat(accountId, formatId) {
    return (await loadFormats(accountId)).find(f => f.id === formatId) || null;
  }

  async function updateFormat(accountId, formatId, patch) {
    const formats = await loadFormats(accountId);
    const i = formats.findIndex(f => f.id === formatId);
    if (i < 0) return null;
    formats[i] = { ...formats[i], ...patch, updated_at: nowIso() };
    await saveFormats(accountId, formats);
    return formats[i];
  }

  async function logHistory(acc, adminTgId, action, status, extra = {}) {
    await db().from("wa_promotion_history").insert({
      account_id: acc?.id ?? null,
      account_label: acc?.label || "Account",
      admin_telegram_id: adminTgId ?? null,
      group_title: extra.group_title || null,
      action,
      status,
      error: extra.error ? String(extra.error).slice(0, 500) : null
    }).then(() => {}, () => {});
  }

  /* ---------- Sesi & koneksi WhatsApp ---------- */

  function isRegistered(id) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(sessionDir(id), "creds.json"), "utf8"));
      return c?.registered === true || !!c?.me?.id;
    } catch (_) {
      return false;
    }
  }

  function wipeSession(id) {
    fs.rmSync(sessionDir(id), { recursive: true, force: true });
  }

  async function refreshGroups(accountId, sock) {
    const all = await sock.groupFetchAllParticipating();
    // Baileys 7: identitas bisa berupa nomor (PN) atau LID, jadi cocokkan keduanya.
    const bare = x => String(x || "").split(":")[0].split("@")[0];
    const meIds = new Set([sock.user?.id, sock.user?.lid].filter(Boolean).map(bare));
    const rows = Object.values(all || {}).map(g => {
      groupCache.set(`${accountId}:${g.id}`, { at: Date.now(), meta: g });
      const mine = (g.participants || []).find(p => [p.id, p.lid, p.phoneNumber].some(x => x && meIds.has(bare(x))));
      const isAdmin = mine?.admin === "admin" || mine?.admin === "superadmin";
      return {
        account_id: accountId,
        group_jid: g.id,
        title: trunc(g.subject || "Tanpa Nama", 100),
        can_send: !g.announce || !!isAdmin
      };
    });
    if (rows.length) {
      // enabled tidak ikut di-upsert, jadi pilihan target admin tetap tersimpan
      const { error } = await db().from("wa_account_groups").upsert(rows, { onConflict: "account_id,group_jid" });
      if (error) throw error;
    }
    return rows.length;
  }

  /* ---------- Pairing: pelacakan kode, kedaluwarsa, pembersihan ---------- */

  const pairings = new Map(); // accountId -> { tgId, phone, prepId, codeId, timer, paired }
  const retries = new Map();  // accountId -> jumlah percobaan sambung ulang
  const delMsg = (chatId, id) => (id ? bot.api.deleteMessage(chatId, id).catch(() => {}) : Promise.resolve());

  // Pemberitahuan selalu berdiri sendiri sebagai pesan baru, tidak ditempel di kartu akun.
  const screenNotice = (title, lines, rows) => ({
    text: [title, RULE, ...lines].join("\n"),
    kb: buildKb(rows || [[["⬅️ Menu WhatsApp", "whatsapp:menu"]]])
  });
  const retryRows = [[["➕ Coba Lagi", "wa:acc:add"]], [["⬅️ Menu WhatsApp", "whatsapp:menu"]]];
  const accNoticeRows = (accId, extra = []) => [...extra, [["📱 Buka Akun", `wa:acc:view:${accId}`]], [["⬅️ Menu WhatsApp", "whatsapp:menu"]]];

  // Hapus total satu akun: timer, pesan pairing, socket, sesi, dan baris database.
  async function dropAccount(id) {
    const key = String(id);
    const p = pairings.get(key);
    if (p) {
      clearTimeout(p.timer);
      pairings.delete(key);
      await delMsg(p.tgId, p.codeId);
      await delMsg(p.tgId, p.prepId);
    }
    retries.delete(key);
    await stopSocket(id);
    wipeSession(id);
    await db().from("wa_accounts").delete().eq("id", id);
  }

  // Pairing gagal / kedaluwarsa: nomor tidak disimpan, lalu kirim pemberitahuan format baru.
  async function abortPairing(acc, title, lines) {
    const p = pairings.get(String(acc.id));
    if (!p) return;
    await dropAccount(acc.id).catch(e => console.error("WA DROP:", errText(e)));
    const s = screenNotice(title, [`📞 Nomor : <code>${esc(acc.phone || p.phone || "-")}</code>`, ...lines], retryRows);
    await note(p.tgId, s.text, s.kb).catch(() => {});
  }

  async function expirePairing(accId) {
    const p = pairings.get(String(accId));
    if (!p || p.paired) return;
    await abortPairing({ id: accId, phone: p.phone }, "⌛ <b>KODE PAIRING KEDALUWARSA</b>", [
      `Waktu ${secText(PAIRING_TTL_MS / 1000)} sudah habis dan belum ada penautan yang masuk.`,
      "Nomor ini tidak disimpan. Tekan Coba Lagi untuk meminta kode baru.",
      "",
      "<i>Kalau di HP muncul \"Gagal menautkan perangkat\" padahal kodenya masih baru, itu ditolak WhatsApp, bukan karena telat.</i>"
    ]);
  }

  // Akun hantu: tidak pernah terhubung, tidak punya sesi, dan tidak punya format.
  async function isGhost(a) {
    if (a.jid || a.status === "connected" || isRegistered(a.id)) return false;
    const formats = await loadFormats(a.id).catch(() => []);
    return formats.length === 0;
  }

  async function purgeGhosts() {
    const cutoff = Date.now() - (PAIRING_TTL_MS + 60 * 1000);
    const { data } = await db().from("wa_accounts").select("*").neq("status", "connected").is("jid", null);
    for (const a of data || []) {
      if (pairings.has(String(a.id))) continue;
      if (new Date(a.created_at).getTime() > cutoff) continue;
      if (await isGhost(a)) await dropAccount(a.id).catch(e => console.error("WA PURGE:", errText(e)));
    }
  }

  /* ---------- Sesi & koneksi WhatsApp ---------- */

  async function startSocket(acc, pairing) {
    fs.mkdirSync(sessionDir(acc.id), { recursive: true });
    const B = await loadBaileys();
    const { state, saveCreds } = await B.useMultiFileAuthState(sessionDir(acc.id));
    const version = await resolveWaVersion();

    const sock = B.make({
      auth: state,
      ...(version ? { version } : {}),
      logger: pino({ level: "silent" }),
      browser: ["Ubuntu", "Chrome", "22.04.4"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      // Tanpa ini, syncFullHistory:false ikut mematikan sinkron data grup/LID di Baileys 7 (FULL = 2 saja yang dilewati).
      shouldSyncHistoryMessage: ({ syncType }) => syncType !== 2,
      // Wajib untuk kirim ke grup: daftar peserta (cache) dan pesan asli untuk kirim ulang.
      cachedGroupMetadata: async jid => {
        const c = groupCache.get(`${acc.id}:${jid}`);
        return c && Date.now() - c.at < GROUP_META_TTL_MS ? c.meta : undefined;
      },
      getMessage: async key => sentCache.get(`${acc.id}:${key?.id}`)?.message
    });

    // Sudah tertaut kalau creds punya registered/me (dibaca dari memori, bukan menunggu file tersimpan).
    const isPaired = () => state.creds.registered === true || !!state.creds.me?.id;
    const entry = { sock, open: false, stopping: false };
    sockets.set(String(acc.id), entry);
    sock.ev.on("creds.update", saveCreds);
    // Anggota/pengaturan grup berubah: buang cache supaya metadata diambil ulang.
    const dropGroupMeta = list => {
      for (const u of Array.isArray(list) ? list : [list]) if (u?.id) groupCache.delete(`${acc.id}:${u.id}`);
    };
    sock.ev.on("groups.update", dropGroupMeta);
    sock.ev.on("group-participants.update", dropGroupMeta);
    sock.ev.on("creds.update", upd => {
      if (upd?.me?.id || upd?.registered) {
        const p = pairings.get(String(acc.id));
        if (p) { p.paired = true; clearTimeout(p.timer); }
      }
    });

    if (pairing && !isPaired()) {
      let requested = false;
      const requestCode = async () => {
        if (requested || entry.stopping || isPaired()) return;
        requested = true;
        try {
          const code = await sock.requestPairingCode(pairing.phone);
          console.log("WA PAIRING: kode diminta untuk", pairing.phone, "->", code);
          const p = pairings.get(String(acc.id));
          if (!p || entry.stopping) return;
          const shown = code.match(/.{1,4}/g)?.join("-") || code;
          const msg = await bot.api.sendMessage(p.tgId,
            `🔑 <b>KODE PAIRING WHATSAPP</b>\n${RULE}\nNomor : <code>${esc(pairing.phone)}</code>\nKode : <code>${esc(shown)}</code>\n\n⏳ Berlaku sekitar ${secText(PAIRING_TTL_MS / 1000)}. Kalau waktunya habis, bot akan memberi tahu.\n\nDi HP: WhatsApp → Perangkat tertaut → Tautkan perangkat → Tautkan dengan nomor telepon, lalu masukkan kode ini.`,
            { parse_mode: "HTML", reply_markup: new (IK())().text("❌ Batal", `wa:pair:cancel:${acc.id}`) });
          p.codeId = msg.message_id;
          // Pesan "Menyiapkan koneksi" sudah tidak perlu, hapus otomatis.
          await delMsg(p.tgId, p.prepId);
          p.prepId = null;
          clearTimeout(p.timer);
          p.timer = setTimeout(() => expirePairing(acc.id).catch(e => console.error("WA EXPIRE:", errText(e))), PAIRING_TTL_MS);
        } catch (e) {
          console.error("WA PAIRING:", errText(e));
          await abortPairing(acc, "❌ <b>GAGAL MEMINTA KODE PAIRING</b>", [esc(errText(e))]);
        }
      };
      // Minta kode begitu socket siap (event qr), dengan cadangan timer jika event itu tidak datang.
      sock.ev.on("connection.update", u => { if (u?.qr) requestCode(); });
      setTimeout(requestCode, 6000);
    }

    sock.ev.on("connection.update", async upd => {
      const { connection, lastDisconnect } = upd;
      console.log(
        "WA UPDATE:", connection || "-",
        "| code:", lastDisconnect?.error?.output?.statusCode || "-",
        "| msg:", lastDisconnect?.error?.message || "-"
      );
      try {
        if (connection === "open") {
          entry.open = true;
          retries.delete(String(acc.id));
          const jid = sock.user?.id ? `${sock.user.id.split(":")[0]}@s.whatsapp.net` : null;
          const waName = sock.user?.name ? trunc(String(sock.user.name).trim(), 60) : "";
          await setAccountStatus(acc.id, "connected", jid, waName || undefined);
          const total = await refreshGroups(acc.id, sock).catch(() => 0);

          const p = pairings.get(String(acc.id));
          if (p) {
            clearTimeout(p.timer);
            pairings.delete(String(acc.id));
            await delMsg(p.tgId, p.codeId);
            await delMsg(p.tgId, p.prepId);
            const s = screenNotice("✅ <b>WHATSAPP TERHUBUNG</b>", [
              `👤 Nama : <b>${esc(waName || acc.label)}</b>`,
              `📞 Nomor : <code>${esc(acc.phone || "-")}</code>`,
              `☑️ ${total} grup terdeteksi.`
            ], accNoticeRows(acc.id));
            await note(p.tgId, s.text, s.kb).catch(() => {});
          }
        }

        if (connection === "close") {
          entry.open = false;
          if (entry.stopping) return;
          sockets.delete(String(acc.id));
          const code = lastDisconnect?.error?.output?.statusCode;
          const p = pairings.get(String(acc.id));

          // Pairing belum selesai lalu koneksi putus: gagal. Nomor tidak disimpan.
          if (p && !isPaired()) {
            await abortPairing(acc, "❌ <b>PAIRING GAGAL</b>", [
              `Penyebab : ${esc(disconnectReason(code))}`,
              "Nomor ini tidak disimpan. Tekan Coba Lagi untuk meminta kode baru."
            ]);
            return;
          }

          // Pairing berhasil: WhatsApp memang menutup koneksi sekali (515), sambung ulang dengan sesi baru.
          if (p && isPaired()) {
            p.restarts = (p.restarts || 0) + 1;
            // 515 = WhatsApp minta restart sekali setelah pairing. 401 atau restart berulang = login ditolak WhatsApp.
            if (code === 401 || p.restarts > 3) {
              console.log("WA PAIRING DITOLAK: akun", acc.id, "kode", code, "restart ke-", p.restarts);
              await abortPairing(acc, "❌ <b>PAIRING DITOLAK WHATSAPP</b>", [
                `HP sempat menerima kode, tapi WhatsApp menolak login perangkat (kode ${esc(code || "-")}).`,
                "Sesi dihapus supaya bot tidak mencoba sambung terus-menerus. Nomor ini tidak disimpan.",
                "",
                "<i>Ini penolakan dari sisi WhatsApp/library Baileys, bukan karena telat atau salah ketik.</i>"
              ]);
              return;
            }
            p.paired = true;
            clearTimeout(p.timer);
            await setAccountStatus(acc.id, "connecting").catch(() => {});
            for (let i = 0; i < 20 && !isRegistered(acc.id); i++) await sleep(500);
            setTimeout(() => reconnect(acc.id), 1500);
            return;
          }

          if (code === 401) {
            // Sesi ditolak/dikeluarkan WhatsApp: berhenti sambung ulang, hapus sesi.
            console.log("WA LOGOUT: akun", acc.id, "sesi ditolak (401), sesi dihapus");
            await setAccountStatus(acc.id, "disconnected", null);
            retries.delete(String(acc.id));
            wipeSession(acc.id);
            return;
          }
          await setAccountStatus(acc.id, "error").catch(() => {});
          const n = (retries.get(String(acc.id)) || 0) + 1;
          retries.set(String(acc.id), n);
          setTimeout(() => reconnect(acc.id), Math.min(5000 * n, 60000));
        }
      } catch (e) {
        console.error("WA CONNECTION:", errText(e));
      }
    });
  }

  async function reconnect(id) {
    if (sockets.has(String(id)) || !isRegistered(id)) return;
    const { data: acc } = await db().from("wa_accounts").select("*").eq("id", id).maybeSingle();
    if (!acc || acc.status === "disconnected") return;
    try {
      await startSocket(acc, null);
    } catch (e) {
      console.error("WA RECONNECT:", errText(e));
      setTimeout(() => reconnect(id), 15000);
    }
  }

  async function stopSocket(id, { logout = false } = {}) {
    const entry = sockets.get(String(id));
    if (!entry) return;
    entry.stopping = true;
    sockets.delete(String(id));
    try {
      if (logout) await Promise.race([entry.sock.logout(), sleep(10000)]);
      else entry.sock.end(undefined);
    } catch (_) { /* abaikan */ }
  }

  /* ---------- Loop promosi ---------- */

  async function enabledGroups(accountId) {
    const { data, error } = await db().from("wa_account_groups").select("*")
      .eq("account_id", accountId).eq("enabled", true).eq("can_send", true)
      .order("id", { ascending: true });
    if (error) throw error;
    return data || [];
  }

  function bumpDaily(id) {
    const today = nowIso().slice(0, 10);
    const cur = daily.get(String(id));
    if (!cur || cur.day !== today) daily.set(String(id), { day: today, n: 1 });
    else cur.n++;
  }

  function overDailyCap(id) {
    const today = nowIso().slice(0, 10);
    const cur = daily.get(String(id));
    return DAILY_CAP > 0 && !!cur && cur.day === today && cur.n >= DAILY_CAP;
  }

  async function waitTask(task, ms) {
    const end = Date.now() + ms;
    while (task.running && Date.now() < end) {
      await sleep(Math.min(1000, end - Date.now()));
    }
  }

  async function sendFormat(sock, jid, fmt, accountId) {
    let sent;
    if (fmt.media && fs.existsSync(fmt.media)) {
      const caption = fmt.message || undefined;
      // Video dibaca streaming dari disk agar video besar tidak memenuhi memori.
      if (isVideoMedia(fmt)) sent = await sock.sendMessage(jid, { video: { url: fmt.media }, caption, mimetype: "video/mp4" });
      else sent = await sock.sendMessage(jid, { image: fs.readFileSync(fmt.media), caption });
    } else {
      sent = await sock.sendMessage(jid, { text: fmt.message });
    }
    if (sent?.key?.id) {
      sentCache.set(`${accountId}:${sent.key.id}`, sent);
      if (sentCache.size > SENT_CACHE_MAX) sentCache.delete(sentCache.keys().next().value);
    }
    return sent;
  }

  async function sendRoundReport(acc, fmt, round) {
    const to = fmt.started_by;
    if (!to) return;
    const total = round.ok + round.fail.length;
    const reasons = new Map();
    for (const f of round.fail) reasons.set(f.reason, (reasons.get(f.reason) || 0) + 1);
    const lines = [
      "📊 <b>HASIL PROMOSI</b>",
      RULE,
      `📝 Format: <b>${esc(await fmtLabel(acc.id, fmt))}</b>`,
      `👤 Nama: <b>${esc((acc && acc.label) || "-")}</b>`,
      `📞 Nomor: <code>${esc((acc && acc.phone) || "-")}</code>`,
      RULE,
      "📤 <b>HASIL PENGIRIMAN</b>",
      `Total group dipilih: <b>${total}</b>`,
      `Berhasil terkirim: <b>${round.ok}</b>`,
      `Gagal: <b>${round.fail.length}</b>`
    ];
    if (round.capped) {
      lines.push("", `⚠️ <b>Putaran terpotong:</b> batas kirim harian (${DAILY_CAP}) tercapai, promosi lanjut otomatis setelah reset harian.`);
    }
    if (reasons.size) {
      lines.push("", "❌ <b>Ringkasan gagal:</b>");
      for (const [reason, n] of reasons) lines.push(`• ${n} grup — ${esc(trunc(reason, 160))}`);
    }
    await bot.api.sendMessage(to, lines.join("\n"), {
      parse_mode: "HTML",
      reply_markup: new (IK())().text("📝 Detail Format", `wa:fmt:view:${acc.id}:${fmt.id}`)
    }).catch(() => {});
  }

  function startLoop(accountId, formatId) {
    const key = `${accountId}:${formatId}`;
    const existing = tasks.get(key);
    if (existing) { existing.running = true; return; }

    const task = { running: true };
    tasks.set(key, task);

    (async () => {
      try {
        while (task.running) {
          const fmt = await getFormat(accountId, formatId);
          if (!fmt || !fmt.active) break;

          if (fmt.expires_at && new Date(fmt.expires_at) <= new Date()) {
            await updateFormat(accountId, formatId, { active: false });
            break;
          }

          const entry = sockets.get(String(accountId));
          if (!entry?.open || (!fmt.message && !fmt.media)) {
            await waitTask(task, 60 * 1000);
            continue;
          }

          const { data: acc } = await db().from("wa_accounts").select("*").eq("id", accountId).maybeSingle();
          const groups = await enabledGroups(accountId);

          const round = { ok: 0, fail: [], capped: false };
          for (const g of groups) {
            if (!task.running) break;
            if (overDailyCap(accountId)) {
              // Jangan menunggu di sini: laporan dikirim dulu, baru menunggu.
              round.capped = true;
              break;
            }
            const sock = sockets.get(String(accountId))?.sock;
            try {
              if (!sock) throw new Error("Akun WhatsApp terputus");
              const sent = await Promise.race([
                sendFormat(sock, g.group_jid, fmt, accountId),
                sleep(SEND_TIMEOUT_MS).then(() => { throw new Error("Timeout kirim ke grup (90 detik)"); })
              ]);
              console.log("WA SEND: ok", accountId, "->", g.title, "| id:", sent?.key?.id || "-");
              bumpDaily(accountId);
              round.ok++;
              await logHistory(acc, null, "promotion_send", "success", { group_title: g.title });
            } catch (e) {
              console.error("WA SEND: gagal", accountId, "->", g.title, "|", errText(e));
              round.fail.push({ title: g.title, reason: errText(e) });
              await logHistory(acc, null, "promotion_send", "error", { group_title: g.title, error: errText(e) });
            }
            await waitTask(task, rnd(GROUP_DELAY_MIN_MS, GROUP_DELAY_MAX_MS));
          }

          if (round.ok + round.fail.length) await sendRoundReport(acc, fmt, round).catch(() => {});
          if (round.capped) {
            console.warn("WA LOOP: batas harian", DAILY_CAP, "tercapai untuk akun", accountId, "- menunggu 1 jam");
            await waitTask(task, 60 * 60 * 1000);
            continue;
          }
          // Jeda bebas (detik pun bisa). Putaran tanpa grup ditunggu min. 10 detik agar tidak looping rapat.
          const gapMs = intervalSec(fmt) * 1000;
          await waitTask(task, round.ok + round.fail.length ? gapMs : Math.max(gapMs, 10000));
        }
      } catch (e) {
        console.error("WA LOOP:", errText(e));
      } finally {
        tasks.delete(key);
      }
    })();
  }

  async function startFormat(acc, formatId, tgId) {
    const fmt = await getFormat(acc.id, formatId);
    const expires = new Date(Date.now() + fmt.duration_hours * 3600 * 1000).toISOString();
    await updateFormat(acc.id, formatId, { active: true, started_at: nowIso(), expires_at: expires, started_by: tgId });
    startLoop(acc.id, formatId);
    await logHistory(acc, tgId, "promotion_start", "info");
  }

  async function stopFormat(acc, formatId, tgId) {
    await updateFormat(acc.id, formatId, { active: false });
    const t = tasks.get(`${acc.id}:${formatId}`);
    if (t) t.running = false;
    await logHistory(acc, tgId, "promotion_stop", "info");
  }

  /* ---------- Layar ---------- */

  const searchTerms = new Map(); // token -> { accountId, term, rawTerm } untuk Cari Grup

  const ASK = {
    msg: `✏️ <b>EDIT ISI FORMAT</b>\n${RULE}\nKirim <b>teks</b> untuk isi pesan.\nAtau kirim <b>foto/video</b> dengan caption untuk mengganti media sekaligus isi pesannya.\n\n<i>Tidak ada batas panjang pesan.</i>`,
    photo: `🖼️ <b>MEDIA FORMAT</b>\n${RULE}\nKirim foto atau video.`,
    interval: `⏱️ <b>ATUR JEDA</b>\n${RULE}\nKirim jeda antar putaran, tanpa batas minimum.\nContoh: 30 detik, 5 menit, 1 jam`,
    duration: `📅 <b>ATUR DURASI</b>\n${RULE}\nKirim lama promosi berjalan.\nContoh: 1 jam, 3 hari`
  };

  const cancelAcc = accId => buildKb([[["❌ Batal", `wa:acc:view:${accId}`]]]);
  const withNote = (s, msg) => ({ text: `${msg}\n\n${s.text}`, kb: s.kb });

  async function screenMain() {
    return {
      text: [
        "💬 <b>PROMOSI WHATSAPP</b>",
        RULE,
        "Kirim promosi ke grup WhatsApp memakai akun WhatsApp biasa (login kode pairing).",
        "",
        "Atur akun, pilih grup target, lalu buat format promosi seperti di menu Telegram."
      ].join("\n"),
      kb: buildKb([
        [["📱 Akun WhatsApp", "wa:acc:list:0"], ["➕ Tambah Akun", "wa:acc:add"]],
        [["🏠 Menu Utama", "menu:dashboard"]]
      ])
    };
  }

  async function screenAccounts(admin, page, scope = "own") {
    const isOwner = admin.role === "OWNER";
    const others = isOwner && scope === "others";
    await purgeGhosts().catch(() => {});
    let q = db().from("wa_accounts").select("*", { count: "exact" })
      .order("id", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (others) q = q.or(`created_by.is.null,created_by.neq.${Number(admin.telegram_user_id)}`);
    else q = q.eq("created_by", admin.telegram_user_id);
    const { data, count, error } = await q;
    if (error) throw error;

    const base = others ? "wa:acc:others" : "wa:acc:list";
    const visible = (data || []).filter(a => !pairings.has(String(a.id)));
    const total = Math.max(0, (count || 0) - ((data || []).length - visible.length));
    const rows = visible.map(a => [[
      `${a.status === "connected" ? "🟢" : "⚪"} ${trunc(a.label, 28)}`,
      `wa:acc:view:${a.id}`
    ]]);
    const nav = [];
    if (page > 0) nav.push(["◀️", `${base}:${page - 1}`]);
    if ((page + 1) * PAGE < total) nav.push(["▶️", `${base}:${page + 1}`]);

    const title = others ? "👥 <b>AKUN WHATSAPP USER LAIN</b>" : "📱 <b>AKUN WHATSAPP</b>";
    const empty = others ? "<i>Belum ada akun WhatsApp user lain.</i>" : "<i>Belum ada akun WhatsApp.</i>";

    return {
      text: [title, RULE, `Total akun : <b>${total}</b>`, total ? "" : empty].join("\n"),
      kb: buildKb([
        ...rows,
        nav,
        others
          ? [["⬅️ Akun Saya", "wa:acc:list:0"]]
          : [["➕ Tambah Akun", "wa:acc:add"]],
        !others && isOwner ? [["👥 Akun User Lain", "wa:acc:others:0"]] : null,
        [["⬅️ Menu WhatsApp", "whatsapp:menu"]]
      ].filter(Boolean))
    };
  }

  async function allGroups(accountId) {
    const { data, error } = await db().from("wa_account_groups").select("*")
      .eq("account_id", accountId).order("title", { ascending: true }).limit(5000);
    if (error) throw error;
    return data || [];
  }

  function accountKb(acc) {
    const connected = acc.status === "connected";
    return buildKb([
      [["📊 Status", `wa:acc:status:${acc.id}`], ["⚙️ Pengaturan", `wa:acc:settings:${acc.id}`]],
      [
        connected ? ["🔌 Putus", `wa:acc:disconnect:${acc.id}`] : ["🔗 Hubungkan", `wa:acc:connect:${acc.id}`],
        ["👥 Grup", `wa:grp:list:${acc.id}:0`]
      ],
      [["➕ Tambah Grup", `wa:grp:add:${acc.id}`], ["📝 Format", `wa:fmt:list:${acc.id}:0`]],
      [["➕ Format Baru", `wa:fmt:add:${acc.id}`], ["▶️ Format Aktif", `wa:fmt:active:${acc.id}:0`]],
      [["⏹ Stop Semua", `wa:acc:stopall:${acc.id}`], ["📋 Riwayat", `wa:hist:${acc.id}`]],
      [["🏷️ Nama", `wa:acc:label:${acc.id}`], ["🗑️ Hapus", `wa:acc:del:${acc.id}`]],
      [["⬅️ Kembali", "wa:acc:list:0"]]
    ]);
  }

  async function screenAccount(acc) {
    const groups = await allGroups(acc.id);
    const formats = await loadFormats(acc.id);
    return {
      text: [
        "📱 <b>AKUN WHATSAPP</b>",
        RULE,
        `👤 Nama : <b>${esc(acc.label)}</b>`,
        `📞 Nomor : <code>${esc(acc.phone || "-")}</code>`,
        `📌 Status : ${statusLabel(acc)}`,
        `📝 Format : <b>${formats.length}</b>`,
        `▶️ Aktif : <b>${formats.filter(f => f.active).length}</b>`,
        `☑️ Grup dipilih : <b>${groups.filter(g => g.enabled && g.can_send).length}</b> dari ${groups.length}`
      ].join("\n"),
      kb: accountKb(acc)
    };
  }

  async function screenStatus(acc) {
    const entry = sockets.get(String(acc.id));
    const groups = await allGroups(acc.id);
    const formats = await loadFormats(acc.id);
    return {
      text: [
        "📊 <b>STATUS WHATSAPP</b>",
        RULE,
        `👤 Nama : <b>${esc(acc.label)}</b>`,
        `📞 Nomor : <code>${esc(acc.phone || "-")}</code>`,
        `🔗 Koneksi : ${statusLabel(acc)}`,
        `🔌 Sesi aktif : <b>${entry?.open ? "aktif" : "tidak aktif"}</b>`,
        `▶️ Promosi berjalan : <b>${formats.filter(f => f.active).length}</b>`,
        `☑️ Grup dipilih : <b>${groups.filter(g => g.enabled && g.can_send).length}</b> dari ${groups.length}`,
        `🕒 Diperbarui : ${esc(dateText(acc.updated_at))}`
      ].join("\n"),
      kb: buildKb([
        [["🔄 Refresh", `wa:acc:status:${acc.id}`]],
        [["⬅️ Akun", `wa:acc:view:${acc.id}`]]
      ])
    };
  }

  async function screenSettings(acc) {
    const formats = await loadFormats(acc.id);
    const running = formats.filter(f => f.active).length;
    return {
      text: [
        "⚙️ <b>SETTING ACCOUNT</b>",
        "",
        "📱 <b>AKUN TERKAIT</b>",
        `👤 Nama : <b>${esc(acc.label)}</b>`,
        `📞 Nomor : <code>${esc(acc.phone || "belum ada nomor")}</code>`,
        `📌 Koneksi : <b>${esc(statusLabel(acc))}</b>`,
        `▶️ Promosi : <b>${running ? "BERJALAN" : "BERHENTI"}</b>`,
        `📝 Format : <b>${formats.length}</b>`
      ].join("\n"),
      kb: buildKb([
        [["🏷️ Nama", `wa:acc:label:${acc.id}`], ["📝 Format", `wa:fmt:list:${acc.id}:0`]],
        [["➕ Format Baru", `wa:fmt:add:${acc.id}`], ["⬅️ Kembali", `wa:acc:view:${acc.id}`]]
      ])
    };
  }

  async function screenGroups(acc, page, opts = {}) {
    const all = await allGroups(acc.id);
    const term = opts.term || "";
    const scope = term ? all.filter(g => String(g.title).toLowerCase().includes(term)) : all;
    const pages = Math.max(1, Math.ceil(scope.length / PAGE));
    const p = Math.min(Math.max(0, page), pages - 1);
    const rows = scope.slice(p * PAGE, p * PAGE + PAGE);
    const picked = all.filter(g => g.enabled && g.can_send).length;
    const locked = all.filter(g => !g.can_send).length;
    const navBase = n => (opts.token ? `wa:grp:find:${acc.id}:${opts.token}:${n}` : `wa:grp:list:${acc.id}:${n}`);
    const backOf = n => (opts.token ? `f:${opts.token}:${n}` : `l:${n}`);

    const kb = [];
    for (const g of rows.filter(x => x.can_send)) {
      kb.push([[`${g.enabled ? "✅" : "⬜"} ${trunc(g.title, 30)}`, `wa:grp:tog:${acc.id}:${g.id}:${backOf(p)}`]]);
    }
    const nav = [];
    if (p > 0) nav.push(["◀️ Sebelumnya", navBase(p - 1)]);
    nav.push(["🏠 Menu", "menu:dashboard"]);
    if (p < pages - 1) nav.push(["Berikutnya ▶️", navBase(p + 1)]);
    kb.push(nav);
    kb.push(opts.token
      ? [["⬅️ Semua Grup", `wa:grp:list:${acc.id}:0`], ["⬅️ Akun", `wa:acc:view:${acc.id}`]]
      : [["🔎 Cari Grup", `wa:grp:search:${acc.id}`], ["⬅️ Akun", `wa:acc:view:${acc.id}`]]);
    // Dua tombol memanjang di bagian paling bawah.
    kb.push([["➕ Tambah Semua Grup", `wa:grp:all:${acc.id}:${backOf(p)}`]]);
    kb.push([["🔄 Deteksi Grup", `wa:grp:refresh:${acc.id}`]]);

    const lines = [
      "🎯 <b>GRUP TARGET</b>",
      RULE,
      `Akun  : <b>${esc(acc.label)}</b>`,
      `Total grup  : <b>${all.length}</b>`,
      `Dipilih  : <b>${picked}</b>`,
      `Terkunci (hanya admin)  : <b>${locked}</b>`
    ];
    if (term) lines.push(`Pencarian  : <b>${esc(opts.rawTerm || term)}</b> (${scope.length} hasil)`);
    lines.push(`Halaman  : <b>${p + 1}</b> / ${pages}`);
    if (opts.prefix) lines.push("", opts.prefix);
    lines.push("", "<blockquote>✅ = jadi target promosi\n⬜ = belum dipilih</blockquote>");
    if (!all.length) lines.push("", "<i>Belum ada grup. Tekan Deteksi Grup setelah akun terhubung.</i>");
    return { text: lines.join("\n"), kb: buildKb(kb) };
  }

  async function groupScreenFromBack(acc, back, opts = {}) {
    const parts = String(back).split(":");
    if (parts[0] === "f") {
      const s = searchTerms.get(parts[1]);
      if (s && s.accountId === String(acc.id)) {
        return screenGroups(acc, Number(parts[2]) || 0, { ...opts, term: s.term, rawTerm: s.rawTerm, token: parts[1] });
      }
    }
    return screenGroups(acc, Number(parts[parts.length - 1]) || 0, opts);
  }

  async function detectGroups(acc) {
    const entry = sockets.get(String(acc.id));
    if (!entry?.open) return { error: "⚠️ Akun belum terhubung, grup belum bisa dideteksi." };
    try {
      const n = await refreshGroups(acc.id, entry.sock);
      return { n };
    } catch (e) {
      return { error: `❌ Deteksi grup gagal : ${esc(errText(e))}` };
    }
  }

  async function fmtLabel(accountId, fmt) {
    const all = await loadFormats(accountId);
    const i = all.findIndex(x => x.id === fmt.id);
    return `Format ${i >= 0 ? i + 1 : all.length + 1}`;
  }

  async function screenFormatList(acc, page, mode = "all") {
    const all = await loadFormats(acc.id);
    const list = all.filter(f => mode === "all" || f.active);
    const pages = Math.max(1, Math.ceil(list.length / PAGE));
    const p = Math.min(Math.max(0, page), pages - 1);
    const kb = list.slice(p * PAGE, p * PAGE + PAGE).map(f => [[
      `${f.active ? "▶️" : "⏹"} Format ${all.findIndex(x => x.id === f.id) + 1}`,
      `wa:fmt:view:${acc.id}:${f.id}`
    ]]);
    const nav = [];
    if (p > 0) nav.push(["◀️", `wa:fmt:${mode}:${acc.id}:${p - 1}`]);
    if (p < pages - 1) nav.push(["▶️", `wa:fmt:${mode}:${acc.id}:${p + 1}`]);
    if (nav.length) kb.push(nav);
    kb.push(mode === "all"
      ? [["➕ Format Baru", `wa:fmt:add:${acc.id}`], ["⬅️ Akun", `wa:acc:view:${acc.id}`]]
      : [["⬅️ Akun", `wa:acc:view:${acc.id}`]]);

    const title = mode === "active" ? "▶️ <b>FORMAT AKTIF</b>" : "📝 <b>FORMAT PROMOSI</b>";
    const empty = mode === "active" ? "<i>Tidak ada format yang sedang berjalan.</i>" : "<i>Belum ada format. Tekan Format Baru untuk membuat.</i>";
    return {
      text: [
        title,
        RULE,
        `Akun  : <b>${esc(acc.label)}</b>`,
        `Total format  : <b>${all.length}</b>`,
        `Berjalan  : <b>${all.filter(f => f.active).length}</b>`,
        "",
        list.length ? "" : empty
      ].filter(x => x !== false).join("\n").replace(/\n+$/, ""),
      kb: buildKb(kb)
    };
  }

  async function screenFormat(acc, fmt) {
    const id = acc.id;
    const f = fmt.id;
    const label = await fmtLabel(acc.id, fmt);
    const body = fmt.message ? esc(trunc(fmt.message, 400)) : "<i>Belum diisi</i>";
    const lines = [
      "📝 <b>FORMAT PROMOSI</b>",
      `Nama  : <b>${esc(label)}</b>`,
      RULE,
      "📄 <b>ISI FORMAT</b>",
      `Media  : <b>${fmt.media ? (isVideoMedia(fmt) ? "🎬 Video" : "🖼️ Foto") : "📝 Teks"}</b>`,
      `<blockquote>${body}</blockquote>`,
      RULE,
      "⚙️ <b>PENGATURAN</b>",
      `⏱️ Jeda  : <b>${secText(intervalSec(fmt))}</b>`,
      `📅 Durasi  : <b>${hours(fmt.duration_hours)}</b>`,
      "🕐 Waktu  : <b>langsung</b>",
      `📌 Status  : <b>${fmt.active ? "🟢 AKTIF" : "🔴 NONAKTIF"}</b>`
    ];
    if (fmt.active && fmt.expires_at) lines.push(`⌛ Berakhir  : ${esc(dateText(fmt.expires_at))}`);
    return {
      text: lines.join("\n"),
      kb: buildKb([
        [["✏️ Edit Format", `wa:fmt:ask:msg:${id}:${f}`], ["⏱️ Atur Jeda", `wa:fmt:ask:interval:${id}:${f}`]],
        [["📅 Atur Durasi", `wa:fmt:ask:duration:${id}:${f}`], fmt.active ? ["⏹ Stop", `wa:fmt:stop:${id}:${f}`] : ["▶️ Mulai", `wa:fmt:start:${id}:${f}`]],
        [["🗑️ Hapus Format", `wa:fmt:del:${id}:${f}`]],
        [["⬅️ Kembali", `wa:fmt:list:${id}:0`]]
      ])
    };
  }

  async function formatWithNote(acc, fmt, warn) {
    const s = await screenFormat(acc, fmt);
    return { text: warn ? `${warn}\n\n${s.text}` : s.text, kb: s.kb };
  }

  async function screenHistory(acc) {
    const { data, error } = await db().from("wa_promotion_history").select("*")
      .eq("account_id", acc.id).order("created_at", { ascending: false }).limit(10);
    if (error) throw error;
    const lines = (data || []).map(h =>
      `• ${esc(dateText(h.created_at))}\n   ${esc(h.action)}: ${esc(h.status)}` +
      (h.group_title ? `\n   Grup : ${esc(trunc(h.group_title, 30))}` : "") +
      (h.error ? `\n   <i>${esc(trunc(h.error, 120))}</i>` : "")
    );
    return {
      text: [
        "🕒 <b>RIWAYAT TERAKHIR</b>",
        RULE,
        `📱 Akun : <b>${esc(acc.label)}</b>`,
        "",
        ...(lines.length ? lines : ["<i>Belum ada riwayat.</i>"])
      ].join("\n"),
      kb: buildKb([[["⬅️ Akun", `wa:acc:view:${acc.id}`]]])
    };
  }

  /* ---------- Guard & lookup ---------- */

  function guard(fn) {
    return async ctx => {
      const admin = await D().requireAdmin(ctx);
      if (!admin) return;
      if (!canUseWhatsapp(admin.role)) {
        await ctx.answerCallbackQuery(
          "Promosi WhatsApp hanya tersedia untuk Admin Premium dan OWNER.",
          { show_alert: true }
        ).catch(() => {});
        return;
      }
      await ctx.answerCallbackQuery().catch(() => {});
      clearFlow(ctx.from.id);
      try {
        await fn(ctx, admin);
      } catch (e) {
        console.error("WA MENU:", errText(e));
        await show(ctx, {
          text: `❌ <b>Terjadi kesalahan.</b>\n${esc(errText(e))}`,
          kb: backKb
        }).catch(() => {});
      }
    };
  }

  async function withAccount(ctx, admin, id, fn) {
    const acc = await visibleAccount(Number(id), admin);
    if (!acc) return show(ctx, denied());
    return fn(acc);
  }

  async function withFormat(ctx, admin, accId, fmtId, fn) {
    const acc = await visibleAccount(Number(accId), admin);
    if (!acc) return show(ctx, denied());
    const fmt = await getFormat(acc.id, fmtId);
    if (!fmt) {
      return show(ctx, {
        text: "❌ Format tidak ditemukan.",
        kb: buildKb([[["⬅️ Daftar Format", `wa:fmt:list:${acc.id}:0`]]])
      });
    }
    return fn(acc, fmt);
  }

  async function showFormatNote(tgId, acc, formatId) {
    const fmt = await getFormat(acc.id, formatId);
    if (!fmt) return note(tgId, "❌ Format tidak ditemukan.", backKb);
    const s = await screenFormat(acc, fmt);
    return note(tgId, s.text, s.kb);
  }

  /* ---------- Callback: menu & akun ---------- */

  bot.callbackQuery("whatsapp:menu", guard(async ctx => show(ctx, await screenMain())));
  bot.callbackQuery("wa:cancel", guard(async ctx => show(ctx, await screenMain())));

  bot.callbackQuery(/^wa:acc:list:(\d+)$/, guard(async (ctx, admin) =>
    show(ctx, await screenAccounts(admin, Number(ctx.match[1]), "own"))));

  // Akun WhatsApp milik user/admin lain: khusus OWNER.
  bot.callbackQuery(/^wa:acc:others:(\d+)$/, guard(async (ctx, admin) => {
    if (admin.role !== "OWNER") return show(ctx, denied());
    return show(ctx, await screenAccounts(admin, Number(ctx.match[1]), "others"));
  }));

  bot.callbackQuery("wa:acc:add", guard(async ctx => {
    setFlow(ctx.from.id, { t: "phone" });
    await show(ctx, {
      text: [
        "📱 <b>TAMBAH AKUN WHATSAPP</b>",
        RULE,
        "Kirim nomor WhatsApp yang akan ditautkan, dengan kode negara tanpa tanda +.",
        "Contoh : <code>628123456789</code>",
        "",
        "Bot akan mengirim kode pairing 8 digit. Masukkan di HP: Perangkat tertaut → Tautkan dengan nomor telepon."
      ].join("\n"),
      kb: buildKb([[["❌ Batal", "wa:cancel"]]])
    });
  }));

  bot.callbackQuery(/^wa:acc:view:(\d+)$/, guard((ctx, admin) =>
    withAccount(ctx, admin, ctx.match[1], async acc => show(ctx, await screenAccount(acc)))));

  bot.callbackQuery(/^wa:acc:status:(\d+)$/, guard((ctx, admin) =>
    withAccount(ctx, admin, ctx.match[1], async acc => show(ctx, await screenStatus(acc)))));

  bot.callbackQuery(/^wa:acc:settings:(\d+)$/, guard((ctx, admin) =>
    withAccount(ctx, admin, ctx.match[1], async acc => show(ctx, await screenSettings(acc)))));

  bot.callbackQuery(/^wa:acc:label:(\d+)$/, guard((ctx, admin) =>
    withAccount(ctx, admin, ctx.match[1], async acc => {
      setFlow(ctx.from.id, { t: "label", accountId: acc.id });
      await show(ctx, {
        text: `${RULE}\n🏷️ <b>UBAH NAMA AKUN</b>\nNama saat ini : <b>${esc(acc.label)}</b>\n\nKirim nama baru.`,
        kb: cancelAcc(acc.id)
      });
    })));

  bot.callbackQuery(/^wa:acc:disconnect:(\d+)$/, guard((ctx, admin) =>
    withAccount(ctx, admin, ctx.match[1], async acc => {
      await stopSocket(acc.id);
      await setAccountStatus(acc.id, "disconnected");
      return show(ctx, screenNotice("🔌 <b>AKUN DIPUTUS</b>", [
        "Sesi tetap tersimpan, akun bisa dihubungkan lagi kapan saja."
      ], accNoticeRows(acc.id)));
    })));

  bot.callbackQuery(/^wa:acc:connect:(\d+)$/, guard((ctx, admin) =>
    withAccount(ctx, admin, ctx.match[1], async acc => {
      if (!isRegistered(acc.id)) {
        // Nomor yang tidak pernah berhasil terhubung tidak disimpan sama sekali.
        if (await isGhost(acc)) {
          await dropAccount(acc.id);
          return show(ctx, screenNotice("❌ <b>SESI TIDAK DITEMUKAN</b>", [
            "Nomor ini belum pernah berhasil terhubung, jadi datanya dibersihkan.",
            "Tambahkan lagi untuk mendapat kode pairing baru."
          ], [[["➕ Tambah Akun", "wa:acc:add"]], [["⬅️ Menu WhatsApp", "whatsapp:menu"]]]));
        }
        return show(ctx, screenNotice("❌ <b>SESI TIDAK DITEMUKAN</b>", [
          `Sesi akun <b>${esc(acc.label)}</b> hilang dari server.`,
          "Hapus akun ini lalu tambah ulang dengan kode pairing."
        ], [[["🗑️ Hapus Akun", `wa:acc:del:${acc.id}`]], [["⬅️ Akun", `wa:acc:view:${acc.id}`]]]));
      }
      if (sockets.get(String(acc.id))) {
        return show(ctx, screenNotice("ℹ️ <b>SUDAH TERSAMBUNG</b>", [
          "Akun sudah tersambung atau sedang menyambung."
        ], accNoticeRows(acc.id)));
      }
      await setAccountStatus(acc.id, "connecting");
      await startSocket({ ...acc, status: "connecting" }, null);
      return show(ctx, screenNotice("🔗 <b>MENYAMBUNGKAN ULANG</b>", [
        "Tekan Refresh di Status beberapa detik lagi."
      ], accNoticeRows(acc.id, [[["📊 Status", `wa:acc:status:${acc.id}`]]])));
    })));

  // Batal saat menunggu kode pairing: nomor tidak disimpan.
  bot.callbackQuery(/^wa:pair:cancel:(\d+)$/, guard(async (ctx, admin) => {
    const acc = await visibleAccount(Number(ctx.match[1]), admin);
    if (acc && (pairings.has(String(acc.id)) || await isGhost(acc))) await dropAccount(acc.id);
    return show(ctx, await screenMain());
  }));

  bot.callbackQuery(/^wa:acc:stopall:(\d+)$/, guard((ctx, admin) =>
    withAccount(ctx, admin, ctx.match[1], async acc => {
      let n = 0;
      for (const f of await loadFormats(acc.id)) {
        if (f.active) { await stopFormat(acc, f.id, ctx.from.id); n++; }
      }
      const fresh = await visibleAccount(acc.id, admin);
      return show(ctx, withNote(await screenAccount(fresh), n ? `⏹ ${n} promosi dihentikan.` : "ℹ️ Tidak ada promosi yang berjalan."));
    })));

  bot.callbackQuery(/^wa:acc:del:(\d+)$/, guard((ctx, admin) =>
    withAccount(ctx, admin, ctx.match[1], async acc => show(ctx, confirmScreen(
      `🗑️ <b>HAPUS AKUN WHATSAPP?</b>\n${RULE}\nAkun <b>${esc(acc.label)}</b> akan diputus, sesinya dihapus, dan format serta grup targetnya ikut hilang.`,
      `wa:acc:delok:${acc.id}`,
      `wa:acc:view:${acc.id}`
    )))));

  bot.callbackQuery(/^wa:acc:delok:(\d+)$/, guard((ctx, admin) =>
    withAccount(ctx, admin, ctx.match[1], async acc => {
      for (const f of await loadFormats(acc.id)) {
        const t = tasks.get(`${acc.id}:${f.id}`);
        if (t) t.running = false;
        clearMedia(acc.id, f.id);
      }
      await stopSocket(acc.id, { logout: true });
      wipeSession(acc.id);
      await db().from("wa_accounts").delete().eq("id", acc.id);
      return show(ctx, await screenAccounts(admin, 0));
    })));

  bot.callbackQuery(/^wa:hist:(\d+)$/, guard((ctx, admin) =>
    withAccount(ctx, admin, ctx.match[1], async acc => show(ctx, await screenHistory(acc)))));

  /* ---------- Callback: grup target ---------- */

  bot.callbackQuery(/^wa:grp:list:(\d+):(\d+)$/, guard((ctx, admin) =>
    withAccount(ctx, admin, ctx.match[1], async acc =>
      show(ctx, await screenGroups(acc, Number(ctx.match[2]))))));

  bot.callbackQuery(/^wa:grp:search:(\d+)$/, guard((ctx, admin) =>
    withAccount(ctx, admin, ctx.match[1], async acc => {
      setFlow(ctx.from.id, { t: "gsearch", accountId: acc.id });
      await show(ctx, {
        text: `${RULE}\n🔎 <b>CARI GRUP</b>\nKirim sebagian nama grup yang dicari.`,
        kb: buildKb([[["❌ Batal", `wa:grp:list:${acc.id}:0`]]])
      });
    })));

  bot.callbackQuery(/^wa:grp:find:(\d+):([a-f0-9]+):(\d+)$/, guard((ctx, admin) =>
    withAccount(ctx, admin, ctx.match[1], async acc => {
      const s = searchTerms.get(ctx.match[2]);
      if (!s || s.accountId !== String(acc.id)) {
        return show(ctx, await screenGroups(acc, 0, { prefix: "⚠️ Pencarian sudah kedaluwarsa, silakan cari ulang." }));
      }
      return show(ctx, await screenGroups(acc, Number(ctx.match[3]), {
        term: s.term, rawTerm: s.rawTerm, token: ctx.match[2]
      }));
    })));

  bot.callbackQuery(/^wa:grp:tog:(\d+):(\d+):(.+)$/, guard((ctx, admin) =>
    withAccount(ctx, admin, ctx.match[1], async acc => {
      const gid = Number(ctx.match[2]);
      const { data: g } = await db().from("wa_account_groups").select("*")
        .eq("id", gid).eq("account_id", acc.id).maybeSingle();
      if (g && g.can_send) {
        await db().from("wa_account_groups").update({ enabled: !g.enabled }).eq("id", gid);
      }
      return show(ctx, await groupScreenFromBack(acc, ctx.match[3]));
    })));

  bot.callbackQuery(/^wa:grp:all:(\d+):(.+)$/, guard((ctx, admin) =>
    withAccount(ctx, admin, ctx.match[1], async acc => {
      await db().from("wa_account_groups").update({ enabled: true })
        .eq("account_id", acc.id).eq("can_send", true);
      return show(ctx, await groupScreenFromBack(acc, ctx.match[2], {
        prefix: "➕ Semua grup yang bisa dikirimi sudah dipilih."
      }));
    })));

  const detectHandler = guard((ctx, admin) =>
    withAccount(ctx, admin, ctx.match[1], async acc => {
      const r = await detectGroups(acc);
      const prefix = r.error ? r.error : `🔎 <b>${r.n}</b> grup terdeteksi.`;
      return show(ctx, await screenGroups(acc, 0, { prefix }));
    }));
  bot.callbackQuery(/^wa:grp:add:(\d+)$/, detectHandler);
  bot.callbackQuery(/^wa:grp:refresh:(\d+)$/, detectHandler);

  /* ---------- Callback: format ---------- */

  bot.callbackQuery(/^wa:fmt:list:(\d+):(\d+)$/, guard((ctx, admin) =>
    withAccount(ctx, admin, ctx.match[1], async acc =>
      show(ctx, await screenFormatList(acc, Number(ctx.match[2]), "all")))));

  bot.callbackQuery(/^wa:fmt:active:(\d+):(\d+)$/, guard((ctx, admin) =>
    withAccount(ctx, admin, ctx.match[1], async acc =>
      show(ctx, await screenFormatList(acc, Number(ctx.match[2]), "active")))));

  function nextFormatName(formats) {
    const nums = formats
      .map(f => /^Format (\d+)$/.exec(String(f.name || "")))
      .filter(Boolean)
      .map(m => Number(m[1]));
    return `Format ${(nums.length ? Math.max(...nums) : 0) + 1}`;
  }

  bot.callbackQuery(/^wa:fmt:add:(\d+)$/, guard((ctx, admin) =>
    withAccount(ctx, admin, ctx.match[1], async acc => {
      const formats = await loadFormats(acc.id);
      const fmt = {
        id: newId(),
        name: nextFormatName(formats),
        message: "",
        media: null,
        interval_minutes: DEFAULT_INTERVAL_SEC / 60,
        interval_seconds: DEFAULT_INTERVAL_SEC,
        duration_hours: 24,
        active: false,
        started_at: null,
        expires_at: null,
        created_at: nowIso()
      };
      formats.push(fmt);
      await saveFormats(acc.id, formats);
      setFlow(ctx.from.id, { t: "msg", accountId: acc.id, formatId: fmt.id });
      await show(ctx, {
        text: `✅ <b>Format ${formats.length}</b> dibuat.\n${RULE}\nKirim <b>teks</b> untuk isi pesan promosi.\nAtau kirim <b>foto/video</b> dengan caption.`,
        kb: cancelKb(acc.id, fmt.id)
      });
    })));

  bot.callbackQuery(/^wa:fmt:view:(\d+):([a-f0-9]+)$/, guard((ctx, admin) =>
    withFormat(ctx, admin, ctx.match[1], ctx.match[2], async (acc, fmt) =>
      show(ctx, await screenFormat(acc, fmt)))));

  bot.callbackQuery(/^wa:fmt:ask:(msg|photo|interval|duration):(\d+):([a-f0-9]+)$/, guard((ctx, admin) =>
    withFormat(ctx, admin, ctx.match[2], ctx.match[3], async (acc, fmt) => {
      const kind = ctx.match[1];
      setFlow(ctx.from.id, { t: kind, accountId: acc.id, formatId: fmt.id });
      await show(ctx, {
        text: ASK[kind],
        kb: buildKb([
          ...(kind === "msg" && fmt.media ? [[["🗑️ Hapus Media", `wa:fmt:nophoto:${acc.id}:${fmt.id}`]]] : []),
          [["❌ Batal", `wa:fmt:view:${acc.id}:${fmt.id}`]]
        ])
      });
    })));

  bot.callbackQuery(/^wa:fmt:nophoto:(\d+):([a-f0-9]+)$/, guard((ctx, admin) =>
    withFormat(ctx, admin, ctx.match[1], ctx.match[2], async (acc, fmt) => {
      clearMedia(acc.id, fmt.id);
      await updateFormat(acc.id, fmt.id, { media: null });
      return show(ctx, await screenFormat(acc, await getFormat(acc.id, fmt.id)));
    })));

  bot.callbackQuery(/^wa:fmt:start:(\d+):([a-f0-9]+)$/, guard((ctx, admin) =>
    withFormat(ctx, admin, ctx.match[1], ctx.match[2], async (acc, fmt) => {
      if (!fmt.message && !fmt.media) {
        return show(ctx, await formatWithNote(acc, fmt, "⚠️ Isi pesan atau foto dulu sebelum mulai."));
      }
      if (!sockets.get(String(acc.id))?.open) {
        return show(ctx, await formatWithNote(acc, fmt, "⚠️ Akun belum terhubung. Pastikan statusnya 🟢 Terhubung."));
      }
      if ((await enabledGroups(acc.id)).length === 0) {
        return show(ctx, await formatWithNote(acc, fmt, "⚠️ Belum ada grup target aktif."));
      }
      await startFormat(acc, fmt.id, ctx.from.id);
      return show(ctx, await screenFormat(acc, await getFormat(acc.id, fmt.id)));
    })));

  bot.callbackQuery(/^wa:fmt:stop:(\d+):([a-f0-9]+)$/, guard((ctx, admin) =>
    withFormat(ctx, admin, ctx.match[1], ctx.match[2], async (acc, fmt) => {
      await stopFormat(acc, fmt.id, ctx.from.id);
      return show(ctx, await screenFormat(acc, await getFormat(acc.id, fmt.id)));
    })));

  bot.callbackQuery(/^wa:fmt:del:(\d+):([a-f0-9]+)$/, guard((ctx, admin) =>
    withFormat(ctx, admin, ctx.match[1], ctx.match[2], async (acc, fmt) => show(ctx, confirmScreen(
      `🗑️ <b>HAPUS FORMAT?</b>\n${RULE}\nFormat <b>${esc(await fmtLabel(acc.id, fmt))}</b> dan medianya akan dihapus.`,
      `wa:fmt:delok:${acc.id}:${fmt.id}`,
      `wa:fmt:view:${acc.id}:${fmt.id}`
    )))));

  bot.callbackQuery(/^wa:fmt:delok:(\d+):([a-f0-9]+)$/, guard((ctx, admin) =>
    withFormat(ctx, admin, ctx.match[1], ctx.match[2], async (acc, fmt) => {
      const t = tasks.get(`${acc.id}:${fmt.id}`);
      if (t) t.running = false;
      clearMedia(acc.id, fmt.id);
      const formats = (await loadFormats(acc.id)).filter(f => f.id !== fmt.id);
      await saveFormats(acc.id, formats);
      return show(ctx, await screenFormatList(acc, 0, "all"));
    })));

  /* ---------- Input teks (nama, nomor, pesan, jeda, durasi, label, cari grup) ---------- */

  bot.on("message:text", async (ctx, next) => {
    const text = String(ctx.message.text || "").trim();
    const flow = getFlow(ctx.from.id);
    if (!flow || text.startsWith("/")) {
      if (text.startsWith("/")) clearFlow(ctx.from.id);
      return next();
    }

    const tgId = ctx.from.id;
    const admin = await adminOfTg(tgId);
    if (!admin || !canUseWhatsapp(admin.role)) { clearFlow(tgId); return next(); }

    try {
      if (flow.t === "photo") {
        return note(tgId, "🖼️ Kirim <b>foto</b> atau <b>video</b> untuk format ini, atau tekan Batal.", cancelKb(flow.accountId, flow.formatId));
      }

      if (flow.t === "phone") {
        const phone = text.replace(/[\s+\-]/g, "");
        if (!/^\d{8,15}$/.test(phone)) {
          return note(tgId, "❌ Nomor tidak valid. Contoh: 628123456789 (tanpa +).", buildKb([[["❌ Batal", "wa:cancel"]]]));
        }
        clearFlow(tgId);

        // Percobaan lama untuk nomor yang sama dibersihkan dulu, supaya tidak ada kode ganda yang saling membatalkan.
        const { data: olds } = await db().from("wa_accounts").select("*").eq("phone", phone);
        for (const o of olds || []) {
          if (pairings.has(String(o.id)) || await isGhost(o)) {
            await dropAccount(o.id).catch(e => console.error("WA DROP:", errText(e)));
          } else {
            const s = screenNotice("ℹ️ <b>NOMOR SUDAH TERDAFTAR</b>", [
              `📞 Nomor : <code>${esc(phone)}</code>`,
              "Nomor ini sudah punya akun WhatsApp. Hapus akun lamanya dulu kalau mau menautkan ulang."
            ], [[["📱 Akun WhatsApp", "wa:acc:list:0"]], [["⬅️ Menu WhatsApp", "whatsapp:menu"]]]);
            return note(tgId, s.text, s.kb);
          }
        }

        const { data, error } = await db().from("wa_accounts").insert({
          label: `WA ${phone}`,
          phone,
          status: "connecting",
          created_by: admin.telegram_user_id
        }).select().single();
        if (error) throw error;

        const prep = await note(tgId, "⏳ Menyiapkan koneksi. Kode pairing akan dikirim sebentar lagi.",
          buildKb([[["❌ Batal", `wa:pair:cancel:${data.id}`]]]));
        pairings.set(String(data.id), { tgId, phone, prepId: prep?.message_id ?? null, codeId: null, timer: null, paired: false });
        try {
          await startSocket(data, { tgId, phone });
        } catch (e) {
          console.error("WA START:", errText(e));
          await abortPairing(data, "❌ <b>KONEKSI GAGAL</b>", [esc(errText(e))]);
        }
        return;
      }

      const acc = await visibleAccount(flow.accountId, admin);
      if (!acc) { clearFlow(tgId); return note(tgId, denied().text, backKb); }

      if (flow.t === "name") {
        if (!text) return note(tgId, "❌ Nama format tidak boleh kosong.", buildKb([[["❌ Batal", `wa:fmt:list:${acc.id}:0`]]]));
        const fmt = {
          id: newId(),
          name: text,
          message: "",
          media: null,
          interval_minutes: DEFAULT_INTERVAL_SEC / 60,
          interval_seconds: DEFAULT_INTERVAL_SEC,
          duration_hours: 24,
          active: false,
          started_at: null,
          expires_at: null,
          created_at: nowIso()
        };
        const formats = await loadFormats(acc.id);
        formats.push(fmt);
        await saveFormats(acc.id, formats);
        setFlow(tgId, { t: "msg", accountId: acc.id, formatId: fmt.id });
        return note(tgId,
          `✅ Format <b>${esc(trunc(text, 100))}</b> dibuat.\n\n✏️ Kirim isi pesan promosinya sekarang.`,
          cancelKb(acc.id, fmt.id));
      }

      if (flow.t === "msg") {
        if (!text) return note(tgId, "❌ Isi pesan tidak boleh kosong.", cancelKb(acc.id, flow.formatId));
        await updateFormat(acc.id, flow.formatId, { message: text });
        clearFlow(tgId);
        return showFormatNote(tgId, acc, flow.formatId);
      }

      if (flow.t === "interval") {
        const sec = parseInterval(text);
        if (!sec) {
          return note(tgId, "❌ Jeda tidak valid. Contoh: 30 detik, 5 menit, 1 jam", cancelKb(acc.id, flow.formatId));
        }
        await updateFormat(acc.id, flow.formatId, {
          interval_seconds: sec,
          interval_minutes: Math.max(1, Math.round(sec / 60))
        });
        clearFlow(tgId);
        return showFormatNote(tgId, acc, flow.formatId);
      }

      if (flow.t === "duration") {
        const h = D().parseHours(text);
        if (!h) return note(tgId, "❌ Format durasi tidak valid. Contoh: 1 jam, 3 hari", cancelKb(acc.id, flow.formatId));
        await updateFormat(acc.id, flow.formatId, { duration_hours: h });
        clearFlow(tgId);
        return showFormatNote(tgId, acc, flow.formatId);
      }

      if (flow.t === "label") {
        if (!text) return note(tgId, "❌ Nama tidak boleh kosong.", cancelAcc(acc.id));
        await db().from("wa_accounts").update({ label: trunc(text, 60), updated_at: nowIso() }).eq("id", acc.id);
        clearFlow(tgId);
        const fresh = await visibleAccount(acc.id, admin);
        const s = await screenAccount(fresh);
        return note(tgId, `✅ Nama akun diubah.\n\n${s.text}`, s.kb);
      }

      if (flow.t === "gsearch") {
        if (!text) return note(tgId, "❌ Kata pencarian tidak boleh kosong.", cancelAcc(acc.id));
        const rawTerm = trunc(text, 60);
        const token = newId();
        searchTerms.set(token, { accountId: String(acc.id), term: rawTerm.toLowerCase(), rawTerm });
        if (searchTerms.size > 200) searchTerms.delete(searchTerms.keys().next().value);
        clearFlow(tgId);
        const s = await screenGroups(acc, 0, { term: rawTerm.toLowerCase(), rawTerm, token });
        return note(tgId, s.text, s.kb);
      }

      clearFlow(tgId);
      return next();
    } catch (e) {
      console.error("WA INPUT:", errText(e));
      return note(tgId, `❌ <b>Gagal memproses input.</b>\n\n${esc(errText(e))}`, backKb);
    }
  });

  /* ---------- Input foto/video (media format) ---------- */

  bot.on(["message:photo", "message:video"], async (ctx, next) => {
    const flow = getFlow(ctx.from.id);
    if (!flow) return next();
    const tgId = ctx.from.id;

    if (flow.t !== "photo" && flow.t !== "msg") {
      return note(tgId, "✏️ Kamu sedang mengisi sesuatu. Kirim teks, atau tekan Batal dulu.", cancelKb(flow.accountId, flow.formatId));
    }

    const admin = await adminOfTg(tgId);
    if (!admin || !canUseWhatsapp(admin.role)) { clearFlow(tgId); return next(); }

    try {
      const acc = await visibleAccount(flow.accountId, admin);
      if (!acc) { clearFlow(tgId); return note(tgId, denied().text, backKb); }

      const isVideo = !!ctx.message.video;
      const media = isVideo ? ctx.message.video : ctx.message.photo[ctx.message.photo.length - 1];
      if (Number(media.file_size || 0) > 2 * 1024 * 1024 * 1024) {
        return note(tgId, "❌ Video terlalu besar. Maksimal 2 GB.", cancelKb(flow.accountId, flow.formatId));
      }

      const tmpDest = mediaPath(acc.id, flow.formatId, isVideo ? "mp4" : "jpg");
      await D().downloadTelegramMedia(
        { fileId: media.file_id, messageId: ctx.message.message_id, fileSize: media.file_size },
        tmpDest
      );
      // Media lama (jenis lain) dibersihkan setelah yang baru sukses tersimpan.
      for (const ext of ["jpg", "mp4"]) {
        const other = mediaPath(acc.id, flow.formatId, ext);
        if (other !== tmpDest) fs.rmSync(other, { force: true });
      }
      const dest = tmpDest;
      const caption = String(ctx.message.caption || "").trim();
      const patch = { media: dest };
      if (caption) patch.message = caption;
      await updateFormat(acc.id, flow.formatId, patch);
      clearFlow(tgId);
      return showFormatNote(tgId, acc, flow.formatId);
    } catch (e) {
      console.error("WA MEDIA:", errText(e));
      return note(tgId, `❌ Gagal menyimpan media.\n${esc(errText(e))}`, cancelKb(flow.accountId, flow.formatId));
    }
  });

  /* ---------- Startup: sambungkan ulang sesi & lanjutkan promosi aktif ---------- */

  async function restore() {
    await purgeGhosts().catch(e => console.error("WA PURGE:", errText(e)));
    const { data: accs, error } = await db().from("wa_accounts").select("*").neq("status", "disconnected");
    if (error) throw error;
    for (const acc of accs || []) {
      if (!isRegistered(acc.id)) continue;
      startSocket(acc, null).catch(e => console.error("WA RESTORE:", errText(e)));
    }

    const { data: settings, error: sErr } = await db().from("wa_account_settings").select("account_id,formats");
    if (sErr) throw sErr;
    for (const s of settings || []) {
      for (const f of Array.isArray(s.formats) ? s.formats : []) {
        if (f.active) startLoop(s.account_id, f.id);
      }
    }
  }

  return { restore };
}

module.exports = { register };
