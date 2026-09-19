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

function safeErrorMessage(error, max = 500) {
  const raw = String(error?.message || error || "Kesalahan tidak diketahui");
  return raw.replace(/\s+/g, " ").slice(0, max);
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

