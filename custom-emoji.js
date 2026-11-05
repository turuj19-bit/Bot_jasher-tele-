"use strict";

/* =========================================================
   EMOJI PREMIUM (CUSTOM EMOJI) UNTUK SEMUA PESAN BOT
   - Semua emoji biasa di pesan & tombol bot otomatis diganti emoji premium
     (animasi) bila emoji tersebut ada di pack yang didaftarkan.
   - Emoji yang tidak ada di pack tetap tampil sebagai emoji biasa.
   - Syarat Telegram (Bot API 9.4): pemilik bot harus punya Telegram Premium.
   - Bila Telegram menolak, bot otomatis kirim ulang tanpa emoji premium,
     jadi menu tidak pernah rusak.
   Modul berdiri sendiri; tidak mengubah fitur lain.
========================================================= */

const KEY = "custom_emoji_packs";
const MAX_ENTITIES = 100;
const PAUSE_MS = 10 * 60 * 1000;

const EMOJI_SRC =
  "\\p{Regional_Indicator}{2}|[#*0-9]\\uFE0F?\\u20E3|" +
  "\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})?" +
  "(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})?)*";
const EMOJI_RE = new RegExp(EMOJI_SRC, "gu");
const EMOJI_START = new RegExp(`^(?:${EMOJI_SRC})`, "u");

const SKIP_TAGS = new Set(["code", "pre", "tg-emoji"]);
const TEXT_METHODS = new Set([
  "sendMessage", "editMessageText", "sendPhoto", "sendVideo", "sendAnimation",
  "sendDocument", "sendAudio", "editMessageCaption", "editMessageMedia", "editMessageReplyMarkup"
]);

let emojiMap = new Map(); // emoji (tanpa VS16) -> custom_emoji_id
const state = { fails: 0, pausedUntil: 0 };

const norm = e => String(e).replace(/️/g, "");

function lookup(em) {
  const direct = emojiMap.get(norm(em));
  if (direct) return direct;
  // Varian (warna kulit / ZWJ) dicoba ke emoji dasarnya.
  const base = Array.from(norm(em))[0];
  return base ? emojiMap.get(base) || null : null;
}

function convertHtml(html) {
  const parts = String(html).split(/(<[^>]*>)/);
  let skip = 0;
  let count = 0;
  let changed = false;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.length > 1 && part[0] === "<" && part[part.length - 1] === ">") {
      const m = /^<\s*(\/)?\s*([a-zA-Z-]+)/.exec(part);
      if (m && SKIP_TAGS.has(m[2].toLowerCase())) skip = Math.max(0, skip + (m[1] ? -1 : 1));
      continue;
    }
    if (skip > 0) continue;
    parts[i] = part.replace(EMOJI_RE, em => {
      const id = lookup(em);
      if (!id || count >= MAX_ENTITIES) return em;
      count++;
      changed = true;
      return `<tg-emoji emoji-id="${id}">${em}</tg-emoji>`;
    });
  }
  return changed ? parts.join("") : null;
}

function convertPlain(text) {
  const escaped = String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return convertHtml(escaped);
}

// Hasil: { value, parse_mode? } atau null bila tidak ada yang berubah.
function convertField(value, parseMode, hasEntities) {
  if (typeof value !== "string" || !value || hasEntities) return null;
  const mode = String(parseMode || "").toLowerCase();
  if (mode === "html") {
    const r = convertHtml(value);
    return r ? { value: r } : null;
  }
  if (!mode) {
    const r = convertPlain(value);
    return r ? { value: r, parse_mode: "HTML" } : null;
  }
  return null; // Markdown: dibiarkan
}

function convertMarkup(markup) {
  const rows = markup && markup.inline_keyboard;
  if (!Array.isArray(rows)) return null;
  let changed = false;

  const out = rows.map(row => row.map(btn => {
    if (!btn || typeof btn.text !== "string" || btn.icon_custom_emoji_id) return btn;
    const m = EMOJI_START.exec(btn.text.trimStart());
    if (!m) return btn;
    const id = lookup(m[0]);
    const rest = btn.text.trimStart().slice(m[0].length).trim();
    if (!id || !rest) return btn; // tombol berisi emoji saja dibiarkan
    changed = true;
    return { ...btn, text: rest, icon_custom_emoji_id: id };
  }));
  return changed ? { ...markup, inline_keyboard: out } : null;
}

function convertPayload(method, payload) {
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.chat_id === "string" && payload.chat_id.startsWith("@")) return null; // channel

  const out = { ...payload };
  let changed = false;

  const t = convertField(payload.text, payload.parse_mode, payload.entities);
  if (t) { out.text = t.value; if (t.parse_mode) out.parse_mode = t.parse_mode; changed = true; }

  const c = convertField(payload.caption, payload.parse_mode, payload.caption_entities);
  if (c) { out.caption = c.value; if (c.parse_mode) out.parse_mode = c.parse_mode; changed = true; }

  if (payload.media && typeof payload.media === "object" && typeof payload.media.caption === "string") {
    const mc = convertField(payload.media.caption, payload.media.parse_mode, payload.media.caption_entities);
    if (mc) {
      out.media = { ...payload.media, caption: mc.value, ...(mc.parse_mode ? { parse_mode: mc.parse_mode } : {}) };
      changed = true;
    }
  }

  const k = convertMarkup(payload.reply_markup);
  if (k) { out.reply_markup = k; changed = true; }

  return changed ? out : null;
}

const isRejection = res =>
  res && res.ok === false && Number(res.error_code) === 400 &&
  /emoji|entit|parse/i.test(String(res.description || ""));

function register(bot, getDeps) {
  const D = () => getDeps();
  const awaiting = new Map(); // ownerId -> timestamp

  /* ---------- Transformer: ubah semua pesan keluar ---------- */
  bot.api.config.use(async (prev, method, payload, signal) => {
    if (!emojiMap.size || !TEXT_METHODS.has(method) || Date.now() < state.pausedUntil) {
      return prev(method, payload, signal);
    }

    let converted = null;
    try { converted = convertPayload(method, payload); } catch (_) { converted = null; }
    if (!converted) return prev(method, payload, signal);

    const res = await prev(method, converted, signal);
    if (res && res.ok) { state.fails = 0; return res; }

    if (isRejection(res)) {
      state.fails++;
      if (state.fails >= 3) {
        state.pausedUntil = Date.now() + PAUSE_MS;
        state.fails = 0;
        console.warn("CUSTOM EMOJI: ditolak Telegram 3x, dijeda 10 menit. Pastikan pemilik bot punya Telegram Premium.");
      }
      return prev(method, payload, signal); // kirim ulang tanpa emoji premium
    }
    return res;
  });

  /* ---------- Penyimpanan daftar pack ---------- */
  async function savedPacks() {
    const names = [];
    try {
      const { data } = await D().sb.from("system_migrations").select("details").eq("key", KEY).maybeSingle();
      if (Array.isArray(data?.details?.packs)) names.push(...data.details.packs);
    } catch (e) {
      console.warn("CUSTOM EMOJI READ:", e?.message || e);
    }
    for (const n of String(process.env.CUSTOM_EMOJI_PACKS || "").split(",")) {
      if (n.trim()) names.push(n.trim());
    }
    return [...new Set(names.map(String))];
  }

  async function savePacks(packs) {
    const { error } = await D().sb.from("system_migrations").upsert({
      key: KEY,
      completed_at: new Date().toISOString(),
      details: { packs }
    }, { onConflict: "key" });
    if (error) throw error;
  }

  /* ---------- Muat pack -> peta emoji ---------- */
  async function load() {
    const names = await savedPacks();
    const next = new Map();
    const report = [];

    for (const name of names) {
      try {
        const set = await bot.api.getStickerSet(name);
        let n = 0;
        for (const st of set.stickers || []) {
          if (!st.custom_emoji_id) continue;
          for (const e of String(st.emoji || "").match(EMOJI_RE) || []) {
            const key = norm(e);
            if (!next.has(key)) { next.set(key, st.custom_emoji_id); n++; }
          }
        }
        report.push({ name, count: n, title: set.title });
      } catch (e) {
        report.push({ name, error: String(e?.description || e?.message || e) });
      }
    }

    emojiMap = next;
    state.fails = 0;
    state.pausedUntil = 0;
    console.log(`CUSTOM EMOJI: ${next.size} emoji dari ${report.filter(r => !r.error).length} pack dimuat.`);
    return report;
  }

  /* ---------- Perintah OWNER: /emojipack ---------- */
  const extractName = text => {
    const link = /(?:t\.me|telegram\.me)\/addemoji\/([A-Za-z0-9_]+)/i.exec(text || "");
    if (link) return link[1];
    const bare = String(text || "").trim();
    return /^[A-Za-z0-9_]{3,64}$/.test(bare) ? bare : null;
  };

  const esc = v => D().escapeHtml(v);

  async function addPack(ctx, name) {
    let set;
    try {
      set = await ctx.api.getStickerSet(name);
    } catch (e) {
      return ctx.reply(`❌ Pack <code>${esc(name)}</code> tidak ditemukan.`, { parse_mode: "HTML" });
    }
    if (set.sticker_type && set.sticker_type !== "custom_emoji") {
      return ctx.reply("❌ Itu bukan pack emoji premium (custom emoji). Pilih pack emoji, bukan stiker.", { parse_mode: "HTML" });
    }
    const packs = await savedPacks();
    if (!packs.includes(set.name)) packs.push(set.name);
    // Pack dari env tidak ikut disimpan ulang ke DB agar tidak dobel.
    const envNames = new Set(String(process.env.CUSTOM_EMOJI_PACKS || "").split(",").map(x => x.trim()).filter(Boolean));
    await savePacks(packs.filter(p => !envNames.has(p)));
    await load();
    return ctx.reply(
      `✅ Pack <b>${esc(set.title || set.name)}</b> ditambahkan.\nTotal emoji premium aktif: <b>${emojiMap.size}</b>.\n\nEmoji yang tidak ada di pack tetap tampil sebagai emoji biasa. Tambah pack lain dengan /emojipack.`,
      { parse_mode: "HTML" }
    );
  }

  bot.command("emojipack", async ctx => {
    if (!ctx.from || !D().isOwnerId(ctx.from.id)) return;
    const arg = String(ctx.match || "").trim();

    if (/^(cek|status)$/i.test(arg)) {
      const names = await savedPacks();
      return ctx.reply(
        `🎨 <b>EMOJI PREMIUM</b>\nPack : <b>${names.length}</b>\nEmoji aktif : <b>${emojiMap.size}</b>\n${names.map(n => `• <code>${esc(n)}</code>`).join("\n")}`,
        { parse_mode: "HTML" }
      );
    }

    if (/^reset$/i.test(arg)) {
      await savePacks([]);
      await load();
      return ctx.reply("🧹 Semua pack emoji premium dihapus. Bot kembali memakai emoji biasa.");
    }

    const del = /^hapus\s+(\S+)$/i.exec(arg);
    if (del) {
      const name = extractName(del[1]);
      const packs = (await savedPacks()).filter(p => p !== name);
      await savePacks(packs);
      await load();
      return ctx.reply(`🗑️ Pack dihapus. Emoji premium aktif: ${emojiMap.size}.`);
    }

    if (arg) {
      const name = extractName(arg);
      if (!name) return ctx.reply("❌ Link/nama pack tidak valid. Contoh: https://t.me/addemoji/NamaPack");
      return addPack(ctx, name);
    }

    awaiting.set(ctx.from.id, Date.now());
    return ctx.reply(
      "🎨 <b>PASANG EMOJI PREMIUM</b>\n\nKirim salah satu:\n• <b>link pack</b> (contoh: https://t.me/addemoji/NamaPack), atau\n• <b>1 emoji premium</b> dari pack yang dimau.\n\nPerintah lain: <code>/emojipack cek</code>, <code>/emojipack hapus NamaPack</code>, <code>/emojipack reset</code>.\n\n⚠️ Pemilik bot harus punya Telegram Premium.",
      { parse_mode: "HTML" }
    );
  });

  // Menunggu link/emoji setelah /emojipack. Selain itu langsung diteruskan.
  bot.on("message", async (ctx, next) => {
    const uid = ctx.from?.id;
    const at = uid ? awaiting.get(uid) : null;
    if (!at) return next();
    if (Date.now() - at > 5 * 60 * 1000) { awaiting.delete(uid); return next(); }

    const text = ctx.message.text || ctx.message.caption || "";
    if (text.startsWith("/")) { awaiting.delete(uid); return next(); }

    const ents = ctx.message.entities || ctx.message.caption_entities || [];
    const ce = ents.find(e => e.type === "custom_emoji");
    let name = null;
    try {
      if (ce) {
        const st = await ctx.api.getCustomEmojiStickers([ce.custom_emoji_id]);
        name = st?.[0]?.set_name || null;
      } else {
        name = extractName(text);
      }
    } catch (e) {
      console.warn("CUSTOM EMOJI RESOLVE:", e?.message || e);
    }

    if (!name) {
      return ctx.reply("❌ Tidak terbaca. Kirim link pack (t.me/addemoji/...) atau 1 emoji premium dari pack-nya.");
    }
    awaiting.delete(uid);
    return addPack(ctx, name);
  });

  return { load };
}

module.exports = { register, convertHtml, convertMarkup };
