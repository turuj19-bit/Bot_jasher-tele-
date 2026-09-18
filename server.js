/* =========================================================================
   TELEGRAM AUTO PROMOTION BOT - MULTI ACCOUNT ADMIN CENTER v3.0
   - Satu bot admin, banyak akun Telegram per akun.
   - Setiap akun punya grup, format, delay, durasi, dan scheduler sendiri.
   - Admin owner: kelola admin. Admin biasa: kelola akun & promosi.
   ========================================================================= */
require("dotenv").config();

const express = require("express");
const { Bot, InlineKeyboard, InputFile } = require("grammy");
const { createClient } = require("@supabase/supabase-js");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");

let ws = null;
try { ws = require("ws"); } catch (_) { /* opsional */ }

/* =========================
   CONFIG
========================= */
const PORT = Number(process.env.PORT || 3000);
const BOT_VERSION = String(process.env.BOT_VERSION || "3.0.0").trim();
const SEED_ADMIN_IDS = String(process.env.ADMIN_IDS || "")
  .split(",").map(x => x.trim()).filter(Boolean);

const START_BANNER_FILE_ID = String(process.env.START_BANNER_FILE_ID || "").trim();
const START_BANNER_URL = String(
  process.env.START_BANNER_URL ||
  "https://cdn.phototourl.com/free/2026-09-17-491f8197-8c02-4344-8754-8314826f54f4.jpg"
).trim();

/* =========================
   SUPABASE
========================= */
const supabaseOptions = ws ? { realtime: { transport: ws } } : {};
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  supabaseOptions
);

/* =========================
   BOT
========================= */
const bot = new Bot(process.env.BOT_TOKEN);

/* =========================
   STATE (in-memory)
========================= */
const clients      = new Map(); // accountId -> TelegramClient
const schedulers   = new Map(); // accountId -> { timer }
const flows        = new Map(); // adminUserId -> { t, ... }
const waiters      = new Map(); // adminUserId -> { type, resolve, reject, timer }
const uiMessages   = new Map(); // adminUserId -> { chatId, messageId, isMedia }

/* =========================
   UTIL
========================= */
function escapeHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function safeButtonText(v, max = 28) {
  const text = String(v ?? "Tanpa Nama")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
  return Array.from(text).slice(0, max).join("");
}
function nowIso() { return new Date().toISOString(); }

function formatInterval(minutes) {
  const m = Number(minutes || 0);
  if (!m) return "-";
  if (m % 1440 === 0) return `${m / 1440} hari`;
  if (m % 60 === 0) return `${m / 60} jam`;
  return `${m} menit`;
}
function formatDuration(hours) {
  const h = Number(hours || 0);
  if (!h) return "-";
  if (h % 24 === 0) return `${h / 24} hari`;
  return `${h} jam`;
}
function parseMinutes(value) {
  const m = String(value || "").trim().toLowerCase()
    .match(/^(\d+(?:\.\d+)?)\s*(menit|jam|hari|m|h|d)$/);
  if (!m) return null;
  const unit = { menit: 1, m: 1, jam: 60, h: 60, hari: 1440, d: 1440 }[m[2]];
  const minutes = Math.round(Number(m[1]) * unit);
  return Number.isFinite(minutes) ? minutes : null;
}
function parseHours(value) {
  const m = String(value || "").trim().toLowerCase()
    .match(/^(\d+(?:\.\d+)?)\s*(jam|hari|h|d)$/);
  if (!m) return null;
  const unit = { jam: 1, h: 1, hari: 24, d: 24 }[m[2]];
  const hours = Math.round(Number(m[1]) * unit);
  return Number.isFinite(hours) ? hours : null;
}

/* =========================
   ADMIN PERMISSION
========================= */
async function getAdmin(tgId) {
  const { data, error } = await sb
    .from("admins").select("*")
    .eq("telegram_user_id", tgId).maybeSingle();
  if (error) { console.error("getAdmin:", error); return null; }
  return data;
}
async function requireAdmin(ctx) {
  const a = await getAdmin(ctx.from.id);
  if (!a) {
    try { await ctx.answerCallbackQuery({ text: "Akses ditolak.", show_alert: true }); }
    catch (_) {}
    return null;
  }
  return a;
}
async function requireOwner(ctx) {
  const a = await getAdmin(ctx.from.id);
  if (!a || a.role !== "owner") {
    try { await ctx.answerCallbackQuery({ text: "Hanya owner.", show_alert: true }); }
    catch (_) {}
    return null;
  }
  return a;
}

/* =========================
   UI HELPERS
========================= */
async function saveUiMessage(userId, msg, isMedia = false) {
  if (!msg) return;
  uiMessages.set(userId, {
    chatId: msg.chat.id,
    messageId: msg.message_id,
    isMedia,
  });
}

async function renderUi(userId, text, keyboard, options = {}) {
  const saved = uiMessages.get(userId);
  const extra = { reply_markup: keyboard };
  if (options.parse_mode) extra.parse_mode = options.parse_mode;

  if (saved) {
    try {
      if (saved.isMedia) {
        await bot.api.editMessageCaption(saved.chatId, saved.messageId,
          { caption: text, ...extra });
        return;
      }
      await bot.api.editMessageText(saved.chatId, saved.messageId, text, extra);
      return;
    } catch (e) {
      if (/message is not modified/i.test(String(e.message || e))) return;
      try { await bot.api.deleteMessage(saved.chatId, saved.messageId); } catch (_) {}
      uiMessages.delete(userId);
    }
  }
  const msg = await bot.api.sendMessage(userId, text, extra);
  await saveUiMessage(userId, msg, false);
  return msg;
}

async function renderStart(ctx, text, keyboard) {
  // Banner via file_id
  if (START_BANNER_FILE_ID) {
    try {
      const msg = await ctx.replyWithPhoto(START_BANNER_FILE_ID, {
        caption: text, parse_mode: "HTML", reply_markup: keyboard,
      });
      await saveUiMessage(ctx.from.id, msg, true);
      return msg;
    } catch (e) { console.error("BANNER FILE_ID:", e?.message || e); }
  }
  // Banner via URL
  if (START_BANNER_URL && /^https?:\/\//i.test(START_BANNER_URL)) {
    try {
      const r = await fetch(START_BANNER_URL, {
        redirect: "follow", signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const type = String(r.headers.get("content-type") || "").toLowerCase();
      if (!type.startsWith("image/")) throw new Error(`content-type ${type}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) throw new Error("banner kosong");
      if (buf.length > 10 * 1024 * 1024) throw new Error("banner >10MB");
      const msg = await ctx.replyWithPhoto(new InputFile(buf, "start-banner.jpg"), {
        caption: text, parse_mode: "HTML", reply_markup: keyboard,
      });
      await saveUiMessage(ctx.from.id, msg, true);
      return msg;
    } catch (e) { console.error("BANNER URL:", e?.message || e); }
  }
  return renderUi(ctx.from.id, text, keyboard, { parse_mode: "HTML" });
}

/* =========================
   MENUS
========================= */
function backHomeMenu() {
  return new InlineKeyboard()
    .text("🏠 Menu Utama", "home")
    .text("🔄 Refresh", "home");
}
function backAccountsMenu() {
  return new InlineKeyboard()
    .text("⬅️ Daftar Akun", "acc:list:0")
    .text("🏠 Menu Utama", "home");
}
function cancelFlowMenu() {
  return new InlineKeyboard().text("❌ Batal", "flow:cancel");
}

function homeMenu(isOwner) {
  const kb = new InlineKeyboard()
    .text("👤 Akun Telegram", "acc:list:0")
    .row()
    .text("📊 Statistik", "stats")
    .text("ℹ️ Info Bot", "info");
  if (isOwner) {
    kb.row().text("👨‍💼 Manajemen Admin", "adm:list:0");
  }
  kb.row().text("🔄 Refresh", "home");
  return kb;
}

function accountListMenu(rows, page) {
  const kb = new InlineKeyboard();
  rows.forEach((a, i) => {
    const idx = page * 10 + i + 1;
    const icon = a.status === "connected" ? "🟢" : "⚪";
    const label = safeButtonText(a.label, 22);
    kb.text(`${icon} ${String(idx).padStart(2, "0")}. ${label}`, `acc:v:${a.id}`).row();
  });
  // pagination
  const nav = [];
  if (page > 0) nav.push(new InlineKeyboard().text("⬅️ Prev", `acc:list:${page - 1}`));
  if (rows.length === 10) nav.push(new InlineKeyboard().text("Next ➡️", `acc:list:${page + 1}`));
  // gabung navigasi
  if (nav.length === 1) { kb.text("⬅️ Prev", `acc:list:${page - 1}`); }
  if (nav.length === 2) {
    kb.text("⬅️ Prev", `acc:list:${page - 1}`).text("Next ➡️", `acc:list:${page + 1}`);
  }
  kb.row().text("➕ Tambah Akun", "acc:add").text("🏠 Menu Utama", "home");
  return kb;
}

function accountDetailMenu(accId, isRunning) {
  const kb = new InlineKeyboard()
    .text("👥 Grup", `grp:list:${accId}:0`)
    .text("📝 Format", `fmt:show:${accId}`)
    .row()
    .text("⏱ Delay", `dly:set:${accId}`)
    .text("📅 Durasi", `dur:set:${accId}`)
    .row();
  if (isRunning) {
    kb.text("⏹ STOP Promosi", `prm:stop:${accId}`);
  } else {
    kb.text("▶️ START Promosi", `prm:start:${accId}`);
  }
  kb.row()
    .text("🔌 Putuskan", `acc:disc:${accId}`)
    .text("🗑 Hapus Akun", `acc:del:${accId}`)
    .row()
    .text("📋 Riwayat", `his:${accId}:0`)
    .text("🔄 Refresh", `acc:v:${accId}`)
    .row()
    .text("⬅️ Daftar Akun", "acc:list:0")
    .text("🏠 Menu Utama", "home");
  return kb;
}

function groupMenu(groups, accId, page) {
  const kb = new InlineKeyboard();
  groups.forEach((g, i) => {
    const icon = g.enabled ? "✅" : "⬜";
    const idx = page * 10 + i + 1;
    kb.text(`${icon} ${String(idx).padStart(2, "0")}. ${safeButtonText(g.title, 24)}`,
      `grp:tgl:${accId}:${g.id}`).row();
  });
  if (page > 0) kb.text("⬅️ Prev", `grp:list:${accId}:${page - 1}`);
  if (groups.length === 10) kb.text("Next ➡️", `grp:list:${accId}:${page + 1}`);
  kb.row()
    .text("🔄 Refresh Grup", `grp:rf:${accId}`)
    .text("⬅️ Kembali", `acc:v:${accId}`);
  return kb;
}

function adminMgmtMenu(isOwner) {
  const kb = new InlineKeyboard();
  if (isOwner) kb.text("➕ Tambah Admin", "adm:add").row();
  kb.text("📋 Daftar Admin", "adm:list:0").row();
  kb.text("🏠 Menu Utama", "home");
  return kb;
}

function adminListMenu(rows, page, isOwner) {
  const kb = new InlineKeyboard();
  rows.forEach((a, i) => {
    const idx = page * 10 + i + 1;
    const icon = a.role === "owner" ? "👑" : "👤";
    kb.text(`${icon} ${idx}. ${safeButtonText(a.note || a.telegram_user_id, 22)}`,
      `adm:v:${a.telegram_user_id}`).row();
  });
  if (page > 0) kb.text("⬅️ Prev", `adm:list:${page - 1}`);
  if (rows.length === 10) kb.text("Next ➡️", `adm:list:${page + 1}`);
  kb.row().text("🏠 Menu Utama", "home");
  return kb;
}

function historyMenu(accId, page, hasMore) {
  const kb = new InlineKeyboard();
  if (page > 0) kb.text("⬅️ Prev", `his:${accId}:${page - 1}`);
  if (hasMore) kb.text("Next ➡️", `his:${accId}:${page + 1}`);
  kb.row()
    .text("⬅️ Kembali", `acc:v:${accId}`)
    .text("🏠 Menu Utama", "home");
  return kb;
}

/* =========================
   TEXTS
========================= */
async function textHome(adminRow) {
  const isOwner = adminRow.role === "owner";
  let stats = { total_accounts: 0, connected_accounts: 0, running_promotions: 0 };
  try {
    const { data } = await sb.from("admin_dashboard_stats").select("*").maybeSingle();
    if (data) stats = data;
  } catch (_) {}

  return [
    `🤖 <b>PROMOTION CONTROL CENTER</b>`,
    `<i>Bot pusat kendali multi akun Telegram</i>`,
    ``,
    `<pre>👤 Admin     : ${escapeHtml(adminRow.note || String(adminRow.telegram_user_id))}
🆔 Telegram ID: <code>${adminRow.telegram_user_id}</code>
🛡 Role       : ${isOwner ? "OWNER" : "ADMIN"}
🤖 Version    : v${escapeHtml(BOT_VERSION)}</pre>`,
    ``,
    `╭─ <b>STATISTIK</b> ─╮`,
    `👥 Total Akun   : <b>${stats.total_accounts}</b>`,
    `🟢 Terhubung    : <b>${stats.connected_accounts}</b>`,
    `▶️ Promosi Jalan: <b>${stats.running_promotions}</b>`,
    `╰──────────────╯`,
    ``,
    `👇 <b>Pilih menu:</b>`,
  ].join("\n");
}

/* =========================
   DB: ACCOUNTS
========================= */
async function listAccounts(page = 0, perPage = 10) {
  const from = page * perPage;
  const to = from + perPage - 1;
  const { data, error } = await sb
    .from("telegram_accounts")
    .select("*")
    .order("created_at", { ascending: false })
    .range(from, to);
  if (error) throw error;
  return data || [];
}
async function getAccount(id) {
  const { data, error } = await sb
    .from("telegram_accounts").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}
async function getSettings(accountId) {
  const { data, error } = await sb
    .from("account_settings").select("*").eq("account_id", accountId).maybeSingle();
  if (error) throw error;
  return data;
}
async function ensureSettings(accountId) {
  const existing = await getSettings(accountId);
  if (existing) return existing;
  const { data, error } = await sb
    .from("account_settings")
    .insert({ account_id: accountId })
    .select("*").single();
  if (error) throw error;
  return data;
}

async function listGroups(accountId, page = 0, perPage = 10) {
  const from = page * perPage, to = from + perPage - 1;
  const { data, error } = await sb
    .from("account_groups")
    .select("*")
    .eq("account_id", accountId)
    .order("title", { ascending: true })
    .range(from, to);
  if (error) throw error;
  return data || [];
}

/* =========================
   TELEGRAM CLIENT
========================= */
async function createTelegramClient(sessionString = "") {
  return new TelegramClient(
    new StringSession(sessionString || ""),
    Number(process.env.API_ID),
    process.env.API_HASH,
    { connectionRetries: 5, retryDelay: 2000, useWSS: false }
  );
}

async function clientForAccount(acc) {
  if (!acc) return null;
  let c = clients.get(acc.id);
  if (c) {
    try {
      if (!c.connected) await c.connect();
      if (await c.checkAuthorization()) return c;
    } catch (_) {}
    try { await c.disconnect(); } catch (_) {}
    clients.delete(acc.id);
  }
  if (!acc.session_string) return null;
  try {
    c = await createTelegramClient(acc.session_string);
    await c.connect();
    if (!(await c.checkAuthorization())) {
      try { await c.disconnect(); } catch (_) {}
      return null;
    }
    clients.set(acc.id, c);
    return c;
  } catch (e) {
    console.error("CLIENT FOR ACCOUNT:", acc.id, e?.message || e);
    return null;
  }
}

/* =========================
   LOGIN WAITER
========================= */
function waitForInput(userId, nextType, timeoutMs = 5 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const old = waiters.get(userId);
    if (old) { try { old.reject(new Error("Dibatalkan.")); } catch (_) {} }

    const timer = setTimeout(() => {
      waiters.delete(userId);
      flows.delete(userId);
      reject(new Error("Waktu input habis."));
    }, timeoutMs);

    waiters.set(userId, {
      type: nextType,
      resolve: v => { clearTimeout(timer); waiters.delete(userId); resolve(v); },
      reject: e => { clearTimeout(timer); waiters.delete(userId); reject(e); },
    });
  });
}

/* =========================
   LOGIN FLOW (akun Telegram)
========================= */
async function runLogin(ctx, accId, phone) {
  const adminUserId = ctx.from.id;
  const c = await createTelegramClient("");
  await c.connect();

  try {
    await c.start({
      phoneNumber: async () => phone,
      phoneCode: async () => {
        flows.set(adminUserId, { t: "login:code", accId });
        await renderUi(adminUserId,
          "📩 <b>Kode OTP Telegram sudah dikirim.</b>\n\nBalas dengan kode OTP-nya.",
          cancelFlowMenu(), { parse_mode: "HTML" });
        return await waitForInput(adminUserId, "code");
      },
      password: async () => {
        flows.set(adminUserId, { t: "login:password", accId });
        await renderUi(adminUserId,
          "🔐 <b>Verifikasi 2 langkah</b>\n\nBalas dengan password Telegram.",
          cancelFlowMenu(), { parse_mode: "HTML" });
        return await waitForInput(adminUserId, "password");
      },
      onError: async err => console.error("LOGIN ERR:", err?.message || err),
    });

    const sessionString = c.session.save();
    const me = await c.getMe().catch(() => null);

    const { error } = await sb.from("telegram_accounts").update({
      session_string: sessionString,
      phone,
      status: "connected",
      telegram_user_id: me?.id ? Number(me.id) : null,
      username: me?.username || null,
    }).eq("id", accId);
    if (error) throw error;

    await ensureSettings(accId);
    clients.set(accId, c);

    await sb.from("promotion_history").insert({
      account_id: accId,
      action: "connect",
      status: "success",
      admin_id: adminUserId,
    });

    flows.delete(adminUserId);

    await renderUi(adminUserId,
      "✅ <b>Akun Telegram berhasil terhubung.</b>\n\nSession sudah disimpan.",
      new InlineKeyboard()
        .text("👤 Detail Akun", `acc:v:${accId}`)
        .text("👥 Refresh Grup", `grp:rf:${accId}`)
        .row().text("🏠 Menu Utama", "home"),
      { parse_mode: "HTML" });
  } catch (e) {
    flows.delete(adminUserId);
    try { await c.disconnect(); } catch (_) {}
    try {
      await sb.from("telegram_accounts")
        .update({ status: "error" }).eq("id", accId);
      await sb.from("promotion_history").insert({
        account_id: accId, action: "connect", status: "failed",
        admin_id: adminUserId, error: String(e?.message || e).slice(0, 500),
      });
    } catch (_) {}
    throw e;
  }
}

/* =========================
   REFRESH GROUPS
========================= */
async function refreshGroupsFor(acc) {
  const c = await clientForAccount(acc);
  if (!c) throw new Error("Akun Telegram belum terhubung.");

  const dialogs = await c.getDialogs({ limit: 500 });
  const rows = [];

  for (const d of dialogs) {
    const entity = d.entity;
    if (!entity) continue;
    const isGroup = Boolean(d.isGroup);
    const isChannel = Boolean(d.isChannel);
    if (!isGroup && !isChannel) continue;

    let canSend = true;

    // heuristik sederhana: broadcast channel butuh cek admin
    if (isChannel && entity.className === "Channel" && entity.broadcast) {
      canSend = false;
      try {
        const me = await c.getInputEntity("me");
        const participant = await c.invoke(new Api.channels.GetParticipant({
          channel: entity, userId: me,
        }));
        const p = participant.participant;
        if (p?.className === "ChannelParticipantCreator" ||
            p?.className === "ChannelParticipantAdmin") {
          canSend = true;
        }
      } catch (_) { canSend = false; }
    }

    if (isGroup || (isChannel && !entity.broadcast)) {
      canSend = true;
      try {
        if (entity.className === "Channel") {
          const me = await c.getInputEntity("me");
          const participant = await c.invoke(new Api.channels.GetParticipant({
            channel: entity, userId: me,
          }));
          const p = participant.participant;
          if (p?.className === "ChannelParticipantBanned" &&
              p.bannedRights?.sendMessages === true) {
            canSend = false;
          }
        }
      } catch (_) { canSend = true; }
    }

    rows.push({
      account_id: acc.id,
      telegram_group_id: String(entity.id?.value ?? entity.id),
      title: d.title || entity.title || "Tanpa Nama",
      can_send: canSend,
    });
  }

  if (rows.length) {
    // upsert; enabled tidak diikutkan supaya toggle user tidak ketimpa
    const { error } = await sb
      .from("account_groups")
      .upsert(rows, { onConflict: "account_id,telegram_group_id" });
    if (error) throw error;
  }
  return rows;
}

/* =========================
   DOWNLOAD PHOTO
========================= */
async function downloadBotPhoto(fileId) {
  const file = await bot.api.getFile(fileId);
  if (!file?.file_path) throw new Error("Telegram tidak mengembalikan file_path.");
  const url = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 30000);
  let r;
  try { r = await fetch(url, { signal: controller.signal }); }
  finally { clearTimeout(t); }
  if (!r.ok) throw new Error(`Download foto gagal: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length) throw new Error("Foto kosong.");
  buf.name = "photo.jpg";
  return buf;
}

/* =========================
   PROMOTION SCHEDULER (per akun)
========================= */
function stopScheduler(accountId) {
  const s = schedulers.get(accountId);
  if (s?.timer) clearTimeout(s.timer);
  schedulers.delete(accountId);
}

function scheduleAccount(accountId, delay = 0) {
  // Jangan buat scheduler kedua
  stopScheduler(accountId);

  const handle = setTimeout(async () => {
    schedulers.delete(accountId);
    try { await fireAccount(accountId); }
    catch (e) { console.error("FIRE:", accountId, e?.message || e); }

    // cek masih aktif?
    let s = null;
    try { s = await getSettings(accountId); } catch (_) {}
    if (s?.active && s.expires_at && new Date(s.expires_at) > new Date()) {
      const nextDelay = Math.max(1000, Number(s.interval_minutes || 10) * 60 * 1000);
      scheduleAccount(accountId, nextDelay);
    } else {
      if (s?.active) {
        try {
          await sb.from("account_settings")
            .update({ active: false }).eq("account_id", accountId);
        } catch (_) {}
      }
      schedulers.delete(accountId);
    }
  }, Math.max(0, delay));

  schedulers.set(accountId, { timer: handle });
}

function failureReason(error) {
  const raw = String(error?.message || error || "").trim();
  const msg = raw.toLowerCase();
  if (msg.includes("chat_write_forbidden") || msg.includes("chat_send_plain_forbidden") ||
      msg.includes("not enough rights") || msg.includes("can't write") ||
      msg.includes("can't send") || msg.includes("forbidden"))
    return "Tidak diizinkan mengirim pesan";
  if (msg.includes("user_banned_in_channel") || msg.includes("banned"))
    return "Akun tidak diizinkan mengirim";
  if (msg.includes("chat_admin_required") || msg.includes("admin required") ||
      msg.includes("administrator"))
    return "Butuh izin admin";
  if (msg.includes("chat_restricted") || msg.includes("restricted"))
    return "Grup dibatasi";
  if (msg.includes("channel_private") || msg.includes("chat_id_invalid") ||
      msg.includes("chat not found") || msg.includes("group not found"))
    return "Grup tidak dapat diakses";
  if (msg.includes("flood_wait") || msg.includes("floodwait") || msg.includes("a wait of"))
    return "Telegram minta tunggu (flood)";
  return raw ? raw.replace(/\s+/g, " ").slice(0, 120) : "Kesalahan tidak diketahui";
}

async function fireAccount(accountId) {
  const settings = await getSettings(accountId);
  if (!settings || !settings.active) return;
  if (!settings.expires_at || new Date(settings.expires_at) <= new Date()) {
    await sb.from("account_settings").update({ active: false }).eq("account_id", accountId);
    return;
  }
  const acc = await getAccount(accountId);
  if (!acc) return;

  const cl = await clientForAccount(acc);
  if (!cl) {
    await sb.from("promotion_history").insert({
      account_id: accountId, account_label: acc.label,
      action: "send", status: "failed",
      error: "Akun Telegram tidak terhubung.",
    });
    return;
  }

  // Ambil group enabled
  const { data: groups, error: gErr } = await sb
    .from("account_groups").select("*")
    .eq("account_id", accountId).eq("enabled", true).eq("can_send", true);
  if (gErr) { console.error("FIRE GROUPS:", gErr); return; }
  if (!groups?.length) return;

  // Map entity
  let dialogs = [];
  try { dialogs = await cl.getDialogs({ limit: 500 }); }
  catch (e) { console.error("DIALOG FETCH:", e?.message || e); }

  const entityMap = new Map();
  for (const d of dialogs) {
    if (!d.entity || (!d.isGroup && !d.isChannel)) continue;
    const rawId = String(d.entity.id?.value ?? d.entity.id);
    entityMap.set(rawId, d.entity);
  }

  // Siapkan foto
  let photoBuffer = null;
  if (settings.media_file_id) {
    try { photoBuffer = await downloadBotPhoto(settings.media_file_id); }
    catch (e) {
      console.error("FOTO:", e?.message || e);
      return;
    }
  }

  let success = 0, failed = 0;

  for (const g of groups) {
    let ok = false, errMsg = null;
    try {
      const target = entityMap.get(String(g.telegram_group_id));
      if (!target) throw new Error(`Entity ${g.telegram_group_id} tidak ditemukan di dialog.`);
      if (settings.media_file_id && photoBuffer) {
        await cl.sendFile(target, {
          file: photoBuffer,
          caption: settings.caption || "",
          forceDocument: false,
        });
      } else {
        await cl.sendMessage(target, { message: settings.message || "" });
      }
      ok = true;
    } catch (e) {
      errMsg = failureReason(e);
    }

    if (ok) {
      success++;
      try {
        await sb.from("promotion_history").insert({
          account_id: accountId, account_label: acc.label,
          group_id: g.id, group_title: g.title,
          action: "send", status: "success",
        });
      } catch (e) { console.error("LOG SUCCESS:", e?.message || e); }
    } else {
      failed++;
      try {
        await sb.from("promotion_history").insert({
          account_id: accountId, account_label: acc.label,
          group_id: g.id, group_title: g.title,
          action: "send", status: "failed",
          error: errMsg ? String(errMsg).slice(0, 500) : null,
        });
      } catch (e) { console.error("LOG FAIL:", e?.message || e); }
    }
  }

  // Ringkasan singkat ke chat admin yang membuat akun
  if (acc.created_by) {
    try {
      await bot.api.sendMessage(
        acc.created_by,
        `📊 <b>Laporan Promosi</b>\n\n` +
        `👤 Akun  : <b>${escapeHtml(acc.label)}</b>\n` +
        `✅ Sukses: <b>${success}</b>\n` +
        `❌ Gagal : <b>${failed}</b>\n` +
        `📅 ${new Date().toLocaleString("id-ID")}`,
        { parse_mode: "HTML" }
      );
    } catch (_) {}
  }
}

/* =========================
   RESTORE ON STARTUP
========================= */
async function seedAdminsFromEnv() {
  if (!SEED_ADMIN_IDS.length) return;
  const { count } = await sb.from("admins")
    .select("*", { count: "exact", head: true });
  if (count && count > 0) return;

  const primary = SEED_ADMIN_IDS[0];
  const rows = SEED_ADMIN_IDS.map((id, i) => ({
    telegram_user_id: Number(id),
    role: i === 0 ? "owner" : "admin",
    note: i === 0 ? "Owner (seed)" : "Admin (seed)",
  }));
  const { error } = await sb.from("admins").insert(rows);
  if (error) console.error("SEED ADMIN:", error);
  else console.log(`Seeded ${rows.length} admin(s). Owner=${primary}`);
}

async function restoreSessions() {
  const { data, error } = await sb
    .from("telegram_accounts").select("*").eq("status", "connected");
  if (error) { console.error("RESTORE SESSIONS:", error); return; }
  for (const acc of data || []) {
    try {
      const c = await createTelegramClient(acc.session_string);
      await c.connect();
      if (await c.checkAuthorization()) clients.set(acc.id, c);
      else {
        try { await c.disconnect(); } catch (_) {}
        console.warn(`Session akun ${acc.id} tidak authorized.`);
      }
    } catch (e) {
      console.warn(`Reconnect akun ${acc.id} gagal:`, e?.message || e);
    }
  }
}

async function restoreSchedules() {
  const { data, error } = await sb
    .from("account_settings").select("*").eq("active", true);
  if (error) { console.error("RESTORE SCHED:", error); return; }
  for (const s of data || []) {
    if (s.expires_at && new Date(s.expires_at) > new Date()) {
      scheduleAccount(s.account_id, 0);
    } else {
      await sb.from("account_settings").update({ active: false }).eq("account_id", s.account_id);
    }
  }
}

/* =========================
   CALLBACK: HOME / STATS / INFO
========================= */
bot.callbackQuery("home", async ctx => {
  const a = await requireAdmin(ctx);
  if (!a) return;
  await ctx.answerCallbackQuery();
  return renderStart(ctx, await textHome(a), homeMenu(a.role === "owner"));
});

bot.callbackQuery("stats", async ctx => {
  const a = await requireAdmin(ctx);
  if (!a) return;
  await ctx.answerCallbackQuery();

  const { data } = await sb.from("admin_dashboard_stats").select("*").maybeSingle();
  const s = data || {};
  const text = [
    `📊 <b>STATISTIK SISTEM</b>`, ``,
    `👨‍💼 Admin            : <b>${s.total_admins || 0}</b>`,
    `👑 Owner            : <b>${s.total_owners || 0}</b>`,
    `👤 Akun Telegram    : <b>${s.total_accounts || 0}</b>`,
    `🟢 Akun Terhubung   : <b>${s.connected_accounts || 0}</b>`,
    `▶️ Promosi Aktif    : <b>${s.running_promotions || 0}</b>`,
    `👥 Total Grup       : <b>${s.total_groups || 0}</b>`,
    `✅ Grup Enabled     : <b>${s.enabled_groups || 0}</b>`,
    `📋 Total Riwayat    : <b>${s.total_history || 0}</b>`,
    `✅ Sukses           : <b>${s.success_history || 0}</b>`,
    `❌ Gagal            : <b>${s.failed_history || 0}</b>`,
  ].join("\n");
  return renderUi(ctx.from.id, text, backHomeMenu(), { parse_mode: "HTML" });
});

bot.callbackQuery("info", async ctx => {
  const a = await requireAdmin(ctx);
  if (!a) return;
  await ctx.answerCallbackQuery();
  const text = [
    `ℹ️ <b>INFO BOT</b>`, ``,
    `Version  : <b>v${escapeHtml(BOT_VERSION)}</b>`,
    `Runtime  : Node ${process.version}`,
    `Mode     : Single Admin Bot · Multi Telegram Account`,
    ``,
    `Fitur    :`,
    `• Multi akun Telegram unlimited`,
    `• Grup per akun`,
    `• Format per akun (teks / foto + caption)`,
    `• Delay & durasi per akun`,
    `• Start/Stop independen`,
    `• Scheduler aman (tidak dobel)`,
    `• Riwayat promosi`,
  ].join("\n");
  return renderUi(ctx.from.id, text, backHomeMenu(), { parse_mode: "HTML" });
});

/* =========================
   CALLBACK: AKUN
========================= */
bot.callbackQuery(/^acc:list:(\d+)$/, async ctx => {
  const a = await requireAdmin(ctx);
  if (!a) return;
  await ctx.answerCallbackQuery();

  const page = Number(ctx.match[1] || 0);
  try {
    const rows = await listAccounts(page, 10);
    if (!rows.length && page === 0) {
      return renderUi(ctx.from.id,
        "👤 <b>Daftar Akun Telegram</b>\n\nBelum ada akun.\nTambahkan akun Telegram untuk mulai.",
        new InlineKeyboard().text("➕ Tambah Akun", "acc:add")
          .row().text("🏠 Menu Utama", "home"),
        { parse_mode: "HTML" });
    }
    const lines = rows.map((x, i) => {
      const idx = page * 10 + i + 1;
      const icon = x.status === "connected" ? "🟢" : x.status === "error" ? "🔴" : "⚪";
      return `${icon} <b>${idx}. ${escapeHtml(x.label)}</b>\n   📱 ${escapeHtml(x.phone || "-")} · 🆔 <code>${x.id}</code>`;
    });
    const text = `👤 <b>Daftar Akun Telegram</b>\n\nHalaman ${page + 1}\n\n` +
      lines.join("\n\n") + "\n\n👇 Pilih akun untuk kelola.";
    return renderUi(ctx.from.id, text, accountListMenu(rows, page), { parse_mode: "HTML" });
  } catch (e) {
    return renderUi(ctx.from.id,
      `❌ Gagal memuat akun: ${escapeHtml(String(e.message || e).slice(0, 400))}`,
      backHomeMenu(), { parse_mode: "HTML" });
  }
});

bot.callbackQuery("acc:add", async ctx => {
  const a = await requireAdmin(ctx);
  if (!a) return;
  await ctx.answerCallbackQuery();
  flows.set(ctx.from.id, { t: "acc:add:label" });
  return renderUi(ctx.from.id,
    "➕ <b>Tambah Akun Telegram</b>\n\nLangkah 1/2\nKirim <b>nama/label</b> akun.\n\nContoh: <i>Akun Promosi 1</i>",
    cancelFlowMenu(), { parse_mode: "HTML" });
});

bot.callbackQuery(/^acc:v:(\d+)$/, async ctx => {
  const a = await requireAdmin(ctx);
  if (!a) return;
  await ctx.answerCallbackQuery();

  const id = Number(ctx.match[1]);
  try {
    const acc = await getAccount(id);
    if (!acc) return renderUi(ctx.from.id, "❌ Akun tidak ditemukan.", backHomeMenu());

    const settings = await getSettings(id);
    const { count: grpCount } = await sb
      .from("account_groups").select("*", { count: "exact", head: true }).eq("account_id", id);
    const { count: enabledCount } = await sb
      .from("account_groups").select("*", { count: "exact", head: true })
      .eq("account_id", id).eq("enabled", true);

    const statusIcon = acc.status === "connected" ? "🟢 Terhubung" :
                       acc.status === "error" ? "🔴 Error" : "⚪ Terputus";

    let fmt;
    if (!settings) fmt = "Belum dibuat";
    else if (settings.media_file_id) fmt = `🖼 Foto${settings.caption ? " + caption" : ""}`;
    else if (settings.message) fmt = `📝 Teks`;
    else fmt = "Belum dibuat";

    const text = [
      `👤 <b>${escapeHtml(acc.label)}</b>`,
      `<pre>🆔 ID Internal : ${acc.id}
📱 Phone       : ${escapeHtml(acc.phone || "-")}
🔗 Username    : ${escapeHtml(acc.username || "-")}
🤖 TG User ID  : ${escapeHtml(acc.telegram_user_id || "-")}
🔌 Status      : ${statusIcon}</pre>`,
      ``,
      `╭─ <b>SETTING</b> ─╮`,
      `📝 Format   : ${fmt}`,
      `⏱ Delay    : <b>${formatInterval(settings?.interval_minutes)}</b>`,
      `📅 Durasi   : <b>${formatDuration(settings?.duration_hours)}</b>`,
      `📌 Promosi  : <b>${settings?.active ? "RUNNING" : "STOPPED"}</b>`,
      `👥 Grup     : <b>${enabledCount || 0}</b>/${grpCount || 0} aktif`,
      `╰──────────────╯`,
    ].join("\n");
    return renderUi(ctx.from.id, text,
      accountDetailMenu(id, settings?.active), { parse_mode: "HTML" });
  } catch (e) {
    return renderUi(ctx.from.id,
      `❌ ${escapeHtml(String(e.message || e).slice(0, 400))}`,
      backHomeMenu(), { parse_mode: "HTML" });
  }
});

bot.callbackQuery(/^acc:del:(\d+)$/, async ctx => {
  const a = await requireAdmin(ctx);
  if (!a) return;
  await ctx.answerCallbackQuery();
  const id = Number(ctx.match[1]);
  const acc = await getAccount(id).catch(() => null);
  if (!acc) return renderUi(ctx.from.id, "❌ Akun tidak ditemukan.", backHomeMenu());
  return renderUi(ctx.from.id,
    `⚠️ <b>Hapus Akun?</b>\n\n${escapeHtml(acc.label)}\n\nSemua grup & setting akan dihapus.`,
    new InlineKeyboard()
      .text("🗑 Ya, Hapus", `acc:delc:${id}`)
      .row().text("⬅️ Batal", `acc:v:${id}`),
    { parse_mode: "HTML" });
});

bot.callbackQuery(/^acc:delc:(\d+)$/, async ctx => {
  const a = await requireAdmin(ctx);
  if (!a) return;
  await ctx.answerCallbackQuery("Menghapus...");
  const id = Number(ctx.match[1]);

  // stop scheduler + client
  stopScheduler(id);
  const c = clients.get(id);
  if (c) {
    try { await c.disconnect(); } catch (_) {}
    clients.delete(id);
  }

  try {
    const acc = await getAccount(id);
    await sb.from("telegram_accounts").delete().eq("id", id);
    try {
      await sb.from("promotion_history").insert({
        account_label: acc?.label || `#${id}`,
        action: "delete", status: "success", admin_id: a.telegram_user_id,
      });
    } catch (_) {}
    return renderUi(ctx.from.id, "✅ Akun berhasil dihapus.",
      new InlineKeyboard().text("⬅️ Daftar Akun", "acc:list:0")
        .row().text("🏠 Menu Utama", "home"));
  } catch (e) {
    return renderUi(ctx.from.id,
      `❌ Gagal hapus: ${escapeHtml(String(e.message || e).slice(0, 400))}`,
      backHomeMenu(), { parse_mode: "HTML" });
  }
});

bot.callbackQuery(/^acc:disc:(\d+)$/, async ctx => {
  const a = await requireAdmin(ctx);
  if (!a) return;
  await ctx.answerCallbackQuery("Memutuskan...");
  const id = Number(ctx.match[1]);

  const c = clients.get(id);
  if (c) { try { await c.disconnect(); } catch (_) {} clients.delete(id); }
  stopScheduler(id);

  try {
    await sb.from("telegram_accounts").update({
      status: "disconnected", session_string: null,
    }).eq("id", id);
    await sb.from("account_settings").update({ active: false }).eq("account_id", id);
    await sb.from("promotion_history").insert({
      account_id: id, action: "disconnect", status: "success",
      admin_id: a.telegram_user_id,
    });
  } catch (e) { console.error("DISC:", e); }

  return renderUi(ctx.from.id,
    "🔌 Akun diputuskan dan session dihapus.",
    new InlineKeyboard().text("👤 Detail", `acc:v:${id}`)
      .row().text("⬅️ Daftar Akun", "acc:list:0"),
    { parse_mode: "HTML" });
});

/* =========================
   CALLBACK: GROUP
========================= */
bot.callbackQuery(/^grp:list:(\d+):(\d+)$/, async ctx => {
  const a = await requireAdmin(ctx);
  if (!a) return;
  await ctx.answerCallbackQuery();
  const accId = Number(ctx.match[1]);
  const page = Number(ctx.match[2] || 0);

  try {
    const acc = await getAccount(accId);
    if (!acc) return renderUi(ctx.from.id, "❌ Akun tidak ditemukan.", backHomeMenu());
    const rows = await listGroups(accId, page, 10);
    if (!rows.length && page === 0) {
      return renderUi(ctx.from.id,
        `👥 <b>Grup — ${escapeHtml(acc.label)}</b>\n\nBelum ada grup tersimpan.\nTekan Refresh untuk scan grup.`,
        new InlineKeyboard()
          .text("🔄 Refresh Grup", `grp:rf:${accId}`)
          .row().text("⬅️ Kembali", `acc:v:${accId}`),
        { parse_mode: "HTML" });
    }
    const enabled = rows.filter(x => x.enabled).length;
    const text = `👥 <b>Grup — ${escapeHtml(acc.label)}</b>\n\n` +
      `Halaman ${page + 1} · Aktif <b>${enabled}</b>/${rows.length}\n\n` +
      `Klik untuk ON/OFF.`;
    return renderUi(ctx.from.id, text, groupMenu(rows, accId, page), { parse_mode: "HTML" });
  } catch (e) {
    return renderUi(ctx.from.id,
      `❌ ${escapeHtml(String(e.message || e).slice(0, 400))}`,
      backHomeMenu(), { parse_mode: "HTML" });
  }
});

bot.callbackQuery(/^grp:rf:(\d+)$/, async ctx => {
  const a = await requireAdmin(ctx);
  if (!a) return;
  await ctx.answerCallbackQuery("Scan grup...");
  const accId = Number(ctx.match[1]);

  try {
    const acc = await getAccount(accId);
    if (!acc) return renderUi(ctx.from.id, "❌ Akun tidak ditemukan.", backHomeMenu());
    const count = (await refreshGroupsFor(acc)).length;
    return renderUi(ctx.from.id,
      `✅ Berhasil scan <b>${count}</b> grup.\nSilakan atur target.`,
      new InlineKeyboard()
        .text("👥 Lihat Grup", `grp:list:${accId}:0`)
        .row().text("⬅️ Kembali", `acc:v:${accId}`),
      { parse_mode: "HTML" });
  } catch (e) {
    return renderUi(ctx.from.id,
      `❌ Gagal scan: ${escapeHtml(String(e.message || e).slice(0, 400))}`,
      new InlineKeyboard().text("⬅️ Kembali", `acc:v:${accId}`)
        .row().text("🏠 Menu Utama", "home"),
      { parse_mode: "HTML" });
  }
});

bot.callbackQuery(/^grp:tgl:(\d+):(\d+)$/, async ctx => {
  const a = await requireAdmin(ctx);
  if (!a) return;
  await ctx.answerCallbackQuery();
  const accId = Number(ctx.match[1]);
  const grpId = Number(ctx.match[2]);

  try {
    const { data: g } = await sb.from("account_groups")
      .select("*").eq("id", grpId).eq("account_id", accId).maybeSingle();
    if (!g) return ctx.answerCallbackQuery({ text: "Grup tidak ditemukan.", show_alert: true });

    await sb.from("account_groups").update({ enabled: !g.enabled }).eq("id", grpId);
    await ctx.answerCallbackQuery(g.enabled ? "Dinonaktifkan" : "Diaktifkan");

    const rows = await listGroups(accId, 0, 10);
    const text = `👥 <b>Grup</b>\n\nKlik untuk ON/OFF.`;
    return renderUi(ctx.from.id, text, groupMenu(rows, accId, 0), { parse_mode: "HTML" });
  } catch (e) {
    return ctx.answerCallbackQuery({ text: "Gagal update.", show_alert: true });
  }
});

/* =========================
   CALLBACK: FORMAT
========================= */
bot.callbackQuery(/^fmt:show:(\d+)$/, async ctx => {
  const a = await requireAdmin(ctx);
  if (!a) return;
  await ctx.answerCallbackQuery();
  const accId = Number(ctx.match[1]);
  const s = await getSettings(accId).catch(() => null);

  let body = "Belum dibuat.";
  if (s?.media_file_id) body = `🖼 <b>Foto</b>${s.caption ? ` + caption\n\n${escapeHtml(s.caption).slice(0, 500)}` : ""}`;
  else if (s?.message) body = `📝 <b>Teks</b>\n\n${escapeHtml(s.message).slice(0, 800)}`;

  return renderUi(ctx.from.id,
    `📝 <b>Format Promosi</b>\n\n${body}\n\nKirim format baru untuk mengganti:`,
    new InlineKeyboard()
      .text("✏️ Set Format Baru", `fmt:set:${accId}`)
      .row().text("⬅️ Kembali", `acc:v:${accId}`),
    { parse_mode: "HTML" });
});

bot.callbackQuery(/^fmt:set:(\d+)$/, async ctx => {
  const a = await requireAdmin(ctx);
  if (!a) return;
  await ctx.answerCallbackQuery();
  const accId = Number(ctx.match[1]);
  flows.set(ctx.from.id, { t: "fmt:set", accId });
  return renderUi(ctx.from.id,
    "📝 <b>Set Format Promosi</b>\n\nKirim salah satu:\n\n• Teks biasa\n• Foto saja\n• Foto + caption",
    cancelFlowMenu(), { parse_mode: "HTML" });
});

/* =========================
   CALLBACK: DELAY & DURATION
========================= */
bot.callbackQuery(/^dly:set:(\d+)$/, async ctx => {
  const a = await requireAdmin(ctx);
  if (!a) return;
  await ctx.answerCallbackQuery();
  const accId = Number(ctx.match[1]);
  flows.set(ctx.from.id, { t: "dly:set", accId });
  return renderUi(ctx.from.id,
    "⏱ <b>Set Delay</b>\n\nContoh: <b>10 menit</b> · <b>1 jam</b> · <b>30 menit</b>\n\nMinimal 1 menit.",
    cancelFlowMenu(), { parse_mode: "HTML" });
});

bot.callbackQuery(/^dur:set:(\d+)$/, async ctx => {
  const a = await requireAdmin(ctx);
  if (!a) return;
  await ctx.answerCallbackQuery();
  const accId = Number(ctx.match[1]);
  flows.set(ctx.from.id, { t: "dur:set", accId });
  return renderUi(ctx.from.id,
    "📅 <b>Set Durasi</b>\n\nContoh: <b>1 hari</b> · <b>12 jam</b> · <b>3 hari</b>",
    cancelFlowMenu(), { parse_mode: "HTML" });
});

/* =========================
   CALLBACK: START / STOP PROMOSI
========================= */
bot.callbackQuery(/^prm:start:(\d+)$/, async ctx => {
  const a = await requireAdmin(ctx);
  if (!a) return;
  await ctx.answerCallbackQuery();
  const accId = Number(ctx.match[1]);

  try {
    const acc = await getAccount(accId);
    if (!acc) return renderUi(ctx.from.id, "❌ Akun tidak ditemukan.", backHomeMenu());
    if (acc.status !== "connected")
      return renderUi(ctx.from.id,
        "❌ Akun Telegram belum terhubung.\nSilakan login ulang akun ini.",
        new InlineKeyboard().text("⬅️ Kembali", `acc:v:${accId}`),
        { parse_mode: "HTML" });

    const s = await ensureSettings(accId);
    if (!s.message && !s.media_file_id)
      return renderUi(ctx.from.id, "❌ Format promosi belum dibuat.",
        new InlineKeyboard().text("📝 Set Format", `fmt:set:${accId}`)
          .row().text("⬅️ Kembali", `acc:v:${accId}`),
        { parse_mode: "HTML" });
    if (!s.interval_minutes || s.interval_minutes < 1)
      return renderUi(ctx.from.id, "❌ Set delay dulu.",
        new InlineKeyboard().text("⏱ Set Delay", `dly:set:${accId}`)
          .row().text("⬅️ Kembali", `acc:v:${accId}`),
        { parse_mode: "HTML" });
    if (!s.duration_hours || s.duration_hours < 1)
      return renderUi(ctx.from.id, "❌ Set durasi dulu.",
        new InlineKeyboard().text("📅 Set Durasi", `dur:set:${accId}`)
          .row().text("⬅️ Kembali", `acc:v:${accId}`),
        { parse_mode: "HTML" });

    const { count: enabledCount } = await sb
      .from("account_groups").select("*", { count: "exact", head: true })
      .eq("account_id", accId).eq("enabled", true).eq("can_send", true);
    if (!enabledCount)
      return renderUi(ctx.from.id, "❌ Belum ada grup target aktif.",
        new InlineKeyboard().text("👥 Atur Grup", `grp:list:${accId}:0`)
          .row().text("⬅️ Kembali", `acc:v:${accId}`),
        { parse_mode: "HTML" });

    // Cek scheduler dobel
    if (schedulers.has(accId)) {
      return renderUi(ctx.from.id,
        "ℹ️ Promosi akun ini <b>sudah berjalan</b>.",
        new InlineKeyboard().text("⏹ Stop", `prm:stop:${accId}`)
          .row().text("⬅️ Kembali", `acc:v:${accId}`),
        { parse_mode: "HTML" });
    }

    const now = new Date();
    const exp = new Date(now.getTime() + s.duration_hours * 3600 * 1000);
    await sb.from("account_settings").update({
      active: true, started_at: now.toISOString(), expires_at: exp.toISOString(),
    }).eq("account_id", accId);

    // fire pertama langsung
    try { await fireAccount(accId); } catch (e) { console.error("FIRST FIRE:", e); }
    // jadwalkan berikutnya
    scheduleAccount(accId, Math.max(1000, s.interval_minutes * 60 * 1000));

    await sb.from("promotion_history").insert({
      account_id: accId, account_label: acc.label,
      action: "start", status: "success", admin_id: a.telegram_user_id,
    });

    return renderUi(ctx.from.id,
      `▶️ <b>Promosi dimulai.</b>\n\n` +
      `👤 Akun  : <b>${escapeHtml(acc.label)}</b>\n` +
      `⏱ Delay : ${formatInterval(s.interval_minutes)}\n` +
      `📅 Durasi: ${formatDuration(s.duration_hours)}\n` +
      `👥 Grup  : ${enabledCount}`,
      new InlineKeyboard().text("⏹ Stop", `prm:stop:${accId}`)
        .row().text("⬅️ Kembali", `acc:v:${accId}`),
      { parse_mode: "HTML" });
  } catch (e) {
    return renderUi(ctx.from.id,
      `❌ Gagal memulai: ${escapeHtml(String(e.message || e).slice(0, 400))}`,
      backHomeMenu(), { parse_mode: "HTML" });
  }
});

bot.callbackQuery(/^prm:stop:(\d+)$/, async ctx => {
  const a = await requireAdmin(ctx);
  if (!a) return;
  await ctx.answerCallbackQuery("Menghentikan...");
  const accId = Number(ctx.match[1]);

  stopScheduler(accId);
  try {
    await sb.from("account_settings").update({ active: false }).eq("account_id", accId);
    const acc = await getAccount(accId);
    await sb.from("promotion_history").insert({
      account_id: accId, account_label: acc?.label,
      action: "stop", status: "success", admin_id: a.telegram_user_id,
    });
  } catch (e) { console.error("STOP:", e); }

  return renderUi(ctx.from.id,
    "⏹ <b>Promosi dihentikan.</b>",
    new InlineKeyboard().text("▶️ Start Lagi", `prm:start:${accId}`)
      .row().text("⬅️ Kembali", `acc:v:${accId}`),
    { parse_mode: "HTML" });
});

/* =========================
   CALLBACK: HISTORY
========================= */
bot.callbackQuery(/^his:(\d+):(\d+)$/, async ctx => {
  const a = await requireAdmin(ctx);
  if (!a) return;
  await ctx.answerCallbackQuery();
  const accId = Number(ctx.match[1]);
  const page = Number(ctx.match[2] || 0);
  const perPage = 10;
  const from = page * perPage, to = from + perPage - 1;

  try {
    const acc = await getAccount(accId);
    if (!acc) return renderUi(ctx.from.id, "❌ Akun tidak ditemukan.", backHomeMenu());

    const { data, error } = await sb
      .from("promotion_history").select("*")
      .eq("account_id", accId)
      .order("created_at", { ascending: false })
      .range(from, to);
    if (error) throw error;

    if (!data?.length && page === 0) {
      return renderUi(ctx.from.id,
        `📋 <b>Riwayat — ${escapeHtml(acc.label)}</b>\n\nBelum ada riwayat.`,
        new InlineKeyboard().text("⬅️ Kembali", `acc:v:${accId}`)
          .row().text("🏠 Menu Utama", "home"),
        { parse_mode: "HTML" });
    }

    const lines = data.map((h, i) => {
      const idx = page * perPage + i + 1;
      const icon = h.status === "success" ? "✅" : h.status === "failed" ? "❌" : "ℹ️";
      const when = new Date(h.created_at).toLocaleString("id-ID");
      let line = `${icon} <b>#${idx}</b> · ${escapeHtml(h.action.toUpperCase())}\n` +
                 `   📢 ${escapeHtml(h.group_title || "-")}\n` +
                 `   🕐 ${escapeHtml(when)}`;
      if (h.error) line += `\n   ⚠️ ${escapeHtml(String(h.error).slice(0, 80))}`;
      return line;
    });

    const text = `📋 <b>Riwayat — ${escapeHtml(acc.label)}</b>\n\nHalaman ${page + 1}\n\n${lines.join("\n\n")}`;
    return renderUi(ctx.from.id, text, historyMenu(accId, page, data.length === perPage), { parse_mode: "HTML" });
  } catch (e) {
    return renderUi(ctx.from.id,
      `❌ ${escapeHtml(String(e.message || e).slice(0, 400))}`,
      backHomeMenu(), { parse_mode: "HTML" });
  }
});

/* =========================
   CALLBACK: ADMIN MANAGEMENT (owner only)
========================= */
bot.callbackQuery("adm:list:0", async ctx => {
  const a = await requireAdmin(ctx);
  if (!a) return;
  await ctx.answerCallbackQuery();
  return showAdminList(ctx, 0);
});

bot.callbackQuery(/^adm:list:(\d+)$/, async ctx => {
  const a = await requireAdmin(ctx);
  if (!a) return;
  await ctx.answerCallbackQuery();
  return showAdminList(ctx, Number(ctx.match[1]));
});

async function showAdminList(ctx, page) {
  const a = await getAdmin(ctx.from.id);
  if (!a) return;
  const perPage = 10;
  const from = page * perPage, to = from + perPage - 1;
  try {
    const { data, error } = await sb.from("admins")
      .select("*").order("created_at", { ascending: true }).range(from, to);
    if (error) throw error;
    const lines = (data || []).map((x, i) => {
      const idx = page * perPage + i + 1;
      const icon = x.role === "owner" ? "👑" : "👤";
      return `${icon} <b>${idx}. ${escapeHtml(x.note || "Admin")}</b>\n   🆔 <code>${x.telegram_user_id}</code> · ${x.role}`;
    });
    const text = `👨‍💼 <b>Daftar Admin</b>\n\nHalaman ${page + 1}\n\n${lines.join("\n\n") || "<i>Kosong</i>"}`;
    const kb = adminListMenu(data || [], page, a.role === "owner");
    if (a.role === "owner") {
      kb.row().text("➕ Tambah Admin", "adm:add");
    }
    return renderUi(ctx.from.id, text, kb, { parse_mode: "HTML" });
  } catch (e) {
    return renderUi(ctx.from.id,
      `❌ ${escapeHtml(String(e.message || e).slice(0, 400))}`,
      backHomeMenu(), { parse_mode: "HTML" });
  }
}

bot.callbackQuery(/^adm:v:(\d+)$/, async ctx => {
  const a = await requireAdmin(ctx);
  if (!a) return;
  await ctx.answerCallbackQuery();
  const tgId = Number(ctx.match[1]);
  try {
    const { data: target } = await sb.from("admins")
      .select("*").eq("telegram_user_id", tgId).maybeSingle();
    if (!target) return renderUi(ctx.from.id, "❌ Admin tidak ditemukan.",
      new InlineKeyboard().text("⬅️ Daftar Admin", "adm:list:0"));

    const text = [
      `👤 <b>Detail Admin</b>`, ``,
      `<pre>🆔 Telegram ID: ${target.telegram_user_id}
🛡 Role       : ${target.role}
📝 Note       : ${escapeHtml(target.note || "-")}
🕐 Created    : ${new Date(target.created_at).toLocaleString("id-ID")}
👤 Created By : ${escapeHtml(target.created_by || "-")}</pre>`,
    ].join("\n");

    const kb = new InlineKeyboard()
      .text("⬅️ Daftar Admin", "adm:list:0")
      .text("🏠 Menu Utama", "home");
    if (a.role === "owner" && target.role !== "owner") {
      kb.row().text("🗑 Hapus Admin", `adm:del:${tgId}`);
    }
    return renderUi(ctx.from.id, text, kb, { parse_mode: "HTML" });
  } catch (e) {
    return renderUi(ctx.from.id,
      `❌ ${escapeHtml(String(e.message || e).slice(0, 400))}`,
      backHomeMenu(), { parse_mode: "HTML" });
  }
});

bot.callbackQuery("adm:add", async ctx => {
  const owner = await requireOwner(ctx);
  if (!owner) return;
  await ctx.answerCallbackQuery();
  flows.set(ctx.from.id, { t: "adm:add" });
  return renderUi(ctx.from.id,
    "➕ <b>Tambah Admin Baru</b>\n\nKirim Telegram User ID admin baru.\n\n" +
    "Contoh: <code>7607446655</code>\n\n" +
    "⚠️ Admin baru akan mendapat role <b>admin</b> (bukan owner).",
    cancelFlowMenu(), { parse_mode: "HTML" });
});

bot.callbackQuery(/^adm:del:(\d+)$/, async ctx => {
  const owner = await requireOwner(ctx);
  if (!owner) return;
  await ctx.answerCallbackQuery();
  const tgId = Number(ctx.match[1]);
  return renderUi(ctx.from.id,
    `⚠️ <b>Hapus Admin</b>\n\nTelegram ID: <code>${tgId}</code>\n\nYakin?`,
    new InlineKeyboard()
      .text("🗑 Ya, Hapus", `adm:delc:${tgId}`)
      .row().text("⬅️ Batal", `adm:v:${tgId}`),
    { parse_mode: "HTML" });
});

bot.callbackQuery(/^adm:delc:(\d+)$/, async ctx => {
  const owner = await requireOwner(ctx);
  if (!owner) return;
  await ctx.answerCallbackQuery();
  const tgId = Number(ctx.match[1]);
  if (tgId === owner.telegram_user_id) {
    return ctx.answerCallbackQuery({ text: "Tidak bisa hapus diri sendiri.", show_alert: true });
  }
  try {
    const { data: t } = await sb.from("admins")
      .select("*").eq("telegram_user_id", tgId).maybeSingle();
    if (t?.role === "owner") {
      return ctx.answerCallbackQuery({ text: "Owner tidak bisa dihapus.", show_alert: true });
    }
    await sb.from("admins").delete().eq("telegram_user_id", tgId);
    return renderUi(ctx.from.id, "✅ Admin dihapus.",
      new InlineKeyboard().text("⬅️ Daftar Admin", "adm:list:0")
        .row().text("🏠 Menu Utama", "home"));
  } catch (e) {
    return renderUi(ctx.from.id,
      `❌ ${escapeHtml(String(e.message || e).slice(0, 400))}`,
      backHomeMenu(), { parse_mode: "HTML" });
  }
});

/* =========================
   CALLBACK: FLOW CANCEL
========================= */
bot.callbackQuery("flow:cancel", async ctx => {
  const a = await requireAdmin(ctx);
  if (!a) return;
  await ctx.answerCallbackQuery("Dibatalkan");

  const w = waiters.get(ctx.from.id);
  if (w) { try { w.reject(new Error("Dibatalkan.")); } catch (_) {} }
  flows.delete(ctx.from.id);
  uiMessages.delete(ctx.from.id);

  return renderStart(ctx, await textHome(a), homeMenu(a.role === "owner"));
});

/* =========================
   MESSAGE HANDLER
========================= */
bot.on("message", async ctx => {
  const userId = ctx.from.id;
  const a = await getAdmin(userId);
  if (!a) return; // bukan admin

  // 1) Waiter (OTP / password login)
  const w = waiters.get(userId);
  if (w && (w.type === "code" || w.type === "password")) {
    const text = String(ctx.message.text || "").trim();
    if (!text) return renderUi(userId, "❌ Kirim teks.", cancelFlowMenu());
    w.resolve(text);
    return;
  }

  // 2) Flow
  const f = flows.get(userId);
  if (!f) return;

  try {
    /* ---------- TAMBAH AKUN: label ---------- */
    if (f.t === "acc:add:label") {
      const label = String(ctx.message.text || "").trim();
      if (!label || label.length > 60)
        return renderUi(userId, "❌ Label tidak valid (1-60 karakter).", cancelFlowMenu());
      flows.set(userId, { t: "acc:add:phone", label });
      return renderUi(userId,
        `➕ <b>${escapeHtml(label)}</b>\n\nLangkah 2/2\nKirim nomor Telegram.\n\nContoh: <b>+628123456789</b>`,
        cancelFlowMenu(), { parse_mode: "HTML" });
    }

    /* ---------- TAMBAH AKUN: phone + start login ---------- */
    if (f.t === "acc:add:phone") {
      const phone = String(ctx.message.text || "").trim();
      if (!/^\+\d{7,15}$/.test(phone))
        return renderUi(userId,
          "❌ Nomor tidak valid.\nGunakan format internasional: +628123456789",
          cancelFlowMenu());
      flows.delete(userId);

      // Buat baris akun dulu
      const { data: acc, error } = await sb.from("telegram_accounts").insert({
        label: f.label, phone, status: "disconnected",
        created_by: a.telegram_user_id,
      }).select("*").single();
      if (error) throw error;
      await ensureSettings(acc.id);

      // Jalankan login
      await renderUi(userId,
        `🔐 Memulai login untuk <b>${escapeHtml(f.label)}</b>...\n\nTunggu kode OTP dari Telegram.`,
        cancelFlowMenu(), { parse_mode: "HTML" });
      await runLogin(ctx, acc.id, phone);
      return;
    }

    /* ---------- SET FORMAT ---------- */
    if (f.t === "fmt:set") {
      const accId = f.accId;

      // Foto?
      if (ctx.message.photo && ctx.message.photo.length) {
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        const caption = ctx.message.caption || "";
        await sb.from("account_settings").update({
          media_type: "photo",
          media_file_id: photo.file_id,
          caption,
          message: null,
        }).eq("account_id", accId);
        flows.delete(userId);
        return renderUi(userId, "✅ Format foto disimpan.",
          new InlineKeyboard().text("👤 Detail Akun", `acc:v:${accId}`)
            .row().text("🏠 Menu Utama", "home"));
      }

      // Teks?
      if (ctx.message.text) {
        const text = ctx.message.text.trim();
        if (!text) return renderUi(userId, "❌ Format kosong.", cancelFlowMenu());
        await sb.from("account_settings").update({
          message: text, media_type: null, media_file_id: null, caption: null,
        }).eq("account_id", accId);
        flows.delete(userId);
        return renderUi(userId, "✅ Format teks disimpan.",
          new InlineKeyboard().text("👤 Detail Akun", `acc:v:${accId}`)
            .row().text("🏠 Menu Utama", "home"));
      }

      return renderUi(userId,
        "❌ Kirim teks atau foto (+caption).",
        cancelFlowMenu());
    }

    /* ---------- SET DELAY ---------- */
    if (f.t === "dly:set") {
      const m = parseMinutes(ctx.message.text);
      if (!m || m < 1)
        return renderUi(userId, "❌ Format delay tidak valid.\nContoh: 10 menit / 1 jam.", cancelFlowMenu());
      await sb.from("account_settings").update({ interval_minutes: m }).eq("account_id", f.accId);
      flows.delete(userId);
      return renderUi(userId,
        `✅ Delay disimpan: <b>${formatInterval(m)}</b>`,
        new InlineKeyboard().text("👤 Detail Akun", `acc:v:${f.accId}`)
          .row().text("🏠 Menu Utama", "home"),
        { parse_mode: "HTML" });
    }

    /* ---------- SET DURASI ---------- */
    if (f.t === "dur:set") {
      const h = parseHours(ctx.message.text);
      if (!h || h < 1)
        return renderUi(userId, "❌ Format durasi tidak valid.\nContoh: 1 hari / 12 jam.", cancelFlowMenu());
      await sb.from("account_settings").update({ duration_hours: h }).eq("account_id", f.accId);
      flows.delete(userId);
      return renderUi(userId,
        `✅ Durasi disimpan: <b>${formatDuration(h)}</b>`,
        new InlineKeyboard().text("👤 Detail Akun", `acc:v:${f.accId}`)
          .row().text("🏠 Menu Utama", "home"),
        { parse_mode: "HTML" });
    }

    /* ---------- TAMBAH ADMIN ---------- */
    if (f.t === "adm:add") {
      if (a.role !== "owner")
        return renderUi(userId, "❌ Hanya owner.", backHomeMenu());
      const raw = String(ctx.message.text || "").trim();
      if (!/^\d+$/.test(raw))
        return renderUi(userId, "❌ Telegram ID harus angka.", cancelFlowMenu());
      const id = Number(raw);
      const { error } = await sb.from("admins").upsert({
        telegram_user_id: id, role: "admin",
        created_by: a.telegram_user_id, note: "Admin",
      }, { onConflict: "telegram_user_id" });
      if (error) throw error;
      flows.delete(userId);
      return renderUi(userId,
        `✅ Admin <code>${id}</code> ditambahkan.`,
        new InlineKeyboard().text("⬅️ Daftar Admin", "adm:list:0")
          .row().text("🏠 Menu Utama", "home"),
        { parse_mode: "HTML" });
    }

    return;
  } catch (e) {
    console.error("FLOW:", e);
    flows.delete(userId);
    return renderUi(userId,
      `❌ ${escapeHtml(String(e.message || e).slice(0, 500))}`,
      backHomeMenu(), { parse_mode: "HTML" });
  }
});

/* =========================
   /start COMMAND
========================= */
bot.command("start", async ctx => {
  const a = await getAdmin(ctx.from.id);
  if (!a) {
    return ctx.reply(
      "❌ Akses ditolak.\n\nAkun ini belum terdaftar sebagai admin.\n" +
      "Hubungi owner bot untuk menambahkan Anda."
    );
  }
  return renderStart(ctx, await textHome(a), homeMenu(a.role === "owner"));
});

/* =========================
   ERROR HANDLER
========================= */
bot.catch(err => {
  console.error("BOT ERROR:", err.error || err);
});

/* =========================
   INIT
========================= */
(async () => {
  console.log("Seeding admins from env...");
  await seedAdminsFromEnv();

  console.log("Restoring Telegram sessions...");
  await restoreSessions();

  console.log("Restoring active schedules...");
  await restoreSchedules();

  await bot.start();
  console.log("Telegram bot started.");
})().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});

/* =========================
   HTTP SERVER (healthcheck)
========================= */
const app = express();
app.get("/", (_, res) => res.json({
  ok: true, service: "telegram-auto-bot", version: BOT_VERSION,
}));
app.get("/health", (_, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`HTTP listening on :${PORT}`));

/* =========================
   GRACEFUL SHUTDOWN
========================= */
function shutdown() {
  for (const s of schedulers.values()) if (s?.timer) clearTimeout(s.timer);
  schedulers.clear();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);