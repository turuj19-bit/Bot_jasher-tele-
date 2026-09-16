require("dotenv").config();

const express = require("express");
const { Bot, InlineKeyboard } = require("grammy");
const { createClient } = require("@supabase/supabase-js");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || "").split(",").map(x => x.trim()).filter(Boolean)
);

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const bot = new Bot(process.env.BOT_TOKEN);
const clients = new Map();          // app_user.id -> GramJS client
const flows = new Map();            // Telegram bot user id -> current UI flow
const waiters = new Map();          // Telegram bot user id -> login input resolver
const timers = new Map();           // campaign id -> timeout

const admin = id => ADMIN_IDS.has(String(id));

function userMenu() {
  return new InlineKeyboard()
    .text("➕ Add Group", "group:list")
    .text("📝 Promosi", "promo:message")
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

function formatDuration(seconds) {
  const s = Number(seconds || 0);
  if (s % 86400 === 0) return `${s / 86400} hari`;
  if (s % 3600 === 0) return `${s / 3600} jam`;
  if (s % 60 === 0) return `${s / 60} menit`;
  return `${s} detik`;
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

function parseSeconds(value) {
  const m = String(value || "").trim().toLowerCase()
    .match(/^(\d+(?:\.\d+)?)\s*(detik|menit|jam|hari|s|m|h|d)$/);

  if (!m) return null;

  const unit = {
    detik: 1, s: 1,
    menit: 60, m: 60,
    jam: 3600, h: 3600,
    hari: 86400, d: 86400
  }[m[2]];

  const seconds = Math.round(Number(m[1]) * unit);
  return Number.isFinite(seconds) ? seconds : null;
}

async function createTelegramClient(sessionString = "") {
  const c = new TelegramClient(
    new StringSession(sessionString || ""),
    Number(process.env.API_ID),
    process.env.API_HASH,
    {
      connectionRetries: 10,
      retryDelay: 2000,
      useWSS: false
    }
  );
  return c;
}

async function clientFor(u) {
  if (!u) return null;

  let c = clients.get(u.id);
  if (c) {
    try {
      if (!c.connected) await c.connect();
      if (await c.checkAuthorization()) return c;
    } catch (_) {
      // Recreate below. The saved session is intentionally kept in Supabase.
    }
  }

  const { data, error } = await sb
    .from("telegram_sessions")
    .select("*")
    .eq("user_id", u.id)
    .maybeSingle();

  if (error) throw error;
  if (!data?.session_string) return null;

  c = await createTelegramClient(data.session_string);

  try {
    await c.connect();
    if (!(await c.checkAuthorization())) {
      // Do NOT delete or overwrite the saved session on a temporary failure.
      return null;
    }
    clients.set(u.id, c);
    return c;
  } catch (e) {
    try { await c.disconnect(); } catch (_) {}
    return null;
  }
}

async function refreshGroups(u) {
  const c = await clientFor(u);
  if (!c) throw new Error("Akun Telegram belum terhubung. Silakan kaitkan akun lagi.");

  const dialogs = await c.getDialogs({ limit: 500 });
  const rows = [];

  for (const d of dialogs) {
    const entity = d.entity;
    if (!entity) continue;

    const isGroup = Boolean(d.isGroup);
    const isChannel = Boolean(d.isChannel);
    if (!isGroup && !isChannel) continue;

    let canSend = true;

    // Broadcast channels require admin/creator rights.
    if (isChannel && entity.className === "Channel" && entity.broadcast) {
      canSend = false;
      try {
        const me = await c.getInputEntity("me");
        const participant = await c.getParticipants(entity, { limit: 1, filter: undefined });
        const mine = participant.find(p => String(p.id?.value ?? p.id) === String(me.userId?.value ?? me.userId));
        if (mine?.className === "ChannelParticipantCreator" ||
            mine?.className === "ChannelParticipantAdmin") {
          canSend = true;
        }
      } catch (_) {
        // Keep false for channels where rights cannot be confirmed.
      }
    }

    // For normal groups/supergroups, verify by attempting to inspect permissions.
    if (isGroup || (isChannel && !entity.broadcast)) {
      canSend = true;
      try {
        if (entity.className === "Channel") {
          const me = await c.getInputEntity("me");
          const participant = await c.invoke(
            new (require("telegram").Api.channels.GetParticipant)({
              channel: entity,
              userId: me
            })
          );
          const p = participant.participant;
          if (p?.className === "ChannelParticipantBanned" &&
              p.bannedRights?.sendMessages === true) {
            canSend = false;
          }
        }
      } catch (_) {
        // If Telegram does not expose participant details, keep the group listed.
        canSend = true;
      }
    }

    rows.push({
      user_id: u.id,
      telegram_group_id: String(entity.id?.value ?? entity.id),
      title: d.title || entity.title || "Tanpa Nama",
      can_send: canSend
    });
  }

  if (rows.length) {
    const { error } = await sb
      .from("groups")
      .upsert(rows, { onConflict: "user_id,telegram_group_id" });
    if (error) throw error;
  }

  return rows;
}

async function getGroups(u, refresh = false) {
  if (refresh) await refreshGroups(u);

  const { data, error } = await sb
    .from("groups")
    .select("*")
    .eq("user_id", u.id)
    .order("title", { ascending: true });

  if (error) throw error;
  return data || [];
}

function groupKeyboard(rows) {
  const kb = new InlineKeyboard();

  for (const g of rows) {
    kb.text(
      `${g.enabled ? "✅" : "⬜"} ${String(g.title).slice(0, 35)}`,
      `group:toggle:${g.id}`
    ).row();
  }

  kb.text("🔄 Refresh Daftar", "group:refresh")
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
        "❌ Belum ada grup yang terbaca.\n\nPastikan akun Telegram yang terhubung sudah masuk ke grup tersebut.",
        { reply_markup: new InlineKeyboard().text("🔄 Coba Refresh", "group:refresh").row().text("⬅️ Menu", "menu:user") }
      );
    }

    const enabled = rows.filter(x => x.enabled).length;
    return ctx.reply(
      `👥 <b>Daftar Grup</b>\n\nPilih tombol grup untuk ON/OFF.\nAktif: <b>${enabled}</b>/${rows.length}`,
      { parse_mode: "HTML", reply_markup: groupKeyboard(rows) }
    );
  } catch (e) {
    console.error("GROUP LIST:", e);
    return ctx.reply(`❌ Gagal mengambil grup: ${String(e.message || e).slice(0, 500)}`);
  }
}

async function latestCampaign(u) {
  const { data, error } = await sb
    .from("campaigns")
    .select("*")
    .eq("user_id", u.id)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) throw error;
  return data?.[0] || null;
}

function campaignStatusText(c) {
  if (!c) return "Belum ada campaign.";

  return [
    `📝 Format: ${String(c.message).slice(0, 300)}`,
    `⏱ Jeda: ${formatDuration(c.interval_seconds)}`,
    `📅 Durasi: ${formatDuration(c.duration_seconds)}`,
    `📌 Status: ${c.status}`,
    c.expires_at ? `⌛ Berakhir: ${new Date(c.expires_at).toLocaleString("id-ID")}` : ""
  ].filter(Boolean).join("\n");
}

async function showStatus(ctx) {
  const u = await requireActive(ctx);
  if (!u) return;

  try {
    const c = await latestCampaign(u);
    const session = await sb.from("telegram_sessions").select("status,phone,updated_at").eq("user_id", u.id).maybeSingle();
    const groups = await getGroups(u, false);

    await ctx.reply(
      `📊 <b>Status Bot</b>\n\n` +
      `🔐 Akun: ${session.data?.status === "connected" ? "Terhubung" : "Belum terhubung"}\n` +
      `👥 Grup aktif: ${groups.filter(g => g.enabled && g.can_send).length}/${groups.length}\n\n` +
      campaignStatusText(c),
      { parse_mode: "HTML", reply_markup: backMenu() }
    );
  } catch (e) {
    await ctx.reply(`❌ Gagal mengambil status: ${String(e.message || e).slice(0, 500)}`);
  }
}

async function fire(campaignId) {
  const { data: c } = await sb.from("campaigns").select("*").eq("id", campaignId).maybeSingle();
  if (!c || c.status !== "running") return;

  if (!c.expires_at || new Date(c.expires_at) <= new Date()) {
    await sb.from("campaigns").update({ status: "expired" }).eq("id", campaignId);
    timers.delete(campaignId);
    return;
  }

  const { data: u } = await sb.from("app_users").select("*").eq("id", c.user_id).maybeSingle();
  if (!u || u.status !== "active") return;

  const cl = await clientFor(u);
  if (!cl) return;

  const { data: links } = await sb
    .from("campaign_groups")
    .select("group_id,groups(*)")
    .eq("campaign_id", campaignId);

  for (const x of links || []) {
    const g = x.groups;
    if (!g?.enabled || !g?.can_send) continue;

    try {
      const target = await cl.getEntity(g.telegram_group_id);
      await cl.sendMessage(target, { message: c.message });
      await sb.from("send_logs").insert({
        campaign_id: campaignId,
        user_id: c.user_id,
        group_id: g.id,
        status: "sent"
      });
    } catch (e) {
      await sb.from("send_logs").insert({
        campaign_id: campaignId,
        user_id: c.user_id,
        group_id: g.id,
        status: "error",
        error: String(e?.message || e).slice(0, 1000)
      });
    }
  }
}

function schedule(campaignId, delay = 0) {
  if (timers.has(campaignId)) clearTimeout(timers.get(campaignId));

  const handle = setTimeout(async () => {
    try {
      await fire(campaignId);
    } catch (e) {
      console.error("CAMPAIGN:", e);
    }

    const { data } = await sb
      .from("campaigns")
      .select("status,interval_seconds,expires_at")
      .eq("id", campaignId)
      .maybeSingle();

    if (data?.status === "running" &&
        data.expires_at &&
        new Date(data.expires_at) > new Date()) {
      schedule(campaignId, Math.max(1000, Number(data.interval_seconds) * 1000));
    } else {
      timers.delete(campaignId);
    }
  }, Math.max(0, delay));

  timers.set(campaignId, handle);
}

function waitForInput(userId, nextType, timeoutMs = 5 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const old = waiters.get(userId);
    if (old) old.reject(new Error("Login sebelumnya dibatalkan."));

    const timer = setTimeout(() => {
      waiters.delete(userId);
      flows.delete(userId);
      reject(new Error("Waktu input habis. Silakan mulai login lagi."));
    }, timeoutMs);

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
  });
}

async function startLogin(ctx, u, phone) {
  const botUserId = ctx.from.id;
  const c = await createTelegramClient("");
  await c.connect();

  try {
    await c.start({
      phoneNumber: async () => phone,
      phoneCode: async () => {
        flows.set(botUserId, { t: "code" });
        await bot.api.sendMessage(botUserId, "📩 Kode Telegram sudah dikirim. Balas dengan kode OTP.");
        return await waitForInput(botUserId, "code");
      },
      password: async () => {
        flows.set(botUserId, { t: "password" });
        await bot.api.sendMessage(botUserId, "🔐 Akun memakai verifikasi 2 langkah. Balas dengan password Telegram kamu.");
        return await waitForInput(botUserId, "password");
      },
      onError: async err => {
        console.error("LOGIN ERROR:", String(err?.message || err));
      }
    });

    const sessionString = c.session.save();

    const { error } = await sb.from("telegram_sessions").upsert({
      user_id: u.id,
      session_string: sessionString,
      status: "connected",
      phone,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id" });

    if (error) throw error;

    clients.set(u.id, c);
    flows.delete(botUserId);

    await ctx.reply("✅ Akun Telegram berhasil terhubung dan sesi disimpan.\nBot tidak akan logout hanya karena server restart.", {
      reply_markup: userMenu()
    });
  } catch (e) {
    flows.delete(botUserId);
    try { await c.disconnect(); } catch (_) {}
    throw e;
  }
}

bot.command("start", async ctx => {
  try {
    if (admin(ctx.from.id)) {
      return ctx.reply("🛠 <b>Admin Dashboard</b>", {
        parse_mode: "HTML",
        reply_markup: adminMenu()
      });
    }

    const u = await getUser(ctx.from.id);
    if (u?.status === "active") {
      return ctx.reply("👤 <b>FARIS STORE — User Panel</b>\nPilih menu di bawah:", {
        parse_mode: "HTML",
        reply_markup: userMenu()
      });
    }

    return ctx.reply("Kirim Telegram ID kamu ke admin untuk diaktifkan.");
  } catch (e) {
    console.error("START:", e);
    return ctx.reply("❌ Terjadi kesalahan saat membuka menu.");
  }
});

bot.callbackQuery("menu:user", async ctx => {
  await ctx.answerCallbackQuery();
  const u = await requireActive(ctx);
  if (!u) return;
  return ctx.editMessageText("👤 <b>FARIS STORE — User Panel</b>\nPilih menu di bawah:", {
    parse_mode: "HTML",
    reply_markup: userMenu()
  });
});

bot.callbackQuery("status", async ctx => {
  await ctx.answerCallbackQuery();
  return showStatus(ctx);
});

bot.callbackQuery("group:list", async ctx => {
  await ctx.answerCallbackQuery();
  return showGroups(ctx, false);
});

bot.callbackQuery("group:refresh", async ctx => {
  await ctx.answerCallbackQuery("Memuat daftar grup...");
  return showGroups(ctx, true);
});

bot.callbackQuery(/^group:toggle:(\d+)$/, async ctx => {
  const u = await requireActive(ctx);
  if (!u) return ctx.answerCallbackQuery();

  const groupId = Number(ctx.match[1]);
  const { data: g, error } = await sb.from("groups").select("*").eq("id", groupId).eq("user_id", u.id).maybeSingle();
  if (error || !g) return ctx.answerCallbackQuery("Grup tidak ditemukan.", { show_alert: true });

  const { error: updateError } = await sb
    .from("groups")
    .update({ enabled: !g.enabled })
    .eq("id", g.id)
    .eq("user_id", u.id);

  if (updateError) return ctx.answerCallbackQuery("Gagal menyimpan.", { show_alert: true });

  await ctx.answerCallbackQuery(g.enabled ? "Grup dinonaktifkan" : "Grup diaktifkan");
  const rows = await getGroups(u, false);

  try {
    await ctx.editMessageReplyMarkup({ reply_markup: groupKeyboard(rows) });
  } catch (_) {}
});

bot.callbackQuery("promo:message", async ctx => {
  await ctx.answerCallbackQuery();
  const u = await requireActive(ctx);
  if (!u) return;
  flows.set(ctx.from.id, { t: "message" });
  return ctx.reply("📝 Kirim format promosi kamu sekarang.\n\nTeks akan disimpan persis sebagai isi pesan.", {
    reply_markup: new InlineKeyboard().text("❌ Batal", "flow:cancel")
  });
});

bot.callbackQuery("promo:interval", async ctx => {
  await ctx.answerCallbackQuery();
  const u = await requireActive(ctx);
  if (!u) return;
  const c = await latestCampaign(u);
  if (!c) return ctx.reply("❌ Buat format promosi dulu.", { reply_markup: backMenu() });
  flows.set(ctx.from.id, { t: "interval", id: c.id });
  return ctx.reply("⏱ Kirim jeda.\nContoh: <b>1 jam</b>, <b>30 menit</b>, atau <b>10 detik</b>.", {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard().text("❌ Batal", "flow:cancel")
  });
});

bot.callbackQuery("promo:duration", async ctx => {
  await ctx.answerCallbackQuery();
  const u = await requireActive(ctx);
  if (!u) return;
  const c = await latestCampaign(u);
  if (!c) return ctx.reply("❌ Buat format promosi dulu.", { reply_markup: backMenu() });
  flows.set(ctx.from.id, { t: "duration", id: c.id });
  return ctx.reply("📅 Kirim durasi.\nContoh: <b>3 hari</b>, <b>12 jam</b>.", {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard().text("❌ Batal", "flow:cancel")
  });
});

bot.callbackQuery("campaign:start", async ctx => {
  await ctx.answerCallbackQuery();
  const u = await requireActive(ctx);
  if (!u) return;

  const c = await latestCampaign(u);
  if (!c) return ctx.reply("❌ Belum ada format promosi.", { reply_markup: backMenu() });

  const { data: gs } = await sb
    .from("groups")
    .select("id")
    .eq("user_id", u.id)
    .eq("enabled", true)
    .eq("can_send", true);

  if (!gs?.length) {
    return ctx.reply("❌ Belum ada grup aktif. Buka Add Group lalu tekan grup yang ingin diaktifkan.", {
      reply_markup: backMenu()
    });
  }

  const now = new Date();
  const exp = new Date(now.getTime() + Number(c.duration_seconds) * 1000);

  await sb.from("campaign_groups").delete().eq("campaign_id", c.id);

  const { error: linkError } = await sb
    .from("campaign_groups")
    .insert(gs.map(g => ({ campaign_id: c.id, group_id: g.id })));

  if (linkError) return ctx.reply("❌ Gagal menyimpan grup campaign.");

  const { error } = await sb
    .from("campaigns")
    .update({
      status: "running",
      started_at: now.toISOString(),
      expires_at: exp.toISOString()
    })
    .eq("id", c.id);

  if (error) return ctx.reply("❌ Gagal memulai campaign.");

  schedule(c.id, 0);
  return ctx.reply("▶️ <b>Campaign dimulai.</b>\nPesan akan dikirim ke grup yang aktif sesuai jeda.", {
    parse_mode: "HTML",
    reply_markup: userMenu()
  });
});

bot.callbackQuery("campaign:stop", async ctx => {
  await ctx.answerCallbackQuery();
  const u = await requireActive(ctx);
  if (!u) return;

  const { data } = await sb
    .from("campaigns")
    .select("id")
    .eq("user_id", u.id)
    .eq("status", "running");

  for (const c of data || []) {
    if (timers.has(c.id)) clearTimeout(timers.get(c.id));
    timers.delete(c.id);
    await sb.from("campaigns").update({ status: "stopped" }).eq("id", c.id);
  }

  return ctx.reply("⏹ Campaign dihentikan.", { reply_markup: userMenu() });
});

bot.callbackQuery("account:login", async ctx => {
  await ctx.answerCallbackQuery();
  const u = await requireActive(ctx);
  if (!u) return;

  const existing = await sb.from("telegram_sessions").select("session_string,status,phone").eq("user_id", u.id).maybeSingle();

  if (existing.data?.session_string && existing.data.status === "connected") {
    return ctx.reply("ℹ️ Sesi akun sudah tersimpan. Jika akun masih terhubung, tidak perlu login ulang.", {
      reply_markup: userMenu()
    });
  }

  flows.set(ctx.from.id, { t: "phone" });
  return ctx.reply("🔐 Kirim nomor Telegram.\nContoh: <b>+628123456789</b>", {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard().text("❌ Batal", "flow:cancel")
  });
});

bot.callbackQuery("flow:cancel", async ctx => {
  await ctx.answerCallbackQuery("Dibatalkan");
  flows.delete(ctx.from.id);

  const waiter = waiters.get(ctx.from.id);
  if (waiter) waiter.reject(new Error("Login dibatalkan."));

  const u = await getUser(ctx.from.id);
  if (!u?.status === "active") return;
  return ctx.reply("Menu utama.", { reply_markup: userMenu() });
});

bot.callbackQuery("admin:add", async ctx => {
  if (!admin(ctx.from.id)) return ctx.answerCallbackQuery();
  await ctx.answerCallbackQuery();
  flows.set(ctx.from.id, { t: "admin:add" });
  return ctx.reply("Kirim numeric Telegram ID user.");
});

bot.callbackQuery("admin:total", async ctx => {
  if (!admin(ctx.from.id)) return ctx.answerCallbackQuery();
  await ctx.answerCallbackQuery();
  const { count } = await sb.from("app_users").select("*", { count: "exact", head: true });
  return ctx.reply(`👥 Total user: ${count || 0}`, { reply_markup: adminMenu() });
});

bot.callbackQuery("admin:active", async ctx => {
  if (!admin(ctx.from.id)) return ctx.answerCallbackQuery();
  await ctx.answerCallbackQuery();

  const { data } = await sb.from("app_users").select("*").eq("status", "active");
  const text = data?.length
    ? data.map((x, i) => `${i + 1}. ${x.first_name || "-"} | ${x.telegram_user_id}`).join("\n")
    : "Belum ada user aktif.";

  return ctx.reply(`🟢 <b>User Aktif</b>\n\n${text}`, {
    parse_mode: "HTML",
    reply_markup: adminMenu()
  });
});

bot.callbackQuery("admin:disconnect", async ctx => {
  if (!admin(ctx.from.id)) return ctx.answerCallbackQuery();
  await ctx.answerCallbackQuery();
  flows.set(ctx.from.id, { t: "admin:disconnect" });
  return ctx.reply("Kirim Telegram ID user yang mau dinonaktifkan.");
});

bot.on("message:text", async ctx => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();
  const f = flows.get(userId);

  // Login callbacks use this message as the OTP / 2FA password.
  const waiter = waiters.get(userId);
  if (waiter && (waiter.type === "code" || waiter.type === "password")) {
    if (!text) return ctx.reply("❌ Input kosong.");
    waiter.resolve(text);
    return;
  }

  if (!f) return;

  try {
    if (admin(userId) && f.t === "admin:add") {
      const id = Number(text);
      if (!Number.isSafeInteger(id) || id <= 0) return ctx.reply("❌ ID Telegram tidak valid.");

      const { error } = await sb.from("app_users").upsert(
        { telegram_user_id: id, status: "active" },
        { onConflict: "telegram_user_id" }
      );

      if (error) throw error;

      flows.delete(userId);
      return ctx.reply("✅ User berhasil diaktifkan.", { reply_markup: adminMenu() });
    }

    if (admin(userId) && f.t === "admin:disconnect") {
      const target = await getUser(Number(text));
      if (!target) return ctx.reply("❌ User tidak ditemukan.");

      const c = clients.get(target.id);
      if (c) {
        // Explicit admin action: disconnect this user. Normal restarts never call this.
        try { await c.disconnect(); } catch (_) {}
        clients.delete(target.id);
      }

      await sb.from("telegram_sessions").update({ status: "disconnected" }).eq("user_id", target.id);
      await sb.from("app_users").update({ status: "disabled" }).eq("id", target.id);

      flows.delete(userId);
      return ctx.reply("✅ User diputuskan.", { reply_markup: adminMenu() });
    }

    const u = await requireActive(ctx);
    if (!u) {
      flows.delete(userId);
      return;
    }

    if (f.t === "groups") {
      // Backward-compatible support for old text selection.
      const nums = text.split(",")
        .map(x => Number(x.trim()) - 1)
        .filter(i => Number.isInteger(i) && i >= 0 && i < f.list.length);

      await sb.from("groups").update({ enabled: false }).eq("user_id", u.id);

      for (const i of nums) {
        await sb.from("groups").update({ enabled: true }).eq("id", f.list[i].id).eq("user_id", u.id);
      }

      flows.delete(userId);
      return ctx.reply("✅ Grup aktif diperbarui.", { reply_markup: userMenu() });
    }

    if (f.t === "message") {
      if (!text) return ctx.reply("❌ Format promosi tidak boleh kosong.");

      const { error } = await sb.from("campaigns").insert({
        user_id: u.id,
        message: text
      });

      if (error) throw error;

      flows.delete(userId);
      return ctx.reply("✅ Format promosi tersimpan.", { reply_markup: userMenu() });
    }

    if (f.t === "interval") {
      const seconds = parseSeconds(text);
      if (!seconds || seconds < 10) {
        return ctx.reply("❌ Format jeda tidak valid. Minimal 10 detik.\nContoh: 10 detik / 30 menit / 1 jam.");
      }

      const c = await latestCampaign(u);
      if (!c) return ctx.reply("❌ Buat format promosi dulu.");

      const { error } = await sb.from("campaigns")
        .update({ interval_seconds: seconds })
        .eq("id", c.id);

      if (error) throw error;

      flows.delete(userId);
      return ctx.reply("✅ Jeda disimpan.", { reply_markup: userMenu() });
    }

    if (f.t === "duration") {
      const seconds = parseSeconds(text);
      if (!seconds) return ctx.reply("❌ Format durasi tidak valid.\nContoh: 3 hari / 12 jam.");

      const { error } = await sb.from("campaigns")
        .update({ duration_seconds: seconds })
        .eq("id", f.id);

      if (error) throw error;

      flows.delete(userId);
      return ctx.reply("✅ Durasi disimpan.", { reply_markup: userMenu() });
    }

    if (f.t === "phone") {
      if (!/^\+\d{7,15}$/.test(text)) {
        return ctx.reply("❌ Nomor tidak valid. Gunakan format internasional, contoh +628123456789.");
      }

      flows.delete(userId);
      await startLogin(ctx, u, text);
      return;
    }
  } catch (e) {
    console.error("MESSAGE FLOW:", e);
    flows.delete(userId);
    return ctx.reply(`❌ ${String(e.message || e).slice(0, 700)}`, { reply_markup: userMenu() });
  }
});

bot.catch(err => console.error("BOT:", err.error || err));

async function restoreRunningCampaigns() {
  const { data, error } = await sb.from("campaigns").select("id").eq("status", "running");
  if (error) throw error;
  for (const c of data || []) schedule(c.id, 0);
}

async function restoreSessions() {
  const { data, error } = await sb
    .from("telegram_sessions")
    .select("user_id,session_string,status")
    .eq("status", "connected");

  if (error) throw error;

  for (const row of data || []) {
    const { data: u } = await sb.from("app_users").select("*").eq("id", row.user_id).maybeSingle();
    if (!u || u.status !== "active") continue;

    try {
      const c = await createTelegramClient(row.session_string);
      await c.connect();

      if (await c.checkAuthorization()) {
        clients.set(u.id, c);
      } else {
        // Do not delete session data. Telegram may require a fresh login.
        console.warn(`Session ${u.id} is not authorized; saved session retained.`);
        try { await c.disconnect(); } catch (_) {}
      }
    } catch (e) {
      console.warn(`Session ${u.id} reconnect failed:`, String(e.message || e));
    }
  }
}

(async () => {
  await restoreSessions();
  await restoreRunningCampaigns();
  await bot.start();
  console.log("Telegram bot started.");
})().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});

const app = express();
app.get("/", (_, res) => res.json({ ok: true, service: "telegram-auto-bot" }));
app.listen(Number(process.env.PORT || 3000), () => {
  console.log(`HTTP server listening on ${process.env.PORT || 3000}`);
});

process.once("SIGINT", () => {
  for (const handle of timers.values()) clearTimeout(handle);
  process.exit(0);
});

process.once("SIGTERM", () => {
  for (const handle of timers.values()) clearTimeout(handle);
  process.exit(0);
});
