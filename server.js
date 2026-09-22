require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const { Bot, InlineKeyboard, InputFile } = require("grammy");
const { createClient } = require("@supabase/supabase-js");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");

let ws = null;
try {
  ws = require("ws");
} catch (_) {
  // Optional. Supabase can use its default transport.
}

/* =========================================================
   ENV / CONFIG
========================================================= */

const requiredEnv = [
  "BOT_TOKEN",
  "API_ID",
  "API_HASH",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY"
];

for (const key of requiredEnv) {
  if (!String(process.env[key] || "").trim()) {
    throw new Error(`ENV wajib belum diisi: ${key}`);
  }
}

const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || "")
    .split(",")
    .map(x => x.trim())
    .filter(x => /^\d+$/.test(x))
);

if (!ADMIN_IDS.size) {
  throw new Error(
    "ADMIN_IDS wajib berisi minimal satu Telegram user ID owner."
  );
}

const BOT_VERSION = String(
  process.env.BOT_VERSION ||
    process.env.npm_package_version ||
    "3.0.0"
).trim();

const START_BANNER_FILE_ID = String(
  process.env.START_BANNER_FILE_ID || ""
).trim();

const START_BANNER_URL = String(
  process.env.START_BANNER_URL ||
    "https://cdn.phototourl.com/free/2026-09-17-491f8197-8c02-4344-8754-8314826f54f4.jpg"
).trim();

const supabaseOptions = ws
  ? { realtime: { transport: ws } }
  : {};

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  supabaseOptions
);

const bot = new Bot(process.env.BOT_TOKEN);

/* =========================================================
   RUNTIME STATE
========================================================= */

// Account ID -> GramJS TelegramClient
const clients = new Map();

// Admin Telegram ID -> current text/media flow
const flows = new Map();

// Admin Telegram ID -> { type, resolve, reject, timer }
const waiters = new Map();

// Scheduler key -> task object. Key is accountId:formatId.
const schedulerTasks = new Map();

// Account ID -> currently loading GramJS client Promise
const clientLoads = new Map();

// Account ID -> Promise used as a simple async mutex
const accountLocks = new Map();

// Telegram admin ID -> last UI message
const uiMessages = new Map();

// Telegram admin ID -> serialized UI render operation. Prevents concurrent
// /start calls from both observing an empty uiMessages entry and sending
// duplicate dashboards.
const uiLocks = new Map();

// Telegram admin ID -> current interactive GramJS login run. This keeps one
// login state per admin chat and gives the cancel flow a safe cancellation flag.
const loginRuns = new Map();

// In-memory promotion reports for the failure-detail button.
const promotionReports = new Map();
const MAX_PROMOTION_REPORTS = 200;

// Short-lived search state for the group picker.
const groupSearches = new Map();
const MAX_GROUP_SEARCHES = 100;

// Private-promotion runtime state. This feature is intentionally kept in memory
// so it does not require any database/schema change and never touches the
// existing scheduler/session state.
const privatePromotionRuns = new Map();
const PRIVATE_PROMO_PAGE_SIZE = 8;
const PRIVATE_PROMO_DELAY_MS = 5000;
const PRIVATE_PROMO_MAX_FLOOD_WAIT_MS = 15 * 60 * 1000;

const ACCOUNT_PAGE_SIZE = 8;
const HISTORY_PAGE_SIZE = 8;
const GROUP_PAGE_SIZE = 8;
const ADMIN_PAGE_SIZE = 12;

/* =========================================================
   BASIC HELPERS
========================================================= */

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeButtonText(value, max = 30) {
  const text = String(value ?? "Tanpa Nama")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "");

  return Array.from(text)
    .filter(ch => {
      const cp = ch.codePointAt(0);
      return cp !== undefined && cp >= 0x20;
    })
    .slice(0, max)
    .join("");
}

// PostgREST/Postgres menolak seluruh JSON ("Empty or invalid json" / PGRST102)
// bila ada karakter NUL atau surrogate UTF-16 yang terbelah. Surrogate terbelah
// biasanya muncul saat teks berisi emoji / huruf fancy (𝗕𝗼𝗹𝗱 dll, 2 unit UTF-16)
// dipotong dengan .slice(). Dua helper ini mencegahnya.
function cleanText(value) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

// Potong berdasarkan jumlah karakter sebenarnya (code point), bukan unit UTF-16.
function truncateText(value, max) {
  return Array.from(cleanText(value)).slice(0, max).join("");
}

function safeErrorMessage(error, max = 500) {
  const raw = String(error?.message || error || "Kesalahan tidak diketahui");
  return truncateText(raw.replace(/\s+/g, " "), max);
}

function isOwnerId(telegramUserId) {
  return ADMIN_IDS.has(String(telegramUserId));
}

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
  const m = String(value || "")
    .trim()
    .toLowerCase()
    .match(/^([1-9]\d*(?:\.\d+)?)\s*(menit|jam|hari|m|h|d)$/);

  if (!m) return null;

  const unit = {
    menit: 1,
    m: 1,
    jam: 60,
    h: 60,
    hari: 1440,
    d: 1440
  }[m[2]];

  const minutes = Math.round(Number(m[1]) * unit);
  if (!Number.isFinite(minutes) || minutes < 1) return null;
  return minutes;
}

function parseHours(value) {
  const m = String(value || "")
    .trim()
    .toLowerCase()
    .match(/^([1-9]\d*(?:\.\d+)?)\s*(jam|hari|h|d)$/);

  if (!m) return null;

  const unit = {
    jam: 1,
    h: 1,
    hari: 24,
    d: 24
  }[m[2]];

  const hours = Math.round(Number(m[1]) * unit);
  if (!Number.isFinite(hours) || hours < 1) return null;
  return hours;
}

function parsePositiveTelegramId(value) {
  const raw = String(value || "").trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

function formatDate(value) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString("id-ID");
  } catch (_) {
    return String(value);
  }
}

function accountStatusIcon(account) {
  if (account?.status === "connected") return "🟢";
  if (account?.status === "error") return "🟠";
  return "⚪";
}

function promotionStatusIcon(settings) {
  if (settings?.active) return "▶️";
  return "⏹";
}

function ensurePage(value, maxPage = 0) {
  const page = Math.max(0, Number.parseInt(value, 10) || 0);
  return Math.min(page, Math.max(0, maxPage));
}

function buildPageButtons(prefix, page, hasPrev, hasNext, extraButtons = []) {
  const kb = new InlineKeyboard();

  if (hasPrev) kb.text("◀️", `${prefix}:${page - 1}`);
  if (hasNext) kb.text("▶️", `${prefix}:${page + 1}`);
  if (hasPrev || hasNext) kb.row();

  for (const row of extraButtons) {
    if (!row?.length) continue;
    for (const item of row) {
      kb.text(item.text, item.callback);
    }
    kb.row();
  }

  return kb;
}

/* =========================================================
   SESSION ENCRYPTION
   New sessions are always encrypted at application level.
   Existing deployments can start without a new ENV because a
   stable key is derived from existing secrets, but a dedicated
   SESSION_ENCRYPTION_KEY is strongly recommended.
========================================================= */

function encryptionKey() {
  const explicit = String(process.env.SESSION_ENCRYPTION_KEY || "").trim();

  if (explicit) {
    if (/^[0-9a-fA-F]{64}$/.test(explicit)) {
      return Buffer.from(explicit, "hex");
    }

    try {
      const decoded = Buffer.from(explicit, "base64");
      if (decoded.length === 32) return decoded;
    } catch (_) {}

    throw new Error(
      "SESSION_ENCRYPTION_KEY harus berupa 64 karakter hex atau base64 32-byte."
    );
  }

  // Compatibility fallback: avoids breaking old VPS deployments.
  return crypto
    .createHash("sha256")
    .update(
      `${process.env.SUPABASE_SERVICE_ROLE_KEY}|${process.env.API_HASH}|telegram-auto-bot-session-v3`
    )
    .digest();
}

const SESSION_KEY = encryptionKey();

function encryptSession(plainText) {
  if (!plainText) return null;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", SESSION_KEY, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plainText), "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url")
  ].join(".");
}

function decryptSession(encoded) {
  const raw = String(encoded || "");
  if (!raw) return null;

  const parts = raw.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Format session terenkripsi tidak valid.");
  }

  const iv = Buffer.from(parts[1], "base64url");
  const tag = Buffer.from(parts[2], "base64url");
  const ciphertext = Buffer.from(parts[3], "base64url");

  const decipher = crypto.createDecipheriv("aes-256-gcm", SESSION_KEY, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]).toString("utf8");
}

/* =========================================================
   ADMIN AUTHORIZATION
========================================================= */


const OFFICIAL_CHANNEL = "@jasebvortex";
const OWNER_CONTACT = "farishost1";
const ROLE_PRICES = { ADMIN_ANAK: 5000, ADMIN_VIP: 10000, ADMIN_PREMIUM: 15000 };
const ROLE_LABELS = { ADMIN_ANAK: "ADMIN BIASA", ADMIN_VIP: "ADMIN VIP", ADMIN_PREMIUM: "ADMIN PREMIUM" };

function subscriptionTableMissing(error) {
  const msg = String(error?.message || error || "").toLowerCase();
  const code = String(error?.code || "");
  return code === "PGRST205" || msg.includes("schema cache") || msg.includes("does not exist") || (msg.includes("relation") && msg.includes("not found"));
}

async function getUserSubscription(telegramUserId) {
  const { data, error } = await sb
    .from("bot_subscriptions")
    .select("*")
    .eq("telegram_user_id", Number(telegramUserId))
    .maybeSingle();
  if (error) {
    if (subscriptionTableMissing(error)) return null;
    throw error;
  }
  return data || null;
}

function subscriptionIsActive(row) {
  return Boolean(row?.active) && (!row.expires_at || new Date(row.expires_at).getTime() > Date.now());
}

async function saveUserSubscription(payload) {
  const { data, error } = await sb
    .from("bot_subscriptions")
    .upsert({
      telegram_user_id: Number(payload.telegram_user_id),
      role: payload.role,
      active: payload.active !== false,
      expires_at: payload.expires_at || null,
      parent_admin_id: payload.parent_admin_id || null,
      activated_by: payload.activated_by || null,
      updated_at: new Date().toISOString()
    }, { onConflict: "telegram_user_id" })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function deactivateExpiredAdmin(adminRow, subscription) {
  if (!subscription?.expires_at || new Date(subscription.expires_at).getTime() > Date.now()) return;
  try {
    await sb.from("admins").update({ active: false, updated_at: new Date().toISOString() }).eq("id", adminRow.id);
  } catch (_) {}
}

async function isOfficialChannelMember(userId) {
  try {
    const member = await bot.api.getChatMember(OFFICIAL_CHANNEL, Number(userId));
    const status = String(member?.status || "").toLowerCase();
    if (["creator", "administrator", "member"].includes(status)) return true;
    if (status === "restricted") return member?.is_member === true;
    return false;
  } catch (error) {
    console.error("CHANNEL CHECK:", safeErrorMessage(error, 300));
    return null;
  }
}

function joinChannelKeyboard() {
  return new InlineKeyboard()
    .url("📢 Join Channel Resmi", "https://t.me/jasebvortex")
    .row()
    .text("✅ Saya Sudah Join", "user:checkjoin");
}

function userJoinText() {
  return [
    "🔒 <b>AKSES BOT BELUM TERSEDIA</b>",
    "━━━━━━━━━━━━━━━━━━",
    "Untuk melanjutkan, kamu wajib bergabung terlebih dahulu ke <b>Channel Resmi</b> kami.",
    "",
    "📢 <b>Channel Resmi:</b> @jasebvortex",
    "",
    "Setelah bergabung, tekan tombol <b>✅ Saya Sudah Join</b> untuk mengecek keanggotaan.",
    "",
    "⚠️ Selama belum bergabung, proses daftar, pembelian, dan penggunaan bot tidak dapat dilanjutkan."
  ].join("\n");
}

function userPurchaseText(subscription = null) {
  const renewal = subscription && !subscriptionIsActive(subscription);
  return [
    renewal ? "🔄 <b>MASA AKTIF HABIS</b>" : "🛒 <b>DAFTAR & BELI AKSES BOT</b>",
    "━━━━━━━━━━━━━━━━━━",
    renewal
      ? "Masa aktif akses kamu sudah berakhir. Silakan pilih role untuk melakukan perpanjangan."
      : "Pilih role yang sesuai kebutuhan. Semua paket berlaku <b>1 bulan</b> dan dapat diperpanjang.",
    "",
    "👤 <b>ADMIN BIASA — Rp5.000 / bulan</b>",
    "• Akses promosi ke grup",
    "• Kelola akun Telegram yang terhubung",
    "• Kelola format dan target promosi",
    "• Tidak memiliki menu Admin",
    "• Tidak memiliki Promosi Chat Privat",
    "",
    "⭐ <b>ADMIN VIP — Rp10.000 / bulan</b>",
    "• Semua fitur Admin Biasa",
    "• Dapat menambah Admin Biasa di bawahnya",
    "• Dapat membuka penjualan/pendaftaran bot untuk pengguna lain",
    "• Tetap tanpa Promosi Chat Privat",
    "",
    "💎 <b>ADMIN PREMIUM — Rp15.000 / bulan</b>",
    "• Semua fitur Admin VIP",
    "• Promosi Chat Privat",
    "• Dapat menambah Admin Biasa",
    "• Dapat membuka penjualan/pendaftaran bot untuk pengguna lain",
    "",
    "⏳ <b>Masa aktif: 1 bulan</b>",
    "Perpanjangan dapat dilakukan sebelum atau setelah masa aktif habis.",
    "",
    "📌 Setelah memilih paket, bot akan membuat detail order yang siap kamu kirim ke Owner."
  ].join("\n");
}

function userPurchaseKeyboard() {
  return new InlineKeyboard()
    .text("👤 Order Admin Biasa — 5K", "user:order:ADMIN_ANAK")
    .row()
    .text("⭐ Order Admin VIP — 10K", "user:order:ADMIN_VIP")
    .row()
    .text("💎 Order Admin Premium — 15K", "user:order:ADMIN_PREMIUM")
    .row()
    .url("📢 Channel Resmi", "https://t.me/jasebvortex");
}

function userOrderText(ctx, role, subscription = null) {
  const roleLabel = ROLE_LABELS[role] || role;
  const price = ROLE_PRICES[role] || 0;
  const first = String(ctx.from?.first_name || "").trim();
  const last = String(ctx.from?.last_name || "").trim();
  const name = [first, last].filter(Boolean).join(" ") || "-";
  const username = ctx.from?.username ? `@${ctx.from.username}` : "-";
  const tgId = String(ctx.from?.id || "-");
  return [
    "🧾 <b>ORDER AKSES BOT</b>",
    "━━━━━━━━━━━━━━━━━━",
    `👤 Nama: <b>${escapeHtml(name)}</b>`,
    `🔗 Username: <b>${escapeHtml(username)}</b>`,
    `🆔 Telegram ID: <code>${escapeHtml(tgId)}</code>`,
    `🎖️ Paket: <b>${escapeHtml(roleLabel)}</b>`,
    `💰 Harga: <b>Rp${price.toLocaleString("id-ID")}</b>`,
    "⏳ Masa aktif: <b>1 bulan</b>",
    subscription && !subscriptionIsActive(subscription) ? "🔄 Status: <b>Perpanjangan</b>" : "🆕 Status: <b>Pendaftaran Baru</b>",
    "",
    "Silakan buka chat Owner melalui tombol di bawah lalu kirim order ini untuk diproses."
  ].join("\n");
}

function ownerOrderUrl(text) {
  return `https://t.me/${OWNER_CONTACT}?text=${encodeURIComponent(text.replace(/<[^>]+>/g, ""))}`;
}

async function getAdminByTelegramId(telegramUserId) {
  const { data, error } = await sb
    .from("admins")
    .select("*")
    .eq("telegram_user_id", telegramUserId)
    .eq("active", true)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const subscription = await getUserSubscription(telegramUserId);
  if (subscription?.expires_at && new Date(subscription.expires_at).getTime() <= Date.now()) {
    await deactivateExpiredAdmin(data, subscription);
    return null;
  }
  if (subscription && subscription.active === false) return null;
  return data;
}

async function ensureBootstrapOwners() {
  const rows = [];

  for (const id of ADMIN_IDS) {
    rows.push({
      telegram_user_id: Number(id),
      role: "OWNER",
      active: true
    });
  }

  if (!rows.length) return;

  const { error } = await sb
    .from("admins")
    .upsert(rows, { onConflict: "telegram_user_id" });

  if (error) throw error;
}

async function requireAdmin(ctx, options = {}) {
  const telegramUserId = ctx.from?.id;
  const adminRow = telegramUserId
    ? await getAdminByTelegramId(telegramUserId)
    : null;

  if (!adminRow) {
    await ctx.answerCallbackQuery("Akses ditolak.", {
      show_alert: true
    }).catch(() => {});
    return null;
  }

  if (options.ownerOnly && adminRow.role !== "OWNER") {
    await ctx.answerCallbackQuery(
      "Fungsi ini hanya untuk ADMIN UTAMA.",
      { show_alert: true }
    ).catch(() => {});
    return null;
  }

  // Keep optional profile data fresh without using it for authorization.
  const profileUpdate = {
    username: ctx.from?.username || null,
    first_name: ctx.from?.first_name || null
  };

  sb.from("admins")
    .update(profileUpdate)
    .eq("id", adminRow.id)
    .then(result => {
      if (result.error) console.error("ADMIN PROFILE UPDATE:", result.error);
    })
    .catch(error => console.error("ADMIN PROFILE UPDATE:", error));

  return adminRow;
}

/* =========================================================
   UI HELPERS
========================================================= */

async function saveUiMessage(userId, msg, isMedia = false) {
  if (!msg) return;
  uiMessages.set(String(userId), {
    chatId: msg.chat.id,
    messageId: msg.message_id,
    isMedia
  });
}

async function deleteSavedUi(userId) {
  const saved = uiMessages.get(String(userId));
  if (!saved) return;

  try {
    await bot.api.deleteMessage(saved.chatId, saved.messageId);
  } catch (_) {}

  uiMessages.delete(String(userId));
}

async function withUiLock(userId, fn) {
  const key = String(userId);
  const previous = uiLocks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(fn);
  uiLocks.set(key, current);

  try {
    return await current;
  } finally {
    if (uiLocks.get(key) === current) {
      uiLocks.delete(key);
    }
  }
}

async function renderUi(userId, text, keyboard, options = {}) {
  const key = String(userId);
  const saved = uiMessages.get(key);

  const extra = {
    reply_markup: keyboard
  };

  if (options.parse_mode) extra.parse_mode = options.parse_mode;

  if (saved) {
    try {
      if (saved.isMedia) {
        await bot.api.editMessageCaption(
          saved.chatId,
          saved.messageId,
          {
            caption: text,
            ...extra
          }
        );
        return;
      }

      await bot.api.editMessageText(
        saved.chatId,
        saved.messageId,
        text,
        extra
      );
      return;
    } catch (e) {
      if (/message is not modified/i.test(String(e.message || e))) {
        return;
      }

      await deleteSavedUi(userId);

      // Let the caller decide how to re-create the message (e.g. with banner).
      if (options.sendFallback === false) return false;
    }
  }

  const msg = await bot.api.sendMessage(userId, text, extra);
  await saveUiMessage(userId, msg, false);
}

async function replaceUi(ctx, text, keyboard, options = {}) {
  // Every menu owns exactly one UI message. Opening another menu removes the
  // previous panel first, so the chat does not fill up with stale menus.
  await deleteSavedUi(ctx.from.id);
  const extra = { reply_markup: keyboard };
  if (options.parse_mode) extra.parse_mode = options.parse_mode;
  const msg = await bot.api.sendMessage(ctx.chat?.id || ctx.from.id, text, extra);
  await saveUiMessage(ctx.from.id, msg, false);
  return msg;
}

async function renderStart(ctx, text, keyboard) {
  const userId = ctx.from.id;

  return withUiLock(userId, async () => {
    // Main panel is a fresh banner panel; remove the previous menu first.
    await deleteSavedUi(userId);
    if (START_BANNER_FILE_ID) {
      try {
        const msg = await ctx.replyWithPhoto(START_BANNER_FILE_ID, {
          caption: text,
          parse_mode: "HTML",
          reply_markup: keyboard
        });
        await saveUiMessage(userId, msg, true);
        return msg;
      } catch (e) {
        console.error("START BANNER FILE_ID:", safeErrorMessage(e));
      }
    }

    if (START_BANNER_URL && /^https?:\/\//i.test(START_BANNER_URL)) {
      try {
        const response = await fetch(START_BANNER_URL, {
          redirect: "follow",
          signal: AbortSignal.timeout(15000)
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const contentType = String(response.headers.get("content-type") || "").toLowerCase();
        if (!contentType.startsWith("image/")) {
          throw new Error(`URL bukan file gambar (content-type: ${contentType || "unknown"})`);
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer.length) throw new Error("File banner kosong.");
        if (buffer.length > 10 * 1024 * 1024) throw new Error("File banner terlalu besar.");

        const msg = await ctx.replyWithPhoto(new InputFile(buffer, "start-banner.jpg"), {
          caption: text,
          parse_mode: "HTML",
          reply_markup: keyboard
        });
        await saveUiMessage(userId, msg, true);
        return msg;
      } catch (e) {
        console.error("START BANNER URL:", safeErrorMessage(e));
      }
    }

    const msg = await bot.api.sendMessage(userId, text, {
      parse_mode: "HTML",
      reply_markup: keyboard
    });
    await saveUiMessage(userId, msg, false);
    return msg;
  });
}

function displayAdminRole(role) {
  return ({
    OWNER: "OWNER",
    ADMIN_PREMIUM: "ADMIN PREMIUM",
    ADMIN_VIP: "ADMIN VIP",
    ADMIN_ANAK: "ADMIN"
  }[role] || role || "ADMIN");
}

function canUsePrivatePromotion(role) {
  return role === "OWNER" || role === "ADMIN_PREMIUM";
}

async function requirePrivatePromotionAccess(ctx, adminRow) {
  if (canUsePrivatePromotion(adminRow?.role)) return true;
  await ctx.answerCallbackQuery(
    "Promosi Chat Privat hanya tersedia untuk Admin Premium dan OWNER.",
    { show_alert: true }
  ).catch(() => {});
  return false;
}

function dashboardText(ctx, stats, extra = "", role = "") {
  const first = String(ctx.from?.first_name || "").trim();
  const last = String(ctx.from?.last_name || "").trim();
  const name = [first, last].filter(Boolean).join(" ") || "Admin";
  const username = ctx.from?.username ? `@${ctx.from.username}` : "-";
  const roleLabel = role ? displayAdminRole(role) : "";
  const rule = "━━━━━━━━━━━━━━━━━━";

  const intro =
    extra ||
    "Silakan pilih menu di bawah untuk mengatur akun Telegram, format promosi, target grup, dan pengaturan lainnya.";

  // Every value that may be copied sits in its own <code> element, so a single
  // tap copies just that value (never one big block).
  return [
    "🎛️ <b>PANEL KONTROL</b>",
    rule,
    `👤 <b>Nama: ${escapeHtml(name)}</b>`,
    `🆔 ID Telegram · <code>${escapeHtml(ctx.from.id)}</code>`,
    `🔗 Username · <code>${escapeHtml(username)}</code>`,
    roleLabel ? `🎖️ Role · <code>${roleLabel}</code>` : null,
    `🤖 Versi bot · <code>v${escapeHtml(BOT_VERSION)}</code>`,
    rule,
    `<blockquote>✨ <b>Panel sesuai akun Telegram yang digunakan.</b>\n${escapeHtml(intro)}</blockquote>`,
    "",
    "📊 <b>STATUS SISTEM</b>",
    `👥 Admin aktif · <b>${stats.admins}</b>`,
    `📱 Akun Telegram · <b>${stats.accounts}</b>`,
    `🟢 Terhubung · <b>${stats.connected}</b>`,
    `▶️ Promosi berjalan · <b>${stats.running}</b>`,
    `🎯 Target grup aktif · <b>${stats.groups}</b>`,
    rule,
    "⬇️ <b>MENU UTAMA</b>"
  ].filter(line => line !== null).join("\n");
}

async function getDashboardStats(adminRow = null) {
  const isOwner = adminRow?.role === "OWNER";
  let accountIds = null;

  if (adminRow && !isOwner) {
    const { data, error } = await sb
      .from("telegram_accounts")
      .select("id")
      .eq("created_by", adminRow.telegram_user_id);
    if (error) throw error;
    accountIds = (data || []).map(x => x.id);
  }

  const accountsQuery = sb.from("telegram_accounts").select("*", { count: "exact", head: true });
  const connectedQuery = sb.from("telegram_accounts").select("*", { count: "exact", head: true }).eq("status", "connected");

  if (accountIds !== null) {
    accountsQuery.eq("created_by", adminRow.telegram_user_id);
    connectedQuery.eq("created_by", adminRow.telegram_user_id);
  }

  const groupsQuery = accountIds === null
    ? sb.from("account_groups").select("*", { count: "exact", head: true }).eq("enabled", true).eq("can_send", true)
    : accountIds.length
      ? sb.from("account_groups").select("*", { count: "exact", head: true }).eq("enabled", true).eq("can_send", true).in("account_id", accountIds)
      : null;

  const settingsQuery = accountIds === null
    ? sb.from("account_settings").select("formats")
    : accountIds.length
      ? sb.from("account_settings").select("formats").in("account_id", accountIds)
      : null;

  const [admins, accounts, connected, groups, settingsRows] = await Promise.all([
    sb.from("admins").select("*", { count: "exact", head: true }).eq("active", true),
    accountsQuery,
    connectedQuery,
    groupsQuery || Promise.resolve({ data: [], count: 0, error: null }),
    settingsQuery || Promise.resolve({ data: [], error: null })
  ]);

  for (const r of [admins, accounts, connected, groups, settingsRows]) {
    if (r.error) throw r.error;
  }

  const running = (settingsRows.data || []).reduce(
    (n, row) => n + (Array.isArray(row.formats) ? row.formats.filter(f => f?.active).length : 0),
    0
  );

  return {
    admins: Number(admins.count || 0),
    accounts: Number(accounts.count || 0),
    connected: Number(connected.count || 0),
    running,
    groups: Number(groups.count || 0)
  };
}

function ownerDashboardMenu() {
  return new InlineKeyboard()
    .text("📱 Akun Telegram", "accounts:list:0")
    .row()
    .text("👥 Admin", "admin:list:0")
    .text("📊 Refresh", "menu:dashboard")
    .row()
    .text("➕ Tambah Akun", "account:add")
    .row()
    .text("📢 Promosi Chat Privat", "privatepromo:accounts:0");
}

function adminDashboardMenu(adminRow = null) {
  const kb = new InlineKeyboard()
    .text("📱 Akun Telegram", "accounts:list:0")
    .row();

  if (["ADMIN_VIP", "ADMIN_PREMIUM"].includes(adminRow?.role)) {
    kb.text("👥 Admin", "admin:list:0")
      .text("📊 Refresh", "menu:dashboard")
      .row();
  } else {
    kb.text("📊 Refresh", "menu:dashboard").row();
  }

  kb.text("➕ Tambah Akun", "account:add").row();
  if (adminRow?.role === "ADMIN_PREMIUM") {
    kb.text("📢 Promosi Chat Privat", "privatepromo:accounts:0");
  }
  return kb;
}

function backDashboardKeyboard() {
  return new InlineKeyboard().text("🏠 Menu Utama", "menu:dashboard");
}

function accountListKeyboard(accounts, page, hasNext) {
  const kb = new InlineKeyboard();

  for (const account of accounts) {
    kb
      .text(
        `${accountStatusIcon(account)} ${safeButtonText(account.label, 28)}`,
        `account:open:${account.id}`
      )
      .row();
  }

  if (page > 0) kb.text("◀️", `accounts:list:${page - 1}`);
  kb.text("🏠", "menu:dashboard");
  if (hasNext) kb.text("▶️", `accounts:list:${page + 1}`);
  kb.row();
  kb.text("➕ Tambah Akun", "account:add");

  return kb;
}

function accountMenu(account, settings) {
  const kb = new InlineKeyboard();
  kb.text("📊 Status", `account:status:${account.id}`).row();
  kb.text("⚙️ Pengaturan", `account:settings:${account.id}`).row();
  if (account.status === "connected") kb.text("🔌 Putus", `account:disconnect:${account.id}`);
  else kb.text("🔗 Hubungkan", `account:connect:${account.id}`);
  kb.row();
  kb.text("👥 Grup", `group:list:${account.id}:0`).row();
  kb.text("➕ Tambah Grup", `group:add:${account.id}`).row();
  kb.text("📝 Format", `promo:list:${account.id}:0`).row();
  kb.text("➕ Format Baru", `promo:add:${account.id}`).row();
  kb.text("▶️ Format Aktif", `promo:active:${account.id}:0`).row();
  kb.text("⏹ Stop Promosi", `promo:stopall:${account.id}`).row();
  kb.text("📋 Riwayat", `history:list:${account.id}:0`).row();
  kb.text("🏷️ Nama", `account:label:${account.id}`).row();
  kb.text("🗑️ Hapus", `account:remove:${account.id}`).row();
  kb.text("⬅️ Kembali", "accounts:list:0");
  return kb;
}

function settingsMenu(accountId) {
  return new InlineKeyboard()
    .text("🏷️ Label", `account:label:${accountId}`).row()
    .text("📝 Format", `promo:list:${accountId}:0`).row()
    .text("➕ Tambah Format", `promo:add:${accountId}`).row()
    .text("⬅️ Kembali", `account:open:${accountId}`);
}

function formatListKeyboard(formats, accountId, page = 0) {
  const kb = new InlineKeyboard();
  for (const f of formats) {
    const icon = f.active ? "🟢" : "⚪";
    kb.text(`${icon} ${safeButtonText(f.name, 30)}`, `promo:view:${accountId}:${f.id}`).row();
  }
  kb.text("➕ Tambah Format", `promo:add:${accountId}`).row();
  kb.text("⬅️ Kembali", `account:open:${accountId}`);
  return kb;
}

function activeFormatKeyboard(formats, accountId) {
  const kb = new InlineKeyboard();
  for (const f of formats.filter(x => x.active)) {
    kb.text(`🟢 ${safeButtonText(f.name, 28)}`, `promo:view:${accountId}:${f.id}`).row();
  }
  kb.text("⬅️ Kembali", `account:open:${accountId}`);
  return kb;
}

function formatDelayKeyboard(accountId, formatId) {
  return new InlineKeyboard()
    .text("5 menit", `promo:delayset:${accountId}:${formatId}:5`)
    .text("10 menit", `promo:delayset:${accountId}:${formatId}:10`)
    .row()
    .text("30 menit", `promo:delayset:${accountId}:${formatId}:30`)
    .text("1 jam", `promo:delayset:${accountId}:${formatId}:60`)
    .row()
    .text("2 jam", `promo:delayset:${accountId}:${formatId}:120`)
    .row()
    .text("⌨️ Ketik sendiri", `promo:delay:${accountId}:${formatId}`)
    .row()
    .text("⬅️ Kembali", `promo:view:${accountId}:${formatId}`);
}

function formatDurationKeyboard(accountId, formatId) {
  return new InlineKeyboard()
    .text("1 jam", `promo:durationset:${accountId}:${formatId}:1`)
    .text("1 hari", `promo:durationset:${accountId}:${formatId}:24`)
    .row()
    .text("3 hari", `promo:durationset:${accountId}:${formatId}:72`)
    .text("7 hari", `promo:durationset:${accountId}:${formatId}:168`)
    .row()
    .text("⌨️ Ketik sendiri", `promo:duration:${accountId}:${formatId}`)
    .row()
    .text("⬅️ Kembali", `promo:view:${accountId}:${formatId}`);
}

function formatDetailKeyboard(accountId, format) {
  const kb = new InlineKeyboard();
  kb.text("✏️ Edit Format", `promo:edit:${accountId}:${format.id}`).row();
  kb.text("⏱️ Atur Jeda", `promo:delay:${accountId}:${format.id}`).row();
  kb.text("📅 Atur Durasi", `promo:duration:${accountId}:${format.id}`).row();
  if (format.active) kb.text("⏹️ Stop", `promo:stop:${accountId}:${format.id}`);
  else kb.text("▶️ Mulai", `promo:start:${accountId}:${format.id}`);
  kb.row();
  kb.text(format.active ? "🔴 Nonaktif" : "🟢 Aktif", `promo:toggle:${accountId}:${format.id}`).row();
  kb.text("🗑️ Hapus Format", `promo:delete:${accountId}:${format.id}`).row();
  kb.text("⬅️ Kembali", `promo:list:${accountId}:0`);
  return kb;
}

function groupListKeyboard(rows, accountId, page, hasNext) {
  const kb = new InlineKeyboard();

  // Only groups/channels Telegram reports as writable are shown as targets.
  // Tapping the group name itself toggles the target state.
  for (const group of rows.filter(g => g.can_send)) {
    const icon = group.enabled ? "✅" : "❌";
    kb.text(`${icon} ${safeButtonText(group.title, 34)}`, `group:toggle:${group.id}:${page}`).row();
  }

  if (page > 0) kb.text("◀️", `group:list:${accountId}:${page - 1}`);
  kb.text("🏠", "menu:dashboard");
  if (hasNext) kb.text("▶️", `group:list:${accountId}:${page + 1}`);
  kb.row();
  kb.text("🔎 Cari Grup", `group:search:${accountId}`).row();
  kb.text("➕ Tambah Semua Grup", `group:all:${accountId}`).row();
  kb.text("🔄 Deteksi Grup", `group:refresh:${accountId}`).row();
  kb.text("⬅️ Akun", `account:open:${accountId}`);

  return kb;
}

function historyKeyboard(accountId, page, hasNext) {
  const kb = new InlineKeyboard();

  if (page > 0) kb.text("◀️", `history:list:${accountId}:${page - 1}`);
  kb.text("🏠", "menu:dashboard");
  if (hasNext) kb.text("▶️", `history:list:${accountId}:${page + 1}`);
  kb.row();
  kb.text("◀️ Account", `account:open:${accountId}`);

  return kb;
}

function adminListKeyboard(admins, page, hasNext, viewer = null) {
  const kb = new InlineKeyboard();

  for (const a of admins) {
    const roleIcon = a.role === "OWNER" ? "👑" : a.role === "ADMIN_PREMIUM" ? "💎" : a.role === "ADMIN_VIP" ? "⭐" : "👤";
    const label = `${roleIcon} ${a.telegram_user_id || "-"}`;
    kb.text(safeButtonText(label, 32), `admin:view:${a.id}`).row();
  }

  if (page > 0) kb.text("◀️", `admin:list:${page - 1}`);
  kb.text("🏠", "menu:dashboard");
  if (hasNext) kb.text("▶️", `admin:list:${page + 1}`);
  kb.row();

  if (viewer?.role === "OWNER") {
    kb.text("➕ Tambah Admin", "admin:add");
    kb.text("❌ Putus Admin", "admin:delete");
  } else if (["ADMIN_VIP", "ADMIN_PREMIUM"].includes(viewer?.role)) {
    kb.text("➕ Tambah Admin", "admin:add");
    kb.text("❌ Putus Admin", "admin:delete");
  }

  return kb;
}

function cancelKeyboard(ownerOnly = false) {
  return new InlineKeyboard().text(
    "❌ Batal",
    ownerOnly ? "admin:cancel" : "flow:cancel"
  );
}

/* =========================================================
   ACCOUNT / SETTINGS DATABASE HELPERS
========================================================= */

async function getAccount(accountId) {
  const { data, error } = await sb
    .from("telegram_accounts")
    .select("*")
    .eq("id", accountId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getAccountForAdmin(accountId, adminRow) {
  const account = await getAccount(accountId);
  if (!account) return null;
  if (adminRow?.role === "OWNER") return account;
  if (String(account.created_by || "") !== String(adminRow?.telegram_user_id || "")) return null;
  return account;
}

async function requireAccountAccess(ctx, adminRow, accountId) {
  const account = await getAccountForAdmin(accountId, adminRow);
  if (account) return account;
  await ctx.answerCallbackQuery("Akun ini bukan milik admin ini.", { show_alert: true }).catch(() => {});
  return null;
}

async function getAccountSettings(accountId) {
  const { data, error } = await sb
    .from("account_settings")
    .select("*")
    .eq("account_id", accountId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function ensureAccountSettings(accountId) {
  const existing = await getAccountSettings(accountId);
  if (existing) return existing;

  const { data, error } = await sb
    .from("account_settings")
    .insert({ account_id: accountId })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

/* =========================================================
   MULTI FORMAT STORAGE
   Formats are stored in account_settings.formats (JSONB) so the existing
   database schema stays compatible. The legacy single-format columns remain
   untouched and are imported once into "Format 1".
========================================================= */

function newFormatId() {
  return crypto.randomBytes(6).toString("hex");
}

function normalizeFormat(row = {}) {
  return {
    id: String(row.id || newFormatId()),
    name: truncateText(String(row.name || "Format Baru").trim(), 60) || "Format Baru",
    media_type: row.media_type === "photo" ? "photo" : "text",
    message: cleanText(row.message || ""),
    media_file_id: row.media_file_id || null,
    caption: row.caption ? cleanText(row.caption) : null,
    interval_minutes: Math.max(1, Number(row.interval_minutes || 10)),
    duration_hours: Math.max(1, Number(row.duration_hours || 1)),
    start_time: row.start_time || null,
    stop_time: row.stop_time || null,
    active: row.active === true,
    started_at: row.started_at || null,
    expires_at: row.expires_at || null,
    failure_reports: Array.isArray(row.failure_reports)
      ? row.failure_reports
          .slice(0, 5)
          .map(report => ({
            token: String(report?.token || ""),
            created_at: report?.created_at || null,
            account_name: cleanText(report?.account_name || ""),
            account_username: report?.account_username ? cleanText(report.account_username) : null,
            account_telegram_id: report?.account_telegram_id || null,
            account_phone: report?.account_phone ? cleanText(report.account_phone) : null,
            format_name: cleanText(report?.format_name || ""),
            failed_rows: Array.isArray(report?.failed_rows)
              ? report.failed_rows.slice(0, 300).map(item => ({
                  groupId: item?.groupId || null,
                  groupTitle: cleanText(item?.groupTitle || "Group tanpa nama"),
                  reason: cleanText(item?.reason || "Kesalahan tidak diketahui")
                }))
              : []
          }))
          .filter(report => report.token && report.failed_rows.length)
      : [],
    created_at: row.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

async function getPromotionFormats(accountId) {
  const settings = await ensureAccountSettings(accountId);
  let formats = Array.isArray(settings.formats) ? settings.formats.map(normalizeFormat) : [];

  // One-time compatibility import from the old single-format columns.
  if (!formats.length) {
    const hasLegacy =
      (settings.media_type === "text" && String(settings.message || "").trim()) ||
      (settings.media_type === "photo" && settings.media_file_id);

    if (hasLegacy) {
      formats = [normalizeFormat({
        name: "Format 1",
        media_type: settings.media_type,
        message: settings.message,
        media_file_id: settings.media_file_id,
        caption: settings.caption,
        interval_minutes: settings.interval_minutes,
        duration_hours: settings.duration_hours,
        active: settings.active === true,
        started_at: settings.started_at || null,
        expires_at: settings.expires_at || null
      })];
      await sb.from("account_settings").update({ formats }).eq("account_id", accountId);
    }
  }

  return formats;
}

async function savePromotionFormats(accountId, formats) {
  // Keep the existing Supabase client path used by the rest of the bot.
  // The previous direct REST PATCH was the source of PGRST102
  // ("Empty or invalid json") on the format-save step.
  const normalized = (formats || []).map(normalizeFormat);
  // Bersihkan semua string (NUL / surrogate terbelah) sebelum dikirim ke PostgREST.
  const jsonFormats = JSON.parse(
    JSON.stringify(normalized),
    (_key, value) => (typeof value === "string" ? cleanText(value) : value)
  );

  const { data, error } = await sb
    .from("account_settings")
    .update({ formats: jsonFormats })
    .eq("account_id", accountId)
    .select("formats")
    .maybeSingle();

  if (error) {
    throw new Error(`Supabase formats update gagal: ${error.message || error.code || "unknown error"}`);
  }

  if (!data) {
    throw new Error("Setting account tidak ditemukan saat menyimpan format.");
  }

  return Array.isArray(data.formats)
    ? data.formats.map(normalizeFormat)
    : jsonFormats.map(normalizeFormat);
}

async function getPromotionFormat(accountId, formatId) {
  const formats = await getPromotionFormats(accountId);
  return formats.find(x => String(x.id) === String(formatId)) || null;
}

function formatReady(format) {
  return Boolean(
    (format?.media_type === "text" && String(format?.message || "").trim()) ||
    (format?.media_type === "photo" && format?.media_file_id)
  );
}

function parseTimeHHMM(value) {
  const m = String(value || "").trim().match(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
  return m ? m[0] : null;
}

function timeParts(value) {
  const [h, m] = String(value).split(":").map(Number);
  return { h, m };
}

function nextFormatStartAt(format, now = new Date()) {
  const startTime = format?.start_time || null;
  const stopTime = format?.stop_time || null;

  // No time restriction: start immediately.
  if (!startTime && !stopTime) return new Date(now);

  const minutesNow = now.getHours() * 60 + now.getMinutes();

  // Start only: active from start time onward.
  if (startTime && !stopTime) {
    const start = new Date(now);
    const { h, m } = timeParts(startTime);
    const startMinutes = h * 60 + m;
    start.setHours(h, m, 0, 0);
    return minutesNow >= startMinutes ? new Date(now) : start;
  }

  // Stop only: active from midnight until stop time.
  // Once today's window has ended, wait for next midnight instead of
  // retrying every second.
  if (!startTime && stopTime) {
    const { h, m } = timeParts(stopTime);
    const stopMinutes = h * 60 + m;

    if (minutesNow <= stopMinutes) return new Date(now);

    const nextMidnight = new Date(now);
    nextMidnight.setDate(nextMidnight.getDate() + 1);
    nextMidnight.setHours(0, 0, 0, 0);
    return nextMidnight;
  }

  const startParts = timeParts(startTime);
  const stopParts = timeParts(stopTime);
  const startMinutes = startParts.h * 60 + startParts.m;
  const stopMinutes = stopParts.h * 60 + stopParts.m;

  // Same-day window, e.g. 08:00 - 22:00.
  if (startMinutes <= stopMinutes) {
    if (minutesNow < startMinutes) {
      const start = new Date(now);
      start.setHours(startParts.h, startParts.m, 0, 0);
      return start;
    }

    if (minutesNow <= stopMinutes) return new Date(now);

    const nextStart = new Date(now);
    nextStart.setDate(nextStart.getDate() + 1);
    nextStart.setHours(startParts.h, startParts.m, 0, 0);
    return nextStart;
  }

  // Overnight window, e.g. 22:00 - 08:00.
  if (minutesNow >= startMinutes || minutesNow <= stopMinutes) {
    return new Date(now);
  }

  const nextStart = new Date(now);
  nextStart.setHours(startParts.h, startParts.m, 0, 0);
  return nextStart;
}

function nextTimeWindowMs(startTime, stopTime, now = new Date()) {
  const startAt = nextFormatStartAt(
    { start_time: startTime || null, stop_time: stopTime || null },
    now
  );

  return Math.max(1000, startAt.getTime() - now.getTime());
}

function isWithinFormatWindow(format, now = new Date()) {
  if (!format?.start_time && !format?.stop_time) return true;
  if (format.start_time && !format.stop_time) {
    const { h, m } = timeParts(format.start_time);
    const start = new Date(now); start.setHours(h, m, 0, 0);
    return now >= start;
  }
  if (!format.start_time && format.stop_time) {
    const { h, m } = timeParts(format.stop_time);
    const stop = new Date(now); stop.setHours(h, m, 0, 0);
    return now <= stop;
  }
  const a = timeParts(format.start_time);
  const b = timeParts(format.stop_time);
  const minutes = now.getHours() * 60 + now.getMinutes();
  const start = a.h * 60 + a.m;
  const stop = b.h * 60 + b.m;
  if (start <= stop) return minutes >= start && minutes <= stop;
  return minutes >= start || minutes <= stop;
}

function formatWindowLabel(format) {
  if (format?.start_time || format?.stop_time) {
    return `${format.start_time || "00:00"} - ${format.stop_time || "23:59"}`;
  }
  return "langsung";
}

function schedulerKey(accountId, formatId) {
  return `${accountId}:${formatId}`;
}


async function getAccountBundle(accountId) {
  const [account, settings] = await Promise.all([
    getAccount(accountId),
    getAccountSettings(accountId)
  ]);

  return { account, settings: settings || null };
}

async function accountHasAccess(accountId) {
  const account = await getAccount(accountId);
  return account;
}

async function createAccountShell(label, adminId, phone = null) {
  const { data, error } = await sb
    .from("telegram_accounts")
    .insert({
      label: String(label || "Telegram Account").trim(),
      status: "disconnected",
      created_by: adminId,
      phone: phone || null,
      session_string: null
    })
    .select("*")
    .single();

  if (error) throw error;

  await ensureAccountSettings(data.id);
  return data;
}

async function listAccounts(page = 0, adminRow = null) {
  const offset = page * ACCOUNT_PAGE_SIZE;
  const owner = adminRow?.role === "OWNER";

  let rowsQuery = sb
    .from("telegram_accounts")
    .select("*")
    .order("created_at", { ascending: false })
    .range(offset, offset + ACCOUNT_PAGE_SIZE);
  let countQuery = sb.from("telegram_accounts").select("*", { count: "exact", head: true });

  if (adminRow && !owner) {
    rowsQuery = rowsQuery.eq("created_by", adminRow.telegram_user_id);
    countQuery = countQuery.eq("created_by", adminRow.telegram_user_id);
  }

  const [{ data, error }, { count, error: countError }] = await Promise.all([
    rowsQuery,
    countQuery
  ]);

  if (error) throw error;
  if (countError) throw countError;

  const rows = data || [];
  const visible = rows.slice(0, ACCOUNT_PAGE_SIZE);

  return {
    rows: visible,
    total: Number(count || 0),
    page,
    hasNext: offset + ACCOUNT_PAGE_SIZE < Number(count || 0)
  };
}

async function listAdmins(page = 0, viewer = null) {
  const offset = page * ADMIN_PAGE_SIZE;
  const isOwner = viewer?.role === "OWNER";
  const isManager = ["ADMIN_VIP", "ADMIN_PREMIUM"].includes(viewer?.role);
  let query = sb
    .from("admins")
    .select("*")
    .eq("active", true)
    .order("created_at", { ascending: true });

  if (!isOwner) {
    if (!isManager) {
      query = query.eq("id", viewer?.id || -1);
    } else {
      query = query.or(`id.eq.${viewer.id},parent_admin_id.eq.${viewer.id}`);
    }
  }

  const rowsResult = await query.range(offset, offset + ADMIN_PAGE_SIZE - 1);
  if (rowsResult.error) throw rowsResult.error;

  let countQuery = sb.from("admins").select("id", { count: "exact", head: true }).eq("active", true);
  if (!isOwner) {
    if (!isManager) countQuery = countQuery.eq("id", viewer?.id || -1);
    else countQuery = countQuery.or(`id.eq.${viewer.id},parent_admin_id.eq.${viewer.id}`);
  }
  const countResult = await countQuery;
  if (countResult.error) throw countResult.error;

  return {
    rows: rowsResult.data || [],
    total: Number(countResult.count || 0),
    hasNext: offset + ADMIN_PAGE_SIZE < Number(countResult.count || 0)
  };
}

async function stopScheduler(accountId) {
  const key = String(accountId);
  const task = schedulerTasks.get(key);
  if (!task) return;

  task.running = false;
  if (task.timeout) clearTimeout(task.timeout);
  schedulerTasks.delete(key);
}

async function withAccountLock(accountId, fn) {
  const key = String(accountId);
  const previous = accountLocks.get(key) || Promise.resolve();
  let release;

  const current = new Promise(resolve => {
    release = resolve;
  });

  accountLocks.set(key, current);

  await previous.catch(() => {});

  try {
    return await fn();
  } finally {
    release();
    if (accountLocks.get(key) === current) {
      accountLocks.delete(key);
    }
  }
}

/* =========================================================
   TELEGRAM USER CLIENT
========================================================= */

async function createTelegramClient(sessionString = "") {
  return new TelegramClient(
    new StringSession(sessionString || ""),
    Number(process.env.API_ID),
    process.env.API_HASH,
    {
      connectionRetries: 10,
      retryDelay: 2000,
      useWSS: false
    }
  );
}

async function markAccountStatus(accountId, status) {
  const { error } = await sb
    .from("telegram_accounts")
    .update({ status })
    .eq("id", accountId);

  if (error) console.error("ACCOUNT STATUS UPDATE:", error);
}

async function clientFor(accountOrId) {
  const accountId = String(
    typeof accountOrId === "object" ? accountOrId?.id : accountOrId
  );

  if (!accountId || accountId === "undefined") return null;

  const existing = clients.get(accountId);

  if (existing) {
    try {
      if (!existing.connected) await existing.connect();
      if (await existing.checkAuthorization()) return existing;
    } catch (_) {}
  }

  if (clientLoads.has(accountId)) {
    return clientLoads.get(accountId);
  }

  const loadPromise = (async () => {
    const account = await getAccount(accountId);
    if (!account?.session_string) return null;

    let sessionString;
    try {
      sessionString = decryptSession(account.session_string);
    } catch (e) {
      console.error(`ACCOUNT ${accountId} SESSION DECRYPT:`, safeErrorMessage(e));
      await markAccountStatus(accountId, "error");
      return null;
    }

    if (!sessionString) return null;

    const client = await createTelegramClient(sessionString);

    try {
      await client.connect();

      if (!(await client.checkAuthorization())) {
        await markAccountStatus(accountId, "error");
        try { await client.disconnect(); } catch (_) {}
        return null;
      }

      clients.set(accountId, client);
      await markAccountStatus(accountId, "connected");
      return client;
    } catch (e) {
      try { await client.disconnect(); } catch (_) {}
      console.warn(`ACCOUNT ${accountId} RECONNECT:`, safeErrorMessage(e, 250));
      return null;
    }
  })();

  clientLoads.set(accountId, loadPromise);

  try {
    return await loadPromise;
  } finally {
    if (clientLoads.get(accountId) === loadPromise) {
      clientLoads.delete(accountId);
    }
  }
}

async function closeClient(accountId) {
  const key = String(accountId);
  const client = clients.get(key);
  if (!client) return;

  try {
    await client.disconnect();
  } catch (_) {}

  clients.delete(key);
}

async function deleteAccountAfterLoginFailure(accountId) {
  const key = String(accountId);

  await stopScheduler(key);
  await closeClient(key);

  // Remove child rows first so the account FK can be deleted cleanly.
  const groupsResult = await sb
    .from("account_groups")
    .delete()
    .eq("account_id", key);
  if (groupsResult.error) throw groupsResult.error;

  const settingsResult = await sb
    .from("account_settings")
    .delete()
    .eq("account_id", key);
  if (settingsResult.error) throw settingsResult.error;

  const accountResult = await sb
    .from("telegram_accounts")
    .delete()
    .eq("id", key);
  if (accountResult.error) throw accountResult.error;
}

async function getMeFromClient(client) {
  const me = await client.getMe();
  if (!me?.id) throw new Error("Telegram tidak mengembalikan identitas akun.");

  return {
    telegramUserId: Number(me.id),
    username: me.username || null,
    firstName: me.firstName || null,
    lastName: me.lastName || null,
    // For the connected account, Telegram's own User object is the
    // authoritative source. Do not trust the number typed during login
    // when displaying/saving the account identity.
    phone: normalizePhone(me.phone) || null
  };
}

/* =========================================================
   PROMOTION FAILURE REPORT
========================================================= */

bot.callbackQuery(/^promo:failures:(\d+):([a-f0-9]+)(?::(\d+))?$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;
  await ctx.answerCallbackQuery().catch(() => {});

  const accountId = String(ctx.match[1]);
  const token = String(ctx.match[2]);
  const page = Math.max(0, Number(ctx.match[3] || 0));

  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;

  let report = promotionReports.get(token);

  // Reports used to live only in RAM. Recover the exact report from the
  // format JSON so the button still works after PM2/VPS restarts.
  if (!report) {
    try {
      const formats = await getPromotionFormats(accountId);
      for (const format of formats) {
        const stored = Array.isArray(format.failure_reports)
          ? format.failure_reports.find(item => String(item?.token || "") === token)
          : null;
        if (!stored) continue;

        report = {
          accountId,
          formatId: String(format.id),
          accountLabel: stored.account_name || "Akun Telegram",
          accountName: stored.account_name || "Akun Telegram",
          accountUsername: stored.account_username || null,
          accountTelegramId: stored.account_telegram_id || null,
          accountPhone: stored.account_phone || null,
          formatName: stored.format_name || format.name || "Format",
          failedRows: Array.isArray(stored.failed_rows) ? stored.failed_rows : [],
          token
        };
        promotionReports.set(token, report);
        break;
      }
    } catch (e) {
      console.warn("PROMOTION FAILURE REPORT LOAD:", safeErrorMessage(e, 300));
    }
  }

  if (!report) {
    return replaceUi(
      ctx,
      "⚠️ <b>Data grup gagal sudah tidak tersedia.</b>\n\nLaporan ini sudah kedaluwarsa atau sudah digantikan laporan yang lebih baru.",
      new InlineKeyboard().text("🏠 Menu Utama", "menu:dashboard"),
      { parse_mode: "HTML" }
    );
  }

  const account = await getAccountForAdmin(report.accountId, adminRow);
  if (!account) return;

  // Keep every detail message safely below Telegram's 4096-character limit.
  const PAGE_SIZE = 7;
  const rows = Array.isArray(report.failedRows) ? report.failedRows : [];
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const visible = rows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const lines = [
    "❌ <b>DAFTAR GROUP GAGAL</b>",
    "━━━━━━━━━━━━━━━━━━",
    `📝 <b>Format:</b> ${escapeHtml(report.formatName || "-")}`,
    `👤 <b>Nama:</b> ${escapeHtml(report.accountName || report.accountLabel || "-")}`,
    `🔗 <b>Username:</b> ${escapeHtml(report.accountUsername ? `@${report.accountUsername}` : "-")}`,
    `🆔 <b>ID Akun:</b> <code>${escapeHtml(report.accountTelegramId || "-")}</code>`,
    `📱 <b>Nomor:</b> <code>${escapeHtml(report.accountPhone || "-")}</code>`,
    `📄 <b>Halaman:</b> ${safePage + 1}/${totalPages}`,
    "━━━━━━━━━━━━━━━━━━"
  ];

  if (!visible.length) lines.push("<i>Tidak ada group yang gagal.</i>");
  else visible.forEach((row,index) => {
    const number = safePage * PAGE_SIZE + index + 1;
    lines.push(`${String(number).padStart(2,"0")}. <b>${escapeHtml(truncateText(row.groupTitle,120))}</b>\n   ❌ ${escapeHtml(truncateText(row.reason,220))}`);
  });

  const kb = new InlineKeyboard();
  if (safePage > 0) kb.text("◀️", `promo:failures:${accountId}:${token}:${safePage - 1}`);
  if (safePage < totalPages - 1) kb.text("▶️", `promo:failures:${accountId}:${token}:${safePage + 1}`);
  if (safePage > 0 || safePage < totalPages - 1) kb.row();
  kb.text("⬅️ Kembali ke Hasil", `promo:view:${report.accountId}:${report.formatId}`).row();
  kb.text("🏠 Menu Utama", "menu:dashboard");

  return replaceUi(ctx, lines.join("\n\n"), kb, { parse_mode: "HTML" });
});

/* =========================================================
   GROUP MANAGEMENT
========================================================= */

function channelCanSend(entity, client) {
  return (async () => {
    const isGroup = Boolean(entity?.className === "Chat");
    const isChannel = Boolean(entity?.className === "Channel");

    if (!isGroup && !isChannel) return false;

    let canSend = true;

    if (isChannel && entity.broadcast) {
      canSend = false;

      try {
        const me = await client.getInputEntity("me");
        const participant = await client.invoke(
          new Api.channels.GetParticipant({
            channel: entity,
            userId: me
          })
        );

        const p = participant?.participant;
        if (
          p?.className === "ChannelParticipantCreator" ||
          p?.className === "ChannelParticipantAdmin"
        ) {
          canSend = true;
        }
      } catch (_) {
        canSend = false;
      }
    }

    if (isGroup || (isChannel && !entity.broadcast)) {
      canSend = true;

      if (isChannel) {
        try {
          const me = await client.getInputEntity("me");
          const participant = await client.invoke(
            new Api.channels.GetParticipant({
              channel: entity,
              userId: me
            })
          );

          const p = participant?.participant;
          if (
            p?.className === "ChannelParticipantBanned" &&
            p.bannedRights?.sendMessages === true
          ) {
            canSend = false;
          }
        } catch (_) {
          // Keep the old behavior: unknown permission is not enough to discard the group.
          canSend = true;
        }
      }
    }

    return canSend;
  })();
}

function isBrokenAccountGroupsUpdatedAtError(error) {
  const message = safeErrorMessage(error, 1000);
  return /record\s+["']new["']\s+has\s+no\s+field\s+["']updated_at["']/i.test(message);
}

async function refreshGroups(accountId) {
  const client = await clientFor(accountId);

  if (!client) {
    throw new Error("Akun Telegram belum terhubung. Connect akun terlebih dahulu.");
  }

  const dialogs = [];
  for await (const dialog of client.iterDialogs({})) dialogs.push(dialog);
  const rows = [];

  for (const dialog of dialogs) {
    const entity = dialog?.entity;
    if (!entity) continue;

    const isGroup = Boolean(dialog.isGroup);
    const isChannel = Boolean(dialog.isChannel);
    if (!isGroup && !isChannel) continue;

    const canSend = await channelCanSend(entity, client);
    const telegramGroupId = String(entity.id?.value ?? entity.id ?? "");

    if (!telegramGroupId) continue;

    rows.push({
      account_id: accountId,
      telegram_group_id: telegramGroupId,
      title: dialog.title || entity.title || "Tanpa Nama",
      can_send: canSend
    });
  }

  if (rows.length) {
    const { error } = await sb
      .from("account_groups")
      .upsert(rows, { onConflict: "account_id,telegram_group_id" });

    if (error) {
      // Some older Supabase databases have the account_groups UPDATE trigger
      // installed even though the table is missing updated_at. That makes an
      // upsert fail with: record "new" has no field "updated_at".
      // Do not make Telegram scanning fail in that case: insert only groups
      // that are not already present, leaving existing rows untouched until
      // the database schema is repaired.
      if (!isBrokenAccountGroupsUpdatedAtError(error)) throw error;

      const { data: existingRows, error: existingError } = await sb
        .from("account_groups")
        .select("telegram_group_id")
        .eq("account_id", accountId);

      if (existingError) throw existingError;

      const existingIds = new Set(
        (existingRows || []).map(row => String(row.telegram_group_id))
      );
      const newRows = rows.filter(row => !existingIds.has(String(row.telegram_group_id)));

      if (newRows.length) {
        const { error: insertError } = await sb
          .from("account_groups")
          .insert(newRows);
        if (insertError) throw insertError;
      }

      console.warn(
        `ACCOUNT_GROUPS legacy schema detected for account ${accountId}: ` +
        "scan completed using insert-only fallback. Run the supplied SQL schema repair to restore updates."
      );
    }
  }

  return rows;
}

async function listGroups(accountId, page = 0) {
  const offset = page * GROUP_PAGE_SIZE;

  const [{ data, error }, { count, error: countError }] = await Promise.all([
    sb
      .from("account_groups")
      .select("*")
      .eq("account_id", accountId)
      .eq("can_send", true)
      .order("title", { ascending: true })
      .range(offset, offset + GROUP_PAGE_SIZE),
    sb
      .from("account_groups")
      .select("*", { count: "exact", head: true })
      .eq("account_id", accountId)
      .eq("can_send", true)
  ]);

  if (error) throw error;
  if (countError) throw countError;

  return {
    rows: (data || []).slice(0, GROUP_PAGE_SIZE),
    total: Number(count || 0),
    hasNext: offset + GROUP_PAGE_SIZE < Number(count || 0)
  };
}

/* =========================================================
   PROMOTION FORMAT / MEDIA
========================================================= */

async function downloadBotPhoto(fileId) {
  const file = await bot.api.getFile(fileId);
  if (!file?.file_path) {
    throw new Error("Telegram tidak mengembalikan file_path.");
  }

  const url = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    throw new Error(`Gagal download foto Telegram: HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error("File foto Telegram kosong.");
  if (buffer.length > 10 * 1024 * 1024) {
    throw new Error("File foto terlalu besar.");
  }

  buffer.name = "photo.jpg";
  return buffer;
}

function settingsFormatText(settings) {
  if (!settings) return "Belum ada format.";

  if (settings.media_type === "photo") {
    return `🖼️ Foto${settings.caption ? " + caption" : " tanpa caption"}`;
  }

  return `📝 Teks${settings.message ? "" : " (kosong)"}`;
}

function settingsSummary(account, settings) {
  const telegramName = account.label || account.username || account.phone || "Akun Telegram";
  const username = account.username ? `@${account.username}` : "belum ada username";
  return [
    `📱 <b>AKUN TERKAIT</b>`,
    `👤 Nama: <b>${escapeHtml(telegramName)}</b>`,
    `🔗 Username: <code>${escapeHtml(username)}</code>`,
    `🆔 Telegram ID: <code>${escapeHtml(account.telegram_user_id || "belum login")}</code>`,
    `📌 Koneksi: <b>${escapeHtml(account.status || "-")}</b>`,
    `▶️ Promosi: <b>${settings?.active ? "RUNNING" : "STOPPED"}</b>`,
    `📝 Format: <b>${escapeHtml(settingsFormatText(settings))}</b>`,
    `⏱ Jeda: <b>${escapeHtml(formatInterval(settings?.interval_minutes))}</b>`,
    `📅 Durasi: <b>${escapeHtml(formatDuration(settings?.duration_hours))}</b>`,
    settings?.expires_at
      ? `⌛ Berakhir: <b>${escapeHtml(formatDate(settings.expires_at))}</b>`
      : null,
    account.phone
      ? `☎️ Nomor: <code>${escapeHtml(account.phone)}</code>`
      : null
  ].filter(Boolean).join("\n");
}

function formatDetailText(account, settings) {
  const hasText = settings?.media_type === "text" && String(settings?.message || "").trim();
  const hasPhoto = settings?.media_type === "photo" && settings?.media_file_id;
  const hasFormat = Boolean(hasText || hasPhoto);

  if (!hasFormat) {
    return [
      `📝 <b>FORMAT PROMOSI</b>`,
      `👤 Nama: <b>${escapeHtml(account.label || "Akun Telegram")}</b>`,
      "",
      "⚠️ <b>Belum ada format promosi.</b>",
      "",
      "Buat format dengan mengirim teks atau foto + caption."
    ].join("\n");
  }

  const separator = "━━━━━━━━━━━━━━━━━━";
  const body = hasText
    ? String(settings.message).trim()
    : (settings.caption ? String(settings.caption).trim() : "Foto tanpa caption");

  const bodyLimit = 2500;
  const safeBody = body.length > bodyLimit
    ? `${body.slice(0, bodyLimit)}\n… <i>(format dipotong di tampilan)</i>`
    : body;

  const scheduleLines = settings?.active
    ? [
        `🟢 <b>Status</b>: AKTIF`,
        settings?.started_at
          ? `🕐 <b>Mulai</b>: ${escapeHtml(formatDate(settings.started_at))}`
          : null,
        settings?.expires_at
          ? `🛑 <b>Stop</b>: ${escapeHtml(formatDate(settings.expires_at))}`
          : null
      ].filter(Boolean)
    : [
        `🔴 <b>Status</b>: NONAKTIF`
      ];

  return [
    `📝 <b>FORMAT PROMOSI</b>`,
    `👤 Nama: <b>${escapeHtml(account.label || "Akun Telegram")}</b>`,
    separator,
    `📄 <b>ISI FORMAT</b>`,
    hasPhoto ? "🖼️ <b>Media</b>: Foto" : "📝 <b>Media</b>: Teks",
    `<blockquote>${escapeHtml(safeBody)}</blockquote>`,
    separator,
    `⚙️ <b>PENGATURAN</b>`,
    `⏱️ <b>Jeda</b>: ${escapeHtml(formatInterval(settings?.interval_minutes))}`,
    `📅 <b>Durasi</b>: ${escapeHtml(formatDuration(settings?.duration_hours))}`,
    ...scheduleLines
  ].join("\n");
}

/* =========================================================
   HISTORY / AUDIT
========================================================= */

async function recordHistory(accountId, adminId, payload = {}) {
  try {
    let account = null;
    if (accountId && !payload.accountLabel) {
      account = await getAccount(accountId);
    }

    const row = {
      account_id: account?.id || accountId || null,
      account_label: account?.label || payload.accountLabel || "Account",
      admin_id: adminId || null,
      group_id: payload.groupId || null,
      group_title: payload.groupTitle || null,
      action: payload.action || payload.actionType || "unknown",
      status: payload.status || "success",
      error: payload.error ? truncateText(payload.error, 1000) : null
    };

    const { error } = await sb.from("promotion_history").insert(row);
    if (error) console.error("HISTORY INSERT:", error);
  } catch (e) {
    console.error("HISTORY:", safeErrorMessage(e));
  }
}

async function renderHistory(ctx, accountId, page = 0) {
  const account = await accountHasAccess(accountId);
  if (!account) {
    return replaceUi(
      ctx,
      "❌ Account tidak ditemukan.",
      backDashboardKeyboard(),
      { parse_mode: "HTML" }
    );
  }

  const offset = page * HISTORY_PAGE_SIZE;

  const [{ data: rows, error }, { count, error: countError }] = await Promise.all([
    sb
      .from("promotion_history")
      .select(
        "id,account_id,account_label,admin_id,group_id,group_title,action,status,error,created_at"
      )
      .eq("account_id", accountId)
      .order("created_at", { ascending: false })
      .range(offset, offset + HISTORY_PAGE_SIZE),
    sb
      .from("promotion_history")
      .select("*", { count: "exact", head: true })
      .eq("account_id", accountId)
  ]);

  if (error) throw error;
  if (countError) throw countError;

  const visible = (rows || []).slice(0, HISTORY_PAGE_SIZE);
  const total = Number(count || 0);
  const hasNext = offset + HISTORY_PAGE_SIZE < total;

  const adminIds = [...new Set(visible.map(x => x.admin_id).filter(Boolean))];
  const groupIds = [...new Set(visible.map(x => x.group_id).filter(Boolean))];

  const [adminsResult, groupsResult] = await Promise.all([
    adminIds.length
      ? sb.from("admins").select("id,telegram_user_id,first_name,username").in("id", adminIds)
      : Promise.resolve({ data: [], error: null }),
    groupIds.length
      ? sb.from("account_groups").select("id,title").in("id", groupIds)
      : Promise.resolve({ data: [], error: null })
  ]);

  if (adminsResult.error) throw adminsResult.error;
  if (groupsResult.error) throw groupsResult.error;

  const adminMap = new Map(
    (adminsResult.data || []).map(x => [String(x.id), x])
  );
  const groupMap = new Map(
    (groupsResult.data || []).map(x => [String(x.id), x.title])
  );

  const lines = [];

  for (const [index, row] of visible.entries()) {
    const status =
      row.status === "success" ? "✅" :
      row.status === "error" ? "❌" :
      row.status === "skipped" ? "⏭️" : "ℹ️";

    const admin = adminMap.get(String(row.admin_id));
    const adminLabel = admin?.telegram_user_id
      ? String(admin.telegram_user_id)
      : "system";

    const groupTitle =
      row.group_title ||
      groupMap.get(String(row.group_id)) ||
      "-";

    const errorLine = row.error
      ? `\n⚠️ ${escapeHtml(truncateText(row.error, 120))}`
      : "";

    lines.push(
      `${status} <b>#${offset + index + 1}</b> • <b>${escapeHtml(row.action || "-")}</b>\n` +
      `👤 Admin: <code>${escapeHtml(adminLabel)}</code>\n` +
      `👥 Target: <b>${escapeHtml(groupTitle)}</b>\n` +
      `🕐 ${escapeHtml(formatDate(row.created_at))}${errorLine}`
    );
  }

  const text = [
    `📋 <b>RIWAYAT • ${escapeHtml(account.label)}</b>`,
    `Total log: <b>${total}</b>`,
    `Halaman: <b>${page + 1}</b>`,
    "",
    lines.length ? lines.join("\n\n") : "<i>Belum ada riwayat.</i>"
  ].join("\n");

  return replaceUi(
    ctx,
    text,
    historyKeyboard(accountId, page, hasNext),
    { parse_mode: "HTML" }
  );
}

/* =========================================================
   SCHEDULER / PROMOTION ENGINE
========================================================= */

function extractFloodWaitMs(error) {
  if (!error) return 0;
  const direct = Number(error.seconds || error.value || 0);
  if (Number.isFinite(direct) && direct > 0 && direct < 86400) {
    return direct * 1000 + 1000;
  }

  const text = String(error.message || error || "");
  const match = text.match(/(?:FLOOD_WAIT|wait of)\s*(\d+)\s*(?:seconds?|s)?/i);
  if (!match) return 0;

  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) return 0;
  return seconds * 1000 + 1000;
}

function classifySendError(error) {
  const raw = String(
    error?.message ||
    error?.errorMessage ||
    error?.rpcError ||
    error ||
    ""
  ).trim();
  const code = String(
    error?.errorMessage ||
    error?.rpcError ||
    error?.code ||
    error?.constructor?.name ||
    ""
  ).toLowerCase();
  const msg = raw.toLowerCase();
  const fingerprint = `${code} ${msg}`;

  // Match concrete Telegram RPC errors instead of the generic word
  // "banned", which can appear in unrelated error text and mislabel the
  // promotion result.
  if (
    fingerprint.includes("user_banned_in_channel") ||
    fingerprint.includes("userbannedinchannelerror")
  ) {
    return "Akun tidak diizinkan mengirim pesan";
  }

  if (
    fingerprint.includes("chat_write_forbidden") ||
    fingerprint.includes("chat_send_plain_forbidden") ||
    fingerprint.includes("not enough rights") ||
    fingerprint.includes("can't write") ||
    fingerprint.includes("can't send")
  ) {
    return "Tidak diizinkan mengirim pesan";
  }

  if (
    msg.includes("chat_admin_required") ||
    msg.includes("admin required") ||
    msg.includes("administrator")
  ) {
    return "Tidak memiliki izin yang diperlukan";
  }

  if (
    msg.includes("chat_restricted") ||
    msg.includes("restricted")
  ) {
    return "Group sedang dibatasi";
  }

  if (
    msg.includes("channel_private") ||
    msg.includes("chat_id_invalid") ||
    msg.includes("chat not found") ||
    msg.includes("group not found") ||
    msg.includes("entity") && msg.includes("not found")
  ) {
    return "Group tidak dapat diakses";
  }

  if (extractFloodWaitMs(error) > 0) {
    return "Telegram meminta menunggu sebelum mengirim lagi";
  }

  return raw ? truncateText(raw.replace(/\s+/g, " "), 160) : "Kesalahan tidak diketahui";
}

function isSendPermissionError(error) {
  const raw = String(
    error?.message ||
    error?.errorMessage ||
    error?.rpcError ||
    error ||
    ""
  ).toLowerCase();
  const code = String(
    error?.errorMessage ||
    error?.rpcError ||
    error?.code ||
    error?.constructor?.name ||
    ""
  ).toLowerCase();
  const fingerprint = `${code} ${raw}`;

  return (
    fingerprint.includes("chat_write_forbidden") ||
    fingerprint.includes("chat_send_plain_forbidden") ||
    fingerprint.includes("user_banned_in_channel") ||
    fingerprint.includes("chat_admin_required") ||
    fingerprint.includes("chat_restricted") ||
    fingerprint.includes("not enough rights") ||
    fingerprint.includes("can't write") ||
    fingerprint.includes("can't send")
  );
}

function rememberPromotionReport(report) {
  const token = crypto.randomBytes(6).toString("hex");
  promotionReports.set(token, { ...report, createdAt: Date.now() });
  while (promotionReports.size > MAX_PROMOTION_REPORTS) {
    const first = promotionReports.keys().next().value;
    if (!first) break;
    promotionReports.delete(first);
  }
  return token;
}

function promotionReportKeyboard(token, failedCount, accountId, formatId) {
  const kb = new InlineKeyboard();
  if (failedCount > 0) {
    kb.text(
      `🔎 Cek Grup Gagal (${failedCount})`,
      `promo:failures:${accountId}:${token}:0`
    ).row();
  }
  kb.text("📝 Detail Format", `promo:view:${accountId}:${formatId}`);
  return kb;
}

async function persistPromotionFailureReport(accountId, formatId, report) {
  if (!accountId || !formatId || !report?.token || !report?.failedRows?.length) return;

  try {
    const formats = await getPromotionFormats(accountId);
    const format = formats.find(x => String(x.id) === String(formatId));
    if (!format) return;

    const entry = {
      token: String(report.token),
      created_at: new Date().toISOString(),
      account_name: report.accountName || "",
      account_username: report.accountUsername || null,
      account_telegram_id: report.accountTelegramId || null,
      account_phone: report.accountPhone || null,
      format_name: report.formatName || format.name || "",
      failed_rows: (report.failedRows || []).slice(0, 300)
    };

    const existing = Array.isArray(format.failure_reports) ? format.failure_reports : [];
    format.failure_reports = [
      entry,
      ...existing.filter(item => String(item?.token || "") !== entry.token)
    ].slice(0, 5);

    await savePromotionFormats(accountId, formats);
  } catch (e) {
    console.warn("PROMOTION FAILURE REPORT SAVE:", safeErrorMessage(e, 300));
  }
}

async function sendPromotionReport(account, format, total, success, failed, failures) {
  const recipientId = account?.created_by;
  if (!recipientId) return;

  const admin = await getAdminByTelegramId(recipientId).catch(() => null);
  if (!admin) return;

  // Refresh identity from the authenticated Telegram session immediately
  // before building the report. This prevents stale/wrong phone data in the
  // promotion result and keeps the displayed name tied to the connected
  // Telegram account itself.
  let liveIdentity = null;
  try {
    const client = await clientFor(account.id);
    if (client) liveIdentity = await getMeFromClient(client);
  } catch (e) {
    console.warn("PROMOTION IDENTITY REFRESH:", safeErrorMessage(e, 220));
  }

  const accountName =
    [liveIdentity?.firstName, liveIdentity?.lastName].filter(Boolean).join(" ").trim() ||
    account.label ||
    liveIdentity?.username ||
    "Akun Telegram";

  const accountUsername = liveIdentity?.username || account.username || null;
  const accountTelegramId = liveIdentity?.telegramUserId || account.telegram_user_id || null;
  const accountPhone = liveIdentity?.phone || account.phone || null;

  const failedRows = failures.map(x => ({
    groupId: x.groupId || null,
    groupTitle: x.groupTitle || "Group tanpa nama",
    reason: x.reason || "Kesalahan tidak diketahui"
  }));

  const token = rememberPromotionReport({
    accountId: String(account.id),
    formatId: String(format.id),
    accountLabel: accountName,
    accountName,
    accountUsername,
    accountTelegramId,
    accountPhone,
    formatName: format.name,
    failedRows
  });

  if (failedRows.length) {
    await persistPromotionFailureReport(account.id, format.id, {
      token,
      accountName,
      accountUsername,
      accountTelegramId,
      accountPhone,
      formatName: format.name,
      failedRows
    });
  }

  const lines = [
    "📊 <b>HASIL PROMOSI</b>",
    "━━━━━━━━━━━━━━━━━━",
    `📝 <b>Format:</b> ${escapeHtml(format.name || "-")}`,
    `👤 <b>Nama:</b> ${escapeHtml(accountName)}`,
    `🔗 <b>Username:</b> ${escapeHtml(accountUsername ? `@${accountUsername}` : "-")}`,
    `🆔 <b>ID Akun:</b> <code>${escapeHtml(accountTelegramId || "-")}</code>`,
    `📱 <b>Nomor:</b> <code>${escapeHtml(accountPhone || "-")}</code>`,
    "━━━━━━━━━━━━━━━━━━",
    "📤 <b>HASIL PENGIRIMAN</b>",
    `Total group dipilih: <b>${total}</b>`,
    `Berhasil terkirim: <b>${success}</b>`,
    `Gagal: <b>${failed}</b>`
  ];

  if (failedRows.length) {
    lines.push("", "❌ <b>Ringkasan gagal:</b>");
    const counts = new Map();
    for (const row of failedRows) counts.set(row.reason, (counts.get(row.reason) || 0) + 1);
    for (const [reason, count] of counts) {
      lines.push(`• ${count} group — ${escapeHtml(reason)}`);
    }
  }

  await bot.api.sendMessage(
    Number(recipientId),
    lines.join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: promotionReportKeyboard(token, failed, account.id, format.id)
    }
  ).catch(e => console.warn("PROMOTION REPORT:", safeErrorMessage(e, 220)));
}

async function fireFormat(accountId, formatId) {
  const account = await getAccount(accountId);
  const format = await getPromotionFormat(accountId, formatId);
  if (!account || !format || !format.active) return { shouldContinue: false, delayMs: 0 };

  const now = new Date();
  if (!format.expires_at || new Date(format.expires_at) <= now) {
    await stopFormat(accountId, formatId, null);
    return { shouldContinue: false, delayMs: 0 };
  }

  if (!isWithinFormatWindow(format, now)) {
    return { shouldContinue: true, delayMs: nextTimeWindowMs(format.start_time, format.stop_time) };
  }

  const client = await clientFor(accountId);
  if (!client) return { shouldContinue: true, delayMs: 120000 };

  const { data: groups, error } = await sb
    .from("account_groups")
    .select("id,telegram_group_id,title,can_send,enabled")
    .eq("account_id", accountId)
    .eq("enabled", true)
    .eq("can_send", true)
    .order("title", { ascending: true });
  if (error) throw error;

  if (!groups?.length) {
    return { shouldContinue: true, delayMs: Number(format.interval_minutes || 10) * 60000 };
  }

  const dialogs = await client.getDialogs({ limit: 500 });
  const entityMap = new Map();
  for (const dialog of dialogs) {
    const entity = dialog?.entity;
    if (!entity || (!dialog.isGroup && !dialog.isChannel)) continue;
    const id = String(entity.id?.value ?? entity.id ?? "");
    if (id) entityMap.set(id, entity);
  }

  let photoBuffer = null;
  if (format.media_type === "photo" && format.media_file_id) {
    photoBuffer = await downloadBotPhoto(format.media_file_id);
  }

  let success = 0;
  let fail = 0;
  let floodWaitMs = 0;
  const failures = [];

  for (const group of groups) {
    let target = entityMap.get(String(group.telegram_group_id));

    if (!target) {
      try {
        target = await client.getEntity(String(group.telegram_group_id));
        if (target) entityMap.set(String(group.telegram_group_id), target);
      } catch (_) {}
    }

    if (!target) {
      fail++;
      failures.push({ groupId: group.id, groupTitle: group.title, reason: "Group tidak dapat diakses" });
      await recordHistory(accountId, null, {
        accountLabel: account.label,
        action: "promotion_send",
        status: "error",
        groupId: group.id,
        groupTitle: group.title,
        error: "Entity grup tidak ditemukan di dialog Telegram",
        details: { format_id: format.id, format_name: format.name }
      });
      continue;
    }

    try {
      if (format.media_type === "photo" && photoBuffer) {
        await client.sendFile(target, {
          file: photoBuffer,
          caption: format.caption || "",
          forceDocument: false
        });
      } else {
        const message = String(format.message || "").trim();
        if (!message) throw new Error("Format teks kosong.");
        await client.sendMessage(target, { message });
      }

      success++;
      await recordHistory(accountId, null, {
        accountLabel: account.label,
        action: "promotion_send",
        status: "success",
        groupId: group.id,
        groupTitle: group.title,
        details: { format_id: format.id, format_name: format.name }
      });
    } catch (e) {
      fail++;
      const reason = classifySendError(e);
      failures.push({ groupId: group.id, groupTitle: group.title, reason });
      floodWaitMs = Math.max(floodWaitMs, extractFloodWaitMs(e));

      console.warn(
        `PROMOTION SEND FAIL account=${accountId} group=${group.id} title=${JSON.stringify(truncateText(group.title, 80))} ` +
        `code=${String(e?.errorMessage || e?.rpcError || e?.code || e?.constructor?.name || "unknown")} ` +
        `error=${safeErrorMessage(e, 350)}`
      );

      if (isSendPermissionError(e)) {
        // A send error alone must not permanently remove the selected target.
        // Re-check Telegram first; only a confirmed non-sendable channel is
        // marked as such. Basic groups stay available for the next run.
        try {
          const confirmedCanSend = await channelCanSend(target, client);
          if (confirmedCanSend === false) {
            await sb.from("account_groups")
              .update({ can_send: false })
              .eq("id", group.id)
              .eq("account_id", accountId)
              .catch(updateError => console.warn(
                "GROUP PERMISSION UPDATE:",
                safeErrorMessage(updateError, 220)
              ));
          }
        } catch (permissionCheckError) {
          console.warn(
            "GROUP PERMISSION RECHECK:",
            safeErrorMessage(permissionCheckError, 220)
          );
        }
      }
      await recordHistory(accountId, null, {
        accountLabel: account.label,
        action: "promotion_send",
        status: "error",
        groupId: group.id,
        groupTitle: group.title,
        error: safeErrorMessage(e, 1000),
        details: { format_id: format.id, format_name: format.name, reason }
      });
    }
  }

  await sendPromotionReport(account, format, groups.length, success, fail, failures);

  return {
    shouldContinue: true,
    delayMs: Math.max(Number(format.interval_minutes || 10) * 60000, floodWaitMs),
    success,
    fail
  };
}

function scheduleFormat(accountId,formatId,delayMs=0){
  const key=schedulerKey(accountId,formatId); const old=schedulerTasks.get(key); if(old?.timeout)clearTimeout(old.timeout);
  const task={running:true,timeout:null}; schedulerTasks.set(key,task);
  task.timeout=setTimeout(async()=>{
    if(schedulerTasks.get(key)!==task||!task.running)return;
    let nextDelay=60000,cont=true;
    try{const r=await fireFormat(accountId,formatId);nextDelay=Number(r?.delayMs||60000);cont=r?.shouldContinue!==false;}catch(e){console.error(`PROMOTION ${key}:`,safeErrorMessage(e));nextDelay=60000;}
    if(schedulerTasks.get(key)!==task||!task.running)return;
    const f=await getPromotionFormat(accountId,formatId).catch(()=>null);
    if(!f?.active||!cont){schedulerTasks.delete(key);return;}
    task.timeout=setTimeout(()=>{if(schedulerTasks.get(key)!==task||!task.running)return;task.timeout=null;scheduleFormat(accountId,formatId,0);},Math.max(1000,nextDelay));
  },Math.max(0,delayMs));
}

async function startFormat(accountId,formatId,adminId){
  const account=await getAccount(accountId); if(!account)throw new Error("Account tidak ditemukan.");
  const formats=await getPromotionFormats(accountId); const f=formats.find(x=>x.id===String(formatId)); if(!f)throw new Error("Format tidak ditemukan.");
  if(!formatReady(f))throw new Error("Isi format belum dibuat.");
  const client=await clientFor(accountId); if(!client)throw new Error("Account belum connected atau session tidak valid.");
  const {count,error}=await sb.from("account_groups").select("*",{count:"exact",head:true}).eq("account_id",accountId).eq("enabled",true).eq("can_send",true); if(error)throw error;if(!Number(count||0))throw new Error("Belum ada target grup aktif yang bisa dikirimi.");
  const now = new Date();
  const scheduledStartAt = nextFormatStartAt(f, now);
  const durationMs = Number(f.duration_hours || 1) * 3600000;

  f.active = true;
  f.started_at = scheduledStartAt.toISOString();
  f.expires_at = new Date(
    scheduledStartAt.getTime() + durationMs
  ).toISOString();

  await savePromotionFormats(accountId, formats);
  scheduleFormat(
    accountId,
    f.id,
    Math.max(0, scheduledStartAt.getTime() - now.getTime())
  );

  await recordHistory(accountId, adminId, {
    action: "promotion_start",
    status: "success",
    details: {
      format_id: f.id,
      format_name: f.name,
      scheduled_start_at: f.started_at,
      expires_at: f.expires_at
    }
  });

  return { format: f };
}

async function stopFormat(accountId,formatId,adminId){
  const formats=await getPromotionFormats(accountId); const f=formats.find(x=>x.id===String(formatId)); if(!f)return {wasRunning:false};
  const key=schedulerKey(accountId,formatId); const task=schedulerTasks.get(key);if(task?.timeout)clearTimeout(task.timeout);schedulerTasks.delete(key);
  const wasRunning=Boolean(f.active);f.active=false;f.started_at=null;f.expires_at=null;await savePromotionFormats(accountId,formats);
  if(adminId)await recordHistory(accountId,adminId,{action:"promotion_stop",status:"success",details:{format_id:f.id,format_name:f.name,was_running:wasRunning}});
  return {wasRunning};
}

async function stopAllFormats(accountId,adminId=null){
  const formats=await getPromotionFormats(accountId); for(const f of formats){if(f.active)await stopFormat(accountId,f.id,adminId);}
}

async function fireAccount(accountId) {
  const account = await getAccount(accountId);
  const settings = await getAccountSettings(accountId);

  if (!account || !settings?.active) {
    return { shouldContinue: false, delayMs: 0 };
  }

  const now = new Date();
  if (
    !settings.expires_at ||
    new Date(settings.expires_at) <= now
  ) {
    await sb
      .from("account_settings")
      .update({
        active: false,
        expires_at: null,
        started_at: null,
      })
      .eq("account_id", accountId);

    return { shouldContinue: false, delayMs: 0 };
  }

  const starterAdminTelegramId = null;
  const client = await clientFor(accountId);
  if (!client) {
    await markAccountStatus(accountId, "error");
    await recordHistory(accountId, null, {
      accountLabel: account.label,
      adminTelegramUserId: starterAdminTelegramId,
      action: "promotion_send",
      status: "error",
      error: "Akun Telegram tidak terhubung atau session tidak valid.",
      details: { retryInSeconds: 120 }
    });

    return { shouldContinue: true, delayMs: 120000 };
  }

  let groupsResult = await sb
    .from("account_groups")
    .select("id,telegram_group_id,title,can_send,enabled")
    .eq("account_id", accountId)
    .eq("enabled", true)
    .eq("can_send", true)
    .order("title", { ascending: true });

  if (groupsResult.error) throw groupsResult.error;

  const groups = groupsResult.data || [];

  if (!groups.length) {
    await recordHistory(accountId, null, {
      accountLabel: account.label,
      adminTelegramUserId: starterAdminTelegramId,
      action: "promotion_send",
      status: "skipped",
      error: "Tidak ada target grup aktif.",
      details: {}
    });

    return {
      shouldContinue: true,
      delayMs: Number(settings.interval_minutes || 10) * 60 * 1000
    };
  }

  const dialogs = await client.getDialogs({ limit: 500 });
  const entityMap = new Map();

  for (const dialog of dialogs) {
    const entity = dialog?.entity;
    if (!entity) continue;
    if (!dialog.isGroup && !dialog.isChannel) continue;

    const rawId = String(entity.id?.value ?? entity.id ?? "");
    if (rawId) entityMap.set(rawId, entity);
  }

  let photoBuffer = null;
  if (settings.media_type === "photo" && settings.media_file_id) {
    try {
      photoBuffer = await downloadBotPhoto(settings.media_file_id);
    } catch (e) {
      const reason = safeErrorMessage(e);
      await recordHistory(accountId, null, {
        accountLabel: account.label,
        adminTelegramUserId: starterAdminTelegramId,
        action: "promotion_send",
        status: "error",
        error: `Foto format gagal diambil: ${reason}`,
        details: { media: true }
      });

      return {
        shouldContinue: true,
        delayMs: Number(settings.interval_minutes || 10) * 60 * 1000
      };
    }
  }

  let successCount = 0;
  let failCount = 0;
  let skippedCount = 0;
  let floodWaitMs = 0;
  const failures = new Map();

  for (const group of groups) {
    const target = entityMap.get(String(group.telegram_group_id));

    if (!target) {
      skippedCount++;
      const reason = "Entity grup tidak ditemukan di dialog Telegram";
      failures.set(reason, (failures.get(reason) || 0) + 1);
      await recordHistory(accountId, null, {
        accountLabel: account.label,
        adminTelegramUserId: starterAdminTelegramId,
        action: "promotion_send",
        status: "error",
        groupId: group.id,
        groupTitle: group.title,
        error: reason,
        details: { telegram_group_id: group.telegram_group_id }
      });
      continue;
    }

    try {
      if (settings.media_type === "photo" && photoBuffer) {
        await client.sendFile(target, {
          file: photoBuffer,
          caption: settings.caption || "",
          forceDocument: false
        });
      } else {
        const message = String(settings.message || "").trim();
        if (!message) {
          throw new Error("Format teks kosong.");
        }

        await client.sendMessage(target, { message });
      }

      successCount++;
      await recordHistory(accountId, null, {
        accountLabel: account.label,
        adminTelegramUserId: starterAdminTelegramId,
        action: "promotion_send",
        status: "success",
        groupId: group.id,
        groupTitle: group.title,
        details: {
          format: settings.media_type,
          telegram_group_id: group.telegram_group_id
        }
      });
    } catch (e) {
      failCount++;
      const reason = classifySendError(e);
      failures.set(reason, (failures.get(reason) || 0) + 1);
      floodWaitMs = Math.max(floodWaitMs, extractFloodWaitMs(e));

      if (isSendPermissionError(e)) {
        await sb.from("account_groups")
          .update({ enabled: false, can_send: false })
          .eq("id", group.id)
          .eq("account_id", accountId)
          .catch(updateError => console.warn("GROUP PERMISSION UPDATE:", safeErrorMessage(updateError, 220)));
      }

      await recordHistory(accountId, null, {
        accountLabel: account.label,
        adminTelegramUserId: starterAdminTelegramId,
        action: "promotion_send",
        status: "error",
        groupId: group.id,
        groupTitle: group.title,
        error: safeErrorMessage(e, 1000),
        details: {
          reason,
          telegram_group_id: group.telegram_group_id
        }
      });
    }
  }

  const reportLines = [
    `📊 <b>${escapeHtml(account.label)}</b>`,
    `✅ Berhasil: <b>${successCount}</b>`,
    `❌ Gagal: <b>${failCount}</b>`,
    `ℹ️ Dilewati: <b>${skippedCount}</b>`
  ];

  if (failures.size) {
    reportLines.push("", "⚠️ <b>Alasan:</b>");
    for (const [reason, count] of failures) {
      reportLines.push(`• ${count} × ${escapeHtml(reason)}`);
    }
  }

  if (starterAdminTelegramId) {
    try {
      await bot.api.sendMessage(
        starterAdminTelegramId,
        reportLines.join("\n"),
        { parse_mode: "HTML" }
      );
    } catch (_) {}
  }

  const baseDelay = Number(settings.interval_minutes || 10) * 60 * 1000;
  const delayMs = Math.max(baseDelay, floodWaitMs);

  return { shouldContinue: true, delayMs };
}

function scheduleAccount(accountId, delayMs = 0) {
  const key = String(accountId);
  const oldTask = schedulerTasks.get(key);

  if (oldTask?.timeout) clearTimeout(oldTask.timeout);

  const task = {
    running: true,
    timeout: null
  };

  schedulerTasks.set(key, task);

  task.timeout = setTimeout(async () => {
    if (schedulerTasks.get(key) !== task || !task.running) return;

    let nextDelay = 60000;
    let shouldContinue = true;

    try {
      const result = await fireAccount(accountId);
      nextDelay = Number(result?.delayMs || 60000);
      shouldContinue = result?.shouldContinue !== false;
    } catch (e) {
      console.error(`PROMOTION ${key}:`, safeErrorMessage(e));
      const settings = await getAccountSettings(accountId).catch(() => null);

      await recordHistory(accountId, null, {
        action: "promotion_send",
        status: "error",
        error: safeErrorMessage(e, 1000)
      });

      nextDelay = Math.max(
        60000,
        Number(settings?.interval_minutes || 10) * 60 * 1000
      );
    }

    const latest = schedulerTasks.get(key);
    if (latest !== task || !task.running) return;

    const settings = await getAccountSettings(accountId).catch(() => null);
    if (!settings?.active) {
      schedulerTasks.delete(key);
      return;
    }

    if (
      settings.expires_at &&
      new Date(settings.expires_at) <= new Date()
    ) {
      await sb
        .from("account_settings")
        .update({
          active: false,
          expires_at: null,
          started_at: null,
        })
        .eq("account_id", accountId);

      schedulerTasks.delete(key);
      return;
    }

    if (!shouldContinue) {
      schedulerTasks.delete(key);
      return;
    }

    task.timeout = setTimeout(() => {
      if (schedulerTasks.get(key) !== task || !task.running) return;

      // Re-use the exact task; scheduleAccount would otherwise replace it.
      task.timeout = null;
      scheduleAccount(key, 0);
    }, Math.max(1000, nextDelay));
  }, Math.max(0, delayMs));
}

async function startPromotion(accountId, adminId) {
  return withAccountLock(accountId, async () => {
    const account = await getAccount(accountId);
    const settings = await getAccountSettings(accountId);

    if (!account) throw new Error("Account tidak ditemukan.");
    if (!settings) throw new Error("Setting account belum tersedia.");

    if (settings.active && schedulerTasks.has(String(accountId))) {
      return { alreadyRunning: true, account, settings };
    }

    const client = await clientFor(accountId);
    if (!client) {
      throw new Error("Account belum connected atau session tidak valid.");
    }

    const formatReady =
      (settings.media_type === "text" && String(settings.message || "").trim()) ||
      (settings.media_type === "photo" && settings.media_file_id);

    if (!formatReady) {
      throw new Error("Format promosi belum dibuat.");
    }

    const { count, error: countError } = await sb
      .from("account_groups")
      .select("*", { count: "exact", head: true })
      .eq("account_id", accountId)
      .eq("enabled", true)
      .eq("can_send", true);

    if (countError) throw countError;
    if (!Number(count || 0)) {
      throw new Error("Belum ada target grup aktif yang bisa dikirimi.");
    }

    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + Number(settings.duration_hours || 1) * 60 * 60 * 1000
    );

    const { data: updated, error } = await sb
      .from("account_settings")
      .update({
        active: true,
        started_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
      })
      .eq("account_id", accountId)
      .select("*")
      .single();

    if (error) throw error;

    await recordHistory(accountId, adminId, {
      action: "promotion_start",
      status: "success",
      details: {
        interval_minutes: updated.interval_minutes,
        duration_hours: updated.duration_hours
      }
    });

    // Exactly one scheduler per account. Immediate first fire is retained from old bot behavior.
    scheduleAccount(accountId, 0);

    return { alreadyRunning: false, account, settings: updated };
  });
}

async function stopPromotion(accountId, adminId) {
  return withAccountLock(accountId, async () => {
    const account = await getAccount(accountId);
    if (!account) throw new Error("Account tidak ditemukan.");

    await stopScheduler(accountId);

    const { data: settings, error } = await sb
      .from("account_settings")
      .select("*")
      .eq("account_id", accountId)
      .maybeSingle();

    if (error) throw error;

    const wasRunning = Boolean(settings?.active);

    const { error: updateError } = await sb
      .from("account_settings")
      .update({
        active: false,
        expires_at: null,
        started_at: null,
      })
      .eq("account_id", accountId);

    if (updateError) throw updateError;

    await recordHistory(accountId, adminId, {
      action: "promotion_stop",
      status: "success",
      details: { was_running: wasRunning }
    });

    return { wasRunning };
  });
}

/* =========================================================
   ACCOUNT LOGIN / CONNECT
========================================================= */

// Accepts "+628123456789", "628123456789", "+62 812-3456-789", etc. and returns
// the canonical "+<digits>" form, or null when it is not a usable number.
function normalizePhone(value) {
  let raw = String(value ?? "").trim().replace(/[\s\-().]/g, "");
  if (/^\d{7,15}$/.test(raw) && !raw.startsWith("0")) raw = `+${raw}`;
  return /^\+[1-9]\d{6,14}$/.test(raw) ? raw : null;
}

// Telegram frequently invalidates a login code when the exact digits are sent
// back through Telegram itself. Admins can therefore write the OTP with
// separators ("1-2-3-4-5" / "1 2 3 4 5"); only the digits reach GramJS.
function parseLoginCode(value) {
  const raw = String(value ?? "").trim();

  if (!raw) {
    return { ok: false, code: "", error: "Kode OTP tidak boleh kosong." };
  }

  if (!/^[\d\s.,\-_]+$/.test(raw)) {
    return {
      ok: false,
      code: "",
      error: "Kode OTP hanya boleh berisi angka (boleh dipisah spasi atau tanda hubung)."
    };
  }

  const code = raw.replace(/\D/g, "");
  if (code.length < 4 || code.length > 8) {
    return { ok: false, code: "", error: "Kode OTP harus 4-8 digit angka." };
  }

  return { ok: true, code, error: "" };
}

function rpcErrorCode(error) {
  return String(error?.errorMessage || error?.message || "").toUpperCase();
}

function loginErrorText(error) {
  const code = rpcErrorCode(error);

  if (/PHONE_NUMBER_INVALID/.test(code)) {
    return "Nomor telepon tidak valid. Periksa kembali nomor Telegram tersebut.";
  }
  if (/PHONE_NUMBER_BANNED/.test(code)) {
    return "Nomor ini diblokir oleh Telegram.";
  }
  if (/FLOOD/.test(code)) {
    const seconds = Number(error?.seconds);
    return seconds > 0
      ? `Terlalu banyak percobaan. Coba lagi dalam ${seconds} detik.`
      : "Terlalu banyak percobaan. Tunggu beberapa saat lalu coba lagi.";
  }
  if (/PHONE_CODE_INVALID/.test(code)) {
    return "Kode OTP salah.";
  }
  if (/PHONE_CODE_EXPIRED/.test(code)) {
    return "Kode OTP kedaluwarsa atau diblokir Telegram. Saat mengirim kode, tulis dengan pemisah (contoh 1-2-3-4-5), lalu ulangi dari awal.";
  }
  if (/PASSWORD_HASH_INVALID/.test(code)) {
    return "Password 2FA salah.";
  }
  if (/API_ID_INVALID/.test(code)) {
    return "API_ID / API_HASH tidak valid. Periksa konfigurasi server.";
  }

  return safeErrorMessage(error, 300);
}

function clearLoginFlow(userKey, accountId) {
  const flow = flows.get(userKey);
  if (
    flow &&
    (flow.t === "login_code" || flow.t === "login_password") &&
    String(flow.accountId) === String(accountId)
  ) {
    flows.delete(userKey);
  }
}

function waitForInput(
  adminTelegramId,
  nextType,
  timeoutMs = 5 * 60 * 1000,
  accountId = null
) {
  const userId = String(adminTelegramId);

  return new Promise((resolve, reject) => {
    const old = waiters.get(userId);
    if (old) old.reject(new Error("Input sebelumnya dibatalkan."));

    let settled = false;
    let timer = null;

    const waiter = {
      type: nextType,
      accountId: accountId == null ? null : String(accountId),
      timer: null,
      resolve(value) {
        if (settled) return;
        if (waiters.get(userId) !== waiter) return;

        const normalized =
          nextType === "code"
            ? parseLoginCode(value).code
            : String(value ?? "").trim();

        if (!normalized) {
          settled = true;
          clearTimeout(timer);
          waiters.delete(userId);
          reject(new Error(
            nextType === "code"
              ? "Kode OTP tidak boleh kosong."
              : "Password 2FA tidak boleh kosong."
          ));
          return;
        }

        settled = true;
        clearTimeout(timer);
        waiters.delete(userId);
        resolve(normalized);
      },
      reject(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (waiters.get(userId) === waiter) {
          waiters.delete(userId);
        }
        reject(error);
      }
    };

    timer = setTimeout(() => {
      if (waiters.get(userId) !== waiter || settled) return;
      settled = true;
      waiters.delete(userId);
      flows.delete(userId);
      reject(new Error("Waktu input habis. Silakan mulai lagi."));
    }, timeoutMs);

    waiter.timer = timer;
    waiters.set(userId, waiter);
  });
}

async function startLoading(ctx, phone) {
  const userId = String(ctx.from.id);
  const chatId = ctx.chat?.id || ctx.from.id;
  const safePhone = escapeHtml(phone);
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const FRAME_MS = 1000;
  const MAX_ANIMATION_MS = 15 * 60 * 1000;

  // Keep the login process inside one editable UI message.
  await deleteSavedUi(userId);

  let frameIndex = 0;
  let stopped = false;
  let timer = null;
  let frameQueued = false;
  let pauseUntil = 0;
  let startedAt = Date.now();
  let message = null;
  let queue = Promise.resolve();
  let currentBody = [
    "<b>Nomor diterima</b>",
    "",
    `📱 Nomor <code>${safePhone}</code>`,
    "⏳ Menghubungkan ke Telegram...",
    "🔐 Menyiapkan sesi login..."
  ].join("\n");
  let currentKeyboard = cancelKeyboard(false);

  const buildText = frame => `${frame} ${currentBody}`;

  // Every edit goes through one queue. A late spinner frame can therefore
  // never land after (and overwrite) a final status, and edits never overlap.
  const enqueue = getText => {
    queue = queue.then(async () => {
      const text = getText();
      if (text == null || !message) return;

      try {
        await bot.api.editMessageText(chatId, message.message_id, text, {
          parse_mode: "HTML",
          reply_markup: currentKeyboard
        });
      } catch (e) {
        const raw = String(e?.message || e);
        if (/message is not modified/i.test(raw)) return;

        const retryAfter = Number(e?.parameters?.retry_after);
        if (retryAfter > 0) pauseUntil = Date.now() + retryAfter * 1000;

        console.warn("LOGIN STATUS UPDATE:", safeErrorMessage(e, 180));
      }
    });

    return queue;
  };

  const halt = () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const tick = () => {
    if (stopped || timer) return;

    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;

      // Failsafe: an animation can never outlive a stuck login.
      if (Date.now() - startedAt > MAX_ANIMATION_MS) {
        halt();
        return;
      }

      if (!frameQueued && Date.now() >= pauseUntil) {
        frameQueued = true;
        frameIndex = (frameIndex + 1) % frames.length;

        void enqueue(() => {
          frameQueued = false;
          return stopped ? null : buildText(frames[frameIndex]);
        });
      }

      tick();
    }, FRAME_MS);
  };

  message = await bot.api.sendMessage(
    chatId,
    buildText(frames[0]),
    {
      parse_mode: "HTML",
      reply_markup: currentKeyboard
    }
  );
  await saveUiMessage(userId, message, false);

  tick();

  return {
    // Change the status text while the animation keeps running.
    async update(text, keyboard = cancelKeyboard(false)) {
      if (stopped) return;
      currentBody = String(text);
      currentKeyboard = keyboard;
      await enqueue(() => (stopped ? null : buildText(frames[frameIndex])));
    },

    // Stop the animation and show a final (static) status.
    async finish(text, keyboard = cancelKeyboard(false)) {
      halt();
      currentBody = String(text);
      currentKeyboard = keyboard;
      await enqueue(() => currentBody);
    },

    // Start animating again (e.g. while an OTP is being verified).
    async restart(text, keyboard = cancelKeyboard(false)) {
      currentBody = String(text);
      currentKeyboard = keyboard;

      if (stopped) {
        stopped = false;
        frameQueued = false;
        startedAt = Date.now();
        tick();
      }

      await enqueue(() => (stopped ? null : buildText(frames[frameIndex])));
    },

    // Clears the interval. The returned promise settles once any edit that is
    // already in flight is done, so the caller can safely render over it.
    stop() {
      halt();
      return queue;
    }
  };
}

function stopLoading(loader) {
  return loader?.stop?.();
}

async function startLogin(ctx, accountId, phone, options = {}) {
  const adminTelegramId = ctx.from.id;
  const userKey = String(adminTelegramId);

  if (loginRuns.has(userKey)) {
    throw new Error("Proses login akun Telegram lain masih berjalan.");
  }

  const run = {
    accountId: String(accountId),
    client: null,
    cancelled: false,
    loader: null,
    stage: "phone",
    notice: "",
    fatalError: null
  };
  loginRuns.set(userKey, run);

  let client = null;
  let loginStatus = null;
  let sessionPersisted = false;

  try {
    client = await createTelegramClient("");
    run.client = client;

    if (run.cancelled) throw new Error("Login dibatalkan.");

    loginStatus = await startLoading(ctx, phone);
    run.loader = loginStatus;

    if (run.cancelled) throw new Error("Login dibatalkan.");

    await client.connect();

    if (run.cancelled) throw new Error("Login dibatalkan.");

    await loginStatus.update(
      [
        "<b>Terhubung ke Telegram</b>",
        "",
        `📱 Nomor <code>${escapeHtml(phone)}</code>`,
        "📩 Kode OTP sedang dikirim..."
      ].join("\n")
    );

    await client.start({
      phoneNumber: async () => phone,

      phoneCode: async isCodeViaApp => {
        if (run.cancelled) throw new Error("Login dibatalkan.");

        run.stage = "code";

        // Register the waiter before changing the UI. This prevents a fast
        // OTP message from arriving before the input promise is available.
        flows.set(userKey, {
          t: "login_code",
          accountId: String(accountId)
        });
        const codePromise = waitForInput(
          adminTelegramId,
          "code",
          5 * 60 * 1000,
          accountId
        );
        codePromise.catch(() => {});

        const notice = run.notice;
        run.notice = "";

        const sentTo =
          isCodeViaApp === true
            ? "📨 Kode dikirim ke aplikasi Telegram pada nomor tersebut."
            : isCodeViaApp === false
              ? "📨 Kode dikirim lewat SMS/panggilan ke nomor tersebut."
              : "📨 Periksa aplikasi Telegram (atau SMS) pada nomor tersebut.";

        await loginStatus.finish(
          [
            notice ? `⚠️ <b>${escapeHtml(notice)}</b>\n` : null,
            "✅ <b>Kode OTP Telegram sudah dikirim</b>",
            "",
            `📱 Nomor <code>${escapeHtml(phone)}</code>`,
            sentTo,
            "",
            "🔑 <b>Kirim kode OTP di chat ini.</b>",
            "💡 <i>Tulis dengan pemisah, contoh 1-2-3-4-5, agar kode tidak diblokir Telegram.</i>"
          ].filter(line => line !== null).join("\n"),
          cancelKeyboard(false)
        );

        const code = await codePromise;
        const parsed = parseLoginCode(code);
        if (!parsed.ok) throw new Error(parsed.error);

        await loginStatus.restart(
          [
            "<b>Memverifikasi kode OTP...</b>",
            "",
            `📱 Nomor <code>${escapeHtml(phone)}</code>`,
            "🔐 Mohon tunggu sebentar."
          ].join("\n")
        );

        return parsed.code;
      },

      password: async () => {
        if (run.cancelled) throw new Error("Login dibatalkan.");

        run.stage = "password";

        flows.set(userKey, {
          t: "login_password",
          accountId: String(accountId)
        });
        const passwordPromise = waitForInput(
          adminTelegramId,
          "password",
          5 * 60 * 1000,
          accountId
        );
        passwordPromise.catch(() => {});

        const notice = run.notice;
        run.notice = "";

        await loginStatus.finish(
          [
            notice ? `⚠️ <b>${escapeHtml(notice)}</b>\n` : null,
            "🔐 <b>Verifikasi 2 langkah</b>",
            "",
            `📱 Nomor <code>${escapeHtml(phone)}</code>`,
            "Akun ini meminta password 2FA Telegram.",
            "",
            "🔑 <b>Kirim password 2FA di chat ini.</b>"
          ].filter(line => line !== null).join("\n"),
          cancelKeyboard(false)
        );

        const password = await passwordPromise;
        if (!password) {
          throw new Error("Password 2FA tidak boleh kosong.");
        }

        await loginStatus.restart(
          [
            "<b>Memverifikasi password 2FA...</b>",
            "",
            `📱 Nomor <code>${escapeHtml(phone)}</code>`,
            "🔐 Mohon tunggu sebentar."
          ].join("\n")
        );

        return password;
      },

      // GramJS calls onError for every failure inside client.start() and then
      // goes back to its auth loop unless the callback returns true. Returning
      // false for a non-recoverable error (bad phone, expired code, flood)
      // would make GramJS re-send the code / re-ask for input forever.
      onError: async error => {
        const message = safeErrorMessage(error, 300);
        console.error("LOGIN ERROR:", message);

        if (
          run.cancelled ||
          message === "Login dibatalkan." ||
          message === "AUTH_USER_CANCEL" ||
          message === "Waktu input habis. Silakan mulai lagi." ||
          message === "Sesi input login sudah tidak aktif." ||
          message === "Input sebelumnya dibatalkan."
        ) {
          run.cancelled = true;
          return true;
        }

        // A wrong OTP / wrong 2FA password can simply be entered again.
        if (
          (run.stage === "code" || run.stage === "password") &&
          /PHONE_CODE_INVALID|PASSWORD_HASH_INVALID|PHONE_CODE_EMPTY/.test(
            rpcErrorCode(error)
          )
        ) {
          run.notice = loginErrorText(error);
          return false;
        }

        // Everything else ends the login with the real reason.
        run.fatalError = error;
        return true;
      }
    });

    if (run.cancelled) throw new Error("Login dibatalkan.");

    const identity = await getMeFromClient(client);

    const { data: other, error: otherError } = await sb
      .from("telegram_accounts")
      .select("id,label")
      .eq("telegram_user_id", identity.telegramUserId)
      .neq("id", accountId)
      .limit(1)
      .maybeSingle();

    if (otherError) throw otherError;

    if (other) {
      throw new Error(
        `Akun Telegram tersebut sudah dikaitkan sebagai "${other.label}".`
      );
    }

    const derivedLabel =
      [identity.firstName, identity.lastName].filter(Boolean).join(" ").trim() ||
      identity.username ||
      phone;

    const sessionString = client.session.save();
    if (!sessionString) {
      throw new Error("Session Telegram kosong setelah login.");
    }
    const sessionEncrypted = encryptSession(sessionString);

    const { data: updated, error } = await sb
      .from("telegram_accounts")
      .update({
        label: truncateText(derivedLabel, 80),
        telegram_user_id: identity.telegramUserId,
        username: identity.username || null,
        phone: identity.phone || phone,
        session_string: sessionEncrypted,
        status: "connected"
      })
      .eq("id", accountId)
      .select("*")
      .single();

    if (error) throw error;

    // Replace (and close) any stale client that was stored for this account.
    const previous = clients.get(String(accountId));
    if (previous && previous !== client) {
      try { await previous.disconnect(); } catch (_) {}
    }

    clients.set(String(accountId), client);
    sessionPersisted = true;
    clearLoginFlow(userKey, accountId);

    await recordHistory(accountId, options.adminId || null, {
      action: "account_connect",
      status: "success",
      details: {
        telegram_user_id: identity.telegramUserId,
        username: identity.username
      }
    });

    await stopLoading(loginStatus);

    const successText = [
      "✅ <b>Login berhasil</b>",
      "",
      `📱 Nomor <code>${escapeHtml(identity.phone || phone)}</code>`,
      `👤 Akun <code>${escapeHtml(derivedLabel)}</code>`,
      "🔒 Session tersimpan (terenkripsi).",
      "🟢 Status: connected",
      ""
    ].join("\n");

    // UI rendering should never undo a successfully persisted login.
    try {
      await showAccount(ctx, updated.id, successText);
    } catch (uiError) {
      console.error("LOGIN SUCCESS UI:", safeErrorMessage(uiError, 300));
      await loginStatus.finish(
        successText,
        new InlineKeyboard()
          .text("📱 Buka Akun", `account:open:${updated.id}`)
          .row()
          .text("🏠 Menu Utama", "menu:dashboard")
      );
    }
  } catch (e) {
    clearLoginFlow(userKey, accountId);

    const waiter = waiters.get(userKey);
    if (waiter?.accountId === String(accountId)) {
      waiter.reject(e);
    }

    const failure = run.fatalError || e;
    const failureMessage = safeErrorMessage(failure, 200);
    const cancelled =
      run.cancelled ||
      failureMessage === "Login dibatalkan." ||
      (failureMessage === "AUTH_USER_CANCEL" && !run.fatalError);

    await stopLoading(loginStatus);

    if (!cancelled && !sessionPersisted) {
      const failText = [
        "❌ <b>Login gagal</b>",
        "",
        `📱 Nomor <code>${escapeHtml(phone)}</code>`,
        escapeHtml(loginErrorText(failure))
      ].join("\n");

      const failKeyboard = new InlineKeyboard()
        .text(
          "🔁 Coba Lagi",
          options.deleteOnFailure
            ? "account:add"
            : `account:connect:${accountId}`
        )
        .row()
        .text("🏠 Menu Utama", "menu:dashboard");

      try {
        if (loginStatus) {
          await loginStatus.finish(failText, failKeyboard);
        } else {
          await renderUi(adminTelegramId, failText, failKeyboard, {
            parse_mode: "HTML"
          });
        }
      } catch (uiError) {
        console.error("LOGIN FAILURE UI:", safeErrorMessage(uiError, 300));
      }
    }

    // Once the session is persisted and the client is stored, never disconnect
    // it because a later UI-only operation failed.
    if (!sessionPersisted) {
      try { await client?.disconnect(); } catch (_) {}

      if (options.deleteOnFailure) {
        try {
          await deleteAccountAfterLoginFailure(accountId);
        } catch (cleanupError) {
          console.error(
            "LOGIN CLEANUP:",
            safeErrorMessage(cleanupError, 300)
          );
        }
      }
    }

    if (cancelled) return;

    throw failure;
  } finally {
    if (loginRuns.get(userKey) === run) {
      loginRuns.delete(userKey);
    }
  }
}

// grammY handles updates one at a time. A login waits for the admin's next
// message (OTP / 2FA), so it must NOT be awaited inside the message handler:
// the handler would never return and the OTP update would stay queued behind
// it. Run it in the background instead; all errors are reported to the admin
// from startLogin() itself.
function startLoginInBackground(ctx, accountId, phone, options = {}) {
  startLogin(ctx, accountId, phone, options).catch(error => {
    console.error("LOGIN RUN:", safeErrorMessage(error, 300));
  });
}

async function connectStoredAccount(ctx, accountId, adminId) {
  const client = await clientFor(accountId);

  if (!client) return false;

  const identity = await getMeFromClient(client);
  const account = await getAccount(accountId);
  const derivedLabel =
    [identity.firstName, identity.lastName].filter(Boolean).join(" ").trim() ||
    identity.username ||
    account?.phone ||
    "Akun Telegram";
  const { error } = await sb
    .from("telegram_accounts")
    .update({
      label: truncateText(derivedLabel, 80),
      telegram_user_id: identity.telegramUserId,
      username: identity.username || null,
      phone: identity.phone || account?.phone || null,
      status: "connected",
    })
    .eq("id", accountId);

  if (error) throw error;

  await recordHistory(accountId, adminId, {
    action: "account_connect",
    status: "success",
    details: { reconnect: true, telegram_user_id: identity.telegramUserId }
  });

  return true;
}

/* =========================================================
   LEGACY MIGRATION
   Tabel lama tetap dipertahankan. Server mengimpor satu kali,
   termasuk encrypt session lama di level aplikasi.
========================================================= */

async function tableExists(tableName) {
  try {
    const { error } = await sb
      .from(tableName)
      .select("*", { count: "exact", head: true });

    if (!error) return true;
    const message = String(error.message || "").toLowerCase();
    const code = String(error.code || "");
    if (code === "PGRST205") return false;
    if (message.includes("schema cache")) return false;
    if (message.includes("does not exist")) return false;
    if (message.includes("relation") && message.includes("not found")) return false;
    return true;
  } catch (_) {
    return false;
  }
}

async function getMigrationState(key) {
  const { data, error } = await sb
    .from("system_migrations")
    .select("*")
    .eq("key", key)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function markMigrationComplete(key, details = {}) {
  const { error } = await sb
    .from("system_migrations")
    .upsert({
      key,
      completed_at: new Date().toISOString(),
      details
    }, { onConflict: "key" });

  if (error) throw error;
}

async function migrateLegacyData() {
  const key = "legacy_import_v1";
  const state = await getMigrationState(key);
  if (state?.completed_at) return;

  const hasUsers = await tableExists("app_users");
  const hasSessions = await tableExists("telegram_sessions");
  const hasGroups = await tableExists("groups");
  const hasCampaigns = await tableExists("campaigns");
  const hasCampaignGroups = await tableExists("campaign_groups");
  const hasSendLogs = await tableExists("send_logs");

  if (!hasUsers) {
    await markMigrationComplete(key, { skipped: true, reason: "legacy app_users not found" });
    return;
  }

  const owner = await sb
    .from("admins")
    .select("id,telegram_user_id")
    .eq("role", "OWNER")
    .eq("active", true)
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (owner.error) throw owner.error;
  const ownerTelegramUserId = owner.data?.telegram_user_id || null;

  const { data: legacyUsers, error: usersError } = await sb
    .from("app_users")
    .select("*")
    .order("id", { ascending: true });

  if (usersError) throw usersError;

  const accountByLegacyUserId = new Map();
  const accountByTelegramId = new Map();
  const legacyUserById = new Map();
  let migratedAccounts = 0;

  for (const legacyUser of legacyUsers || []) {
    legacyUserById.set(String(legacyUser.id), legacyUser);

    const tgId = legacyUser.telegram_user_id;
    if (!tgId) continue;

    const existing = await sb
      .from("telegram_accounts")
      .select("*")
      .eq("telegram_user_id", tgId)
      .maybeSingle();

    if (existing.error) throw existing.error;

    let account = existing.data;

    if (!account) {
      const label =
        String(legacyUser.first_name || legacyUser.username || "").trim() ||
        `Legacy Account ${tgId}`;

      const inserted = await sb
        .from("telegram_accounts")
        .insert({
          telegram_user_id: tgId,
          label,
          status: "disconnected",
          created_by: ownerTelegramUserId
        })
        .select("*")
        .single();

      if (inserted.error) throw inserted.error;
      account = inserted.data;
      migratedAccounts++;
    }

    await ensureAccountSettings(account.id);
    accountByLegacyUserId.set(String(legacyUser.id), account);
    accountByTelegramId.set(String(tgId), account);
  }

  if (hasSessions && legacyUsers?.length) {
    const { data: legacySessions, error: sessionsError } = await sb
      .from("telegram_sessions")
      .select("*");

    if (sessionsError) throw sessionsError;

    for (const session of legacySessions || []) {
      const legacyUser = legacyUserById.get(String(session.user_id));
      const account = accountByLegacyUserId.get(String(session.user_id));
      if (!account) continue;

      const update = {};
      if (session.phone) update.phone = session.phone;
      if (
        session.status === "connected" &&
        legacyUser?.status === "active"
      ) {
        update.status = "connected";
      } else if (session.status) {
        update.status = "disconnected";
      }

      const existingAccount = await getAccount(account.id);
      if (!existingAccount?.session_string && session.session_string) {
        update.session_string = encryptSession(session.session_string);
      }

      if (Object.keys(update).length) {
        const { error } = await sb
          .from("telegram_accounts")
          .update(update)
          .eq("id", account.id);
        if (error) throw error;
      }
    }
  }

  if (hasGroups) {
    const { data: legacyGroups, error: groupsError } = await sb
      .from("groups")
      .select("*")
      .order("id", { ascending: true });

    if (groupsError) throw groupsError;

    for (const group of legacyGroups || []) {
      const account = accountByLegacyUserId.get(String(group.user_id));
      if (!account) continue;

      const { error } = await sb
        .from("account_groups")
        .upsert({
          account_id: account.id,
          telegram_group_id: String(group.telegram_group_id),
          title: group.title || "Tanpa Nama",
          can_send: group.can_send !== false,
          enabled: group.enabled === true
        }, {
          onConflict: "account_id,telegram_group_id"
        });

      if (error) throw error;
    }
  }

  const latestCampaignByLegacyUser = new Map();

  if (hasCampaigns) {
    const { data: campaigns, error: campaignsError } = await sb
      .from("campaigns")
      .select("*")
      .order("created_at", { ascending: false });

    if (campaignsError) throw campaignsError;

    for (const campaign of campaigns || []) {
      const keyUser = String(campaign.user_id);
      if (!latestCampaignByLegacyUser.has(keyUser)) {
        latestCampaignByLegacyUser.set(keyUser, campaign);
      }
    }

    for (const [legacyUserId, campaign] of latestCampaignByLegacyUser) {
      const account = accountByLegacyUserId.get(legacyUserId);
      if (!account) continue;

      const update = {
        interval_minutes: Number(campaign.interval_minutes || 10),
        duration_hours: Number(campaign.duration_hours || 1),
        media_type: campaign.media_file_id ? "photo" : "text",
        message: campaign.message || "",
        media_file_id: campaign.media_file_id || null,
        caption: campaign.caption || null,
        active: campaign.active === true,
        started_at: campaign.started_at || null,
        expires_at: campaign.expires_at || null
      };

      // The migration runs before normal new-version use, so legacy settings
      // are intentionally copied as the starting per-account configuration.
      const { error } = await sb
        .from("account_settings")
        .update(update)
        .eq("account_id", account.id);

      if (error) throw error;

      if (hasCampaignGroups) {
        const links = await sb
          .from("campaign_groups")
          .select("group_id")
          .eq("campaign_id", campaign.id);

        if (links.error) throw links.error;

        const targetGroupLegacyIds = new Set(
          (links.data || []).map(x => String(x.group_id))
        );

        for (const legacyGroupId of targetGroupLegacyIds) {
          // Legacy groups are uniquely identifiable by their old integer id.
          const legacyGroup = await sb
            .from("groups")
            .select("id,telegram_group_id")
            .eq("id", legacyGroupId)
            .maybeSingle();

          if (legacyGroup.error || !legacyGroup.data) continue;

          await sb
            .from("account_groups")
            .update({ enabled: true })
            .eq("account_id", account.id)
            .eq("telegram_group_id", String(legacyGroup.data.telegram_group_id));
        }
      }
    }
  }

  if (hasSendLogs) {
    let offset = 0;
    const batchSize = 500;

    while (true) {
      const { data: logs, error: logsError } = await sb
        .from("send_logs")
        .select("*")
        .order("id", { ascending: true })
        .range(offset, offset + batchSize - 1);

      if (logsError) throw logsError;
      if (!logs?.length) break;

      for (const log of logs) {
        const account = accountByLegacyUserId.get(String(log.user_id));
        if (!account) continue;

        let groupId = null;
        let groupTitle = null;

        if (log.group_id) {
          const legacyGroup = await sb
            .from("groups")
            .select("id,title,telegram_group_id")
            .eq("id", log.group_id)
            .maybeSingle();

          if (!legacyGroup.error && legacyGroup.data) {
            const currentGroup = await sb
              .from("account_groups")
              .select("id,title")
              .eq("account_id", account.id)
              .eq("telegram_group_id", String(legacyGroup.data.telegram_group_id))
              .maybeSingle();

            if (!currentGroup.error && currentGroup.data) {
              groupId = currentGroup.data.id;
              groupTitle = currentGroup.data.title;
            }
          }
        }

        const status = ["sent", "success", "ok"].includes(String(log.status).toLowerCase())
          ? "success"
          : "error";

        await recordHistory(account.id, null, {
          action: "legacy_send",
          status,
          groupId,
          groupTitle,
          error: log.error || null,
          accountLabel: account.label,
          details: {
            legacy_campaign_id: log.campaign_id || null,
            legacy_user_id: log.user_id || null
          },
          legacySource: "send_logs",
          legacySourceId: log.id
        });
      }

      if (logs.length < batchSize) break;
      offset += batchSize;
    }
  }

  await markMigrationComplete(key, {
    migrated_accounts: migratedAccounts,
    legacy_users: legacyUsers?.length || 0
  });
}

/* =========================================================
   ACCOUNT VIEWS / MENUS
========================================================= */

async function showAccount(ctx, accountId, prefixMessage = "") {
  const { account, settings } = await getAccountBundle(accountId);
  if (!account) return replaceUi(ctx, "❌ Account tidak ditemukan.", backDashboardKeyboard(), { parse_mode: "HTML" });
  const formats = await getPromotionFormats(accountId);
  const activeCount = formats.filter(x => x.active).length;
  const name = account.label || account.username || account.phone || "Akun Telegram";
  const message = [
    prefixMessage,
    `📱 <b>AKUN TELEGRAM</b>`,
    `👤 Nama: <b>${escapeHtml(name)}</b>`,
    `🔗 Username: <code>${escapeHtml(account.username ? `@${account.username}` : "-")}</code>`,
    `🆔 ID: <code>${escapeHtml(account.telegram_user_id || "-")}</code>`,
    `🟢 Koneksi: <b>${escapeHtml(account.status || "-")}</b>`,
    `📝 Format: <b>${formats.length}</b>`,
    `▶️ Format aktif: <b>${activeCount}</b>`,
    `🎯 Target aktif: <b>${formats.length >= 0 ? "dibagi bersama akun ini" : "-"}</b>`
  ].filter(Boolean).join("\n");
  return replaceUi(ctx, message, accountMenu(account, settings), { parse_mode: "HTML" });
}

async function renderFormatDetail(ctx, accountId, formatId, prefixMessage = "") {
  const account = await getAccount(accountId);
  if (!account) return replaceUi(ctx, "❌ Account tidak ditemukan.", backDashboardKeyboard(), { parse_mode: "HTML" });
  const format = await getPromotionFormat(accountId, formatId);
  if (!format) return replaceUi(ctx, "❌ Format tidak ditemukan.", new InlineKeyboard().text("⬅️ Kembali", `promo:list:${accountId}:0`), { parse_mode: "HTML" });
  const body = format.media_type === "photo"
    ? (format.caption || "Foto tanpa caption")
    : (format.message || "Format teks kosong");
  const message = [
    prefixMessage,
    `📝 <b>FORMAT: ${escapeHtml(format.name)}</b>`,
    "━━━━━━━━━━━━━━━━━━",
    "📄 <b>ISI FORMAT</b>",
    format.media_type === "photo" ? "🖼️ Media: Foto" : "📝 Media: Teks",
    `<blockquote>${escapeHtml(truncateText(body, 2500))}</blockquote>`,
    "━━━━━━━━━━━━━━━━━━",
    "⚙️ <b>PENGATURAN</b>",
    `⏱️ Jeda: <b>${escapeHtml(formatInterval(format.interval_minutes))}</b>`,
    `📅 Durasi: <b>${escapeHtml(formatDuration(format.duration_hours))}</b>`,
    `🕐 Waktu: <b>${escapeHtml(formatWindowLabel(format))}</b>`,
    `🟢 Status: <b>${format.active ? "AKTIF" : "NONAKTIF"}</b>`
  ].filter(Boolean).join("\n");
  return replaceUi(ctx, message, formatDetailKeyboard(accountId, format), { parse_mode: "HTML" });
}

async function renderFormatList(ctx, accountId, prefixMessage = "") {
  const account = await getAccount(accountId);
  if (!account) return replaceUi(ctx, "❌ Account tidak ditemukan.", backDashboardKeyboard(), { parse_mode: "HTML" });
  const formats = await getPromotionFormats(accountId);
  const lines = [prefixMessage, `📝 <b>FORMAT PROMOSI</b>`, `👤 ${escapeHtml(account.label || "Akun Telegram")}`, "", formats.length ? `Total format: <b>${formats.length}</b>` : "Belum ada format."];
  return replaceUi(ctx, lines.filter(Boolean).join("\n"), formatListKeyboard(formats, accountId), { parse_mode: "HTML" });
}

/* =========================================================
   CHAT LOADING ANIMATION
   Menu loading is shown as an animated message in the chat itself.
   No loading text is sent through Telegram's callback notification/toast.
========================================================= */

async function startChatLoading(ctx, title = "Memproses...") {
  const chatId = ctx.chat?.id || ctx.from?.id;
  const frames = ["◐", "◓", "◑", "◒"];
  const frameMs = 500;
  let index = 0;
  let stopped = false;
  let timer = null;
  let message = null;
  let queue = Promise.resolve();

  const body = () => `⏳ <b>${escapeHtml(title)}</b>\n\n<code>${frames[index]}</code> <i>Sedang bekerja, tunggu sebentar...</i>`;
  const edit = () => {
    queue = queue.then(async () => {
      if (stopped || !message) return;
      try { await bot.api.editMessageText(chatId, message.message_id, body(), { parse_mode: "HTML" }); } catch (_) {}
    });
    return queue;
  };
  message = await bot.api.sendMessage(chatId, body(), { parse_mode: "HTML" });
  const tick = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      timer = null;
      if (stopped) return;
      index = (index + 1) % frames.length;
      await edit();
      tick();
    }, frameMs);
  };
  tick();
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await queue.catch(() => {});
      if (message) { try { await bot.api.deleteMessage(chatId, message.message_id); } catch (_) {} }
    }
  };
}

async function withChatLoading(ctx, title, operation) {
  const loader = await startChatLoading(ctx, title);
  try { return await operation(); }
  finally { await loader.stop(); }
}

// Long operations call the loader explicitly; normal menu navigation stays clean.

/* =========================================================
   PUBLIC USER ACCESS / CHANNEL GATE / PURCHASE
========================================================= */

async function renderPublicGate(ctx, notice = "") {
  const member = await isOfficialChannelMember(ctx.from.id);
  if (member === true) {
    const subscription = await getUserSubscription(ctx.from.id);
    return replaceUi(
      ctx,
      userPurchaseText(subscription),
      userPurchaseKeyboard(),
      { parse_mode: "HTML" }
    );
  }
  if (member === false) {
    return replaceUi(
      ctx,
      `${notice ? `${escapeHtml(notice)}\n\n` : ""}${userJoinText()}`,
      joinChannelKeyboard(),
      { parse_mode: "HTML" }
    );
  }
  return replaceUi(
    ctx,
    "⚠️ <b>Belum dapat mengecek keanggotaan.</b>\n\nPastikan kamu sudah join channel resmi, lalu tekan <b>✅ Saya Sudah Join</b> lagi.",
    joinChannelKeyboard(),
    { parse_mode: "HTML" }
  );
}

async function publicUserAllowed(ctx) {
  const id = ctx.from?.id;
  if (!id) return true;
  const admin = await getAdminByTelegramId(id).catch(() => null);
  if (admin) return true;

  const member = await isOfficialChannelMember(id);
  if (member !== true) {
    await renderPublicGate(ctx, member === false ? "⛔ Kamu belum bergabung ke Channel Resmi." : "⚠️ Keanggotaan belum dapat diverifikasi.");
    if (ctx.callbackQuery) await ctx.answerCallbackQuery("Silakan join channel resmi terlebih dahulu.", { show_alert: true }).catch(() => {});
    return false;
  }

  const subscription = await getUserSubscription(id);
  if (subscription && subscriptionIsActive(subscription)) return true;

  // Public users are allowed to see the purchase/renewal menu only.
  const callback = String(ctx.callbackQuery?.data || "");
  const text = String(ctx.message?.text || "").trim();
  const allowed = text === "/start" || callback === "user:checkjoin" || callback === "user:purchase" || /^user:order:(ADMIN_ANAK|ADMIN_VIP|ADMIN_PREMIUM)$/.test(callback);
  if (!allowed) {
    await replaceUi(ctx, userPurchaseText(subscription), userPurchaseKeyboard(), { parse_mode: "HTML" });
    if (ctx.callbackQuery) await ctx.answerCallbackQuery("Akses bot belum aktif. Silakan pilih paket terlebih dahulu.", { show_alert: true }).catch(() => {});
    return false;
  }
  return true;
}

// Public users are gated before all normal bot actions. Admins keep their existing
// dashboard permissions and are not affected by the customer onboarding gate.
bot.use(async (ctx, next) => {
  try {
    if (await publicUserAllowed(ctx)) return next();
  } catch (error) {
    console.error("PUBLIC ACCESS GATE:", safeErrorMessage(error, 500));
    if (ctx.callbackQuery) await ctx.answerCallbackQuery("Terjadi kesalahan saat memeriksa akses.", { show_alert: true }).catch(() => {});
    else if (ctx.from?.id) await renderUi(ctx.from.id, "❌ Terjadi kesalahan saat memeriksa akses. Coba lagi sebentar.", joinChannelKeyboard(), { parse_mode: "HTML" }).catch(() => {});
  }
});

bot.callbackQuery("user:checkjoin", async ctx => {
  const member = await isOfficialChannelMember(ctx.from.id);
  if (member === true) {
    await ctx.answerCallbackQuery("✅ Kamu sudah bergabung. Akses dilanjutkan.").catch(() => {});
    const subscription = await getUserSubscription(ctx.from.id);
    return replaceUi(ctx, userPurchaseText(subscription), userPurchaseKeyboard(), { parse_mode: "HTML" });
  }
  if (member === false) {
    return ctx.answerCallbackQuery("❌ Kamu belum join Channel Resmi. Silakan join terlebih dahulu.", { show_alert: true });
  }
  return ctx.answerCallbackQuery("⚠️ Keanggotaan belum dapat diverifikasi. Coba lagi.", { show_alert: true });
});

bot.callbackQuery(/^user:order:(ADMIN_ANAK|ADMIN_VIP|ADMIN_PREMIUM)$/, async ctx => {
  const member = await isOfficialChannelMember(ctx.from.id);
  if (member !== true) {
    return ctx.answerCallbackQuery("❌ Kamu belum join Channel Resmi. Silakan join terlebih dahulu.", { show_alert: true });
  }

  const role = String(ctx.match[1]);
  const subscription = await getUserSubscription(ctx.from.id);
  const orderText = userOrderText(ctx, role, subscription);
  const kb = new InlineKeyboard()
    .url("📤 Kirim Order ke Owner", ownerOrderUrl(orderText))
    .row()
    .text("⬅️ Pilih Paket", "user:purchase")
    .row()
    .url("📢 Channel Resmi", "https://t.me/jasebvortex");

  await ctx.answerCallbackQuery().catch(() => {});
  return replaceUi(ctx, orderText, kb, { parse_mode: "HTML" });
});

bot.callbackQuery("user:purchase", async ctx => {
  const member = await isOfficialChannelMember(ctx.from.id);
  if (member !== true) return ctx.answerCallbackQuery("❌ Kamu belum join Channel Resmi. Silakan join terlebih dahulu.", { show_alert: true });
  await ctx.answerCallbackQuery().catch(() => {});
  const subscription = await getUserSubscription(ctx.from.id);
  return replaceUi(ctx, userPurchaseText(subscription), userPurchaseKeyboard(), { parse_mode: "HTML" });
});

// Best-effort immediate re-gating when Telegram sends a channel membership update.
bot.on("chat_member", async ctx => {
  const userId = ctx.chatMember?.user?.id;
  if (!userId) return;
  if (String(ctx.chat?.username || "").toLowerCase() !== OFFICIAL_CHANNEL.slice(1).toLowerCase()) return;
  const status = String(ctx.chatMember?.new_chat_member?.status || "").toLowerCase();
  if (!["left", "kicked"].includes(status)) return;
  const admin = await getAdminByTelegramId(userId).catch(() => null);
  if (admin) return;
  const subscription = await getUserSubscription(userId).catch(() => null);
  if (!subscription || !subscriptionIsActive(subscription)) return;
  await bot.api.sendMessage(userId, userJoinText(), { parse_mode: "HTML", reply_markup: joinChannelKeyboard() }).catch(() => {});
});

/* =========================================================
   START / DASHBOARD
========================================================= */

bot.command("start", async ctx => {
  try {
    const userKey = String(ctx.from.id);
    const activeFlow = flows.get(userKey);
    const activeLogin = loginRuns.get(userKey);

    // Do not let /start replace the OTP/2FA UI while GramJS is waiting for
    // user input. The login waiter remains the only consumer of the next OTP
    // or password message.
    if (
      activeLogin ||
      activeFlow?.t === "login_code" ||
      activeFlow?.t === "login_password"
    ) {
      try {
        await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
      } catch (_) {}
      return;
    }

    const adminRow = await getAdminByTelegramId(ctx.from.id);

    if (!adminRow) {
      const subscription = await getUserSubscription(ctx.from.id);
      return renderUi(
        ctx.from.id,
        userPurchaseText(subscription),
        userPurchaseKeyboard(),
        { parse_mode: "HTML" }
      );
    }

    const stats = await getDashboardStats(adminRow).catch(() => ({
      admins: 0,
      accounts: 0,
      connected: 0,
      running: 0,
      groups: 0
    }));

    // /start always returns to a clean state: drop any half-finished input
    // flow (label, format, ...). Login flows were already handled above.
    flows.delete(userKey);

    const text = dashboardText(ctx, stats, "", adminRow.role);
    const menu = adminRow.role === "OWNER" ? ownerDashboardMenu() : adminDashboardMenu(adminRow);
    const rendered = await renderStart(ctx, text, menu);

    // Remove the "/start" command itself so the chat only keeps the dashboard.
    try {
      await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
    } catch (_) {}

    return rendered;
  } catch (e) {
    console.error("START:", safeErrorMessage(e));
    return ctx.reply("❌ Terjadi kesalahan saat membuka dashboard.");
  }
});

bot.callbackQuery("menu:dashboard", async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const stats = await getDashboardStats(adminRow).catch(() => ({
    admins: 0,
    accounts: 0,
    connected: 0,
    running: 0,
    groups: 0
  }));

  const menu = adminRow.role === "OWNER" ? ownerDashboardMenu() : adminDashboardMenu(adminRow);
  return renderStart(ctx, dashboardText(ctx, stats, "", adminRow.role), menu);
});

/* =========================================================
   ACCOUNT LIST / ADD
========================================================= */

bot.callbackQuery(/^accounts:list:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const rawPage = Number(ctx.match[1]);

  try {
    const result = await listAccounts(rawPage, adminRow);
    const page = ensurePage(rawPage, Math.floor(Math.max(0, result.total - 1) / ACCOUNT_PAGE_SIZE));

    // Re-load if the requested page was beyond current max.
    const current = page === rawPage ? result : await listAccounts(page, adminRow);

    const lines = [
      "📱 <b>AKUN TELEGRAM</b>",
      `Total: <b>${current.total}</b>`,
      `Halaman: <b>${page + 1}</b>`,
      "",
      current.rows.length
        ? current.rows.map((x, i) =>
            `${String(page * ACCOUNT_PAGE_SIZE + i + 1).padStart(2, "0")}. ${accountStatusIcon(x)} <b>${escapeHtml(x.label)}</b>\n   🆔 <code>${escapeHtml(x.telegram_user_id || "belum login")}</code>`
          ).join("\n\n")
        : "<i>Belum ada akun Telegram.</i>",
      "",
      "Tekan nama akun untuk membuka semua kontrol account."
    ].join("\n");

    return replaceUi(
      ctx,
      lines,
      accountListKeyboard(current.rows, page, current.hasNext),
      { parse_mode: "HTML" }
    );
  } catch (e) {
    return replaceUi(
      ctx,
      `❌ Gagal mengambil daftar akun.\n\n${escapeHtml(safeErrorMessage(e))}`,
      backDashboardKeyboard(),
      { parse_mode: "HTML" }
    );
  }
});

bot.callbackQuery("account:add", async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  flows.set(String(ctx.from.id), {
    t: "account_phone_new",
    adminId: adminRow.id
  });

  return replaceUi(
    ctx,
    "➕ <b>KAITKAN AKUN TELEGRAM</b>\n\nMasukkan <b>nomor HP Telegram</b> dari akun yang ingin kamu kaitkan ke bot.\n\nSetelah login berhasil, <b>nama, username, dan Telegram ID</b> akan diambil otomatis dari akun tersebut. Nama akun di panel tidak akan memakai nama nomor lagi.\n\n📱 Contoh: <code>+628123456789</code>\n\n🔐 <i>Kode OTP/2FA akan diproses melalui chat ini.</i>",
    cancelKeyboard(false),
    { parse_mode: "HTML" }
  );
});

bot.callbackQuery(/^account:open:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  return showAccount(ctx, accountId);
});

bot.callbackQuery(/^account:status:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  return showAccount(ctx, accountId);
});

/* =========================================================
   ACCOUNT CONNECT / DISCONNECT / REMOVE
========================================================= */

bot.callbackQuery(/^account:connect:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  const account = await getAccount(accountId);

  if (!account) {
    return replaceUi(ctx, "❌ Account tidak ditemukan.", backDashboardKeyboard(), { parse_mode: "HTML" });
  }

  try {
    const reconnected = await connectStoredAccount(ctx, accountId, adminRow.id);
    if (reconnected) {
      return showAccount(ctx, accountId, "✅ Session tersimpan berhasil digunakan kembali.");
    }
  } catch (e) {
    console.error("CONNECT STORED:", safeErrorMessage(e));
  }

  flows.set(String(ctx.from.id), {
    t: "account_phone",
    accountId,
    adminId: adminRow.id
  });

  return replaceUi(
    ctx,
    "📱 <b>KAITKAN ULANG AKUN TELEGRAM</b>\n\nMasukkan <b>nomor HP Telegram</b> akun yang ingin dikaitkan kembali.\n\nNama akun akan disesuaikan otomatis dengan identitas Telegram setelah login berhasil.\n\n📱 Contoh: <code>+628123456789</code>",
    cancelKeyboard(false),
    { parse_mode: "HTML" }
  );
});

bot.callbackQuery(/^account:disconnect:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;

  try {
    await stopScheduler(accountId);
    await stopAllFormats(accountId, adminRow.id);
    await closeClient(accountId);

    const { error } = await sb
      .from("telegram_accounts")
      .update({ status: "disconnected" })
      .eq("id", accountId);

    if (error) throw error;

    await recordHistory(accountId, adminRow.id, {
      action: "account_disconnect",
      status: "success"
    });

    return showAccount(ctx, accountId, "✅ Account diputuskan. Session terenkripsi tetap disimpan untuk reconnect.");
  } catch (e) {
    return replaceUi(
      ctx,
      `❌ Gagal memutus account.\n\n${escapeHtml(safeErrorMessage(e))}`,
      backDashboardKeyboard(),
      { parse_mode: "HTML" }
    );
  }
});

bot.callbackQuery(/^account:remove:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  const account = await getAccount(accountId);

  if (!account) {
    return replaceUi(ctx, "❌ Account tidak ditemukan.", backDashboardKeyboard(), { parse_mode: "HTML" });
  }

  return replaceUi(
    ctx,
    `⚠️ <b>HAPUS ACCOUNT?</b>\n\n` +
      `📱 Account: <b>${escapeHtml(account.label)}</b>\n` +
      `🆔 Telegram ID: <code>${escapeHtml(account.telegram_user_id || "-")}</code>\n\n` +
      `Data account, setting, dan target grup akan dihapus. Riwayat tetap disimpan sebagai audit log.`,
    new InlineKeyboard()
      .text("✅ Ya, Hapus", `account:remove:confirm:${accountId}`)
      .row()
      .text("❌ Batal", `account:open:${accountId}`),
    { parse_mode: "HTML" }
  );
});

bot.callbackQuery(/^account:remove:confirm:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery("Menghapus account...").catch(() => {});
  const accountId = String(ctx.match[1]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  const account = await getAccount(accountId);

  if (!account) {
    return replaceUi(
      ctx,
      "❌ Account sudah tidak ada.",
      backDashboardKeyboard(),
      { parse_mode: "HTML" }
    );
  }

  try {
    await withAccountLock(accountId, async () => {
      await stopScheduler(accountId);
      await closeClient(accountId);

      // Detach history from the account/group rows first so the audit log can
      // survive the account deletion even when the FK uses RESTRICT.
      const detach = await sb
        .from("promotion_history")
        .update({ account_id: null, group_id: null })
        .eq("account_id", accountId);

      if (detach.error) throw detach.error;

      const { error: settingsError } = await sb
        .from("account_settings")
        .delete()
        .eq("account_id", accountId);

      if (settingsError) throw settingsError;

      const { error: groupsError } = await sb
        .from("account_groups")
        .delete()
        .eq("account_id", accountId);

      if (groupsError) throw groupsError;

      const { error: accountError } = await sb
        .from("telegram_accounts")
        .delete()
        .eq("id", accountId);

      if (accountError) throw accountError;
    });

    await recordHistory(null, adminRow.id, {
      accountLabel: account.label,
      action: "account_remove",
      status: "success",
      details: { deleted_account_id: accountId }
    });

    return replaceUi(
      ctx,
      `✅ <b>Account dihapus.</b>\\n\\n${escapeHtml(account.label)} sudah tidak lagi berada di sistem. Riwayat audit tetap disimpan.`,
      new InlineKeyboard().text("📱 Daftar Akun", "accounts:list:0"),
      { parse_mode: "HTML" }
    );
  } catch (e) {
    return replaceUi(
      ctx,
      `❌ Gagal menghapus account.\\n\\n${escapeHtml(safeErrorMessage(e))}`,
      new InlineKeyboard()
        .text("◀️ Account", `account:open:${accountId}`)
        .row()
        .text("🏠 Dashboard", "menu:dashboard"),
      { parse_mode: "HTML" }
    );
  }
});

/* =========================================================
   ACCOUNT SETTINGS / LABEL
========================================================= */

bot.callbackQuery(/^account:settings:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  const { account, settings } = await getAccountBundle(accountId);

  if (!account) {
    return replaceUi(ctx, "❌ Account tidak ditemukan.", backDashboardKeyboard(), { parse_mode: "HTML" });
  }

  return replaceUi(
    ctx,
    `⚙️ <b>SETTING ACCOUNT</b>\n\n${settingsSummary(account, settings)}`,
    settingsMenu(accountId),
    { parse_mode: "HTML" }
  );
});

bot.callbackQuery(/^account:label:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  const account = await getAccount(accountId);

  if (!account) {
    return replaceUi(ctx, "❌ Account tidak ditemukan.", backDashboardKeyboard(), { parse_mode: "HTML" });
  }

  flows.set(String(ctx.from.id), {
    t: "account_label_edit",
    accountId
  });

  return replaceUi(
    ctx,
    `✏️ <b>Ubah Label</b>\n\nLabel saat ini: <b>${escapeHtml(account.label)}</b>\n\nKirim label baru.`,
    cancelKeyboard(false),
    { parse_mode: "HTML" }
  );
});

/* =========================================================
   PROMOTION FORMAT / DELAY / DURATION
========================================================= */

bot.callbackQuery(/^promo:list:(\d+):\d+$/, async ctx => {
  const adminRow = await requireAdmin(ctx); if (!adminRow) return;
  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  return renderFormatList(ctx, accountId);
});

bot.callbackQuery(/^promo:add:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx); if (!adminRow) return;
  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  const account = await getAccount(accountId);
  if (!account) return replaceUi(ctx, "❌ Account tidak ditemukan.", backDashboardKeyboard(), {parse_mode:"HTML"});
  flows.set(String(ctx.from.id), { t:"format_add", accountId, adminId:adminRow.id });
  return replaceUi(ctx, `➕ <b>TAMBAH FORMAT</b>\n\nKirim <b>isi format promosi</b> sekarang:\n• Teks (panjang/pendek bebas), atau\n• Foto (dengan/tanpa caption)`, cancelKeyboard(false), {parse_mode:"HTML"});
});

bot.callbackQuery(/^promo:view:(\d+):([^:]+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx); if (!adminRow) return;
  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  return renderFormatDetail(ctx, accountId, String(ctx.match[2]));
});

bot.callbackQuery(/^promo:edit:(\d+):([^:]+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx); if (!adminRow) return;
  await ctx.answerCallbackQuery().catch(() => {});
  const accountId=String(ctx.match[1]), formatId=String(ctx.match[2]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  const format=await getPromotionFormat(accountId, formatId);
  if(!format) return renderFormatList(ctx, accountId, "❌ Format tidak ditemukan.");
  flows.set(String(ctx.from.id), {t:"format", accountId, formatId, adminId:adminRow.id});
  return replaceUi(ctx, `✏️ <b>EDIT FORMAT: ${escapeHtml(format.name)}</b>\n\nKirim teks atau foto + caption baru.`, cancelKeyboard(false), {parse_mode:"HTML"});
});

bot.callbackQuery(/^promo:delete:(\d+):([^:]+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx); if (!adminRow) return;
  await ctx.answerCallbackQuery().catch(() => {});
  const accountId=String(ctx.match[1]), formatId=String(ctx.match[2]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  const formats=await getPromotionFormats(accountId);
  const format=formats.find(x=>x.id===formatId);
  if(!format) return renderFormatList(ctx, accountId, "❌ Format tidak ditemukan.");
  await stopFormat(accountId, formatId, adminRow.id).catch(()=>{});
  await savePromotionFormats(accountId, formats.filter(x=>x.id!==formatId));
  await recordHistory(accountId, adminRow.id, {action:"format_delete",status:"success",details:{format_id:formatId,format_name:format.name}});
  return renderFormatList(ctx, accountId, `🗑️ Format <b>${escapeHtml(format.name)}</b> dihapus.`);
});

bot.callbackQuery(/^promo:active:(\d+):\d+$/, async ctx => {
  const adminRow = await requireAdmin(ctx); if (!adminRow) return;
  await ctx.answerCallbackQuery().catch(() => {});
  const accountId=String(ctx.match[1]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  const formats=await getPromotionFormats(accountId);
  const active=formats.filter(x=>x.active);
  return replaceUi(ctx, `▶️ <b>FORMAT AKTIF</b>\n\n${active.length ? active.map(x=>`🟢 <b>${escapeHtml(x.name)}</b>\n⏱ ${escapeHtml(formatInterval(x.interval_minutes))}\n📅 ${escapeHtml(formatDuration(x.duration_hours))}\n🕐 ${escapeHtml(formatWindowLabel(x))}`).join("\n\n") : "Tidak ada format yang sedang aktif."}`, activeFormatKeyboard(active,accountId), {parse_mode:"HTML"});
});

bot.callbackQuery(/^promo:delay:(\d+):([^:]+)$/, async ctx => {
  const adminRow=await requireAdmin(ctx); if(!adminRow)return; await ctx.answerCallbackQuery().catch(()=>{});
  const accountId=String(ctx.match[1]), formatId=String(ctx.match[2]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return; const f=await getPromotionFormat(accountId,formatId);
  if(!f)return renderFormatList(ctx,accountId,"❌ Format tidak ditemukan.");
  flows.set(String(ctx.from.id),{t:"delay",accountId,formatId,adminId:adminRow.id});
  return replaceUi(ctx,`⏱️ <b>ATUR JEDA</b>\n\nFormat: <b>${escapeHtml(f.name)}</b>\nPilih jeda cepat di bawah, atau tekan <b>Ketik sendiri</b> untuk menulis menit/jam.`,formatDelayKeyboard(accountId,formatId),{parse_mode:"HTML"});
});

bot.callbackQuery(/^promo:duration:(\d+):([^:]+)$/, async ctx => {
  const adminRow=await requireAdmin(ctx); if(!adminRow)return; await ctx.answerCallbackQuery().catch(()=>{});
  const accountId=String(ctx.match[1]), formatId=String(ctx.match[2]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return; const f=await getPromotionFormat(accountId,formatId);
  if(!f)return renderFormatList(ctx,accountId,"❌ Format tidak ditemukan.");
  flows.set(String(ctx.from.id),{t:"duration",accountId,formatId,adminId:adminRow.id});
  return replaceUi(ctx,`📅 <b>ATUR DURASI</b>\n\nFormat: <b>${escapeHtml(f.name)}</b>\nPilih durasi cepat di bawah, atau tekan <b>Ketik sendiri</b> untuk menulis jam/hari.`,formatDurationKeyboard(accountId,formatId),{parse_mode:"HTML"});
});

bot.callbackQuery(/^promo:delayset:(\d+):([^:]+):(\d+)$/, async ctx => {
  const adminRow=await requireAdmin(ctx); if(!adminRow)return;
  await ctx.answerCallbackQuery().catch(()=>{});
  const accountId=String(ctx.match[1]), formatId=String(ctx.match[2]), minutes=Number(ctx.match[3]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  if (!Number.isFinite(minutes) || minutes < 1) return;
  const formats=await getPromotionFormats(accountId); const f=formats.find(x=>x.id===formatId);
  if(!f)return renderFormatList(ctx,accountId,"❌ Format tidak ditemukan.");
  f.interval_minutes=minutes; f.updated_at=new Date().toISOString();
  await savePromotionFormats(accountId,formats);
  flows.delete(String(ctx.from.id));
  return renderFormatDetail(ctx,accountId,formatId,`✅ Jeda disimpan: <b>${escapeHtml(formatInterval(minutes))}</b>`);
});

bot.callbackQuery(/^promo:durationset:(\d+):([^:]+):(\d+)$/, async ctx => {
  const adminRow=await requireAdmin(ctx); if(!adminRow)return;
  await ctx.answerCallbackQuery().catch(()=>{});
  const accountId=String(ctx.match[1]), formatId=String(ctx.match[2]), hours=Number(ctx.match[3]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  if (!Number.isFinite(hours) || hours < 1) return;
  const formats=await getPromotionFormats(accountId); const f=formats.find(x=>x.id===formatId);
  if(!f)return renderFormatList(ctx,accountId,"❌ Format tidak ditemukan.");
  f.duration_hours=hours;
  if(f.active) f.expires_at=new Date(Date.now()+hours*3600000).toISOString();
  f.updated_at=new Date().toISOString();
  await savePromotionFormats(accountId,formats);
  flows.delete(String(ctx.from.id));
  return renderFormatDetail(ctx,accountId,formatId,`✅ Durasi disimpan: <b>${escapeHtml(formatDuration(hours))}</b>`);
});

bot.callbackQuery(/^promo:toggle:(\d+):([^:]+)$/, async ctx => {
  const adminRow=await requireAdmin(ctx); if(!adminRow)return; await ctx.answerCallbackQuery().catch(()=>{});
  const accountId=String(ctx.match[1]),formatId=String(ctx.match[2]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return; const formats=await getPromotionFormats(accountId); const f=formats.find(x=>x.id===formatId);
  if(!f)return renderFormatList(ctx,accountId,"❌ Format tidak ditemukan.");
  try {
    if(f.active) await stopFormat(accountId,formatId,adminRow.id); else await startFormat(accountId,formatId,adminRow.id);
  } catch(e) {
    return renderFormatDetail(ctx,accountId,formatId,`❌ ${escapeHtml(safeErrorMessage(e))}`);
  }
  return renderFormatDetail(ctx,accountId,formatId,f.active?"🔴 Format dinonaktifkan.":"🟢 Format diaktifkan.");
});

/* =========================================================
   FORMAT START / STOP
========================================================= */

bot.callbackQuery(/^promo:stopall:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;
  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  try {
    await stopAllFormats(accountId, adminRow.id);
    return showAccount(ctx, accountId, "⏹️ <b>Semua promosi dihentikan.</b>");
  } catch (e) {
    return showAccount(ctx, accountId, `❌ ${escapeHtml(safeErrorMessage(e))}`);
  }
});

bot.callbackQuery(/^promo:start:(\d+):([^:]+)$/, async ctx => {
  const adminRow=await requireAdmin(ctx); if(!adminRow)return; await ctx.answerCallbackQuery().catch(()=>{});
  const accountId=String(ctx.match[1]),formatId=String(ctx.match[2]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  try { const r=await startFormat(accountId,formatId,adminRow.id); return renderFormatDetail(ctx,accountId,formatId,`▶️ <b>Format ${escapeHtml(r.format.name)} dimulai.</b>`); }
  catch(e){ return renderFormatDetail(ctx,accountId,formatId,`❌ ${escapeHtml(safeErrorMessage(e))}`); }
});

bot.callbackQuery(/^promo:stop:(\d+):([^:]+)$/, async ctx => {
  const adminRow=await requireAdmin(ctx); if(!adminRow)return; await ctx.answerCallbackQuery().catch(()=>{});
  const accountId=String(ctx.match[1]),formatId=String(ctx.match[2]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  try { const r=await stopFormat(accountId,formatId,adminRow.id); return renderFormatDetail(ctx,accountId,formatId,r.wasRunning?"⏹️ <b>Format dihentikan.</b>":"ℹ️ Format tidak sedang aktif."); }
  catch(e){ return renderFormatDetail(ctx,accountId,formatId,`❌ ${escapeHtml(safeErrorMessage(e))}`); }
});

/* =========================================================
   GROUP MANAGEMENT
========================================================= */

function rememberGroupSearch(accountId, query, page = 0) {
  const token = crypto.randomBytes(5).toString("hex");
  groupSearches.set(token, { accountId: String(accountId), query: String(query || "").trim(), page: Math.max(0, Number(page) || 0), createdAt: Date.now() });
  while (groupSearches.size > MAX_GROUP_SEARCHES) {
    const first = groupSearches.keys().next().value;
    if (!first) break;
    groupSearches.delete(first);
  }
  return token;
}

function groupSearchKeyboard(rows, accountId, token, page, hasNext) {
  const kb = new InlineKeyboard();
  for (const group of rows) {
    const icon = group.enabled ? "✅" : "❌";
    kb.text(`${icon} ${safeButtonText(group.title, 34)}`, `group:searchtoggle:${group.id}:${token}`).row();
  }
  if (page > 0) kb.text("◀️", `group:searchpage:${token}:${page - 1}`);
  kb.text("⬅️ Grup", `group:list:${accountId}:0`);
  if (hasNext) kb.text("▶️", `group:searchpage:${token}:${page + 1}`);
  kb.row();
  kb.text("🔎 Cari Lagi", `group:search:${accountId}`);
  return kb;
}

async function renderGroupSearch(ctx, token, page = 0) {
  const state = groupSearches.get(String(token));
  if (!state) return replaceUi(ctx, "⚠️ <b>Pencarian sudah kedaluwarsa.</b>", backDashboardKeyboard(), { parse_mode: "HTML" });
  const accountId = String(state.accountId);
  const query = String(state.query || "").trim();
  const offset = Math.max(0, Number(page) || 0) * GROUP_PAGE_SIZE;
  const pattern = `%${query.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
  const [{ data, error }, { count, error: countError }] = await Promise.all([
    sb.from("account_groups").select("id,account_id,title,can_send,enabled").eq("account_id", accountId).eq("can_send", true).ilike("title", pattern).order("title", { ascending: true }).range(offset, offset + GROUP_PAGE_SIZE - 1),
    sb.from("account_groups").select("*", { count: "exact", head: true }).eq("account_id", accountId).eq("can_send", true).ilike("title", pattern)
  ]);
  if (error) throw error;
  if (countError) throw countError;
  const total = Number(count || 0);
  const safePage = total ? Math.min(Math.max(0, Number(page) || 0), Math.floor((total - 1) / GROUP_PAGE_SIZE)) : 0;
  state.page = safePage;
  const rows = (data || []).slice(0, GROUP_PAGE_SIZE);
  const text = [
    "🔎 <b>CARI GRUP</b>",
    `Kata kunci: <code>${escapeHtml(query)}</code>`,
    `Ditemukan: <b>${total}</b>`,
    `Halaman: <b>${safePage + 1}</b>`,
    "",
    rows.length ? rows.map(g => `${g.enabled ? "✅" : "❌"} <b>${escapeHtml(g.title)}</b>`).join("\n\n") : "<i>Tidak ada grup yang mengandung kata tersebut.</i>",
    "",
    "Tekan nama grup untuk memilih / membatalkan target."
  ].join("\n");
  return replaceUi(ctx, text, groupSearchKeyboard(rows, accountId, token, safePage, offset + rows.length < total), { parse_mode: "HTML" });
}

bot.callbackQuery(/^group:search:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;
  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  flows.set(String(ctx.from.id), { t: "group_search", accountId });
  return replaceUi(ctx, "🔎 <b>CARI GRUP</b>\n\nKetik sebagian nama/kata yang ingin dicari.\nContoh: <code>lpm</code> — tidak perlu nama lengkap.\n\nBot akan menampilkan grup yang namanya mengandung kata tersebut.", cancelKeyboard(false), { parse_mode: "HTML" });
});

bot.callbackQuery(/^group:searchpage:([a-f0-9]+):(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;
  await ctx.answerCallbackQuery().catch(() => {});
  const token = String(ctx.match[1]);
  const state = groupSearches.get(token);
  if (!state) return replaceUi(ctx, "⚠️ Pencarian sudah kedaluwarsa.", backDashboardKeyboard(), { parse_mode: "HTML" });
  if (!await requireAccountAccess(ctx, adminRow, state.accountId)) return;
  return renderGroupSearch(ctx, token, Number(ctx.match[2]));
});

bot.callbackQuery(/^group:searchtoggle:(\d+):([a-f0-9]+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;
  const groupId = String(ctx.match[1]);
  const token = String(ctx.match[2]);
  const state = groupSearches.get(token);
  if (!state) return ctx.answerCallbackQuery("Pencarian sudah kedaluwarsa.", { show_alert: true });
  const { data: group, error } = await sb.from("account_groups").select("*").eq("id", groupId).maybeSingle();
  if (error || !group) return ctx.answerCallbackQuery("Grup tidak ditemukan.", { show_alert: true });
  if (!await requireAccountAccess(ctx, adminRow, String(group.account_id))) return;
  if (!group.can_send) return ctx.answerCallbackQuery("Telegram menandai grup ini tidak bisa menerima pesan.", { show_alert: true });
  await ctx.answerCallbackQuery().catch(() => {});
  const { error: updateError } = await sb.from("account_groups").update({ enabled: !group.enabled }).eq("id", groupId).eq("account_id", group.account_id);
  if (updateError) return ctx.answerCallbackQuery("Gagal menyimpan pilihan grup.", { show_alert: true });
  return renderGroupSearch(ctx, token, state.page);
});

bot.callbackQuery(/^group:list:(\d+):(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  const requestedPage = Number(ctx.match[2]);
  const account = await getAccount(accountId);

  if (!account) {
    return replaceUi(ctx, "❌ Account tidak ditemukan.", backDashboardKeyboard(), { parse_mode: "HTML" });
  }

  try {
    const offset = requestedPage * GROUP_PAGE_SIZE;
    const { count } = await sb
      .from("account_groups")
      .select("*", { count: "exact", head: true })
      .eq("account_id", accountId);

    const total = Number(count || 0);
    const maxPage = Math.floor(Math.max(0, total - 1) / GROUP_PAGE_SIZE);
    const page = ensurePage(requestedPage, maxPage);
    const result = page === requestedPage
      ? await listGroups(accountId, page)
      : await listGroups(accountId, page);

    const activeCountResult = await sb
      .from("account_groups")
      .select("*", { count: "exact", head: true })
      .eq("account_id", accountId)
      .eq("enabled", true)
      .eq("can_send", true);

    if (activeCountResult.error) throw activeCountResult.error;

    const lines = [
      `👥 <b>GRUP • ${escapeHtml(account.label)}</b>`,
      `Total: <b>${result.total}</b> • Target aktif: <b>${activeCountResult.count || 0}</b>`,
      `Halaman: <b>${page + 1}</b>`,
      "",
      result.rows.length
        ? result.rows.map((g, i) =>
            `${g.enabled ? "✅" : "❌"} <b>${escapeHtml(g.title)}</b>`
          ).join("\n\n")
        : "<i>Belum ada grup yang terdeteksi. Tekan Tambah Target / Deteksi Ulang.</i>",
      "",
      "Tekan nama grup untuk memilih / membatalkan target."
    ].join("\n");

    return replaceUi(
      ctx,
      lines,
      groupListKeyboard(result.rows, accountId, page, result.hasNext),
      { parse_mode: "HTML" }
    );
  } catch (e) {
    return replaceUi(
      ctx,
      `❌ Gagal mengambil grup.\n\n${escapeHtml(safeErrorMessage(e))}`,
      new InlineKeyboard().text("◀️ Account", `account:open:${accountId}`),
      { parse_mode: "HTML" }
    );
  }
});

bot.callbackQuery(/^group:add:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  const account = await getAccount(accountId);
  if (!account) {
    return replaceUi(ctx, "❌ Account tidak ditemukan.", backDashboardKeyboard(), { parse_mode: "HTML" });
  }

  try {
    const rows = await withChatLoading(ctx, "Mendeteksi grup...", () => refreshGroups(accountId));
    const allowed = rows.filter(x => x.can_send);
    await recordHistory(accountId, adminRow.id, {
      action: "group_scan_add",
      status: "success",
      details: { detected: rows.length, allowed: allowed.length }
    });

    return renderGroupPageDirect(
      ctx,
      accountId,
      0,
      `🔎 <b>GRUP TERDETEKSI</b>\n\n${allowed.length} grup yang bisa menerima pesan tersedia. Tekan nama grup untuk memilih target.`
    );
  } catch (e) {
    return replaceUi(
      ctx,
      `❌ Deteksi grup gagal.\n\n${escapeHtml(safeErrorMessage(e))}`,
      new InlineKeyboard().text("◀️ Account", `account:open:${accountId}`),
      { parse_mode: "HTML" }
    );
  }
});

bot.callbackQuery(/^group:refresh:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  const account = await getAccount(accountId);

  if (!account) {
    return replaceUi(ctx, "❌ Account tidak ditemukan.", backDashboardKeyboard(), { parse_mode: "HTML" });
  }

  try {
    const rows = await withChatLoading(ctx, "Menyegarkan daftar grup...", () => refreshGroups(accountId));
    await recordHistory(accountId, adminRow.id, {
      action: "group_refresh",
      status: "success",
      details: { scanned: rows.length }
    });

    return renderGroupPageDirect(ctx, accountId, 0, `🔎 Deteksi selesai. ${rows.length} grup/channel terbaca dan diperbarui.`);
  } catch (e) {
    return replaceUi(
      ctx,
      `❌ Scan grup gagal.\n\n${escapeHtml(safeErrorMessage(e))}`,
      new InlineKeyboard().text("◀️ Account", `account:open:${accountId}`),
      { parse_mode: "HTML" }
    );
  }
});

async function renderGroupPageDirect(ctx, accountId, page, prefix = "") {
  const result = await listGroups(accountId, page);
  const activeCountResult = await sb
    .from("account_groups")
    .select("*", { count: "exact", head: true })
    .eq("account_id", accountId)
    .eq("enabled", true)
    .eq("can_send", true);

  if (activeCountResult.error) throw activeCountResult.error;

  const account = await getAccount(accountId);
  if (!account) throw new Error("Account tidak ditemukan.");

  const text = [
    prefix,
    `👥 <b>GRUP • ${escapeHtml(account.label)}</b>`,
    `Total: <b>${result.total}</b> • Target aktif: <b>${activeCountResult.count || 0}</b>`,
    "",
    result.rows.length
      ? result.rows.map((g, i) =>
          `${g.enabled ? "✅" : "❌"} <b>${escapeHtml(g.title)}</b>`
        ).join("\n\n")
      : "<i>Belum ada grup.</i>"
  ].filter(Boolean).join("\n");

  return replaceUi(
    ctx,
    text,
    groupListKeyboard(result.rows, accountId, page, result.hasNext),
    { parse_mode: "HTML" }
  );
}

bot.callbackQuery(/^group:toggle:(\d+):(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  const groupId = String(ctx.match[1]);
  const page = Math.max(0, Number(ctx.match[2] || 0));
  const group = await sb
    .from("account_groups")
    .select("*")
    .eq("id", groupId)
    .maybeSingle();

  if (group.error || !group.data) {
    return ctx.answerCallbackQuery("Grup tidak ditemukan.", { show_alert: true });
  }

  if (!await requireAccountAccess(ctx, adminRow, String(group.data.account_id))) return;

  if (!group.data.can_send && !group.data.enabled) {
    return ctx.answerCallbackQuery(
      "Telegram menandai group ini tidak bisa menerima pesan.",
      { show_alert: true }
    );
  }

  await ctx.answerCallbackQuery().catch(() => {});

  const nextEnabled = !group.data.enabled;
  const { error } = await sb
    .from("account_groups")
    .update({ enabled: nextEnabled })
    .eq("id", groupId)
    .eq("account_id", group.data.account_id);

  if (error) {
    return ctx.answerCallbackQuery("Gagal menyimpan setting group.", { show_alert: true });
  }

  await recordHistory(group.data.account_id, adminRow.id, {
    action: nextEnabled ? "group_enable" : "group_disable",
    status: "success",
    groupId: groupId
  });

  return renderGroupPageDirect(ctx, group.data.account_id, page);
});

/* Add/select all writable groups for this account in one action. */
bot.callbackQuery(/^group:all:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  const account = await getAccount(accountId);
  if (!account) {
    return replaceUi(ctx, "❌ Account tidak ditemukan.", backDashboardKeyboard(), { parse_mode: "HTML" });
  }

  try {
    // Scan first so newly detected writable groups are included too.
    const rows = await withChatLoading(ctx, "Menambahkan semua grup...", () => refreshGroups(accountId));
    const allowed = rows.filter(x => x.can_send);

    if (allowed.length) {
      const { error } = await sb
        .from("account_groups")
        .update({ enabled: true })
        .eq("account_id", accountId)
        .eq("can_send", true);
      if (error) throw error;
    }

    await recordHistory(accountId, adminRow.id, {
      action: "group_enable_all",
      status: "success",
      details: { detected: rows.length, enabled: allowed.length }
    });

    return renderGroupPageDirect(
      ctx,
      accountId,
      0,
      `✅ <b>Semua grup ditambahkan.</b>\n\n${allowed.length} grup yang bisa menerima pesan sekarang aktif sebagai target.`
    );
  } catch (e) {
    return replaceUi(
      ctx,
      `❌ Gagal menambahkan semua grup.\n\n${escapeHtml(safeErrorMessage(e))}`,
      new InlineKeyboard().text("⬅️ Akun", `account:open:${accountId}`),
      { parse_mode: "HTML" }
    );
  }
});

bot.callbackQuery(/^group:remove:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  const groupId = String(ctx.match[1]);
  const { data: group, error: groupError } = await sb
    .from("account_groups")
    .select("*")
    .eq("id", groupId)
    .maybeSingle();

  if (groupError || !group) {
    return ctx.answerCallbackQuery("Grup tidak ditemukan.", { show_alert: true });
  }

  if (!await requireAccountAccess(ctx, adminRow, String(group.account_id))) return;

  await ctx.answerCallbackQuery().catch(() => {});

  const { error } = await sb
    .from("account_groups")
    .delete()
    .eq("id", groupId)
    .eq("account_id", group.account_id);

  if (error) {
    return ctx.answerCallbackQuery("Gagal menghapus grup.", { show_alert: true });
  }

  await recordHistory(group.account_id, adminRow.id, {
    action: "group_remove",
    status: "success",
    groupId: groupId,
    groupTitle: group.title
  });

  return renderGroupPageDirect(ctx, group.account_id, 0, `🗑 <b>${escapeHtml(group.title)}</b> dihapus dari daftar target.`);
});


/* =========================================================
   PRIVATE CHAT PROMOTION
   Uses the already-connected GramJS user account. No database/schema
   changes are required. This feature has its own runtime state so the
   existing group-promotion scheduler/session system remains untouched.
========================================================= */

function privatePromoAccountKeyboard(accounts, page, hasNext) {
  const kb = new InlineKeyboard();

  for (const account of accounts) {
    kb
      .text(
        `${accountStatusIcon(account)} ${safeButtonText(account.label, 28)}`,
        `privatepromo:account:${account.id}`
      )
      .row();
  }

  if (page > 0) kb.text("◀️", `privatepromo:accounts:${page - 1}`);
  kb.text("🏠", "menu:dashboard");
  if (hasNext) kb.text("▶️", `privatepromo:accounts:${page + 1}`);
  kb.row();

  return kb;
}

async function listConnectedPrivatePromoAccounts(page = 0, adminRow = null) {
  const offset = Math.max(0, Number(page) || 0) * PRIVATE_PROMO_PAGE_SIZE;
  let query = sb
    .from("telegram_accounts")
    .select("*")
    .eq("status", "connected")
    .order("created_at", { ascending: false })
    .range(offset, offset + PRIVATE_PROMO_PAGE_SIZE);

  if (adminRow?.role !== "OWNER") {
    query = query.eq("created_by", adminRow?.telegram_user_id);
  }

  const { data, error } = await query;
  if (error) throw error;

  let countQuery = sb
    .from("telegram_accounts")
    .select("id", { count: "exact", head: true })
    .eq("status", "connected");

  if (adminRow?.role !== "OWNER") {
    countQuery = countQuery.eq("created_by", adminRow?.telegram_user_id);
  }

  const countResult = await countQuery;
  if (countResult.error) throw countResult.error;

  const rows = (data || []).slice(0, PRIVATE_PROMO_PAGE_SIZE);
  const total = Number(countResult.count || 0);

  return {
    rows,
    total,
    page: Math.max(0, Number(page) || 0),
    hasNext: offset + PRIVATE_PROMO_PAGE_SIZE < total
  };
}

async function getPrivatePromoSourceGroups(accountId) {
  const { data, error } = await sb
    .from("account_groups")
    .select("*")
    .eq("account_id", accountId)
    .order("title", { ascending: true });

  if (error) throw error;
  return data || [];
}

function privatePromoGroupsKeyboard(rows, selectedIds, page = 0) {
  const kb = new InlineKeyboard();
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);

  for (const row of rows) {
    const id = String(row.id);
    const icon = selected.has(id) ? "☑️" : "⬜";
    kb
      .text(
        `${icon} ${safeButtonText(row.title, 30)}`,
        `privatepromo:group:${id}:${page}`
      )
      .row();
  }

  const hasPrev = page > 0;
  const hasNext = (page + 1) * PRIVATE_PROMO_PAGE_SIZE < rows._privatePromoTotal;

  if (hasPrev) kb.text("◀️", `privatepromo:groups:${page - 1}`);
  kb.text("🏠", "menu:dashboard");
  if (hasNext) kb.text("▶️", `privatepromo:groups:${page + 1}`);
  kb.row();

  kb.text("✅ Lanjut", "privatepromo:groups:continue").row();
  kb.text("🔄 Deteksi Grup", "privatepromo:groups:refresh").row();
  kb.text("❌ Batal", "privatepromo:cancel");

  return kb;
}

async function renderPrivatePromoGroups(ctx, page = 0, notice = "") {
  const userKey = String(ctx.from.id);
  const state = privatePromotionRuns.get(userKey);

  if (!state?.accountId) {
    return replaceUi(
      ctx,
      "⚠️ <b>Sesi Promosi Chat Privat tidak tersedia.</b>",
      new InlineKeyboard().text("📢 Promosi Chat Privat", "privatepromo:accounts:0").row()
        .text("🏠 Menu Utama", "menu:dashboard"),
      { parse_mode: "HTML" }
    );
  }

  const account = await getAccount(state.accountId);
  if (!account) {
    privatePromotionRuns.delete(userKey);
    return replaceUi(
      ctx,
      "❌ Akun Telegram tidak ditemukan.",
      backDashboardKeyboard(),
      { parse_mode: "HTML" }
    );
  }

  let rows = await getPrivatePromoSourceGroups(state.accountId);
  const total = rows.length;
  const maxPage = Math.max(0, Math.ceil(total / PRIVATE_PROMO_PAGE_SIZE) - 1);
  const safePage = Math.min(Math.max(0, Number(page) || 0), maxPage);
  const start = safePage * PRIVATE_PROMO_PAGE_SIZE;
  const visible = rows.slice(start, start + PRIVATE_PROMO_PAGE_SIZE);

  // Keep total attached only to this local array instance for keyboard pagination.
  visible._privatePromoTotal = total;

  const selectedCount = state.selectedGroupIds?.size || 0;
  const text = [
    notice,
    "📢 <b>PROMOSI CHAT PRIVAT</b>",
    "━━━━━━━━━━━━━━━━━━",
    `📱 Akun pengirim: <b>${escapeHtml(account.label)}</b>`,
    `👥 Grup tersedia: <b>${total}</b>`,
    `☑️ Grup dipilih: <b>${selectedCount}</b>`,
    "",
    visible.length
      ? visible.map(row => {
          const icon = state.selectedGroupIds.has(String(row.id)) ? "☑️" : "⬜";
          return `${icon} <b>${escapeHtml(row.title || "Tanpa Nama")}</b>`;
        }).join("\n")
      : "<i>Belum ada grup yang terdeteksi untuk akun ini.</i>",
    "",
    "Pilih satu atau beberapa grup sumber member, lalu tekan <b>✅ Lanjut</b>."
  ].filter(Boolean).join("\n");

  return replaceUi(
    ctx,
    text,
    privatePromoGroupsKeyboard(visible, state.selectedGroupIds, safePage),
    { parse_mode: "HTML" }
  );
}

async function resolvePrivatePromoSourceEntities(client, groupRows) {
  const wanted = new Set(
    (groupRows || []).map(row => String(row.telegram_group_id || "")).filter(Boolean)
  );
  const found = new Map();

  for await (const dialog of client.iterDialogs({})) {
    const entity = dialog?.entity;
    if (!entity) continue;

    const isGroup = Boolean(dialog.isGroup);
    const isChannel = Boolean(dialog.isChannel);
    if (!isGroup && !isChannel) continue;

    const telegramId = String(entity.id?.value ?? entity.id ?? "");
    if (telegramId && wanted.has(telegramId)) {
      found.set(telegramId, {
        entity,
        title: dialog.title || entity.title || "Tanpa Nama"
      });
    }

    if (found.size >= wanted.size) break;
  }

  return found;
}

function privatePromoUserId(user) {
  const raw = user?.id?.value ?? user?.id ?? null;
  const id = raw == null ? null : String(raw);
  return id && /^\d+$/.test(id) ? id : null;
}

function privatePromoErrorFingerprint(error) {
  const raw = String(
    error?.message ||
    error?.errorMessage ||
    error?.rpcError ||
    error ||
    ""
  ).toLowerCase();

  const code = String(
    error?.errorMessage ||
    error?.rpcError ||
    error?.code ||
    error?.constructor?.name ||
    ""
  ).toLowerCase();

  const combined = `${code} ${raw}`;
  const normalized = combined.replace(/[^a-z0-9]+/g, "_");
  const compact = normalized.replace(/_/g, "");
  return { combined, normalized, compact };
}

function privatePromoErrorCategory(error) {
  const { combined, normalized, compact } = privatePromoErrorFingerprint(error);
  const has = (...needles) => needles.some(n =>
    normalized.includes(n) || compact.includes(n.replace(/_/g, "")) || combined.includes(n.replace(/_/g, " "))
  );

  if (has(
    "user_privacy_restricted",
    "privacy_prevention",
    "user_privacy_restricted_error",
    "userprivacyrestrictederror",
    "privacyrestrictederror"
  )) return "Privasi user membatasi pesan";

  if (has(
    "user_not_mutual_contact",
    "usernotmutualcontacterror",
    "not_mutual_contact"
  )) return "Bukan mutual contact";

  if (has(
    "user_is_blocked",
    "userisblockederror",
    "user_blocked",
    "userblockederror"
  )) return "User memblokir akun";

  if (has(
    "peer_id_invalid",
    "peeridinvaliderror",
    "input_user_invalid",
    "inputuserinvaliderror",
    "user_id_invalid",
    "user_not_found"
  )) return "User tidak dapat diakses";

  if (has(
    "input_user_deactivated",
    "inputuserdeactivatederror",
    "user_deactivated",
    "userdeactivatederror",
    "user_deleted"
  )) return "Akun user sudah dihapus/nonaktif";

  if (has(
    "chat_write_forbidden",
    "chat_forbidden",
    "user_banned_in_channel",
    "recipient_is_not_a_member",
    "cannot_message",
    "you_cant_write",
    "you_cannot_write"
  )) return "Telegram tidak mengizinkan pengiriman";

  return null;
}

function isPrivatePromoExpectedSkipError(error) {
  return Boolean(privatePromoErrorCategory(error));
}

function privatePromoErrorLabel(error) {
  const raw = String(
    error?.message ||
    error?.errorMessage ||
    error?.rpcError ||
    error ||
    "Kesalahan tidak diketahui"
  ).replace(/\s+/g, " ").trim();

  const category = privatePromoErrorCategory(error);
  if (category) return category;

  if (/flood_wait|wait of\s+\d+\s*seconds?/i.test(raw)) {
    return "Telegram meminta jeda sebelum pengiriman berikutnya";
  }

  return truncateText(raw, 180);
}

function privatePromoStopKeyboard() {
  return new InlineKeyboard()
    .text("🛑 Stop Promosi", "privatepromo:stop");
}

function sleepMs(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function sleepPrivatePromoWithStop(userKey, ms) {
  let remaining = Math.max(0, Number(ms) || 0);

  while (remaining > 0) {
    const state = privatePromotionRuns.get(userKey);
    if (!state || state.stopRequested) return false;

    const step = Math.min(1000, remaining);
    await sleepMs(step);
    remaining -= step;
  }

  return true;
}

async function collectPrivatePromoTargets(client, sourceRows, userKey, onGroupProgress) {
  const entities = await resolvePrivatePromoSourceEntities(client, sourceRows);
  const targets = new Map();
  const sourceFailures = [];
  let selfId = null;

  try {
    const me = await client.getMe();
    selfId = privatePromoUserId(me);
  } catch (_) {}

  for (const row of sourceRows) {
    if (privatePromotionRuns.get(userKey)?.stopRequested) break;

    const source = entities.get(String(row.telegram_group_id || ""));
    if (!source?.entity) {
      sourceFailures.push({
        title: row.title || "Tanpa Nama",
        reason: "Akun tidak memiliki akses ke grup sumber"
      });
      continue;
    }

    try {
      let groupCount = 0;

      for await (const user of client.iterParticipants(source.entity)) {
        if (privatePromotionRuns.get(userKey)?.stopRequested) break;

        const userId = privatePromoUserId(user);
        if (!userId) continue;

        // Never target bots, deleted accounts, or the sender account itself.
        if (user?.bot === true || user?.deleted === true) continue;
        if (selfId && userId === selfId) continue;

        if (!targets.has(userId)) {
          targets.set(userId, user);
          groupCount++;
        }
      }

      if (typeof onGroupProgress === "function") {
        await onGroupProgress(row, groupCount, targets.size);
      }
    } catch (error) {
      sourceFailures.push({
        title: row.title || "Tanpa Nama",
        reason: privatePromoErrorLabel(error)
      });

      if (typeof onGroupProgress === "function") {
        await onGroupProgress(row, 0, targets.size, error);
      }
    }
  }

  return { targets, sourceFailures };
}

function bumpPrivatePromoReason(bucket, reason) {
  if (!reason) return;
  bucket[reason] = Number(bucket[reason] || 0) + 1;
}

function privatePromoReasonLines(title, bucket, limit = 5) {
  const entries = Object.entries(bucket || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
  if (!entries.length) return [];
  return [
    "",
    `📋 <b>${title}</b>`,
    ...entries.map(([reason, count]) => `• ${escapeHtml(reason)}: <b>${count}</b>`)
  ];
}

async function runPrivatePromotion(userKey, accountId, groupRows, message, adminRow) {
  const state = privatePromotionRuns.get(userKey);
  if (!state) return;

  const client = await clientFor(accountId);
  if (!client) throw new Error("Session akun Telegram tidak tersedia atau sudah tidak terhubung.");

  const groupTitles = groupRows.map(x => x.title || "Tanpa Nama");
  state.running = true;
  state.stopRequested = false;
  state.startedAt = Date.now();
  state.stats = {
    total: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    skipReasons: {},
    failureReasons: {}
  };
  state.sourceFailures = [];

  await renderUi(
    userKey,
    [
      "📢 <b>Promosi Chat Privat</b>",
      "",
      "⏳ Mengambil member dari grup sumber...",
      `👥 Grup sumber: <b>${groupRows.length}</b>`,
      `📚 ${escapeHtml(groupTitles.join(", "))}`,
      "",
      "Tunggu sampai daftar target selesai dikumpulkan."
    ].join("\n"),
    privatePromoStopKeyboard(),
    { parse_mode: "HTML" }
  );

  const collected = await collectPrivatePromoTargets(
    client,
    groupRows,
    userKey,
    async (row, added, total) => {
      await renderUi(
        userKey,
        [
          "📢 <b>Promosi Chat Privat</b>",
          "",
          `📚 Membaca: <b>${escapeHtml(row.title || "Tanpa Nama")}</b>`,
          `👥 Target unik sementara: <b>${total}</b>`,
          `➕ Member baru dari grup ini: <b>${added}</b>`,
          "",
          "⏳ Pengumpulan target masih berjalan..."
        ].join("\n"),
        privatePromoStopKeyboard(),
        { parse_mode: "HTML" }
      ).catch(() => {});
    }
  );

  state.sourceFailures = collected.sourceFailures;
  const targets = Array.from(collected.targets.entries());
  state.stats.total = targets.length;

  if (state.stopRequested) {
    state.running = false;
    return renderPrivatePromoFinished(userKey, accountId, groupTitles, adminRow, true);
  }

  if (!targets.length) {
    state.running = false;
    return renderPrivatePromoFinished(userKey, accountId, groupTitles, adminRow, false);
  }

  await renderUi(
    userKey,
    [
      "📢 <b>Promosi Chat Privat</b>",
      "",
      `👥 Target: <b>0/${targets.length}</b>`,
      "✅ Berhasil: <b>0</b>",
      "❌ Gagal: <b>0</b>",
      "⏭️ Skip: <b>0</b>",
      "",
      "▶️ Pengiriman dimulai..."
    ].join("\n"),
    privatePromoStopKeyboard(),
    { parse_mode: "HTML" }
  );

  for (let index = 0; index < targets.length; index++) {
    const currentState = privatePromotionRuns.get(userKey);
    if (!currentState || currentState.stopRequested) break;

    const [, user] = targets[index];
    const targetNumber = index + 1;

    try {
      await client.sendMessage(user, { message: cleanText(message) });
      state.stats.success++;
    } catch (error) {
      const floodWaitMs = extractFloodWaitMs(error);

      if (floodWaitMs > 0) {
        if (floodWaitMs > PRIVATE_PROMO_MAX_FLOOD_WAIT_MS) {
          state.sourceFailures.push({
            title: "Telegram rate limit",
            reason: `Pengiriman dihentikan. Telegram meminta menunggu ${Math.ceil(floodWaitMs / 1000)} detik.`
          });
          state.stopRequested = true;
          break;
        }

        await renderUi(
          userKey,
          [
            "📢 <b>Promosi Chat Privat</b>",
            "",
            `👤 Target: <b>${targetNumber}/${targets.length}</b>`,
            `✅ Berhasil: <b>${state.stats.success}</b>`,
            `❌ Gagal: <b>${state.stats.failed}</b>`,
            `⏭️ Skip: <b>${state.stats.skipped}</b>`,
            "",
            `⏸️ Telegram meminta tunggu <b>${Math.ceil(floodWaitMs / 1000)} detik</b>.`,
            "Mengikuti batas Telegram dan tidak mencoba melewatinya."
          ].join("\n"),
          privatePromoStopKeyboard(),
          { parse_mode: "HTML" }
        ).catch(() => {});

        const waited = await sleepPrivatePromoWithStop(userKey, floodWaitMs);
        if (!waited) break;

        // Retry this same target once after the exact Telegram wait.
        try {
          await client.sendMessage(user, { message: cleanText(message) });
          state.stats.success++;
        } catch (retryError) {
          if (extractFloodWaitMs(retryError) > 0) {
            state.sourceFailures.push({
              title: "Telegram rate limit",
              reason: "Pengiriman dihentikan karena Telegram kembali memberikan rate limit."
            });
            state.stopRequested = true;
            break;
          }

          const retryCategory = privatePromoErrorCategory(retryError);
          if (retryCategory) {
            state.stats.skipped++;
            bumpPrivatePromoReason(state.stats.skipReasons, retryCategory);
          } else {
            state.stats.failed++;
            bumpPrivatePromoReason(
              state.stats.failureReasons,
              privatePromoErrorLabel(retryError)
            );
          }
        }
      } else {
        const category = privatePromoErrorCategory(error);
        if (category) {
          state.stats.skipped++;
          bumpPrivatePromoReason(state.stats.skipReasons, category);
        } else {
          state.stats.failed++;
          bumpPrivatePromoReason(
            state.stats.failureReasons,
            privatePromoErrorLabel(error)
          );
        }
      }
    }

    const after = privatePromotionRuns.get(userKey);
    if (!after || after.stopRequested) break;

    await renderUi(
      userKey,
      [
        "📢 <b>Promosi Chat Privat</b>",
        "",
        `👤 Target: <b>${targetNumber}/${targets.length}</b>`,
        `✅ Berhasil: <b>${state.stats.success}</b>`,
        `❌ Gagal: <b>${state.stats.failed}</b>`,
        `⏭️ Skip: <b>${state.stats.skipped}</b>`,
        "",
        `📚 Grup sumber: <b>${groupRows.length}</b>`
      ].join("\n"),
      privatePromoStopKeyboard(),
      { parse_mode: "HTML" }
    ).catch(() => {});

    // Deliberate, modest pacing between targets. This is not intended to
    // bypass Telegram anti-spam controls.
    if (targetNumber < targets.length) {
      const continued = await sleepPrivatePromoWithStop(userKey, PRIVATE_PROMO_DELAY_MS);
      if (!continued) break;
    }
  }

  state.running = false;
  return renderPrivatePromoFinished(
    userKey,
    accountId,
    groupTitles,
    adminRow,
    Boolean(state.stopRequested)
  );
}

async function renderPrivatePromoFinished(userKey, accountId, groupTitles, adminRow, stopped) {
  const state = privatePromotionRuns.get(userKey);
  if (!state) return;

  const stats = state.stats || {
    total: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    skipReasons: {},
    failureReasons: {}
  };
  const sourceFailures = Array.isArray(state.sourceFailures) ? state.sourceFailures : [];

  const lines = [
    stopped ? "🛑 <b>PROMOSI CHAT PRIVAT DIHENTIKAN</b>" : "📊 <b>PROMOSI CHAT PRIVAT SELESAI</b>",
    "",
    `👥 Total Target: <b>${stats.total}</b>`,
    `✅ Berhasil: <b>${stats.success}</b>`,
    `❌ Gagal: <b>${stats.failed}</b>`,
    `⏭️ Skip: <b>${stats.skipped}</b>`,
    "",
    `📚 Grup sumber: <b>${groupTitles.length}</b>`,
    groupTitles.length
      ? groupTitles.map(title => `• ${escapeHtml(title)}`).join("\n")
      : "• -"
  ];

  lines.push(...privatePromoReasonLines("Alasan Skip", stats.skipReasons));
  lines.push(...privatePromoReasonLines("Alasan Gagal", stats.failureReasons));

  if (sourceFailures.length) {
    lines.push(
      "",
      `⚠️ <b>Catatan sumber/rate limit:</b> ${sourceFailures.length}`,
      ...sourceFailures.slice(0, 5).map(item =>
        `• ${escapeHtml(item.title)} — ${escapeHtml(item.reason)}`
      )
    );
  }

  await renderUi(
    userKey,
    lines.join("\n"),
    new InlineKeyboard()
      .text("📢 Promosi Lagi", "privatepromo:accounts:0")
      .row()
      .text("🏠 Menu Utama", "menu:dashboard"),
    { parse_mode: "HTML" }
  );

  try {
    if (accountId && adminRow?.id) {
      await recordHistory(accountId, adminRow.id, {
        action: "private_promotion",
        status: stopped ? "stopped" : "success",
        details: {
          total_target: stats.total,
          success: stats.success,
          failed: stats.failed,
          skipped: stats.skipped,
          skip_reasons: stats.skipReasons || {},
          failure_reasons: stats.failureReasons || {},
          source_groups: groupTitles
        }
      });
    }
  } catch (error) {
    console.warn("PRIVATE PROMOTION HISTORY:", safeErrorMessage(error, 300));
  }

  // Keep the completed result available briefly for the stop/status callbacks,
  // then remove it without touching any account/session data.
  setTimeout(() => {
    const current = privatePromotionRuns.get(userKey);
    if (current && !current.running) privatePromotionRuns.delete(userKey);
  }, 10 * 60 * 1000);
}

/* -------------------------
   PRIVATE PROMOTION MENU
-------------------------- */

bot.callbackQuery(/^privatepromo:accounts:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;
  if (!await requirePrivatePromotionAccess(ctx, adminRow)) return;


  await ctx.answerCallbackQuery().catch(() => {});
  const page = Math.max(0, Number(ctx.match[1] || 0));

  try {
    const result = await listConnectedPrivatePromoAccounts(page, adminRow);
    const lines = [
      "📢 <b>PROMOSI CHAT PRIVAT</b>",
      "━━━━━━━━━━━━━━━━━━",
      "Pilih akun Telegram yang sudah terhubung. Pesan privat akan dikirim oleh <b>akun Telegram tersebut</b>, bukan bot.",
      "",
      `📱 Akun terhubung: <b>${result.total}</b>`,
      result.rows.length
        ? result.rows.map((account, i) =>
            `${String(page * PRIVATE_PROMO_PAGE_SIZE + i + 1).padStart(2, "0")}. ${accountStatusIcon(account)} <b>${escapeHtml(account.label)}</b>\n   🆔 <code>${escapeHtml(account.telegram_user_id || "-")}</code>`
          ).join("\n\n")
        : "<i>Belum ada akun Telegram yang terhubung.</i>"
    ].join("\n");

    return replaceUi(
      ctx,
      lines,
      privatePromoAccountKeyboard(result.rows, result.page, result.hasNext),
      { parse_mode: "HTML" }
    );
  } catch (error) {
    return replaceUi(
      ctx,
      `❌ Gagal mengambil akun terhubung.\n\n${escapeHtml(safeErrorMessage(error))}`,
      backDashboardKeyboard(),
      { parse_mode: "HTML" }
    );
  }
});

bot.callbackQuery(/^privatepromo:account:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;
  if (!await requirePrivatePromotionAccess(ctx, adminRow)) return;


  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  const account = await getAccountForAdmin(accountId, adminRow);

  if (!account) {
    return replaceUi(
      ctx,
      "❌ Akun Telegram tidak ditemukan atau bukan milik admin ini.",
      new InlineKeyboard().text("⬅️ Akun", "privatepromo:accounts:0").row()
        .text("🏠 Menu Utama", "menu:dashboard"),
      { parse_mode: "HTML" }
    );
  }

  if (account.status !== "connected") {
    return replaceUi(
      ctx,
      "⚠️ <b>Akun belum terhubung.</b>\n\nPilih akun Telegram yang statusnya terhubung.",
      new InlineKeyboard().text("📱 Pilih Akun", "privatepromo:accounts:0"),
      { parse_mode: "HTML" }
    );
  }

  const client = await clientFor(accountId);
  if (!client) {
    return replaceUi(
      ctx,
      "❌ Session akun Telegram tidak dapat digunakan. Hubungkan kembali akun tersebut dari menu Akun Telegram.",
      new InlineKeyboard().text("📱 Pilih Akun", "privatepromo:accounts:0").row()
        .text("🏠 Menu Utama", "menu:dashboard"),
      { parse_mode: "HTML" }
    );
  }

  privatePromotionRuns.set(String(ctx.from.id), {
    accountId,
    adminId: adminRow.id,
    selectedGroupIds: new Set(),
    running: false,
    stopRequested: false,
    stats: { total: 0, success: 0, failed: 0, skipped: 0 },
    sourceFailures: []
  });

  return renderPrivatePromoGroups(ctx, 0);
});

bot.callbackQuery(/^privatepromo:group:(\d+):(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;
  if (!await requirePrivatePromotionAccess(ctx, adminRow)) return;


  const userKey = String(ctx.from.id);
  const state = privatePromotionRuns.get(userKey);
  if (!state || state.running) {
    return ctx.answerCallbackQuery(
      state?.running ? "Promosi sedang berjalan." : "Sesi promosi sudah tidak aktif.",
      { show_alert: true }
    );
  }

  const groupId = String(ctx.match[1]);
  const page = Math.max(0, Number(ctx.match[2] || 0));
  const { data: group, error } = await sb
    .from("account_groups")
    .select("*")
    .eq("id", groupId)
    .eq("account_id", state.accountId)
    .maybeSingle();

  if (error || !group) {
    return ctx.answerCallbackQuery("Grup tidak ditemukan.", { show_alert: true });
  }

  if (!await requireAccountAccess(ctx, adminRow, state.accountId)) return;

  if (!state.selectedGroupIds) state.selectedGroupIds = new Set();
  if (state.selectedGroupIds.has(groupId)) state.selectedGroupIds.delete(groupId);
  else state.selectedGroupIds.add(groupId);

  await ctx.answerCallbackQuery().catch(() => {});
  return renderPrivatePromoGroups(ctx, page);
});

bot.callbackQuery(/^privatepromo:groups:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;
  if (!await requirePrivatePromotionAccess(ctx, adminRow)) return;


  const state = privatePromotionRuns.get(String(ctx.from.id));
  if (!state || state.running) {
    return ctx.answerCallbackQuery("Sesi promosi tidak aktif.", { show_alert: true });
  }

  if (!await requireAccountAccess(ctx, adminRow, state.accountId)) return;
  await ctx.answerCallbackQuery().catch(() => {});
  return renderPrivatePromoGroups(ctx, Math.max(0, Number(ctx.match[1] || 0)));
});

bot.callbackQuery("privatepromo:groups:continue", async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;
  if (!await requirePrivatePromotionAccess(ctx, adminRow)) return;


  const userKey = String(ctx.from.id);
  const state = privatePromotionRuns.get(userKey);
  if (!state || state.running) {
    return ctx.answerCallbackQuery("Sesi promosi tidak aktif.", { show_alert: true });
  }

  if (!await requireAccountAccess(ctx, adminRow, state.accountId)) return;

  const selectedIds = Array.from(state.selectedGroupIds || []);
  if (!selectedIds.length) {
    return ctx.answerCallbackQuery("Pilih minimal satu grup sumber.", { show_alert: true });
  }

  state.stage = "message";
  state.selectedGroupIds = new Set(selectedIds);
  flows.set(userKey, {
    t: "private_promo_message",
    accountId: state.accountId,
    adminId: adminRow.id
  });
  await ctx.answerCallbackQuery().catch(() => {});

  return replaceUi(
    ctx,
    [
      "📢 <b>PROMOSI CHAT PRIVAT</b>",
      "",
      `☑️ Grup sumber dipilih: <b>${selectedIds.length}</b>`,
      "",
      "Kirim <b>pesan promosi</b> yang akan dikirim ke target.",
      "",
      "Setelah pesan diterima, sistem akan mengambil member dari grup yang dipilih, deduplicate berdasarkan Telegram user ID, lalu memproses target satu per satu.",
      "",
      "⚠️ Pengiriman tetap mengikuti pembatasan dan rate limit Telegram."
    ].join("\n"),
    new InlineKeyboard().text("❌ Batal", "privatepromo:cancel"),
    { parse_mode: "HTML" }
  );
});

bot.callbackQuery("privatepromo:groups:refresh", async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;
  if (!await requirePrivatePromotionAccess(ctx, adminRow)) return;


  const state = privatePromotionRuns.get(String(ctx.from.id));
  if (!state || state.running) {
    return ctx.answerCallbackQuery("Sesi promosi tidak aktif.", { show_alert: true });
  }

  if (!await requireAccountAccess(ctx, adminRow, state.accountId)) return;
  await ctx.answerCallbackQuery().catch(() => {});

  try {
    await withChatLoading(ctx, "Mendeteksi grup...", () => refreshGroups(state.accountId));
    return renderPrivatePromoGroups(ctx, 0, "✅ Daftar grup berhasil diperbarui.");
  } catch (error) {
    return renderPrivatePromoGroups(
      ctx,
      0,
      `⚠️ Deteksi ulang gagal: ${escapeHtml(safeErrorMessage(error, 300))}`
    );
  }
});

bot.callbackQuery("privatepromo:stop", async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;
  if (!await requirePrivatePromotionAccess(ctx, adminRow)) return;


  const userKey = String(ctx.from.id);
  const state = privatePromotionRuns.get(userKey);
  if (!state) {
    return ctx.answerCallbackQuery("Tidak ada promosi yang sedang berjalan.", { show_alert: true });
  }

  await ctx.answerCallbackQuery("Permintaan stop diterima. Target yang sedang diproses akan diselesaikan jika memungkinkan.").catch(() => {});
  state.stopRequested = true;

  if (!state.running) {
    return renderPrivatePromoFinished(
      userKey,
      state.accountId,
      [],
      adminRow,
      true
    );
  }

  return renderUi(
    userKey,
    [
      "🛑 <b>STOP PROMOSI</b>",
      "",
      "Permintaan penghentian sudah diterima.",
      "Proses akan berhenti dengan aman pada titik berikutnya."
    ].join("\n"),
    new InlineKeyboard(),
    { parse_mode: "HTML" }
  );
});

bot.callbackQuery("privatepromo:cancel", async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;
  if (!await requirePrivatePromotionAccess(ctx, adminRow)) return;


  const userKey = String(ctx.from.id);
  const state = privatePromotionRuns.get(userKey);

  if (state?.running) {
    state.stopRequested = true;
    return ctx.answerCallbackQuery(
      "Promosi sedang berjalan. Gunakan Stop Promosi untuk menghentikannya.",
      { show_alert: true }
    );
  }

  privatePromotionRuns.delete(userKey);
  flows.delete(userKey);
  await ctx.answerCallbackQuery("Dibatalkan").catch(() => {});

  return replaceUi(
    ctx,
    "🏠 <b>Menu utama</b>",
    adminRow.role === "OWNER" ? ownerDashboardMenu() : adminDashboardMenu(adminRow),
    { parse_mode: "HTML" }
  );
});

/* =========================================================
   HISTORY
========================================================= */

bot.callbackQuery(/^history:list:(\d+):(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  const page = Number(ctx.match[2]);

  try {
    return await renderHistory(ctx, accountId, Math.max(0, page));
  } catch (e) {
    return replaceUi(
      ctx,
      `❌ Gagal mengambil riwayat.\n\n${escapeHtml(safeErrorMessage(e))}`,
      new InlineKeyboard().text("◀️ Account", `account:open:${accountId}`),
      { parse_mode: "HTML" }
    );
  }
});

/* =========================================================
   ADMIN MANAGEMENT - OWNER ONLY
========================================================= */

bot.callbackQuery(/^admin:list:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  if (!["OWNER", "ADMIN_VIP", "ADMIN_PREMIUM"].includes(adminRow.role)) {
    return ctx.answerCallbackQuery("Admin biasa tidak memiliki akses ke menu admin.", { show_alert: true });
  }

  await ctx.answerCallbackQuery().catch(() => {});
  const page = Math.max(0, Number(ctx.match[1]));

  try {
    const result = await listAdmins(page, adminRow);
    const title = "DAFTAR ADMIN";
    const lines = [
      `👥 <b>${title}</b>`,
      `Total terlihat: <b>${result.total}</b>`,
      `Halaman: <b>${page + 1}</b>`,
      "",
      result.rows.length
        ? result.rows.map((a, i) => {
            const icon = a.role === "OWNER" ? "👑" : a.role === "ADMIN_PREMIUM" ? "💎" : a.role === "ADMIN_VIP" ? "⭐" : "👤";
            return `${String(page * ADMIN_PAGE_SIZE + i + 1).padStart(2, "0")}. ${icon} <b>${escapeHtml(displayAdminRole(a.role))}</b>\n   🆔 <code>${escapeHtml(a.telegram_user_id)}</code>`;
          }).join("\n\n")
        : "<i>Belum ada admin yang dapat dilihat.</i>",
      "",
      adminRow.role === "OWNER"
        ? "OWNER dapat menambah Admin Biasa, Admin VIP, atau Admin Premium."
        : adminRow.role === "ADMIN_VIP"
          ? "Admin VIP dapat mengelola maksimal 20 Admin miliknya sendiri."
          : "Admin Premium dapat mengelola Admin miliknya sendiri tanpa batas."
    ].join("\n");

    return replaceUi(ctx, lines, adminListKeyboard(result.rows, page, result.hasNext, adminRow), { parse_mode: "HTML" });
  } catch (e) {
    return replaceUi(ctx, `❌ Gagal mengambil daftar admin.\n\n${escapeHtml(safeErrorMessage(e))}`, backDashboardKeyboard(), { parse_mode: "HTML" });
  }
});

bot.callbackQuery("admin:add", async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});

  if (adminRow.role === "OWNER") {
    return replaceUi(
      ctx,
      "➕ <b>TAMBAH ADMIN</b>\n\nPilih jenis admin yang akan disetujui:",
      new InlineKeyboard()
        .text("👤 Admin Biasa", "admin:add:basic")
        .text("⭐ Admin VIP", "admin:add:vip")
        .row()
        .text("💎 Admin Premium", "admin:add:premium")
        .row()
        .text("⬅️ Admin", "admin:list:0"),
      { parse_mode: "HTML" }
    );
  }

  if (!["ADMIN_VIP", "ADMIN_PREMIUM"].includes(adminRow.role)) {
    return ctx.answerCallbackQuery("Admin biasa tidak dapat menambah admin.", { show_alert: true });
  }

  const countResult = await sb.from("admins").select("id", { count: "exact", head: true })
    .eq("parent_admin_id", adminRow.id).eq("active", true);
  if (countResult.error) throw countResult.error;
  if (adminRow.role === "ADMIN_VIP" && Number(countResult.count || 0) >= 20) {
    return replaceUi(ctx, "⚠️ <b>Batas Admin VIP tercapai.</b>\n\nAdmin VIP maksimal memiliki 20 Admin aktif.", new InlineKeyboard().text("⬅️ Admin", "admin:list:0"), { parse_mode: "HTML" });
  }

  flows.set(String(ctx.from.id), { t: "admin_add", adminId: adminRow.id, adminRole: "ADMIN_ANAK" });
  return replaceUi(ctx, "➕ <b>TAMBAH ADMIN</b>\n\nKirim Telegram user ID Admin yang ingin kamu setujui.\n\nAdmin ini hanya akan terlihat dan dikelola oleh kamu.", cancelKeyboard(false), { parse_mode: "HTML" });
});

bot.callbackQuery("admin:add:vip", async ctx => {
  const owner = await requireAdmin(ctx, { ownerOnly: true });
  if (!owner) return;
  await ctx.answerCallbackQuery().catch(() => {});
  flows.set(String(ctx.from.id), { t: "admin_add", adminId: owner.id, adminRole: "ADMIN_VIP" });
  return replaceUi(ctx, "⭐ <b>TAMBAH ADMIN VIP</b>\n\nKirim Telegram user ID Admin VIP yang ingin kamu setujui.", cancelKeyboard(true), { parse_mode: "HTML" });
});

bot.callbackQuery("admin:add:premium", async ctx => {
  const owner = await requireAdmin(ctx, { ownerOnly: true });
  if (!owner) return;
  await ctx.answerCallbackQuery().catch(() => {});
  flows.set(String(ctx.from.id), { t: "admin_add", adminId: owner.id, adminRole: "ADMIN_PREMIUM" });
  return replaceUi(ctx, "💎 <b>TAMBAH ADMIN PREMIUM</b>\n\nKirim Telegram user ID Admin Premium yang ingin kamu setujui.", cancelKeyboard(true), { parse_mode: "HTML" });
});

bot.callbackQuery("admin:add:basic", async ctx => {
  const owner = await requireAdmin(ctx, { ownerOnly: true });
  if (!owner) return;
  await ctx.answerCallbackQuery().catch(() => {});
  flows.set(String(ctx.from.id), {
    t: "admin_add",
    adminId: owner.id,
    adminRole: "ADMIN_ANAK"
  });
  return replaceUi(
    ctx,
    "👤 <b>TAMBAH ADMIN BIASA</b>\n\nKirim Telegram user ID Admin Biasa yang ingin kamu setujui.\n\nAdmin Biasa hanya dapat menggunakan promosi biasa dan tidak memiliki akses ke menu Admin atau Promosi Chat Privat.",
    cancelKeyboard(true),
    { parse_mode: "HTML" }
  );
});

async function activateAdminFromDuration(ctx, days) {
  const owner = await requireAdmin(ctx);
  if (!owner) return;
  const userKey = String(ctx.from.id);
  const flow = flows.get(userKey);
  if (!flow || flow.t !== "admin_add_duration") {
    return ctx.answerCallbackQuery("Sesi tambah admin sudah tidak aktif.", { show_alert: true });
  }

  const role = flow.adminRole;
  const targetId = Number(flow.targetId);
  if (!targetId || !["ADMIN_ANAK", "ADMIN_VIP", "ADMIN_PREMIUM"].includes(role)) {
    flows.delete(userKey);
    return ctx.answerCallbackQuery("Data admin tidak valid.", { show_alert: true });
  }
  if (owner.role !== "OWNER" && role !== "ADMIN_ANAK") {
    flows.delete(userKey);
    return ctx.answerCallbackQuery("Admin VIP/Premium hanya dapat menambah Admin Biasa.", { show_alert: true });
  }
  if (owner.role === "ADMIN_VIP") {
    const countResult = await sb.from("admins").select("id", { count: "exact", head: true }).eq("parent_admin_id", owner.id).eq("active", true);
    if (countResult.error) throw countResult.error;
    const existing = await sb.from("admins").select("id,role,active").eq("telegram_user_id", targetId).maybeSingle();
    if (existing.error) throw existing.error;
    const alreadyChild = existing.data?.active && String(existing.data.parent_admin_id || "") === String(owner.id);
    if (!alreadyChild && Number(countResult.count || 0) >= 20) {
      flows.delete(userKey);
      return replaceUi(ctx, "⚠️ <b>Batas Admin VIP tercapai.</b>\n\nAdmin VIP maksimal memiliki 20 Admin aktif.", new InlineKeyboard().text("⬅️ Admin", "admin:list:0"), { parse_mode: "HTML" });
    }
  }

  const existing = await sb.from("admins").select("*").eq("telegram_user_id", targetId).maybeSingle();
  if (existing.error) throw existing.error;
  const expiresAt = new Date(Date.now() + Number(days) * 24 * 60 * 60 * 1000).toISOString();
  const parentId = role === "ADMIN_ANAK" && ["ADMIN_VIP", "ADMIN_PREMIUM"].includes(owner.role) ? owner.id : null;

  let adminData;
  if (existing.data) {
    const updated = await sb.from("admins").update({ role, active: true, parent_admin_id: parentId, updated_at: new Date().toISOString() }).eq("id", existing.data.id).select("*").single();
    if (updated.error) throw updated.error;
    adminData = updated.data;
  } else {
    const inserted = await sb.from("admins").insert({ telegram_user_id: targetId, role, active: true, parent_admin_id: parentId }).select("*").single();
    if (inserted.error) throw inserted.error;
    adminData = inserted.data;
  }

  try {
    await saveUserSubscription({
      telegram_user_id: targetId,
      role,
      active: true,
      expires_at: expiresAt,
      parent_admin_id: parentId,
      activated_by: owner.telegram_user_id
    });
  } catch (error) {
    // Roll back the admin activation if the subscription table is unavailable so
    // an account never receives a role that cannot be expiry-checked.
    try { await sb.from("admins").update({ active: false, updated_at: new Date().toISOString() }).eq("id", adminData.id); } catch (_) {}
    throw new Error("Tabel masa aktif belum tersedia. Jalankan SQL bot_subscriptions.sql terlebih dahulu.");
  }

  flows.delete(userKey);
  if (ctx.callbackQuery) await ctx.answerCallbackQuery("Masa aktif berhasil disimpan.").catch(() => {});
  return replaceUi(
    ctx,
    `✅ <b>${escapeHtml(displayAdminRole(role))} AKTIF</b>\n\nTelegram ID: <code>${targetId}</code>\nMasa aktif: <b>${days} hari</b>\nBerakhir: <b>${escapeHtml(formatDate(expiresAt))}</b>\n\nAkses otomatis ditolak setelah masa aktif habis.`,
    new InlineKeyboard().text("👥 Daftar Admin", "admin:list:0").row().text("🏠 Dashboard", "menu:dashboard"),
    { parse_mode: "HTML" }
  );
}

bot.callbackQuery(/^admin:duration:(7|30|90|180|365)$/, async ctx => {
  try { return await activateAdminFromDuration(ctx, Number(ctx.match[1])); }
  catch (error) {
    return replaceUi(ctx, `❌ Gagal mengatur masa aktif.\n\n${escapeHtml(safeErrorMessage(error, 500))}`, new InlineKeyboard().text("👥 Admin", "admin:list:0"), { parse_mode: "HTML" });
  }
});

bot.callbackQuery("admin:duration:custom", async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;
  const flow = flows.get(String(ctx.from.id));
  if (!flow || flow.t !== "admin_add_duration") return ctx.answerCallbackQuery("Sesi sudah tidak aktif.", { show_alert: true });
  await ctx.answerCallbackQuery().catch(() => {});
  flows.set(String(ctx.from.id), { ...flow, t: "admin_duration_custom" });
  return replaceUi(ctx, "✏️ <b>ATUR MASA AKTIF</b>\n\nKirim jumlah hari berupa angka.\nContoh: <code>30</code> = 30 hari, <code>60</code> = 60 hari.", cancelKeyboard(adminRow.role === "OWNER"), { parse_mode: "HTML" });
});

bot.callbackQuery("admin:delete", async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;
  if (!["OWNER", "ADMIN_VIP", "ADMIN_PREMIUM"].includes(adminRow.role)) {
    return ctx.answerCallbackQuery("Admin biasa tidak dapat memutus admin.", { show_alert: true });
  }
  await ctx.answerCallbackQuery().catch(() => {});
  flows.set(String(ctx.from.id), { t: "admin_delete", adminId: adminRow.id });
  return replaceUi(ctx,
    adminRow.role === "OWNER"
      ? "❌ <b>PUTUS ADMIN</b>\n\nKirim Telegram user ID Admin VIP atau Admin Premium yang akan diputus."
      : "❌ <b>PUTUS ADMIN</b>\n\nKirim Telegram user ID Admin yang kamu setujui sebelumnya.",
    cancelKeyboard(adminRow.role === "OWNER"), { parse_mode: "HTML" });
});

bot.callbackQuery(/^admin:view:(\d+)$/, async ctx => {
  const viewer = await requireAdmin(ctx);
  if (!viewer) return;
  if (!["OWNER", "ADMIN_VIP", "ADMIN_PREMIUM"].includes(viewer.role)) return;
  await ctx.answerCallbackQuery().catch(() => {});
  const adminId = Number(ctx.match[1]);

  const { data, error } = await sb.from("admins").select("*").eq("id", adminId).eq("active", true).maybeSingle();
  if (error || !data) return replaceUi(ctx, "❌ Admin tidak ditemukan.", new InlineKeyboard().text("◀️ Admin", "admin:list:0"), { parse_mode: "HTML" });

  const visible = viewer.role === "OWNER" || data.id === viewer.id || (data.parent_admin_id && data.parent_admin_id === viewer.id);
  if (!visible) return ctx.answerCallbackQuery("Admin ini bukan bagian dari hierarki kamu.", { show_alert: true });

  const icon = data.role === "OWNER" ? "👑" : data.role === "ADMIN_PREMIUM" ? "💎" : data.role === "ADMIN_VIP" ? "⭐" : "👤";
  const parentText = data.parent_admin_id ? `<code>${escapeHtml(data.parent_admin_id)}</code>` : "-";
  return replaceUi(ctx,
    `${icon} <b>DETAIL ADMIN</b>\n\nRole: <b>${escapeHtml(displayAdminRole(data.role))}</b>\nTelegram ID: <code>${escapeHtml(data.telegram_user_id)}</code>\nUsername: ${escapeHtml(data.username ? `@${data.username}` : "-")}\nStatus: <b>${data.active ? "active" : "disabled"}</b>\nParent Admin: ${parentText}`,
    new InlineKeyboard().text("◀️ Admin", "admin:list:0").text("🏠", "menu:dashboard"), { parse_mode: "HTML" });
});

/* =========================================================
   CANCEL FLOW
========================================================= */

bot.callbackQuery("flow:cancel", async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery("Dibatalkan").catch(() => {});
  const userKey = String(ctx.from.id);
  const run = loginRuns.get(userKey);
  if (run) {
    run.cancelled = true;
    // Stop the spinner first so no late frame overwrites the menu below.
    await stopLoading(run.loader);
  }

  const waiter = waiters.get(userKey);
  if (waiter) waiter.reject(new Error("Login dibatalkan."));
  flows.delete(userKey);

  // Abort the local connection for an active login only. A stored/connected
  // account client is not touched because it is not placed in loginRuns.
  if (run && !waiter) {
    try { await run.client.disconnect(); } catch (_) {}
  }

  return replaceUi(
    ctx,
    "🏠 <b>Menu utama</b>\n\nSemua input yang sedang berjalan dibatalkan.",
    adminRow.role === "OWNER" ? ownerDashboardMenu() : adminDashboardMenu(),
    { parse_mode: "HTML" }
  );
});

bot.callbackQuery("admin:cancel", async ctx => {
  const owner = await requireAdmin(ctx, { ownerOnly: true });
  if (!owner) return;

  await ctx.answerCallbackQuery("Dibatalkan").catch(() => {});
  flows.delete(String(ctx.from.id));
  return replaceUi(
    ctx,
    "🏠 <b>Dashboard Admin</b>",
    ownerDashboardMenu(),
    { parse_mode: "HTML" }
  );
});

/* =========================================================
   MESSAGE FLOW HANDLER
========================================================= */

bot.on("message", async (ctx, next) => {
  const telegramUserId = ctx.from?.id;
  if (!telegramUserId) return next();

  // Biarkan command handler seperti /start memproses command lebih dulu.
  if (ctx.message?.text?.trim().startsWith("/start")) {
    return next();
  }

  const adminRow = await getAdminByTelegramId(telegramUserId).catch(() => null);
  if (!adminRow) return next();

  const userKey = String(telegramUserId);
  const waiter = waiters.get(userKey);
  const flow = flows.get(userKey);

  // OTP / 2FA password
  if (waiter && ["code", "password"].includes(waiter.type)) {
    const expectedFlowType = waiter.type === "code" ? "login_code" : "login_password";

    if (
      flow?.t !== expectedFlowType ||
      (waiter.accountId != null && String(flow.accountId) !== String(waiter.accountId))
    ) {
      waiter.reject(new Error("Sesi input login sudah tidak aktif."));
      return next();
    }

    if (!ctx.message.text) {
      return renderUi(
        telegramUserId,
        "❌ Input ini harus berupa teks.",
        cancelKeyboard(false),
        { parse_mode: "HTML" }
      );
    }

    // OTP may be written with separators (1-2-3-4-5); only digits are used.
    const parsedCode = waiter.type === "code"
      ? parseLoginCode(ctx.message.text)
      : null;
    const text = waiter.type === "code"
      ? parsedCode.code
      : ctx.message.text.trim();

    if (waiter.type === "code" && !parsedCode.ok) {
      try {
        await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
      } catch (_) {}

      return renderUi(
        telegramUserId,
        `❌ ${escapeHtml(parsedCode.error)}\n\n🔑 <b>Kirim ulang kode OTP di chat ini.</b>\n💡 <i>Contoh penulisan: 1-2-3-4-5</i>`,
        cancelKeyboard(false),
        { parse_mode: "HTML" }
      );
    }

    if (!text) {
      return renderUi(
        telegramUserId,
        "❌ Password 2FA tidak boleh kosong.",
        cancelKeyboard(false),
        { parse_mode: "HTML" }
      );
    }

    // Try to reduce exposure of OTP/password in the admin chat.
    try {
      await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
    } catch (_) {}

    waiter.resolve(text);
    return;
  }

  if (!flow) return next();

  try {
    if (flow.accountId && !["account_phone", "account_phone_new"].includes(flow.t)) {
      const owned = await getAccountForAdmin(flow.accountId, adminRow);
      if (!owned) {
        flows.delete(userKey);
        return renderUi(telegramUserId, "⛔ Akun tersebut bukan milik admin ini.", backDashboardKeyboard(), { parse_mode: "HTML" });
      }
    }

    /* -------------------------
       ADD ACCOUNT: PHONE
    -------------------------- */
    if (flow.t === "account_phone_new") {
      if (!ctx.message.text) {
        return renderUi(
          telegramUserId,
          "❌ Nomor Telegram harus berupa teks.",
          cancelKeyboard(false)
        );
      }

      const phone = normalizePhone(ctx.message.text);
      if (!phone) {
        return renderUi(
          telegramUserId,
          "❌ Nomor tidak valid. Gunakan format internasional, contoh <code>+628123456789</code>.",
          cancelKeyboard(false),
          { parse_mode: "HTML" }
        );
      }

      if (loginRuns.has(userKey)) {
        return renderUi(
          telegramUserId,
          "⏳ Proses login akun Telegram lain masih berjalan. Selesaikan atau batalkan dulu.",
          cancelKeyboard(false),
          { parse_mode: "HTML" }
        );
      }

      // Keep the chat clean: the number is now shown in the status message.
      try {
        await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
      } catch (_) {}

      const account = await createAccountShell("Menunggu login", adminRow.telegram_user_id, phone);
      flows.delete(userKey);

      // Do not await: the login must stay free to receive the OTP message.
      startLoginInBackground(ctx, account.id, phone, {
        adminId: adminRow.id,
        deleteOnFailure: true
      });
      return;
    }

    /* -------------------------
       EXISTING ACCOUNT: PHONE
    -------------------------- */
    if (flow.t === "account_phone") {
      if (!ctx.message.text) {
        return renderUi(
          telegramUserId,
          "❌ Nomor Telegram harus berupa teks.",
          cancelKeyboard(false)
        );
      }

      const phone = normalizePhone(ctx.message.text);
      if (!phone) {
        return renderUi(
          telegramUserId,
          "❌ Nomor tidak valid. Gunakan format internasional.",
          cancelKeyboard(false)
        );
      }

      if (loginRuns.has(userKey)) {
        return renderUi(
          telegramUserId,
          "⏳ Proses login akun Telegram lain masih berjalan. Selesaikan atau batalkan dulu.",
          cancelKeyboard(false),
          { parse_mode: "HTML" }
        );
      }

      try {
        await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
      } catch (_) {}

      flows.delete(userKey);

      // Do not await: the login must stay free to receive the OTP message.
      startLoginInBackground(ctx, flow.accountId, phone, {
        adminId: adminRow.id,
        deleteOnFailure: false
      });
      return;
    }

    /* -------------------------
       GROUP SEARCH
    -------------------------- */
    if (flow.t === "group_search") {
      const query = String(ctx.message.text || "").trim().replace(/\s+/g, " ");
      if (!query) return replaceUi(ctx, "❌ Kata pencarian tidak boleh kosong. Contoh: <code>lpm</code>.", cancelKeyboard(false), { parse_mode: "HTML" });
      if (query.length > 80) return replaceUi(ctx, "❌ Kata pencarian terlalu panjang. Maksimal 80 karakter.", cancelKeyboard(false), { parse_mode: "HTML" });
      try {
        const token = rememberGroupSearch(flow.accountId, query, 0);
        flows.delete(userKey);
        return renderGroupSearch(ctx, token, 0);
      } catch (e) {
        return replaceUi(ctx, `❌ Pencarian grup gagal.\n\n${escapeHtml(safeErrorMessage(e))}`, new InlineKeyboard().text("⬅️ Grup", `group:list:${flow.accountId}:0`), { parse_mode: "HTML" });
      }
    }

    /* -------------------------
       PRIVATE PROMOTION: MESSAGE
    -------------------------- */
    if (flow.t === "private_promo_message") {
      if (!canUsePrivatePromotion(adminRow.role)) {
        flows.delete(userKey);
        privatePromotionRuns.delete(userKey);
        return renderUi(
          telegramUserId,
          "⛔ <b>AKSES DITOLAK</b>\n\nPromosi Chat Privat hanya tersedia untuk Admin Premium dan OWNER.",
          backDashboardKeyboard(),
          { parse_mode: "HTML" }
        );
      }

      const state = privatePromotionRuns.get(userKey);

      if (!state || state.running) {
        flows.delete(userKey);
        return renderUi(
          telegramUserId,
          "⚠️ Sesi Promosi Chat Privat sudah tidak tersedia atau sedang berjalan.",
          backDashboardKeyboard(),
          { parse_mode: "HTML" }
        );
      }

      if (!ctx.message.text) {
        return renderUi(
          telegramUserId,
          "❌ Pesan promosi harus berupa teks.",
          new InlineKeyboard().text("❌ Batal", "privatepromo:cancel"),
          { parse_mode: "HTML" }
        );
      }

      const message = cleanText(String(ctx.message.text).trim());
      if (!message) {
        return renderUi(
          telegramUserId,
          "❌ Pesan promosi tidak boleh kosong.",
          new InlineKeyboard().text("❌ Batal", "privatepromo:cancel"),
          { parse_mode: "HTML" }
        );
      }

      const selectedIds = Array.from(state.selectedGroupIds || []);
      if (!selectedIds.length) {
        flows.delete(userKey);
        return renderPrivatePromoGroups(
          ctx,
          0,
          "❌ Tidak ada grup sumber yang dipilih."
        );
      }

      const { data: groupRows, error: groupError } = await sb
        .from("account_groups")
        .select("*")
        .eq("account_id", state.accountId)
        .in("id", selectedIds);

      if (groupError) throw groupError;

      const groupsById = new Map(
        (groupRows || []).map(row => [String(row.id), row])
      );
      const sourceRows = selectedIds
        .map(id => groupsById.get(String(id)))
        .filter(Boolean);

      if (!sourceRows.length) {
        flows.delete(userKey);
        return renderPrivatePromoGroups(
          ctx,
          0,
          "❌ Grup sumber sudah tidak tersedia."
        );
      }

      flows.delete(userKey);

      // The worker owns the same runtime state and can be stopped by the
      // callback handler while it is collecting/sending targets.
      state.message = message;
      state.stage = "running";

      void runPrivatePromotion(
        userKey,
        state.accountId,
        sourceRows,
        message,
        adminRow
      ).catch(async error => {
        console.error("PRIVATE PROMOTION:", safeErrorMessage(error, 800));

        const current = privatePromotionRuns.get(userKey);
        if (current) {
          current.running = false;
          current.sourceFailures = [
            ...(current.sourceFailures || []),
            {
              title: "Promosi Chat Privat",
              reason: safeErrorMessage(error, 300)
            }
          ];

          await renderUi(
            userKey,
            [
              "❌ <b>PROMOSI CHAT PRIVAT BERHENTI KARENA ERROR</b>",
              "",
              `👥 Total Target: <b>${current.stats?.total || 0}</b>`,
              `✅ Berhasil: <b>${current.stats?.success || 0}</b>`,
              `❌ Gagal: <b>${current.stats?.failed || 0}</b>`,
              `⏭️ Skip: <b>${current.stats?.skipped || 0}</b>`,
              "",
              `⚠️ ${escapeHtml(safeErrorMessage(error, 500))}`
            ].join("\n"),
            new InlineKeyboard()
              .text("📢 Promosi Lagi", "privatepromo:accounts:0")
              .row()
              .text("🏠 Menu Utama", "menu:dashboard"),
            { parse_mode: "HTML" }
          ).catch(() => {});
        }
      });

      return;
    }

    /* -------------------------
       LABEL EDIT
    -------------------------- */
    if (flow.t === "account_label_edit") {
      if (!ctx.message.text) {
        return renderUi(
          telegramUserId,
          "❌ Label harus berupa teks.",
          cancelKeyboard(false)
        );
      }

      const label = truncateText(ctx.message.text.trim().replace(/\s+/g, " "), 80);
      if (label.length < 2) {
        return renderUi(
          telegramUserId,
          "❌ Label terlalu pendek.",
          cancelKeyboard(false)
        );
      }

      const { error } = await sb
        .from("telegram_accounts")
        .update({ label })
        .eq("id", flow.accountId);

      if (error) throw error;

      await recordHistory(flow.accountId, adminRow.id, {
        action: "label_update",
        status: "success",
        details: { label }
      });

      flows.delete(userKey);
      return showAccount(ctx, flow.accountId, "✅ Label berhasil diperbarui.");
    }

    /* -------------------------
       FORMAT CONTENT
    -------------------------- */
    if (flow.t === "format" || flow.t === "format_add") {
      const isNew = flow.t === "format_add";
      const formats = await getPromotionFormats(flow.accountId);
      let format;
      if (isNew) {
        // Format baru: nama otomatis (Format 1, Format 2, ...), tanpa batas panjang isi.
        const usedNames = new Set(formats.map(x => x.name));
        let n = formats.length + 1;
        while (usedNames.has(`Format ${n}`)) n++;
        format = normalizeFormat({ id: newFormatId(), name: `Format ${n}` });
        formats.push(format); // baru disimpan setelah isi format valid
      } else {
        format = formats.find(x=>x.id===String(flow.formatId));
        if(!format) { flows.delete(userKey); return renderFormatList(ctx,flow.accountId,"❌ Format tidak ditemukan."); }
      }
      if (ctx.message.photo?.length) {
        const photo=ctx.message.photo[ctx.message.photo.length-1];
        format.media_type="photo"; format.message=""; format.media_file_id=photo.file_id; format.caption=ctx.message.caption||"";
      } else if (ctx.message.text) {
        const message=ctx.message.text.trim();
        if(!message)return replaceUi(ctx,"❌ Format teks tidak boleh kosong.",cancelKeyboard(false));
        format.media_type="text"; format.message=message; format.media_file_id=null; format.caption=null;
      } else return replaceUi(ctx,"❌ Format tidak didukung. Kirim teks atau foto.",cancelKeyboard(false));
      format.updated_at=new Date().toISOString();
      await savePromotionFormats(flow.accountId,formats);
      await recordHistory(flow.accountId,adminRow.id,{action:"format_update",status:"success",details:{format_id:format.id,format_name:format.name,type:format.media_type}});
      flows.delete(userKey);
      return renderFormatDetail(ctx,flow.accountId,format.id,isNew?`✅ <b>Format berhasil dibuat</b> (${escapeHtml(format.name)}).`:"✅ Isi format berhasil disimpan.");
    }

    /* -------------------------
       FORMAT DELAY
    -------------------------- */
    if (flow.t === "delay") {
      const minutes=parseMinutes(ctx.message.text);
      if(!minutes)return replaceUi(ctx,"❌ Jeda tidak valid. Contoh: <code>10 menit</code> atau <code>1 jam</code>.",cancelKeyboard(false),{parse_mode:"HTML"});
      const formats=await getPromotionFormats(flow.accountId); const f=formats.find(x=>x.id===String(flow.formatId));
      if(!f)return renderFormatList(ctx,flow.accountId,"❌ Format tidak ditemukan.");
      f.interval_minutes=minutes; f.updated_at=new Date().toISOString(); await savePromotionFormats(flow.accountId,formats);
      flows.delete(userKey); return renderFormatDetail(ctx,flow.accountId,f.id,`✅ Jeda disimpan: <b>${escapeHtml(formatInterval(minutes))}</b>`);
    }

    /* -------------------------
       FORMAT DURATION
    -------------------------- */
    if (flow.t === "duration") {
      const hours=parseHours(ctx.message.text);
      if(!hours)return replaceUi(ctx,"❌ Durasi tidak valid. Contoh: <code>3 hari</code> atau <code>12 jam</code>.",cancelKeyboard(false),{parse_mode:"HTML"});
      const formats=await getPromotionFormats(flow.accountId); const f=formats.find(x=>x.id===String(flow.formatId));
      if(!f)return renderFormatList(ctx,flow.accountId,"❌ Format tidak ditemukan.");
      f.duration_hours=hours; if(f.active)f.expires_at=new Date(Date.now()+hours*3600000).toISOString(); f.updated_at=new Date().toISOString();
      await savePromotionFormats(flow.accountId,formats); flows.delete(userKey); return renderFormatDetail(ctx,flow.accountId,f.id,`✅ Durasi disimpan: <b>${escapeHtml(formatDuration(hours))}</b>`);
    }

    /* -------------------------
       FORMAT TIME WINDOW
    -------------------------- */
    if (flow.t === "time") {
      const raw=String(ctx.message.text||"").trim();
      if(raw === "00:00 - 00:00") {
        const formats=await getPromotionFormats(flow.accountId); const f=formats.find(x=>x.id===String(flow.formatId));
        if(!f)return renderFormatList(ctx,flow.accountId,"❌ Format tidak ditemukan.");
        f.start_time=null;f.stop_time=null;f.updated_at=new Date().toISOString();await savePromotionFormats(flow.accountId,formats);flows.delete(userKey);return renderFormatDetail(ctx,flow.accountId,f.id,"✅ Waktu dijadikan tanpa batas.");
      }
      const m=raw.match(/^\s*(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})\s*$/);
      const a=parseTimeHHMM(m?.[1]), b=parseTimeHHMM(m?.[2]);
      if(!a||!b)return replaceUi(ctx,"❌ Format waktu salah. Contoh: <code>08:00 - 22:00</code>.",cancelKeyboard(false),{parse_mode:"HTML"});
      const formats=await getPromotionFormats(flow.accountId); const f=formats.find(x=>x.id===String(flow.formatId));
      if(!f)return renderFormatList(ctx,flow.accountId,"❌ Format tidak ditemukan.");
      f.start_time=a;f.stop_time=b;f.updated_at=new Date().toISOString();await savePromotionFormats(flow.accountId,formats);flows.delete(userKey);return renderFormatDetail(ctx,flow.accountId,f.id,`✅ Waktu disimpan: <b>${a} - ${b}</b>`);
    }

    /* -------------------------
       ADMIN DURATION CUSTOM
    -------------------------- */
    if (flow.t === "admin_duration_custom") {
      const days = Number(String(ctx.message.text || "").trim());
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        return renderUi(telegramUserId, "❌ Jumlah hari tidak valid. Masukkan angka 1 sampai 3650.", cancelKeyboard(adminRow.role === "OWNER"), { parse_mode: "HTML" });
      }
      flows.set(userKey, { ...flow, t: "admin_add_duration" });
      // Reuse the same activation path as the preset buttons.
      const fakeCtx = ctx;
      try {
        return await activateAdminFromDuration(fakeCtx, days);
      } catch (error) {
        return renderUi(telegramUserId, `❌ Gagal mengatur masa aktif.\n\n${escapeHtml(safeErrorMessage(error, 500))}`, new InlineKeyboard().text("👥 Admin", "admin:list:0"), { parse_mode: "HTML" });
      }
    }

    /* -------------------------
       ADMIN ADD / APPROVE
    -------------------------- */
    if (flow.t === "admin_add") {
      const allowedRoles = ["OWNER", "ADMIN_VIP", "ADMIN_PREMIUM"];
      if (!allowedRoles.includes(adminRow.role)) {
        flows.delete(userKey);
        return renderUi(telegramUserId, "⛔ Akses ditolak.", backDashboardKeyboard(), { parse_mode: "HTML" });
      }

      const targetId = parsePositiveTelegramId(ctx.message.text);
      if (!targetId) {
        return renderUi(telegramUserId, "❌ Telegram ID harus berupa angka positif.", cancelKeyboard(adminRow.role === "OWNER"), { parse_mode: "HTML" });
      }
      if (targetId === Number(adminRow.telegram_user_id)) {
        return renderUi(telegramUserId, "❌ Kamu tidak dapat menambahkan diri sendiri.", cancelKeyboard(adminRow.role === "OWNER"), { parse_mode: "HTML" });
      }

      const role = flow.adminRole || (adminRow.role === "OWNER" ? "ADMIN_VIP" : "ADMIN_ANAK");
      if (adminRow.role === "OWNER" && !["ADMIN_ANAK", "ADMIN_VIP", "ADMIN_PREMIUM"].includes(role)) {
        return renderUi(telegramUserId, "❌ Role admin tidak valid. Pilih Admin Biasa, Admin VIP, atau Admin Premium.", cancelKeyboard(true), { parse_mode: "HTML" });
      }
      if (adminRow.role !== "OWNER" && role !== "ADMIN_ANAK") {
        return renderUi(telegramUserId, "⛔ Admin VIP/Premium hanya dapat menambah Admin biasa.", cancelKeyboard(false), { parse_mode: "HTML" });
      }

      if (role === "ADMIN_ANAK") {
        const countResult = await sb.from("admins").select("id", { count: "exact", head: true })
          .eq("parent_admin_id", adminRow.id).eq("active", true);
        if (countResult.error) throw countResult.error;
        if (adminRow.role === "ADMIN_VIP" && Number(countResult.count || 0) >= 20) {
          return replaceUi(ctx, "⚠️ <b>Batas Admin VIP tercapai.</b>\n\nAdmin VIP maksimal memiliki 20 Admin aktif.", new InlineKeyboard().text("⬅️ Admin", "admin:list:0"), { parse_mode: "HTML" });
        }
      }

      flows.set(userKey, {
        t: "admin_add_duration",
        adminId: adminRow.id,
        adminRole: role,
        targetId
      });
      return replaceUi(
        ctx,
        `⏳ <b>ATUR MASA AKTIF</b>\n\nRole: <b>${escapeHtml(displayAdminRole(role))}</b>\nTelegram ID: <code>${targetId}</code>\n\nPilih masa aktif akses admin ini. Setelah habis, akses bot otomatis dinonaktifkan dan user harus memperpanjang.`,
        new InlineKeyboard()
          .text("7 Hari", "admin:duration:7")
          .text("30 Hari", "admin:duration:30")
          .row()
          .text("3 Bulan", "admin:duration:90")
          .text("6 Bulan", "admin:duration:180")
          .row()
          .text("12 Bulan", "admin:duration:365")
          .row()
          .text("✏️ Atur Hari Sendiri", "admin:duration:custom")
          .row()
          .text("❌ Batal", adminRow.role === "OWNER" ? "admin:cancel" : "flow:cancel"),
        { parse_mode: "HTML" }
      );

      /* Legacy activation block below is intentionally unreachable; duration callbacks perform activation. */
      const existing = await sb.from("admins").select("*").eq("telegram_user_id", targetId).maybeSingle();
      if (existing.error) throw existing.error;

      if (existing.data) {
        if (existing.data.active) {
          return replaceUi(ctx, `ℹ️ Telegram ID <code>${targetId}</code> sudah terdaftar sebagai <b>${escapeHtml(displayAdminRole(existing.data.role))}</b>.`, new InlineKeyboard().text("👥 Admin", "admin:list:0"), { parse_mode: "HTML" });
        }

        // A previously disconnected admin may be approved again by its new parent.
        const { error } = await sb.from("admins").update({
          role,
          active: true,
          parent_admin_id: role === "ADMIN_ANAK" && ["ADMIN_VIP", "ADMIN_PREMIUM"].includes(adminRow.role) ? adminRow.id : null,
          updated_at: new Date().toISOString()
        }).eq("id", existing.data.id);
        if (error) throw error;
      } else {
        const { error } = await sb.from("admins").insert({
          telegram_user_id: targetId,
          role,
          active: true,
          parent_admin_id: role === "ADMIN_ANAK" ? adminRow.id : null
        });
        if (error) throw error;
      }

      flows.delete(userKey);
      const roleLabel = role === "ADMIN_PREMIUM" ? "ADMIN PREMIUM" : role === "ADMIN_VIP" ? "ADMIN VIP" : "ADMIN";
      return replaceUi(ctx,
        `✅ <b>${roleLabel} DITAMBAHKAN</b>\n\nTelegram ID <code>${targetId}</code> sekarang aktif.\n${role === "ADMIN_ANAK" ? (adminRow.role === "OWNER" ? "Admin ini dikelola langsung oleh OWNER." : "Admin ini hanya berada di bawah akun kamu.") : "Admin ini berada di bawah OWNER."}`,
        new InlineKeyboard().text("👥 Daftar Admin", "admin:list:0").row().text("🏠 Dashboard", "menu:dashboard"),
        { parse_mode: "HTML" });
    }

    /* -------------------------
       ADMIN DISCONNECT / REMOVE
    -------------------------- */
    if (flow.t === "admin_delete") {
      if (!["OWNER", "ADMIN_VIP", "ADMIN_PREMIUM"].includes(adminRow.role)) {
        flows.delete(userKey);
        return renderUi(telegramUserId, "⛔ Akses ditolak.", backDashboardKeyboard(), { parse_mode: "HTML" });
      }

      const targetId = parsePositiveTelegramId(ctx.message.text);
      if (!targetId) return renderUi(telegramUserId, "❌ Telegram ID harus berupa angka positif.", cancelKeyboard(adminRow.role === "OWNER"), { parse_mode: "HTML" });
      if (isOwnerId(targetId)) return renderUi(telegramUserId, "⛔ OWNER tidak dapat diputus.", cancelKeyboard(true), { parse_mode: "HTML" });

      const existing = await sb.from("admins").select("*").eq("telegram_user_id", targetId).maybeSingle();
      if (existing.error) throw existing.error;
      if (!existing.data || !existing.data.active) {
        flows.delete(userKey);
        return replaceUi(ctx, `❌ Admin dengan Telegram ID <code>${targetId}</code> tidak ditemukan atau sudah tidak aktif.`, new InlineKeyboard().text("👥 Admin", "admin:list:0"), { parse_mode: "HTML" });
      }

      const target = existing.data;
      const canRemove = adminRow.role === "OWNER"
        ? ["ADMIN_VIP", "ADMIN_PREMIUM"].includes(target.role)
        : target.role === "ADMIN_ANAK" && Number(target.parent_admin_id) === Number(adminRow.id);

      if (!canRemove) {
        return renderUi(telegramUserId, "⛔ Admin tersebut bukan bagian dari hierarki yang bisa kamu kelola.", cancelKeyboard(adminRow.role === "OWNER"), { parse_mode: "HTML" });
      }

      // Disconnect access without deleting historical identity. Children remain stored,
      // but inactive parent/children can no longer access the admin menu.
      const { error } = await sb.from("admins").update({
        active: false,
        updated_at: new Date().toISOString()
      }).eq("id", target.id);
      if (error) throw error;

      // If a VIP/Premium is disconnected, disconnect its direct Admin accounts too so
      // there is no orphaned active admin below a removed parent.
      if (["ADMIN_VIP", "ADMIN_PREMIUM"].includes(target.role)) {
        const { error: childError } = await sb.from("admins").update({
          active: false,
          updated_at: new Date().toISOString()
        }).eq("parent_admin_id", target.id).eq("active", true);
        if (childError) throw childError;
      }

      flows.delete(userKey);
      return replaceUi(ctx,
        `✅ <b>ADMIN DIPUTUS</b>\n\nTelegram ID <code>${targetId}</code> (${escapeHtml(displayAdminRole(target.role))}) sudah dinonaktifkan.\n\nAkses admin dicabut tanpa menghapus data account/promosi yang sudah ada.`,
        new InlineKeyboard().text("👥 Daftar Admin", "admin:list:0").row().text("🏠 Dashboard", "menu:dashboard"),
        { parse_mode: "HTML" });
    }

  } catch (e) {
    console.error("MESSAGE FLOW:", safeErrorMessage(e));

    // Do not leak session material or internal credentials.
    const message = safeErrorMessage(e, 700);
    const errorText = `❌ <b>Gagal memproses input.</b>\n\n${escapeHtml(message)}`;

    // Alur format: kirim notifikasi sebagai pesan baru di bagian bawah chat.
    if (String(flow?.t || "").startsWith("format")) {
      return replaceUi(ctx, errorText, cancelKeyboard(false), { parse_mode: "HTML" });
    }

    return renderUi(
      telegramUserId,
      errorText,
      cancelKeyboard(false),
      { parse_mode: "HTML" }
    );
  }
});

/* =========================================================
   UNKNOWN CALLBACK SAFETY NET
========================================================= */

bot.on("callback_query:data", async ctx => {
  await ctx.answerCallbackQuery(
    "Menu tidak tersedia atau sudah kedaluwarsa.",
    { show_alert: true }
  ).catch(() => {});
});

/* =========================================================
   RESTORE RUNNING PROMOTIONS / SESSIONS
========================================================= */

async function restoreSessions() {
  const { data, error } = await sb
    .from("telegram_accounts")
    .select("id,status,session_string")
    .eq("status", "connected");

  if (error) throw error;

  for (const row of data || []) {
    if (!row.session_string) continue;

    try {
      const client = await clientFor(row.id);
      if (client) {
        clients.set(String(row.id), client);
      }
    } catch (e) {
      console.warn(
        `ACCOUNT ${row.id} RESTORE SESSION:`,
        safeErrorMessage(e, 250)
      );
    }
  }
}

async function restoreRunningPromotions() {
  const {data,error}=await sb.from("telegram_accounts").select("id");
  if(error)throw error;
  for(const row of data||[]){
    const formats=await getPromotionFormats(row.id);
    for(const f of formats){
      if(!f.active)continue;
      if(!f.expires_at||new Date(f.expires_at)<=new Date()){await stopFormat(row.id,f.id,null);continue;}
      scheduleFormat(row.id,f.id,0);
    }
  }
}

/* =========================================================
   ERROR HANDLING / BOT START
========================================================= */

bot.catch(async err => {
  const error = err?.error || err;
  console.error("BOT:", error);

  const ctx = err?.ctx;
  if (!ctx?.from?.id) return;

  const message = `❌ <b>Terjadi kesalahan menu.</b>\n\n${escapeHtml(safeErrorMessage(error, 500))}`;

  try {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery("Terjadi kesalahan.", { show_alert: true }).catch(() => {});
      await replaceUi(
        ctx,
        message,
        new InlineKeyboard().text("🏠 Menu Utama", "menu:dashboard"),
        { parse_mode: "HTML" }
      );
      return;
    }

    await renderUi(
      ctx.from.id,
      message,
      new InlineKeyboard().text("🏠 Menu Utama", "menu:dashboard"),
      { parse_mode: "HTML" }
    );
  } catch (uiError) {
    console.error("BOT ERROR UI:", safeErrorMessage(uiError, 300));
  }
});

const app = express();

app.get("/", (_, res) => {
  res.json({
    ok: true,
    service: "telegram-admin-bot",
    version: BOT_VERSION
  });
});

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    accountsLoaded: clients.size,
    schedulersRunning: schedulerTasks.size
  });
});

app.listen(
  Number(process.env.PORT || 3000),
  () => {
    console.log(
      `HTTP server listening on ${process.env.PORT || 3000}`
    );
  }
);

async function gracefulShutdown(signal) {
  console.log(`${signal}: shutting down without Telegram logout...`);

  for (const task of schedulerTasks.values()) {
    task.running = false;
    if (task.timeout) clearTimeout(task.timeout);
  }
  schedulerTasks.clear();

  // Stop unfinished interactive logins (spinner timers + temporary clients).
  for (const run of loginRuns.values()) {
    run.cancelled = true;
    try { await run.loader?.stop?.(); } catch (_) {}
    try { await run.client?.disconnect(); } catch (_) {}
  }
  loginRuns.clear();

  // Intentionally disconnect local sockets only. The Telegram session is NOT logged out
  // and encrypted session remains in the database for reconnect after restart.
  for (const [accountId, client] of clients.entries()) {
    try {
      await client.disconnect();
    } catch (_) {}
    clients.delete(accountId);
  }

  process.exit(0);
}

process.once("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});

(async () => {
  try {
    await ensureBootstrapOwners();

    // Start the admin Telegram bot before any non-essential restore/migration work.
    // A stale legacy table, promotion record, or GramJS session must never block
    // the admin bot from reaching Telegram polling.
    void migrateLegacyData().catch(e => {
      console.error("LEGACY MIGRATION WARNING:", safeErrorMessage(e, 800));
    });

    void restoreSessions().catch(e => {
      console.error("RESTORE SESSIONS:", safeErrorMessage(e, 800));
    });

    void restoreRunningPromotions().catch(e => {
      console.error("RESTORE PROMOTIONS:", safeErrorMessage(e, 800));
    });

    console.log("STARTUP: starting Telegram admin bot...");
    await bot.start({
      onStart: info => {
        console.log(`Telegram admin bot started as @${info?.username || "bot"}.`);
      }
    });
  } catch (e) {
    console.error("FATAL:", e);
    process.exit(1);
  }
})();
