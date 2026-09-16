require("dotenv").config();

const express = require("express");
const { Bot, InlineKeyboard } = require("grammy");
const { createClient } = require("@supabase/supabase-js");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");

const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean)
);

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const bot = new Bot(process.env.BOT_TOKEN);

const clients = new Map();
const flows = new Map();
const waiters = new Map();
const timers = new Map();

const admin = id => ADMIN_IDS.has(String(id));

/* =========================
   MENU
========================= */

function userMenu() {
  return new InlineKeyboard()
    .text("➕ Add Group", "group:list")
    .text("📝 Buat Format", "promo:message")
    .row()
    .text("✏️ Ubah Format", "promo:edit")
    .row()
    .text("⏱ Set Jeda", "promo:interval")
    .text("📅 Set Hari", "promo:duration")
    .row()
    .text("▶️ Mulai", "campaign:start")
    .text("⏹ Stop", "campaign:stop")
    .row()
    .text("🔐 Perangkat Terhubung", "account:login")
    .row()
    .text("📊 Status", "status")
    .text("🔄 Refresh", "menu:user");
}

function adminMenu() {
  return new InlineKeyboard()
    .text("➕ Add User", "admin:add")
    .text("👥 Total User", "admin:total")
    .row()
    .text("🟢 User Aktif", "admin:active")
    .text("🔌 Putuskan User", "admin:disconnect");
}

function backMenu() {
  return new InlineKeyboard().text("⬅️ Menu", "menu:user");
}

function cancelMenu() {
  return new InlineKeyboard().text("❌ Batal", "flow:cancel");
}

/* =========================
   HELPERS
========================= */

function formatDuration(seconds) {
  const s = Number(seconds || 0);

  if (!s) return "-";
  if (s % 86400 === 0) return `${s / 86400} hari`;
  if (s % 3600 === 0) return `${s / 3600} jam`;
  if (s % 60 === 0) return `${s / 60} menit`;

  return `${s} detik`;
}

function parseSeconds(value) {
  const m = String(value || "")
    .trim()
    .toLowerCase()
    .match(/^(\d+(?:\.\d+)?)\s*(detik|menit|jam|hari|s|m|h|d)$/);

  if (!m) return null;

  const unit = {
    detik: 1,
    s: 1,
    menit: 60,
    m: 60,
    jam: 3600,
    h: 3600,
    hari: 86400,
    d: 86400
  }[m[2]];

  const seconds = Math.round(Number(m[1]) * unit);

  return Number.isFinite(seconds) ? seconds : null;
}

async function getUser(tgId) {
  const { data, error } = await sb
    .from("app_users")
    .select("*")
    .eq("telegram_user_id", tgId)
    .maybeSingle();

  if (error) throw error;

  return data;
}

async function requireActive(ctx) {
  const u = await getUser(ctx.from.id);

  if (!u || u.status !== "active") {
    await ctx.reply("❌ Akun kamu belum diaktifkan admin.");
    return null;
  }

  return u;
}

/* =========================
   TELEGRAM USER CLIENT
========================= */

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

async function clientFor(u) {
  if (!u) return null;

  let c = clients.get(u.id);

  if (c) {
    try {
      if (!c.connected) {
        await c.connect();
      }

      if (await c.checkAuthorization()) {
        return c;
      }
    } catch (_) {}
  }

  const { data, error } = await sb
    .from("telegram_sessions")
    .select("*")
    .eq("user_id", u.id)
    .maybeSingle();

  if (error) throw error;

  if (!data?.session_string) {
    return null;
  }

  c = await createTelegramClient(data.session_string);

  try {
    await c.connect();

    if (!(await c.checkAuthorization())) {
      return null;
    }

    clients.set(u.id, c);

    return c;
  } catch (_) {
    try {
      await c.disconnect();
    } catch (_) {}

    return null;
  }
}

/* =========================
   GROUPS
========================= */

async function refreshGroups(u) {
  const c = await clientFor(u);

  if (!c) {
    throw new Error(
      "Akun Telegram belum terhubung. Silakan kaitkan akun lagi."
    );
  }

  const dialogs = await c.getDialogs({
    limit: 500
  });

  const rows = [];

  for (const d of dialogs) {
    const entity = d.entity;

    if (!entity) continue;

    const isGroup = Boolean(d.isGroup);
    const isChannel = Boolean(d.isChannel);

    if (!isGroup && !isChannel) continue;

    let canSend = true;

    /*
      Broadcast channel:
      hanya creator/admin yang dianggap bisa kirim.
    */
    if (
      isChannel &&
      entity.className === "Channel" &&
      entity.broadcast
    ) {
      canSend = false;

      try {
        const me = await c.getInputEntity("me");

        const participant = await c.invoke(
          new Api.channels.GetParticipant({
            channel: entity,
            userId: me
          })
        );

        const p = participant.participant;

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

    /*
      Grup / supergroup
    */
    if (isGroup || (isChannel && !entity.broadcast)) {
      canSend = true;

      try {
        if (entity.className === "Channel") {
          const me = await c.getInputEntity("me");

          const participant = await c.invoke(
            new Api.channels.GetParticipant({
              channel: entity,
              userId: me
            })
          );

          const p = participant.participant;

          if (
            p?.className === "ChannelParticipantBanned" &&
            p.bannedRights?.sendMessages === true
          ) {
            canSend = false;
          }
        }
      } catch (_) {
        canSend = true;
      }
    }

    rows.push({
      user_id: u.id,
      telegram_group_id: String(
        entity.id?.value ?? entity.id
      ),
      title: d.title || entity.title || "Tanpa Nama",
      can_send: canSend
    });
  }

  if (rows.length) {
    const { error } = await sb
      .from("groups")
      .upsert(rows, {
        onConflict: "user_id,telegram_group_id"
      });

    if (error) throw error;
  }

  return rows;
}

async function getGroups(u, refresh = false) {
  if (refresh) {
    await refreshGroups(u);
  }

  const { data, error } = await sb
    .from("groups")
    .select("*")
    .eq("user_id", u.id)
    .order("title", {
      ascending: true
    });

  if (error) throw error;

  return data || [];
}

function groupKeyboard(rows) {
  const kb = new InlineKeyboard();

  for (const g of rows) {
    kb
      .text(
        `${g.enabled ? "✅" : "⬜"} ${String(g.title).slice(0, 35)}`,
        `group:toggle:${g.id}`
      )
      .row();
  }

  kb
    .text("🔄 Refresh Daftar", "group:refresh")
    .text("⬅️ Menu", "menu:user");

  return kb;
}

async function showGroups(ctx, refresh = false) {
  const u = await requireActive(ctx);

  if (!u) return;

  try {
    const rows = await getGroups(u, refresh);

    if (!rows.length) {
      return ctx.reply(
        "❌ Belum ada grup yang terbaca.\n\n" +
        "Pastikan akun Telegram yang terhubung sudah masuk ke grup tersebut.",
        {
          reply_markup: new InlineKeyboard()
            .text("🔄 Coba Refresh", "group:refresh")
            .row()
            .text("⬅️ Menu", "menu:user")
        }
      );
    }

    const enabled = rows.filter(x => x.enabled).length;

    return ctx.reply(
      `👥 <b>Daftar Grup</b>\n\n` +
      `Pilih tombol grup untuk ON/OFF.\n` +
      `Aktif: <b>${enabled}</b>/${rows.length}`,
      {
        parse_mode: "HTML",
        reply_markup: groupKeyboard(rows)
      }
    );
  } catch (e) {
    console.error("GROUP LIST:", e);

    return ctx.reply(
      `❌ Gagal mengambil grup: ${String(
        e.message || e
      ).slice(0, 500)}`
    );
  }
}

/* =========================
   CAMPAIGN
========================= */

async function latestCampaign(u) {
  const { data, error } = await sb
    .from("campaigns")
    .select("*")
    .eq("user_id", u.id)
    .order("created_at", {
      ascending: false
    })
    .limit(1);

  if (error) throw error;

  return data?.[0] || null;
}

function campaignFormatText(c) {
  if (!c) return "Belum ada format.";

  if (c.media_file_id) {
    if (c.caption) {
      return `🖼️ Foto + caption\n${String(c.caption).slice(0, 300)}`;
    }

    return "🖼️ Foto tanpa caption";
  }

  return `📝 Teks\n${String(c.message || "").slice(0, 300)}`;
}

function campaignStatusText(c) {
  if (!c) {
    return "Belum ada campaign.";
  }

  return [
    `📝 Format: ${campaignFormatText(c)}`,
    `⏱ Jeda: ${formatDuration(c.interval_seconds)}`,
    `📅 Durasi: ${formatDuration(c.duration_seconds)}`,
    `📌 Status: ${c.status}`,
    c.expires_at
      ? `⌛ Berakhir: ${new Date(c.expires_at).toLocaleString("id-ID")}`
      : ""
  ]
    .filter(Boolean)
    .join("\n");
}

/* =========================
   DOWNLOAD PHOTO FROM BOT
========================= */

async function downloadBotPhoto(fileId) {
  const file = await bot.api.getFile(fileId);

  if (!file?.file_path) {
    throw new Error("Telegram tidak mengembalikan file_path.");
  }

  const url =
    `https://api.telegram.org/file/bot` +
    `${process.env.BOT_TOKEN}/` +
    `${file.file_path}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Gagal download foto Telegram: HTTP ${response.status}`
    );
  }

  const arrayBuffer = await response.arrayBuffer();

  return Buffer.from(arrayBuffer);
}

/* =========================
   SEND CAMPAIGN
========================= */

async function fire(campaignId) {
  const { data: c, error: campaignError } = await sb
    .from("campaigns")
    .select("*")
    .eq("id", campaignId)
    .maybeSingle();

  if (campaignError) {
    console.error("CAMPAIGN LOAD:", campaignError);
    return;
  }

  if (!c || c.status !== "running") {
    return;
  }

  if (
    !c.expires_at ||
    new Date(c.expires_at) <= new Date()
  ) {
    await sb
      .from("campaigns")
      .update({
        status: "expired"
      })
      .eq("id", campaignId);

    timers.delete(campaignId);

    return;
  }

  const { data: u } = await sb
    .from("app_users")
    .select("*")
    .eq("id", c.user_id)
    .maybeSingle();

  if (!u || u.status !== "active") {
    return;
  }

  const cl = await clientFor(u);

  if (!cl) {
    console.error(
      `Campaign ${campaignId}: akun Telegram tidak terhubung.`
    );

    return;
  }

  const { data: links } = await sb
    .from("campaign_groups")
    .select("group_id,groups(*)")
    .eq("campaign_id", campaignId);

  let photoBuffer = null;

  /*
    Kalau format berupa foto,
    download sekali lalu dipakai untuk semua grup.
  */
  if (c.media_file_id) {
    try {
      photoBuffer = await downloadBotPhoto(
        c.media_file_id
      );
    } catch (e) {
      console.error(
        "DOWNLOAD PHOTO:",
        String(e.message || e)
      );

      return;
    }
  }

  for (const x of links || []) {
    const g = x.groups;

    if (
      !g?.enabled ||
      !g?.can_send
    ) {
      continue;
    }

    try {
      const target = await cl.getEntity(
        g.telegram_group_id
      );

      if (c.media_file_id && photoBuffer) {
        await cl.sendFile(target, {
          file: photoBuffer,
          caption: c.caption || ""
        });
      } else {
        await cl.sendMessage(target, {
          message: c.message || ""
        });
      }

      await sb.from("send_logs").insert({
        campaign_id: campaignId,
        user_id: c.user_id,
        group_id: g.id,
        status: "sent"
      });
    } catch (e) {
      console.error(
        `SEND GROUP ${g.id}:`,
        String(e.message || e)
      );

      await sb.from("send_logs").insert({
        campaign_id: campaignId,
        user_id: c.user_id,
        group_id: g.id,
        status: "error",
        error: String(
          e?.message || e
        ).slice(0, 1000)
      });
    }
  }
}

function schedule(campaignId, delay = 0) {
  if (timers.has(campaignId)) {
    clearTimeout(
      timers.get(campaignId)
    );
  }

  const handle = setTimeout(
    async () => {
      try {
        await fire(campaignId);
      } catch (e) {
        console.error(
          "CAMPAIGN:",
          e
        );
      }

      const { data } = await sb
        .from("campaigns")
        .select(
          "status,interval_seconds,expires_at"
        )
        .eq("id", campaignId)
        .maybeSingle();

      if (
        data?.status === "running" &&
        data.expires_at &&
        new Date(data.expires_at) > new Date()
      ) {
        schedule(
          campaignId,
          Math.max(
            1000,
            Number(data.interval_seconds || 60) *
              1000
          )
        );
      } else {
        timers.delete(campaignId);
      }
    },
    Math.max(0, delay)
  );

  timers.set(
    campaignId,
    handle
  );
}

/* =========================
   LOGIN WAITERS
========================= */

function waitForInput(
  userId,
  nextType,
  timeoutMs = 5 * 60 * 1000
) {
  return new Promise(
    (resolve, reject) => {
      const old = waiters.get(userId);

      if (old) {
        old.reject(
          new Error(
            "Login sebelumnya dibatalkan."
          )
        );
      }

      const timer = setTimeout(
        () => {
          waiters.delete(userId);
          flows.delete(userId);

          reject(
            new Error(
              "Waktu input habis. Silakan mulai login lagi."
            )
          );
        },
        timeoutMs
      );

      waiters.set(userId, {
        type: nextType,

        resolve: value => {
          clearTimeout(timer);
          waiters.delete(userId);
          resolve(value);
        },

        reject: err => {
          clearTimeout(timer);
          waiters.delete(userId);
          reject(err);
        }
      });
    }
  );
}

async function startLogin(
  ctx,
  u,
  phone
) {
  const botUserId = ctx.from.id;

  const c = await createTelegramClient("");

  await c.connect();

  try {
    await c.start({
      phoneNumber: async () => phone,

      phoneCode: async () => {
        flows.set(
          botUserId,
          { t: "code" }
        );

        await bot.api.sendMessage(
          botUserId,
          "📩 Kode Telegram sudah dikirim.\nBalas dengan kode OTP."
        );

        return await waitForInput(
          botUserId,
          "code"
        );
      },

      password: async () => {
        flows.set(
          botUserId,
          { t: "password" }
        );

        await bot.api.sendMessage(
          botUserId,
          "🔐 Akun memakai verifikasi 2 langkah.\nBalas dengan password Telegram kamu."
        );

        return await waitForInput(
          botUserId,
          "password"
        );
      },

      onError: async err => {
        console.error(
          "LOGIN ERROR:",
          String(
            err?.message || err
          )
        );
      }
    });

    const sessionString =
      c.session.save();

    const { error } = await sb
      .from("telegram_sessions")
      .upsert(
        {
          user_id: u.id,
          session_string: sessionString,
          status: "connected",
          phone,
          updated_at:
            new Date().toISOString()
        },
        {
          onConflict: "user_id"
        }
      );

    if (error) {
      throw error;
    }

    clients.set(
      u.id,
      c
    );

    flows.delete(
      botUserId
    );

    await ctx.reply(
      "✅ Akun Telegram berhasil terhubung dan sesi disimpan.\n\n" +
      "Bot tidak akan logout hanya karena server restart.",
      {
        reply_markup:
          userMenu()
      }
    );
  } catch (e) {
    flows.delete(
      botUserId
    );

    try {
      await c.disconnect();
    } catch (_) {}

    throw e;
  }
}

/* =========================
   START
========================= */

bot.command(
  "start",
  async ctx => {
    try {
      if (admin(ctx.from.id)) {
        return ctx.reply(
          "🛠 <b>Admin Dashboard</b>",
          {
            parse_mode: "HTML",
            reply_markup:
              adminMenu()
          }
        );
      }

      const u =
        await getUser(
          ctx.from.id
        );

      if (
        u?.status === "active"
      ) {
        return ctx.reply(
          "👤 <b>FARIS STORE — User Panel</b>\nPilih menu di bawah:",
          {
            parse_mode: "HTML",
            reply_markup:
              userMenu()
          }
        );
      }

      return ctx.reply(
        "Kirim Telegram ID kamu ke admin untuk diaktifkan."
      );
    } catch (e) {
      console.error(
        "START:",
        e
      );

      return ctx.reply(
        "❌ Terjadi kesalahan saat membuka menu."
      );
    }
  }
);

/* =========================
   USER MENU
========================= */

bot.callbackQuery(
  "menu:user",
  async ctx => {
    await ctx.answerCallbackQuery();

    const u =
      await requireActive(ctx);

    if (!u) return;

    return ctx.editMessageText(
      "👤 <b>FARIS STORE — User Panel</b>\nPilih menu di bawah:",
      {
        parse_mode: "HTML",
        reply_markup:
          userMenu()
      }
    );
  }
);

/* =========================
   STATUS
========================= */

bot.callbackQuery(
  "status",
  async ctx => {
    await ctx.answerCallbackQuery();

    const u =
      await requireActive(ctx);

    if (!u) return;

    try {
      const c =
        await latestCampaign(u);

      const session =
        await sb
          .from("telegram_sessions")
          .select(
            "status,phone,updated_at"
          )
          .eq(
            "user_id",
            u.id
          )
          .maybeSingle();

      const groups =
        await getGroups(
          u,
          false
        );

      return ctx.reply(
        `📊 <b>Status Bot</b>\n\n` +
        `🔐 Akun: ${
          session.data?.status === "connected"
            ? "Terhubung"
            : "Belum terhubung"
        }\n` +
        `👥 Grup aktif: ${
          groups.filter(
            g =>
              g.enabled &&
              g.can_send
          ).length
        }/${groups.length}\n\n` +
        campaignStatusText(c),
        {
          parse_mode: "HTML",
          reply_markup:
            backMenu()
        }
      );
    } catch (e) {
      return ctx.reply(
        `❌ Gagal mengambil status: ${String(
          e.message || e
        ).slice(0, 500)}`
      );
    }
  }
);

/* =========================
   GROUP MENU
========================= */

bot.callbackQuery(
  "group:list",
  async ctx => {
    await ctx.answerCallbackQuery();

    return showGroups(
      ctx,
      false
    );
  }
);

bot.callbackQuery(
  "group:refresh",
  async ctx => {
    await ctx.answerCallbackQuery(
      "Memuat daftar grup..."
    );

    return showGroups(
      ctx,
      true
    );
  }
);

bot.callbackQuery(
  /^group:toggle:(\d+)$/,
  async ctx => {
    const u =
      await requireActive(ctx);

    if (!u) {
      return ctx.answerCallbackQuery();
    }

    const groupId =
      Number(ctx.match[1]);

    const { data: g, error } =
      await sb
        .from("groups")
        .select("*")
        .eq(
          "id",
          groupId
        )
        .eq(
          "user_id",
          u.id
        )
        .maybeSingle();

    if (error || !g) {
      return ctx.answerCallbackQuery(
        "Grup tidak ditemukan.",
        {
          show_alert: true
        }
      );
    }

    const {
      error: updateError
    } = await sb
      .from("groups")
      .update({
        enabled:
          !g.enabled
      })
      .eq(
        "id",
        g.id
      )
      .eq(
        "user_id",
        u.id
      );

    if (updateError) {
      return ctx.answerCallbackQuery(
        "Gagal menyimpan.",
        {
          show_alert: true
        }
      );
    }

    await ctx.answerCallbackQuery(
      g.enabled
        ? "Grup dinonaktifkan"
        : "Grup diaktifkan"
    );

    const rows =
      await getGroups(
        u,
        false
      );

    try {
      await ctx.editMessageReplyMarkup(
        {
          reply_markup:
            groupKeyboard(rows)
        }
      );
    } catch (_) {}
  }
);

/* =========================
   BUAT FORMAT
========================= */

bot.callbackQuery(
  "promo:message",
  async ctx => {
    await ctx.answerCallbackQuery();

    const u =
      await requireActive(ctx);

    if (!u) return;

    flows.set(
      ctx.from.id,
      {
        t: "message"
      }
    );

    return ctx.reply(
      "📝 <b>Buat Format Promosi</b>\n\n" +
      "Kirim salah satu:\n\n" +
      "• Teks biasa\n" +
      "• Foto saja\n" +
      "• Foto + caption\n\n" +
      "Pesan akan disimpan sebagai format promosi.",
      {
        parse_mode: "HTML",
        reply_markup:
          cancelMenu()
      }
    );
  }
);

/* =========================
   UBAH FORMAT
========================= */

bot.callbackQuery(
  "promo:edit",
  async ctx => {
    await ctx.answerCallbackQuery();

    const u =
      await requireActive(ctx);

    if (!u) return;

    try {
      const c =
        await latestCampaign(u);

      if (!c) {
        return ctx.reply(
          "❌ Belum ada format promosi.\n\n" +
          "Gunakan 📝 Buat Format terlebih dahulu.",
          {
            reply_markup:
              userMenu()
          }
        );
      }

      flows.set(
        ctx.from.id,
        {
          t: "message_edit",
          id: c.id
        }
      );

      return ctx.reply(
        "✏️ <b>Ubah Format Promosi</b>\n\n" +
        "Kirim format baru:\n\n" +
        "• Teks\n" +
        "• Foto\n" +
        "• Foto + caption\n\n" +
        "Format lama akan diganti.",
        {
          parse_mode: "HTML",
          reply_markup:
            cancelMenu()
        }
      );
    } catch (e) {
      return ctx.reply(
        `❌ Gagal membuka format: ${String(
          e.message || e
        ).slice(0, 500)}`
      );
    }
  }
);

/* =========================
   JEDA
========================= */

bot.callbackQuery(
  "promo:interval",
  async ctx => {
    await ctx.answerCallbackQuery();

    const u =
      await requireActive(ctx);

    if (!u) return;

    const c =
      await latestCampaign(u);

    if (!c) {
      return ctx.reply(
        "❌ Buat format promosi dulu.",
        {
          reply_markup:
            backMenu()
        }
      );
    }

    flows.set(
      ctx.from.id,
      {
        t: "interval",
        id: c.id
      }
    );

    return ctx.reply(
      "⏱ <b>Set Jeda</b>\n\n" +
      "Contoh:\n" +
      "• 10 detik\n" +
      "• 30 menit\n" +
      "• 1 jam\n\n" +
      "Minimal 10 detik.",
      {
        parse_mode: "HTML",
        reply_markup:
          cancelMenu()
      }
    );
  }
);

/* =========================
   DURASI
========================= */

bot.callbackQuery(
  "promo:duration",
  async ctx => {
    await ctx.answerCallbackQuery();

    const u =
      await requireActive(ctx);

    if (!u) return;

    const c =
      await latestCampaign(u);

    if (!c) {
      return ctx.reply(
        "❌ Buat format promosi dulu.",
        {
          reply_markup:
            backMenu()
        }
      );
    }

    flows.set(
      ctx.from.id,
      {
        t: "duration",
        id: c.id
      }
    );

    return ctx.reply(
      "📅 <b>Set Durasi</b>\n\n" +
      "Contoh:\n" +
      "• 3 hari\n" +
      "• 12 jam\n" +
      "• 30 menit",
      {
        parse_mode: "HTML",
        reply_markup:
          cancelMenu()
      }
    );
  }
);

/* =========================
   MULAI CAMPAIGN
========================= */

bot.callbackQuery(
  "campaign:start",
  async ctx => {
    await ctx.answerCallbackQuery();

    const u =
      await requireActive(ctx);

    if (!u) return;

    const c =
      await latestCampaign(u);

    if (!c) {
      return ctx.reply(
        "❌ Belum ada format promosi.",
        {
          reply_markup:
            backMenu()
        }
      );
    }

    if (!c.interval_seconds) {
      return ctx.reply(
        "❌ Set jeda terlebih dahulu.",
        {
          reply_markup:
            backMenu()
        }
      );
    }

    if (!c.duration_seconds) {
      return ctx.reply(
        "❌ Set hari/durasi terlebih dahulu.",
        {
          reply_markup:
            backMenu()
        }
      );
    }

    const {
      data: gs
    } = await sb
      .from("groups")
      .select("id")
      .eq(
        "user_id",
        u.id
      )
      .eq(
        "enabled",
        true
      )
      .eq(
        "can_send",
        true
      );

    if (!gs?.length) {
      return ctx.reply(
        "❌ Belum ada grup aktif.\n\n" +
        "Buka Add Group lalu aktifkan grup.",
        {
          reply_markup:
            backMenu()
        }
      );
    }

    const now =
      new Date();

    const exp =
      new Date(
        now.getTime() +
        Number(
          c.duration_seconds
        ) * 1000
      );

    await sb
      .from("campaign_groups")
      .delete()
      .eq(
        "campaign_id",
        c.id
      );

    const {
      error: linkError
    } = await sb
      .from("campaign_groups")
      .insert(
        gs.map(
          g => ({
            campaign_id:
              c.id,
            group_id:
              g.id
          })
        )
      );

    if (linkError) {
      return ctx.reply(
        `❌ Gagal menyimpan grup campaign:\n${String(
          linkError.message || linkError
        ).slice(0, 500)}`
      );
    }

    const {
      error
    } = await sb
      .from("campaigns")
      .update({
        status: "running",
        started_at:
          now.toISOString(),
        expires_at:
          exp.toISOString()
      })
      .eq(
        "id",
        c.id
      );

    if (error) {
      return ctx.reply(
        `❌ Gagal memulai campaign:\n${String(
          error.message || error
        ).slice(0, 500)}`
      );
    }

    schedule(
      c.id,
      0
    );

    return ctx.reply(
      "▶️ <b>Campaign dimulai.</b>\n\n" +
      "Pesan akan dikirim ke grup aktif sesuai jeda.",
      {
        parse_mode: "HTML",
        reply_markup:
          userMenu()
      }
    );
  }
);

/* =========================
   STOP
========================= */

bot.callbackQuery(
  "campaign:stop",
  async ctx => {
    await ctx.answerCallbackQuery();

    const u =
      await requireActive(ctx);

    if (!u) return;

    const {
      data
    } = await sb
      .from("campaigns")
      .select("id")
      .eq(
        "user_id",
        u.id
      )
      .eq(
        "status",
        "running"
      );

    for (const c of data || []) {
      if (timers.has(c.id)) {
        clearTimeout(
          timers.get(c.id)
        );
      }

      timers.delete(c.id);

      await sb
        .from("campaigns")
        .update({
          status: "stopped"
        })
        .eq(
          "id",
          c.id
        );
    }

    return ctx.reply(
      "⏹ Campaign dihentikan.",
      {
        reply_markup:
          userMenu()
      }
    );
  }
);

/* =========================
   LOGIN
========================= */

bot.callbackQuery(
  "account:login",
  async ctx => {
    await ctx.answerCallbackQuery();

    const u =
      await requireActive(ctx);

    if (!u) return;

    const existing =
      await sb
        .from("telegram_sessions")
        .select(
          "session_string,status,phone"
        )
        .eq(
          "user_id",
          u.id
        )
        .maybeSingle();

    if (
      existing.data?.session_string &&
      existing.data.status ===
        "connected"
    ) {
      return ctx.reply(
        "ℹ️ Sesi akun sudah tersimpan.\n\n" +
        "Jika akun masih terhubung, tidak perlu login ulang.",
        {
          reply_markup:
            userMenu()
        }
      );
    }

    flows.set(
      ctx.from.id,
      {
        t: "phone"
      }
    );

    return ctx.reply(
      "🔐 <b>Kirim nomor Telegram</b>\n\n" +
      "Contoh: <b>+628123456789</b>",
      {
        parse_mode: "HTML",
        reply_markup:
          cancelMenu()
      }
    );
  }
);

/* =========================
   CANCEL
========================= */

bot.callbackQuery(
  "flow:cancel",
  async ctx => {
    await ctx.answerCallbackQuery(
      "Dibatalkan"
    );

    flows.delete(
      ctx.from.id
    );

    const waiter =
      waiters.get(
        ctx.from.id
      );

    if (waiter) {
      waiter.reject(
        new Error(
          "Login dibatalkan."
        )
      );
    }

    return ctx.reply(
      "Menu utama.",
      {
        reply_markup:
          userMenu()
      }
    );
  }
);

/* =========================
   ADMIN
========================= */

bot.callbackQuery(
  "admin:add",
  async ctx => {
    if (!admin(ctx.from.id)) {
      return ctx.answerCallbackQuery();
    }

    await ctx.answerCallbackQuery();

    flows.set(
      ctx.from.id,
      {
        t: "admin:add"
      }
    );

    return ctx.reply(
      "Kirim numeric Telegram ID user."
    );
  }
);

bot.callbackQuery(
  "admin:total",
  async ctx => {
    if (!admin(ctx.from.id)) {
      return ctx.answerCallbackQuery();
    }

    await ctx.answerCallbackQuery();

    const {
      count
    } = await sb
      .from("app_users")
      .select("*", {
        count: "exact",
        head: true
      });

    return ctx.reply(
      `👥 Total user: ${count || 0}`,
      {
        reply_markup:
          adminMenu()
      }
    );
  }
);

bot.callbackQuery(
  "admin:active",
  async ctx => {
    if (!admin(ctx.from.id)) {
      return ctx.answerCallbackQuery();
    }

    await ctx.answerCallbackQuery();

    const {
      data
    } = await sb
      .from("app_users")
      .select("*")
      .eq(
        "status",
        "active"
      );

    const text =
      data?.length
        ? data
            .map(
              (x, i) =>
                `${i + 1}. ${
                  x.first_name || "-"
                } | ${
                  x.telegram_user_id
                }`
            )
            .join("\n")
        : "Belum ada user aktif.";

    return ctx.reply(
      `🟢 <b>User Aktif</b>\n\n${text}`,
      {
        parse_mode: "HTML",
        reply_markup:
          adminMenu()
      }
    );
  }
);

bot.callbackQuery(
  "admin:disconnect",
  async ctx => {
    if (!admin(ctx.from.id)) {
      return ctx.answerCallbackQuery();
    }

    await ctx.answerCallbackQuery();

    flows.set(
      ctx.from.id,
      {
        t: "admin:disconnect"
      }
    );

    return ctx.reply(
      "Kirim Telegram ID user yang mau dinonaktifkan."
    );
  }
);

/* =========================
   MESSAGE HANDLER
   TEKS + FOTO
========================= */

bot.on(
  "message",
  async ctx => {
    const userId =
      ctx.from.id;

    const f =
      flows.get(userId);

    /*
      OTP / password login
    */
    const waiter =
      waiters.get(userId);

    if (
      waiter &&
      (
        waiter.type === "code" ||
        waiter.type === "password"
      )
    ) {
      if (
        !ctx.message.text
      ) {
        return ctx.reply(
          "❌ Kirim teks saja untuk input ini."
        );
      }

      const text =
        ctx.message.text.trim();

      if (!text) {
        return ctx.reply(
          "❌ Input kosong."
        );
      }

      waiter.resolve(
        text
      );

      return;
    }

    if (!f) return;

    try {
      /*
        ========================
        ADMIN ADD USER
        ========================
      */

      if (
        admin(userId) &&
        f.t === "admin:add"
      ) {
        if (!ctx.message.text) {
          return ctx.reply(
            "❌ Kirim Telegram ID berupa angka."
          );
        }

        const id =
          Number(
            ctx.message.text.trim()
          );

        if (
          !Number.isSafeInteger(id) ||
          id <= 0
        ) {
          return ctx.reply(
            "❌ ID Telegram tidak valid."
          );
        }

        const {
          error
        } = await sb
          .from("app_users")
          .upsert(
            {
              telegram_user_id:
                id,
              status:
                "active"
            },
            {
              onConflict:
                "telegram_user_id"
            }
          );

        if (error) {
          throw error;
        }

        flows.delete(
          userId
        );

        return ctx.reply(
          "✅ User berhasil diaktifkan.",
          {
            reply_markup:
              adminMenu()
          }
        );
      }

      /*
        ========================
        ADMIN DISCONNECT
        ========================
      */

      if (
        admin(userId) &&
        f.t === "admin:disconnect"
      ) {
        if (!ctx.message.text) {
          return ctx.reply(
            "❌ Kirim Telegram ID user."
          );
        }

        const target =
          await getUser(
            Number(
              ctx.message.text.trim()
            )
          );

        if (!target) {
          return ctx.reply(
            "❌ User tidak ditemukan."
          );
        }

        const c =
          clients.get(
            target.id
          );

        if (c) {
          try {
            await c.disconnect();
          } catch (_) {}

          clients.delete(
            target.id
          );
        }

        await sb
          .from("telegram_sessions")
          .update({
            status:
              "disconnected"
          })
          .eq(
            "user_id",
            target.id
          );

        await sb
          .from("app_users")
          .update({
            status:
              "disabled"
          })
          .eq(
            "id",
            target.id
          );

        flows.delete(
          userId
        );

        return ctx.reply(
          "✅ User diputuskan.",
          {
            reply_markup:
              adminMenu()
          }
        );
      }

      /*
        ========================
        USER ACTIVE
        ========================
      */

      const u =
        await requireActive(ctx);

      if (!u) {
        flows.delete(
          userId
        );

        return;
      }

      /*
        ========================
        BUAT / UBAH FORMAT
        ========================
      */

      if (
        f.t === "message" ||
        f.t === "message_edit"
      ) {
        const isEdit =
          f.t === "message_edit";

        /*
          FOTO
        */
        if (
          ctx.message.photo &&
          ctx.message.photo.length
        ) {
          const photo =
            ctx.message.photo[
              ctx.message.photo.length - 1
            ];

          const caption =
            ctx.message.caption || "";

          let query;

          if (isEdit) {
            query =
              sb
                .from("campaigns")
                .update({
                  message:
                    "",
                  media_type:
                    "photo",
                  media_file_id:
                    photo.file_id,
                  caption:
                    caption
                })
                .eq(
                  "id",
                  f.id
                )
                .eq(
                  "user_id",
                  u.id
                );
          } else {
            query =
              sb
                .from("campaigns")
                .insert({
                  user_id:
                    u.id,
                  message:
                    "",
                  media_type:
                    "photo",
                  media_file_id:
                    photo.file_id,
                  caption:
                    caption
                });
          }

          const {
            error
          } = await query;

          if (error) {
            throw error;
          }

          flows.delete(
            userId
          );

          return ctx.reply(
            isEdit
              ? "✅ Format foto berhasil diubah."
              : "✅ Format foto berhasil disimpan.",
            {
              reply_markup:
                userMenu()
            }
          );
        }

        /*
          TEKS
        */
        if (
          ctx.message.text
        ) {
          const text =
            ctx.message.text.trim();

          if (!text) {
            return ctx.reply(
              "❌ Format promosi tidak boleh kosong."
            );
          }

          let query;

          if (isEdit) {
            query =
              sb
                .from("campaigns")
                .update({
                  message:
                    text,
                  media_type:
                    null,
                  media_file_id:
                    null,
                  caption:
                    null
                })
                .eq(
                  "id",
                  f.id
                )
                .eq(
                  "user_id",
                  u.id
                );
          } else {
            query =
              sb
                .from("campaigns")
                .insert({
                  user_id:
                    u.id,
                  message:
                    text,
                  media_type:
                    null,
                  media_file_id:
                    null,
                  caption:
                    null
                });
          }

          const {
            error
          } = await query;

          if (error) {
            throw error;
          }

          flows.delete(
            userId
          );

          return ctx.reply(
            isEdit
              ? "✅ Format teks berhasil diubah."
              : "✅ Format teks berhasil disimpan.",
            {
              reply_markup:
                userMenu()
            }
          );
        }

        /*
          Pesan lain tidak didukung
        */
        return ctx.reply(
          "❌ Format tidak didukung.\n\n" +
          "Kirim teks atau foto + caption."
        );
      }

      /*
        ========================
        SET JEDA
        ========================
      */

      if (
        f.t === "interval"
      ) {
        if (!ctx.message.text) {
          return ctx.reply(
            "❌ Kirim jeda dalam bentuk teks.\nContoh: 1 jam"
          );
        }

        const seconds =
          parseSeconds(
            ctx.message.text
          );

        if (
          !seconds ||
          seconds < 10
        ) {
          return ctx.reply(
            "❌ Format jeda tidak valid.\n\n" +
            "Minimal 10 detik.\n" +
            "Contoh: 10 detik / 30 menit / 1 jam."
          );
        }

        const c =
          await latestCampaign(
            u
          );

        if (!c) {
          return ctx.reply(
            "❌ Buat format promosi dulu."
          );
        }

        const {
          error
        } = await sb
          .from("campaigns")
          .update({
            interval_seconds:
              seconds
          })
          .eq(
            "id",
            c.id
          );

        if (error) {
          throw error;
        }

        flows.delete(
          userId
        );

        return ctx.reply(
          "✅ Jeda disimpan.",
          {
            reply_markup:
              userMenu()
          }
        );
      }

      /*
        ========================
        SET DURASI
        ========================
      */

      if (
        f.t === "duration"
      ) {
        if (!ctx.message.text) {
          return ctx.reply(
            "❌ Kirim durasi dalam bentuk teks."
          );
        }

        const seconds =
          parseSeconds(
            ctx.message.text
          );

        if (!seconds) {
          return ctx.reply(
            "❌ Format durasi tidak valid.\n\n" +
            "Contoh: 3 hari / 12 jam."
          );
        }

        const {
          error
        } = await sb
          .from("campaigns")
          .update({
            duration_seconds:
              seconds
          })
          .eq(
            "id",
            f.id
          );

        if (error) {
          throw error;
        }

        flows.delete(
          userId
        );

        return ctx.reply(
          "✅ Durasi disimpan.",
          {
            reply_markup:
              userMenu()
          }
        );
      }

      /*
        ========================
        LOGIN PHONE
        ========================
      */

      if (
        f.t === "phone"
      ) {
        if (!ctx.message.text) {
          return ctx.reply(
            "❌ Kirim nomor Telegram dalam bentuk teks."
          );
        }

        const phone =
          ctx.message.text.trim();

        if (
          !/^\+\d{7,15}$/.test(
            phone
          )
        ) {
          return ctx.reply(
            "❌ Nomor tidak valid.\n\n" +
            "Gunakan format internasional.\n" +
            "Contoh: +628123456789"
          );
        }

        flows.delete(
          userId
        );

        await startLogin(
          ctx,
          u,
          phone
        );

        return;
      }
    } catch (e) {
      console.error(
        "MESSAGE FLOW:",
        e
      );

      flows.delete(
        userId
      );

      return ctx.reply(
        `❌ ${String(
          e.message || e
        ).slice(0, 700)}`,
        {
          reply_markup:
            userMenu()
        }
      );
    }
  }
);

/* =========================
   RESTORE
========================= */

async function restoreRunningCampaigns() {
  const {
    data,
    error
  } = await sb
    .from("campaigns")
    .select("id")
    .eq(
      "status",
      "running"
    );

  if (error) {
    throw error;
  }

  for (const c of data || []) {
    schedule(
      c.id,
      0
    );
  }
}

async function restoreSessions() {
  const {
    data,
    error
  } = await sb
    .from("telegram_sessions")
    .select(
      "user_id,session_string,status"
    )
    .eq(
      "status",
      "connected"
    );

  if (error) {
    throw error;
  }

  for (const row of data || []) {
    const {
      data: u
    } = await sb
      .from("app_users")
      .select("*")
      .eq(
        "id",
        row.user_id
      )
      .maybeSingle();

    if (
      !u ||
      u.status !== "active"
    ) {
      continue;
    }

    try {
      const c =
        await createTelegramClient(
          row.session_string
        );

      await c.connect();

      if (
        await c.checkAuthorization()
      ) {
        clients.set(
          u.id,
          c
        );
      } else {
        console.warn(
          `Session ${u.id} is not authorized; saved session retained.`
        );

        try {
          await c.disconnect();
        } catch (_) {}
      }
    } catch (e) {
      console.warn(
        `Session ${u.id} reconnect failed:`,
        String(
          e.message || e
        )
      );
    }
  }
}

/* =========================
   BOT START
========================= */

bot.catch(
  err =>
    console.error(
      "BOT:",
      err.error || err
    )
);

(async () => {
  await restoreSessions();
  await restoreRunningCampaigns();

  await bot.start();

  console.log(
    "Telegram bot started."
  );
})().catch(
  err => {
    console.error(
      "FATAL:",
      err
    );

    process.exit(1);
  }
);

/* =========================
   HTTP SERVER
========================= */

const app =
  express();

app.get(
  "/",
  (_, res) =>
    res.json({
      ok: true,
      service:
        "telegram-auto-bot"
    })
);

app.listen(
  Number(
    process.env.PORT || 3000
  ),
  () => {
    console.log(
      `HTTP server listening on ${
        process.env.PORT || 3000
      }`
    );
  }
);

/* =========================
   SHUTDOWN
========================= */

process.once(
  "SIGINT",
  () => {
    for (
      const handle
      of timers.values()
    ) {
      clearTimeout(handle);
    }

    process.exit(0);
  }
);

process.once(
  "SIGTERM",
  () => {
    for (
      const handle
      of timers.values()
    ) {
      clearTimeout(handle);
    }

    process.exit(0);
  }
);