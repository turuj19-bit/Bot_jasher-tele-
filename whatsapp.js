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
const baileys = require("@whiskeysockets/baileys");

const makeWASocket = baileys.default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

const SESSION_ROOT = process.env.WA_SESSION_DIR || path.join(__dirname, "wa_sessions");
const MEDIA_ROOT = process.env.WA_MEDIA_DIR || path.join(__dirname, "wa_media");
const PAGE = 8;
const MIN_INTERVAL_MIN = 30;            // jeda minimum antar putaran (menit)
const GROUP_DELAY_MIN_MS = 20 * 1000;   // jeda acak antar grup
const GROUP_DELAY_MAX_MS = 60 * 1000;
const DAILY_CAP = 200;                  // maksimal kirim per akun per hari
const FLOW_TTL_MS = 10 * 60 * 1000;
const RULE = "━━━━━━━━━━━━━━━━━━";

fs.mkdirSync(SESSION_ROOT, { recursive: true });
fs.mkdirSync(MEDIA_ROOT, { recursive: true });

// State runtime (memori). Data tetap di tabel wa_*.
const sockets = new Map(); // accountId -> { sock, open, stopping }
const tasks = new Map();   // "accountId:formatId" -> { running }
const flows = new Map();   // telegramId -> { t, accountId?, formatId?, at }
const daily = new Map();   // accountId -> { day, n }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const newId = () => crypto.randomBytes(4).toString("hex");
const nowIso = () => new Date().toISOString();
const trunc = (s, n) => Array.from(String(s ?? "")).slice(0, n).join("");
const mins = m => (m >= 60 && m % 60 === 0 ? `${m / 60} jam` : `${m} menit`);
const hours = h => (h >= 24 && h % 24 === 0 ? `${h / 24} hari` : `${h} jam`);
const dateText = v => (v ? new Date(v).toLocaleString("id-ID") : "-");
const mediaPath = (accId, fmtId) => path.join(MEDIA_ROOT, `${accId}_${fmtId}.jpg`);
const sessionDir = id => path.join(SESSION_ROOT, String(id));

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

  const show = (ctx, s) => D().replaceUi(ctx, s.text, s.kb, { parse_mode: "HTML" });
  const note = (tgId, text, kb) => D().renderUi(tgId, text, kb, { parse_mode: "HTML" });
  const cancelKb = (accId, fmtId) => buildKb([[["❌ Batal", `wa:fmt:view:${accId}:${fmtId}`]]]);
  const backKb = buildKb([[["⬅️ Menu WhatsApp", "whatsapp:menu"]]]);
  const denied = () => ({ text: "⛔ Akun tidak ditemukan atau bukan milikmu.", kb: backKb });
  const confirmScreen = (text, yes, no) => ({ text, kb: buildKb([[["✅ Ya, hapus", yes], ["❌ Batal", no]]]) });
  const statusLabel = a =>
    a.status === "connected" ? "🟢 Terhubung"
      : a.status === "connecting" ? "🟡 Menunggu kode pairing"
        : a.status === "error" ? "🟠 Error, mencoba sambung ulang"
          : "⚪ Terputus";

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

  async function setAccountStatus(id, status, jid) {
    const patch = { status, updated_at: nowIso() };
    if (jid !== undefined) patch.jid = jid;
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
      return JSON.parse(fs.readFileSync(path.join(sessionDir(id), "creds.json"), "utf8"))?.registered === true;
    } catch (_) {
      return false;
    }
  }

  function wipeSession(id) {
    fs.rmSync(sessionDir(id), { recursive: true, force: true });
  }

  async function refreshGroups(accountId, sock) {
    const all = await sock.groupFetchAllParticipating();
    const me = sock.user?.id ? sock.user.id.split(":")[0] : null;
    const rows = Object.values(all || {}).map(g => {
      const mine = (g.participants || []).find(p => p.id?.split("@")[0] === me);
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

  async function startSocket(acc, pairing) {
    fs.mkdirSync(sessionDir(acc.id), { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir(acc.id));
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch (_) { /* pakai default */ }

    const sock = makeWASocket({
      auth: state,
      ...(version ? { version } : {}),
      logger: pino({ level: "silent" }),
      browser: ["Ubuntu", "Chrome", "22.04.4"],
      syncFullHistory: false,
      markOnlineOnConnect: false
    });

    const entry = { sock, open: false, stopping: false };
    sockets.set(String(acc.id), entry);
    sock.ev.on("creds.update", saveCreds);

    let notifyTg = pairing?.tgId ?? null;

    if (pairing && !state.creds.registered) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(pairing.phone);
          const shown = code.match(/.{1,4}/g)?.join("-") || code;
          await bot.api.sendMessage(pairing.tgId,
            `🔑 <b>KODE PAIRING WHATSAPP</b>\n${RULE}\nNomor: <code>${esc(pairing.phone)}</code>\nKode: <code>${esc(shown)}</code>\n\nDi HP: WhatsApp → Perangkat tertaut → Tautkan perangkat → Tautkan dengan nomor telepon, lalu masukkan kode ini.`,
            { parse_mode: "HTML" });
        } catch (e) {
          await bot.api.sendMessage(pairing.tgId,
            `❌ Gagal meminta kode pairing.\n${esc(errText(e))}`,
            { parse_mode: "HTML" }).catch(() => {});
        }
      }, 3000);
    }

    sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
      try {
        if (connection === "open") {
          entry.open = true;
          const jid = sock.user?.id ? `${sock.user.id.split(":")[0]}@s.whatsapp.net` : null;
          await setAccountStatus(acc.id, "connected", jid);
          const total = await refreshGroups(acc.id, sock).catch(() => 0);
          if (notifyTg) {
            await bot.api.sendMessage(notifyTg,
              `✅ WhatsApp <b>${esc(acc.label)}</b> terhubung. ${total} grup terdeteksi.`,
              { parse_mode: "HTML" }).catch(() => {});
            notifyTg = null;
          }
        }

        if (connection === "close") {
          entry.open = false;
          if (entry.stopping) return;
          sockets.delete(String(acc.id));
          const code = lastDisconnect?.error?.output?.statusCode;
          if (code === DisconnectReason.loggedOut) {
            await setAccountStatus(acc.id, "disconnected", null);
            wipeSession(acc.id);
            return;
          }
          await setAccountStatus(acc.id, "error").catch(() => {});
          setTimeout(() => reconnect(acc.id), 5000);
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
    return !!cur && cur.day === today && cur.n >= DAILY_CAP;
  }

  async function waitTask(task, ms) {
    const end = Date.now() + ms;
    while (task.running && Date.now() < end) {
      await sleep(Math.min(1000, end - Date.now()));
    }
  }

  async function sendFormat(sock, jid, fmt) {
    if (fmt.media && fs.existsSync(fmt.media)) {
      return sock.sendMessage(jid, {
        image: fs.readFileSync(fmt.media),
        caption: fmt.message || undefined
      });
    }
    return sock.sendMessage(jid, { text: fmt.message });
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

          for (const g of groups) {
            if (!task.running) break;
            if (overDailyCap(accountId)) {
              await waitTask(task, 60 * 60 * 1000);
              break;
            }
            const sock = sockets.get(String(accountId))?.sock;
            try {
              if (!sock) throw new Error("Akun WhatsApp terputus");
              await sendFormat(sock, g.group_jid, fmt);
              bumpDaily(accountId);
              await logHistory(acc, null, "promotion_send", "success", { group_title: g.title });
            } catch (e) {
              await logHistory(acc, null, "promotion_send", "error", { group_title: g.title, error: errText(e) });
            }
            await waitTask(task, rnd(GROUP_DELAY_MIN_MS, GROUP_DELAY_MAX_MS));
          }

          await waitTask(task, Math.max(MIN_INTERVAL_MIN, fmt.interval_minutes) * 60 * 1000);
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
    await updateFormat(acc.id, formatId, { active: true, started_at: nowIso(), expires_at: expires });
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

  async function screenAccounts(admin, page) {
    let q = db().from("wa_accounts").select("*", { count: "exact" })
      .order("id", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (admin.role !== "OWNER") q = q.eq("created_by", admin.telegram_user_id);
    const { data, count, error } = await q;
    if (error) throw error;

    const total = count || 0;
    const rows = (data || []).map(a => [[
      `${a.status === "connected" ? "🟢" : "⚪"} ${trunc(a.label, 28)}`,
      `wa:acc:view:${a.id}`
    ]]);
    const nav = [];
    if (page > 0) nav.push(["◀️", `wa:acc:list:${page - 1}`]);
    if ((page + 1) * PAGE < total) nav.push(["▶️", `wa:acc:list:${page + 1}`]);

    return {
      text: ["📱 <b>AKUN WHATSAPP</b>", RULE, `Total akun: <b>${total}</b>`, total ? "" : "<i>Belum ada akun WhatsApp.</i>"].join("\n"),
      kb: buildKb([
        ...rows,
        nav,
        [["➕ Tambah Akun", "wa:acc:add"]],
        [["⬅️ Menu WhatsApp", "whatsapp:menu"]]
      ])
    };
  }

  async function screenAccount(acc) {
    const { data: groups } = await db().from("wa_account_groups").select("enabled").eq("account_id", acc.id);
    const formats = await loadFormats(acc.id);
    const g = groups || [];
    return {
      text: [
        `📱 <b>${esc(acc.label)}</b>`,
        RULE,
        `Status: ${statusLabel(acc)}`,
        `Nomor: <code>${esc(acc.phone || "-")}</code>`,
        `Grup target aktif: <b>${g.filter(x => x.enabled).length}</b> dari ${g.length}`,
        `Format: <b>${formats.length}</b> (berjalan ${formats.filter(f => f.active).length})`
      ].join("\n"),
      kb: buildKb([
        [["📝 Format", `wa:fmt:list:${acc.id}:0`], ["🎯 Grup Target", `wa:grp:list:${acc.id}:0`]],
        [["🔄 Muat Ulang Grup", `wa:grp:refresh:${acc.id}`], ["🕒 Riwayat", `wa:hist:${acc.id}`]],
        [["🗑️ Hapus Akun", `wa:acc:del:${acc.id}`]],
        [["⬅️ Daftar Akun", "wa:acc:list:0"]]
      ])
    };
  }

  async function screenGroups(acc, page) {
    const { data, count, error } = await db().from("wa_account_groups").select("*", { count: "exact" })
      .eq("account_id", acc.id)
      .order("title", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw error;

    const total = count || 0;
    const rows = (data || []).map(g => [[
      `${g.enabled ? "✅" : "⬜"} ${trunc(g.title, 30)}${g.can_send ? "" : " 🔒"}`,
      `wa:grp:tog:${acc.id}:${g.id}:${page}`
    ]]);
    const nav = [];
    if (page > 0) nav.push(["◀️", `wa:grp:list:${acc.id}:${page - 1}`]);
    if ((page + 1) * PAGE < total) nav.push(["▶️", `wa:grp:list:${acc.id}:${page + 1}`]);

    return {
      text: [
        "🎯 <b>GRUP TARGET</b>",
        RULE,
        `Akun: <b>${esc(acc.label)}</b>`,
        `Total grup: <b>${total}</b>`,
        "",
        "✅ = jadi target promosi · 🔒 = hanya admin yang bisa kirim",
        total ? "" : "<i>Belum ada grup. Tekan Muat Ulang Grup setelah akun terhubung.</i>"
      ].join("\n"),
      kb: buildKb([
        ...rows,
        nav,
        [["🔄 Muat Ulang Grup", `wa:grp:refresh:${acc.id}`]],
        [["⬅️ Kembali", `wa:acc:view:${acc.id}`]]
      ])
    };
  }

  async function screenFormatList(acc, page) {
    const formats = await loadFormats(acc.id);
    const rows = formats.slice(page * PAGE, page * PAGE + PAGE).map(f => [[
      `${f.active ? "▶️" : "⏹"} ${trunc(f.name, 28)}`,
      `wa:fmt:view:${acc.id}:${f.id}`
    ]]);
    const nav = [];
    if (page > 0) nav.push(["◀️", `wa:fmt:list:${acc.id}:${page - 1}`]);
    if ((page + 1) * PAGE < formats.length) nav.push(["▶️", `wa:fmt:list:${acc.id}:${page + 1}`]);

    return {
      text: [
        "📝 <b>FORMAT PROMOSI</b>",
        RULE,
        `Akun: <b>${esc(acc.label)}</b>`,
        `Total format: <b>${formats.length}</b>`,
        formats.length ? "" : "<i>Belum ada format.</i>"
      ].join("\n"),
      kb: buildKb([
        ...rows,
        nav,
        [["➕ Format Baru", `wa:fmt:add:${acc.id}`]],
        [["⬅️ Kembali", `wa:acc:view:${acc.id}`]]
      ])
    };
  }

  async function screenFormat(acc, fmt) {
    const id = acc.id;
    const f = fmt.id;
    const preview = fmt.message ? esc(trunc(fmt.message, 400)) : "<i>Belum diisi</i>";
    const lines = [
      `${fmt.active ? "▶️" : "⏹"} <b>${esc(fmt.name)}</b>`,
      RULE,
      `Status: ${fmt.active ? "Berjalan" : "Berhenti"}`,
      `Jenis: ${fmt.media ? "🖼️ Foto + teks" : "📝 Teks saja"}`,
      `Jeda: <b>${mins(fmt.interval_minutes)}</b> · Durasi: <b>${hours(fmt.duration_hours)}</b>`
    ];
    if (fmt.active && fmt.expires_at) lines.push(`Berakhir: ${esc(dateText(fmt.expires_at))}`);
    lines.push("", "<b>Isi pesan:</b>", preview);

    return {
      text: lines.join("\n"),
      kb: buildKb([
        [["✏️ Ubah Pesan", `wa:fmt:ask:msg:${id}:${f}`]],
        [
          [fmt.media ? "🔁 Ganti Foto" : "🖼️ Tambah Foto", `wa:fmt:ask:photo:${id}:${f}`],
          fmt.media ? ["🗑️ Hapus Foto", `wa:fmt:nophoto:${id}:${f}`] : null
        ],
        [["⏱️ Jeda", `wa:fmt:ask:interval:${id}:${f}`], ["📅 Durasi", `wa:fmt:ask:duration:${id}:${f}`]],
        [fmt.active ? ["⏹ Stop", `wa:fmt:stop:${id}:${f}`] : ["▶️ Mulai", `wa:fmt:start:${id}:${f}`]],
        [["🗑️ Hapus Format", `wa:fmt:del:${id}:${f}`]],
        [["⬅️ Daftar Format", `wa:fmt:list:${id}:0`]]
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
      `• ${esc(dateText(h.created_at))}\n   ${esc(h.action)} · ${esc(h.status)}` +
      (h.group_title ? ` · ${esc(trunc(h.group_title, 30))}` : "") +
      (h.error ? `\n   <i>${esc(trunc(h.error, 120))}</i>` : "")
    );
    return {
      text: [
        "🕒 <b>RIWAYAT TERAKHIR</b>",
        RULE,
        `Akun: <b>${esc(acc.label)}</b>`,
        "",
        ...(lines.length ? lines : ["<i>Belum ada riwayat.</i>"])
      ].join("\n"),
      kb: buildKb([[["⬅️ Kembali", `wa:acc:view:${acc.id}`]]])
    };
  }

  const ASK = {
    msg: "✏️ Kirim isi pesan promosi sekarang.\nBisa memakai emoji dan format WhatsApp: *tebal*, _miring_, ~coret~.",
    photo: "🖼️ Kirim foto (sebagai foto, bukan file). Isi pesan akan dipakai sebagai caption.",
    interval: `⏱️ Kirim jeda antar putaran, minimal ${MIN_INTERVAL_MIN} menit.\nContoh: 30 menit, 1 jam`,
    duration: "📅 Kirim durasi promosi.\nContoh: 1 jam, 3 hari"
  };

  /* ---------- Guard & lookup ---------- */

  function guard(fn) {
    return async ctx => {
      const admin = await D().requireAdmin(ctx);
      if (!admin) return;
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
    show(ctx, await screenAccounts(admin, Number(ctx.match[1])))));

  bot.callbackQuery("wa:acc:add", guard(async ctx => {
    setFlow(ctx.from.id, { t: "phone" });
    await show(ctx, {
      text: [
        "📱 <b>TAMBAH AKUN WHATSAPP</b>",
        RULE,
        "Kirim nomor WhatsApp yang akan ditautkan, dengan kode negara tanpa tanda +.",
        "Contoh: <code>628123456789</code>",
        "",
        "Bot akan mengirim kode pairing 8 digit. Masukkan di HP: Perangkat tertaut → Tautkan dengan nomor telepon."
      ].join("\n"),
      kb: buildKb([[["❌ Batal", "wa:cancel"]]])
    });
  }));

  bot.callbackQuery(/^wa:acc:view:(\d+)$/, guard((ctx, admin) =>
    withAccount(ctx, admin, ctx.match[1], async acc => show(ctx, await screenAccount(acc)))));

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
        fs.rmSync(mediaPath(acc.id, f.id), { force: true });
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

  bot.callbackQuery(/^wa:grp:tog:(\d+):(\d+):(\d+)$/, guard((ctx, admin) =>
    withAccount(ctx, admin, ctx.match[1], async acc => {
      const gid = Number(ctx.match[2]);
      const { data: g } = await db().from("wa_account_groups").select("*")
        .eq("id", gid).eq("account_id", acc.id).maybeSingle();
      if (g) await db().from("wa_account_groups").update({ enabled: !g.enabled }).eq("id", gid);
      return show(ctx, await screenGroups(acc, Number(ctx.match[3])));
    })));

  bot.callbackQuery(/^wa:grp:refresh:(\d+)$/, guard((ctx, admin) =>
    withAccount(ctx, admin, ctx.match[1], async acc => {
      const entry = sockets.get(String(acc.id));
      let msg = "";
      if (!entry?.open) {
        msg = "⚠️ Akun belum terhubung, grup belum bisa dimuat ulang.\n\n";
      } else {
        try {
          const n = await refreshGroups(acc.id, entry.sock);
          msg = `✅ ${n} grup dimuat ulang.\n\n`;
        } catch (e) {
          msg = `❌ ${esc(errText(e))}\n\n`;
        }
      }
      const s = await screenGroups(acc, 0);
      return show(ctx, { text: msg + s.text, kb: s.kb });
    })));

  /* ---------- Callback: format ---------- */

  bot.callbackQuery(/^wa:fmt:list:(\d+):(\d+)$/, guard((ctx, admin) =>
    withAccount(ctx, admin, ctx.match[1], async acc =>
      show(ctx, await screenFormatList(acc, Number(ctx.match[2]))))));

  bot.callbackQuery(/^wa:fmt:add:(\d+)$/, guard((ctx, admin) =>
    withAccount(ctx, admin, ctx.match[1], async acc => {
      setFlow(ctx.from.id, { t: "name", accountId: acc.id });
      await show(ctx, {
        text: `📝 <b>FORMAT BARU</b>\n${RULE}\nKirim nama format (maks 40 karakter).\nNama ini hanya untuk pengenal di menu.`,
        kb: buildKb([[["❌ Batal", `wa:fmt:list:${acc.id}:0`]]])
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
        text: `${RULE}\n${ASK[kind]}`,
        kb: cancelKb(acc.id, fmt.id)
      });
    })));

  bot.callbackQuery(/^wa:fmt:nophoto:(\d+):([a-f0-9]+)$/, guard((ctx, admin) =>
    withFormat(ctx, admin, ctx.match[1], ctx.match[2], async (acc, fmt) => {
      fs.rmSync(mediaPath(acc.id, fmt.id), { force: true });
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
      `🗑️ <b>HAPUS FORMAT?</b>\n${RULE}\nFormat <b>${esc(fmt.name)}</b> dan fotonya akan dihapus.`,
      `wa:fmt:delok:${acc.id}:${fmt.id}`,
      `wa:fmt:view:${acc.id}:${fmt.id}`
    )))));

  bot.callbackQuery(/^wa:fmt:delok:(\d+):([a-f0-9]+)$/, guard((ctx, admin) =>
    withFormat(ctx, admin, ctx.match[1], ctx.match[2], async (acc, fmt) => {
      const t = tasks.get(`${acc.id}:${fmt.id}`);
      if (t) t.running = false;
      fs.rmSync(mediaPath(acc.id, fmt.id), { force: true });
      const formats = (await loadFormats(acc.id)).filter(f => f.id !== fmt.id);
      await saveFormats(acc.id, formats);
      return show(ctx, await screenFormatList(acc, 0));
    })));

  /* ---------- Input teks (nama, nomor, pesan, jeda, durasi) ---------- */

  bot.on("message:text", async (ctx, next) => {
    const text = String(ctx.message.text || "").trim();
    const flow = getFlow(ctx.from.id);
    if (!flow || text.startsWith("/")) {
      if (text.startsWith("/")) clearFlow(ctx.from.id);
      return next();
    }

    const tgId = ctx.from.id;
    const admin = await adminOfTg(tgId);
    if (!admin) { clearFlow(tgId); return next(); }

    try {
      if (flow.t === "photo") {
        return note(tgId, "🖼️ Kirim <b>foto</b> untuk format ini, atau tekan Batal.", cancelKb(flow.accountId, flow.formatId));
      }

      if (flow.t === "phone") {
        const phone = text.replace(/[\s+\-]/g, "");
        if (!/^\d{8,15}$/.test(phone)) {
          return note(tgId, "❌ Nomor tidak valid. Contoh: 628123456789 (tanpa +).", buildKb([[["❌ Batal", "wa:cancel"]]]));
        }
        clearFlow(tgId);
        const { data, error } = await db().from("wa_accounts").insert({
          label: `WA ${phone}`,
          phone,
          status: "connecting",
          created_by: admin.telegram_user_id
        }).select().single();
        if (error) throw error;
        await startSocket(data, { tgId, phone });
        return note(tgId, "⏳ Menyiapkan koneksi. Kode pairing akan dikirim sebentar lagi.",
          buildKb([[["📱 Akun WhatsApp", "wa:acc:list:0"]]]));
      }

      const acc = await visibleAccount(flow.accountId, admin);
      if (!acc) { clearFlow(tgId); return note(tgId, denied().text, backKb); }

      if (flow.t === "name") {
        if (!text || text.length > 40) {
          return note(tgId, "❌ Nama format 1–40 karakter.", buildKb([[["❌ Batal", `wa:fmt:list:${acc.id}:0`]]]));
        }
        const fmt = {
          id: newId(),
          name: text,
          message: "",
          media: null,
          interval_minutes: MIN_INTERVAL_MIN,
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
          `✅ Format <b>${esc(text)}</b> dibuat.\n\n✏️ Kirim isi pesan promosinya sekarang.`,
          cancelKb(acc.id, fmt.id));
      }

      if (flow.t === "msg") {
        if (!text || text.length > 4000) return note(tgId, "❌ Isi pesan 1–4000 karakter.", cancelKb(acc.id, flow.formatId));
        await updateFormat(acc.id, flow.formatId, { message: text });
        clearFlow(tgId);
        return showFormatNote(tgId, acc, flow.formatId);
      }

      if (flow.t === "interval") {
        const m = D().parseMinutes(text);
        if (!m || m < MIN_INTERVAL_MIN) {
          return note(tgId, `❌ Jeda minimal ${MIN_INTERVAL_MIN} menit. Contoh: 30 menit, 1 jam`, cancelKb(acc.id, flow.formatId));
        }
        await updateFormat(acc.id, flow.formatId, { interval_minutes: m });
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

      clearFlow(tgId);
      return next();
    } catch (e) {
      console.error("WA INPUT:", errText(e));
      return note(tgId, `❌ <b>Gagal memproses input.</b>\n\n${esc(errText(e))}`, backKb);
    }
  });

  /* ---------- Input foto (gambar format) ---------- */

  bot.on("message:photo", async (ctx, next) => {
    const flow = getFlow(ctx.from.id);
    if (!flow) return next();
    const tgId = ctx.from.id;

    if (flow.t !== "photo") {
      return note(tgId, "✏️ Kamu sedang mengisi sesuatu. Kirim teks, atau tekan Batal dulu.", cancelKb(flow.accountId, flow.formatId));
    }

    const admin = await adminOfTg(tgId);
    if (!admin) { clearFlow(tgId); return next(); }

    try {
      const acc = await visibleAccount(flow.accountId, admin);
      if (!acc) { clearFlow(tgId); return note(tgId, denied().text, backKb); }

      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      const file = await ctx.api.getFile(photo.file_id);
      const res = await fetch(`https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`);
      if (!res.ok) throw new Error("Gagal mengunduh foto dari Telegram.");

      const dest = mediaPath(acc.id, flow.formatId);
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      await updateFormat(acc.id, flow.formatId, { media: dest });
      clearFlow(tgId);
      return showFormatNote(tgId, acc, flow.formatId);
    } catch (e) {
      console.error("WA PHOTO:", errText(e));
      return note(tgId, `❌ Gagal menyimpan foto.\n${esc(errText(e))}`, cancelKb(flow.accountId, flow.formatId));
    }
  });

  /* ---------- Startup: sambungkan ulang sesi & lanjutkan promosi aktif ---------- */

  async function restore() {
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
