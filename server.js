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
   MENUS
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
  return new InlineKeyboard().text(
    "⬅️ Menu",
    "menu:user"
  );
}

function cancelMenu() {
  return new InlineKeyboard().text(
    "❌ Batal",
    "flow:cancel"
  );
}

/* =========================
   HELPERS
========================= */

function formatInterval(minutes) {
  const m = Number(minutes || 0);

  if (!m) return "-";

  if (m % 1440 === 0) {
    return `${m / 1440} hari`;
  }

  if (m % 60 === 0) {
    return `${m / 60} jam`;
  }

  return `${m} menit`;
}

function formatDuration(hours) {
  const h = Number(hours || 0);

  if (!h) return "-";

  if (h % 24 === 0) {
    return `${h / 24} hari`;
  }

  return `${h} jam`;
}

function parseMinutes(value) {
  const m = String(value || "")
    .trim()
    .toLowerCase()
    .match(
      /^(\d+(?:\.\d+)?)\s*(menit|jam|hari|m|h|d)$/
    );

  if (!m) return null;

  const unit = {
    menit: 1,
    m: 1,
    jam: 60,
    h: 60,
    hari: 1440,
    d: 1440
  }[m[2]];

  const minutes = Math.round(
    Number(m[1]) * unit
  );

  return Number.isFinite(minutes)
    ? minutes
    : null;
}

function parseHours(value) {
  const m = String(value || "")
    .trim()
    .toLowerCase()
    .match(
      /^(\d+(?:\.\d+)?)\s*(jam|hari|h|d)$/
    );

  if (!m) return null;

  const unit = {
    jam: 1,
    h: 1,
    hari: 24,
    d: 24
  }[m[2]];

  const hours = Math.round(
    Number(m[1]) * unit
  );

  return Number.isFinite(hours)
    ? hours
    : null;
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
    await ctx.reply(
      "❌ Akun kamu belum diaktifkan admin."
    );

    return null;
  }

  return u;
}

/* =========================
   TELEGRAM USER CLIENT
========================= */

async function createTelegramClient(
  sessionString = ""
) {
  return new TelegramClient(
    new StringSession(
      sessionString || ""
    ),
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

  const {
    data,
    error
  } = await sb
    .from("telegram_sessions")
    .select("*")
    .eq("user_id", u.id)
    .maybeSingle();

  if (error) throw error;

  if (!data?.session_string) {
    return null;
  }

  c = await createTelegramClient(
    data.session_string
  );

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

    if (!isGroup && !isChannel) {
      continue;
    }

    let canSend = true;

    /*
      Broadcast channel:
      hanya creator/admin yang boleh dianggap bisa kirim.
    */
    if (
      isChannel &&
      entity.className === "Channel" &&
      entity.broadcast
    ) {
      canSend = false;

      try {
        const me =
          await c.getInputEntity("me");

        const participant =
          await c.invoke(
            new Api.channels.GetParticipant({
              channel: entity,
              userId: me
            })
          );

        const p =
          participant.participant;

        if (
          p?.className ===
            "ChannelParticipantCreator" ||
          p?.className ===
            "ChannelParticipantAdmin"
        ) {
          canSend = true;
        }
      } catch (_) {
        canSend = false;
      }
    }

    /*
      Group / supergroup.
    */
    if (
      isGroup ||
      (isChannel && !entity.broadcast)
    ) {
      canSend = true;

      try {
        if (
          entity.className === "Channel"
        ) {
          const me =
            await c.getInputEntity("me");

          const participant =
            await c.invoke(
              new Api.channels.GetParticipant({
                channel: entity,
                userId: me
              })
            );

          const p =
            participant.participant;

          if (
            p?.className ===
              "ChannelParticipantBanned" &&
            p.bannedRights
              ?.sendMessages === true
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

      telegram_group_id:
        String(
          entity.id?.value ??
          entity.id
        ),

      title:
        d.title ||
        entity.title ||
        "Tanpa Nama",

      can_send: canSend
    });
  }

  if (rows.length) {
    const {
      error
    } = await sb
      .from("groups")
      .upsert(rows, {
        onConflict:
          "user_id,telegram_group_id"
      });

    if (error) throw error;
  }

  return rows;
}

async function getGroups(
  u,
  refresh = false
) {
  if (refresh) {
    await refreshGroups(u);
  }

  const {
    data,
    error
  } = await sb
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
  const kb =
    new InlineKeyboard();

  for (const g of rows) {
    kb
      .text(
        `${g.enabled ? "✅" : "⬜"} ${String(
          g.title
        ).slice(0, 35)}`,
        `group:toggle:${g.id}`
      )
      .row();
  }

  kb
    .text(
      "🔄 Refresh Daftar",
      "group:refresh"
    )
    .text(
      "⬅️ Menu",
      "menu:user"
    );

  return kb;
}

async function showGroups(
  ctx,
  refresh = false
) {
  const u =
    await requireActive(ctx);

  if (!u) return;

  try {
    const rows =
      await getGroups(
        u,
        refresh
      );

    if (!rows.length) {
      return ctx.reply(
        "❌ Belum ada grup yang terbaca.\n\n" +
          "Pastikan akun Telegram yang terhubung sudah masuk ke grup tersebut.",
        {
          reply_markup:
            new InlineKeyboard()
              .text(
                "🔄 Coba Refresh",
                "group:refresh"
              )
              .row()
              .text(
                "⬅️ Menu",
                "menu:user"
              )
        }
      );
    }

    const enabled =
      rows.filter(
        x => x.enabled
      ).length;

    return ctx.reply(
      `👥 <b>Daftar Grup</b>\n\n` +
        `Pilih tombol grup untuk ON/OFF.\n` +
        `Aktif: <b>${enabled}</b>/${rows.length}`,
      {
        parse_mode: "HTML",
        reply_markup:
          groupKeyboard(rows)
      }
    );
  } catch (e) {
    console.error(
      "GROUP LIST:",
      e
    );

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
  const {
    data,
    error
  } = await sb
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
  if (!c) {
    return "Belum ada format.";
  }

  if (c.media_file_id) {
    if (c.caption) {
      return (
        `🖼️ Foto + caption\n` +
        String(c.caption).slice(0, 300)
      );
    }

    return "🖼️ Foto tanpa caption";
  }

  return (
    `📝 Teks\n` +
    String(
      c.message || ""
    ).slice(0, 300)
  );
}

function campaignStatusText(c) {
  if (!c) {
    return "Belum ada campaign.";
  }

  return [
    `📝 Format: ${campaignFormatText(c)}`,

    `⏱ Jeda: ${formatInterval(
      c.interval_minutes
    )}`,

    `📅 Durasi: ${formatDuration(
      c.duration_hours
    )}`,

    `📌 Status: ${
      c.active
        ? "RUNNING"
        : "STOPPED"
    }`,

    c.expires_at
      ? `⌛ Berakhir: ${new Date(
          c.expires_at
        ).toLocaleString("id-ID")}`
      : ""
  ]
    .filter(Boolean)
    .join("\n");
}

/*
  Membuat campaign baru.

  Karena schema kamu mewajibkan:
  interval_minutes
  duration_hours
  started_at
  expires_at
  active

  maka campaign baru dibuat dengan
  default jeda 10 menit dan durasi 1 jam.
  User masih bisa mengubahnya lewat menu.
*/
async function createCampaign(
  u,
  payload
) {
  const now =
    new Date();

  const defaultInterval =
    10;

  const defaultDuration =
    1;

  const initialExpires =
    new Date(
      now.getTime() +
        defaultDuration *
          60 *
          60 *
          1000
    );

  const {
    data,
    error
  } = await sb
    .from("campaigns")
    .insert({
      user_id: u.id,

      name: null,

      promotion_id: null,

      interval_minutes:
        defaultInterval,

      duration_hours:
        defaultDuration,

      started_at:
        now.toISOString(),

      expires_at:
        initialExpires.toISOString(),

      active: false,

      message:
        payload.message || "",

      media_type:
        payload.media_type || null,

      media_file_id:
        payload.media_file_id || null,

      caption:
        payload.caption || null
    })
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

/* =========================
   DOWNLOAD PHOTO
========================= */

async function downloadBotPhoto(
  fileId
) {
  const file =
    await bot.api.getFile(
      fileId
    );

  if (!file?.file_path) {
    throw new Error(
      "Telegram tidak mengembalikan file_path."
    );
  }

  const url =
    `https://api.telegram.org/file/bot` +
    `${process.env.BOT_TOKEN}/` +
    `${file.file_path}`;

  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Gagal download foto Telegram: HTTP ${response.status}`
    );
  }

  const arrayBuffer =
    await response.arrayBuffer();

  return Buffer.from(
    arrayBuffer
  );
}

/* =========================
   SEND CAMPAIGN
========================= */

async function fire(
  campaignId
) {
  const {
    data: c,
    error: campaignError
  } = await sb
    .from("campaigns")
    .select("*")
    .eq("id", campaignId)
    .maybeSingle();

  if (campaignError) {
    console.error(
      "CAMPAIGN LOAD:",
      campaignError
    );

    return;
  }

  if (!c || !c.active) {
    return;
  }

  if (
    !c.expires_at ||
    new Date(c.expires_at) <=
      new Date()
  ) {
    await sb
      .from("campaigns")
      .update({
        active: false
      })
      .eq(
        "id",
        campaignId
      );

    timers.delete(
      campaignId
    );

    return;
  }

  const {
    data: u
  } = await sb
    .from("app_users")
    .select("*")
    .eq(
      "id",
      c.user_id
    )
    .maybeSingle();

  if (
    !u ||
    u.status !== "active"
  ) {
    return;
  }

  const cl =
    await clientFor(u);

  if (!cl) {
    console.error(
      `Campaign ${campaignId}: akun Telegram tidak terhubung.`
    );

    return;
  }

  const {
    data: links,
    error: linksError
  } = await sb
    .from("campaign_groups")
    .select(
      "campaign_id,group_id,groups(*)"
    )
    .eq(
      "campaign_id",
      campaignId
    );

  if (linksError) {
    console.error(
      "CAMPAIGN GROUPS:",
      linksError
    );

    return;
  }

  let photoBuffer =
    null;

  if (c.media_file_id) {
    try {
      photoBuffer =
        await downloadBotPhoto(
          c.media_file_id
        );
    } catch (e) {
      console.error(
        "DOWNLOAD PHOTO:",
        String(
          e.message || e
        )
      );

      return;
    }
  }

  for (
    const x of links || []
  ) {
    const g =
      x.groups;

    if (
      !g?.enabled ||
      !g?.can_send
    ) {
      continue;
    }

    try {
      const target =
        await cl.getEntity(
          g.telegram_group_id
        );

      if (
        c.media_file_id &&
        photoBuffer
      ) {
        await cl.sendFile(
          target,
          {
            file:
              photoBuffer,

            caption:
              c.caption || ""
          }
        );
      } else {
        await cl.sendMessage(
          target,
          {
            message:
              c.message || ""
          }
        );
      }

      await sb
        .from("send_logs")
        .insert({
          campaign_id:
            campaignId,

          user_id:
            c.user_id,

          group_id:
            g.id,

          status:
            "sent"
        });
    } catch (e) {
      console.error(
        `SEND GROUP ${g.id}:`,
        String(
          e.message || e
        )
      );

      await sb
        .from("send_logs")
        .insert({
          campaign_id:
            campaignId,

          user_id:
            c.user_id,

          group_id:
            g.id,

          status:
            "error",

          error:
            String(
              e?.message || e
            ).slice(0, 1000)
        });
    }
  }
}

/* =========================
   SCHEDULER
========================= */

function schedule(
  campaignId,
  delay = 0
) {
  if (
    timers.has(
      campaignId
    )
  ) {
    clearTimeout(
      timers.get(
        campaignId
      )
    );
  }

  const handle =
    setTimeout(
      async () => {
        try {
          await fire(
            campaignId
          );
        } catch (e) {
          console.error(
            "CAMPAIGN:",
            e
          );
        }

        const {
          data
        } = await sb
          .from("campaigns")
          .select(
            "active,interval_minutes,expires_at"
          )
          .eq(
            "id",
            campaignId
          )
          .maybeSingle();

        if (
          data?.active &&
          data.expires_at &&
          new Date(
            data.expires_at
          ) > new Date()
        ) {
          schedule(
            campaignId,
            Math.max(
              1000,
              Number(
                data.interval_minutes ||
                  10
              ) *
                60 *
                1000
            )
          );
        } else {
          timers.delete(
            campaignId
          );
        }
      },
      Math.max(
        0,
        delay
      )
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
  timeoutMs =
    5 * 60 * 1000
) {
  return new Promise(
    (
      resolve,
      reject
    ) => {
      const old =
        waiters.get(
          userId
        );

      if (old) {
        old.reject(
          new Error(
            "Login sebelumnya dibatalkan."
          )
        );
      }

      const timer =
        setTimeout(
          () => {
            waiters.delete(
              userId
            );

            flows.delete(
              userId
            );

            reject(
              new Error(
                "Waktu input habis. Silakan mulai login lagi."
              )
            );
          },
          timeoutMs
        );

      waiters.set(
        userId,
        {
          type:
            nextType,

          resolve:
            value => {
              clearTimeout(
                timer
              );

              waiters.delete(
                userId
              );

              resolve(
                value
              );
            },

          reject:
            err => {
              clearTimeout(
                timer
              );

              waiters.delete(
                userId
              );

              reject(
                err
              );
            }
        }
      );
    }
  );
}

async function startLogin(
  ctx,
  u,
  phone
) {
  const botUserId =
    ctx.from.id;

  const c =
    await createTelegramClient(
      ""
    );

  await c.connect();

  try {
    await c.start({
      phoneNumber:
        async () =>
          phone,

      phoneCode:
        async () => {
          flows.set(
            botUserId,
            {
              t: "code"
            }
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

      password:
        async () => {
          flows.set(
            botUserId,
            {
              t: "password"
            }
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

      onError:
        async err => {
          console.error(
            "LOGIN ERROR:",
            String(
              err?.message ||
                err
            )
          );
        }
    });

    const sessionString =
      c.session.save();

    const {
      error
    } = await sb
      .from(
        "telegram_sessions"
      )
      .upsert(
        {
          user_id:
            u.id,

          session_string:
            sessionString,

          status:
            "connected",

          phone,

          updated_at:
            new Date().toISOString()
        },
        {
          onConflict:
            "user_id"
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
      if (
        admin(
          ctx.from.id
        )
      ) {
        return ctx.reply(
          "🛠 <b>Admin Dashboard</b>",
          {
            parse_mode:
              "HTML",

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
        u?.status ===
        "active"
      ) {
        return ctx.reply(
          "👤 <b>FARIS STORE — User Panel</b>\nPilih menu di bawah:",
          {
            parse_mode:
              "HTML",

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
      await requireActive(
        ctx
      );

    if (!u) return;

    return ctx.editMessageText(
      "👤 <b>FARIS STORE — User Panel</b>\nPilih menu di bawah:",
      {
        parse_mode:
          "HTML",

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
      await requireActive(
        ctx
      );

    if (!u) return;

    try {
      const c =
        await latestCampaign(
          u
        );

      const session =
        await sb
          .from(
            "telegram_sessions"
          )
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
            session.data?.status ===
            "connected"
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
          campaignStatusText(
            c
          ),
        {
          parse_mode:
            "HTML",

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
   GROUP LIST
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
      await requireActive(
        ctx
      );

    if (!u) {
      return ctx.answerCallbackQuery();
    }

    const groupId =
      Number(
        ctx.match[1]
      );

    const {
      data: g,
      error
    } = await sb
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
          show_alert:
            true
        }
      );
    }

    const {
      error:
        updateError
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
          show_alert:
            true
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
            groupKeyboard(
              rows
            )
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
      await requireActive(
        ctx
      );

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
        parse_mode:
          "HTML",

        reply_markup:
          cancelMenu()
      }
    );
  }
);

/* =========================
   EDIT FORMAT
========================= */

bot.callbackQuery(
  "promo:edit",
  async ctx => {
    await ctx.answerCallbackQuery();

    const u =
      await requireActive(
        ctx
      );

    if (!u) return;

    try {
      const c =
        await latestCampaign(
          u
        );

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
          t:
            "message_edit",

          id:
            c.id
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
          parse_mode:
            "HTML",

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
   SET JEDA
========================= */

bot.callbackQuery(
  "promo:interval",
  async ctx => {
    await ctx.answerCallbackQuery();

    const u =
      await requireActive(
        ctx
      );

    if (!u) return;

    const c =
      await latestCampaign(
        u
      );

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
        t:
          "interval",

        id:
          c.id
      }
    );

    return ctx.reply(
      "⏱ <b>Set Jeda</b>\n\n" +
        "Contoh:\n" +
        "• 10 menit\n" +
        "• 30 menit\n" +
        "• 1 jam\n\n" +
        "Minimal 1 menit.",
      {
        parse_mode:
          "HTML",

        reply_markup:
          cancelMenu()
      }
    );
  }
);

/* =========================
   SET DURASI
========================= */

bot.callbackQuery(
  "promo:duration",
  async ctx => {
    await ctx.answerCallbackQuery();

    const u =
      await requireActive(
        ctx
      );

    if (!u) return;

    const c =
      await latestCampaign(
        u
      );

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
        t:
          "duration",

        id:
          c.id
      }
    );

    return ctx.reply(
      "📅 <b>Set Durasi</b>\n\n" +
        "Contoh:\n" +
        "• 3 hari\n" +
        "• 12 jam\n" +
        "• 30 jam",
      {
        parse_mode:
          "HTML",

        reply_markup:
          cancelMenu()
      }
    );
  }
);

/* =========================
   START CAMPAIGN
========================= */

bot.callbackQuery(
  "campaign:start",
  async ctx => {
    await ctx.answerCallbackQuery();

    const u =
      await requireActive(
        ctx
      );

    if (!u) return;

    const c =
      await latestCampaign(
        u
      );

    if (!c) {
      return ctx.reply(
        "❌ Belum ada format promosi.",
        {
          reply_markup:
            backMenu()
        }
      );
    }

    if (
      !c.message &&
      !c.media_file_id
    ) {
      return ctx.reply(
        "❌ Format promosi belum dibuat.",
        {
          reply_markup:
            backMenu()
        }
      );
    }

    if (
      !c.interval_minutes ||
      c.interval_minutes < 1
    ) {
      return ctx.reply(
        "❌ Set jeda terlebih dahulu.",
        {
          reply_markup:
            backMenu()
        }
      );
    }

    if (
      !c.duration_hours ||
      c.duration_hours < 1
    ) {
      return ctx.reply(
        "❌ Set durasi terlebih dahulu.",
        {
          reply_markup:
            backMenu()
        }
      );
    }

    const {
      data: gs,
      error: groupError
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

    if (groupError) {
      return ctx.reply(
        `❌ Gagal mengambil grup:\n${String(
          groupError.message ||
            groupError
        ).slice(0, 500)}`
      );
    }

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
            c.duration_hours
          ) *
            60 *
            60 *
            1000
      );

    /*
      Hapus target campaign lama.
    */
    const {
      error:
        deleteError
    } = await sb
      .from("campaign_groups")
      .delete()
      .eq(
        "campaign_id",
        c.id
      );

    if (deleteError) {
      return ctx.reply(
        `❌ Gagal membersihkan grup campaign:\n${String(
          deleteError.message ||
            deleteError
        ).slice(0, 500)}`
      );
    }

    /*
      Masukkan semua grup aktif.
    */
    const {
      error:
        linkError
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
          linkError.message ||
            linkError
        ).slice(0, 500)}`
      );
    }

    /*
      Aktifkan campaign.
    */
    const {
      error
    } = await sb
      .from("campaigns")
      .update({
        active:
          true,

        started_at:
          now.toISOString(),

        expires_at:
          exp.toISOString()
      })
      .eq(
        "id",
        c.id
      )
      .eq(
        "user_id",
        u.id
      );

    if (error) {
      return ctx.reply(
        `❌ Gagal memulai campaign:\n${String(
          error.message ||
            error
        ).slice(0, 500)}`
      );
    }

    schedule(
      c.id,
      0
    );

    return ctx.reply(
      "▶️ <b>Campaign dimulai.</b>\n\n" +
        `⏱ Jeda: ${formatInterval(
          c.interval_minutes
        )}\n` +
        `📅 Durasi: ${formatDuration(
          c.duration_hours
        )}\n` +
        `👥 Grup: ${gs.length}\n\n` +
        "Pesan akan dikirim ke grup aktif sesuai jeda.",
      {
        parse_mode:
          "HTML",

        reply_markup:
          userMenu()
      }
    );
  }
);

/* =========================
   STOP CAMPAIGN
========================= */

bot.callbackQuery(
  "campaign:stop",
  async ctx => {
    await ctx.answerCallbackQuery();

    const u =
      await requireActive(
        ctx
      );

    if (!u) return;

    const {
      data,
      error
    } = await sb
      .from("campaigns")
      .select("id")
      .eq(
        "user_id",
        u.id
      )
      .eq(
        "active",
        true
      );

    if (error) {
      return ctx.reply(
        `❌ Gagal mengambil campaign:\n${String(
          error.message ||
            error
        ).slice(0, 500)}`
      );
    }

    for (
      const c of data || []
    ) {
      if (
        timers.has(c.id)
      ) {
        clearTimeout(
          timers.get(
            c.id
          )
        );
      }

      timers.delete(
        c.id
      );

      await sb
        .from("campaigns")
        .update({
          active:
            false
        })
        .eq(
          "id",
          c.id
        )
        .eq(
          "user_id",
          u.id
        );
    }

    return ctx.reply(
      data?.length
        ? "⏹ Campaign dihentikan."
        : "ℹ️ Tidak ada campaign yang sedang berjalan.",
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
      await requireActive(
        ctx
      );

    if (!u) return;

    const existing =
      await sb
        .from(
          "telegram_sessions"
        )
        .select(
          "session_string,status,phone"
        )
        .eq(
          "user_id",
          u.id
        )
        .maybeSingle();

    if (
      existing.data
        ?.session_string &&
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
        t:
          "phone"
      }
    );

    return ctx.reply(
      "🔐 <b>Kirim nomor Telegram</b>\n\n" +
        "Contoh: <b>+628123456789</b>",
      {
        parse_mode:
          "HTML",

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
    if (
      !admin(
        ctx.from.id
      )
    ) {
      return ctx.answerCallbackQuery();
    }

    await ctx.answerCallbackQuery();

    flows.set(
      ctx.from.id,
      {
        t:
          "admin:add"
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
    if (
      !admin(
        ctx.from.id
      )
    ) {
      return ctx.answerCallbackQuery();
    }

    await ctx.answerCallbackQuery();

    const {
      count,
      error
    } = await sb
      .from("app_users")
      .select("*", {
        count:
          "exact",
        head:
          true
      });

    if (error) {
      return ctx.reply(
        `❌ ${String(
          error.message ||
            error
        ).slice(0, 500)}`
      );
    }

    return ctx.reply(
      `👥 Total user: ${
        count || 0
      }`,
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
    if (
      !admin(
        ctx.from.id
      )
    ) {
      return ctx.answerCallbackQuery();
    }

    await ctx.answerCallbackQuery();

    const {
      data,
      error
    } = await sb
      .from("app_users")
      .select("*")
      .eq(
        "status",
        "active"
      );

    if (error) {
      return ctx.reply(
        `❌ ${String(
          error.message ||
            error
        ).slice(0, 500)}`
      );
    }

    const text =
      data?.length
        ? data
            .map(
              (x, i) =>
                `${i + 1}. ${
                  x.first_name ||
                  "-"
                } | ${
                  x.telegram_user_id
                }`
            )
            .join("\n")
        : "Belum ada user aktif.";

    return ctx.reply(
      `🟢 <b>User Aktif</b>\n\n${text}`,
      {
        parse_mode:
          "HTML",

        reply_markup:
          adminMenu()
      }
    );
  }
);

bot.callbackQuery(
  "admin:disconnect",
  async ctx => {
    if (
      !admin(
        ctx.from.id
      )
    ) {
      return ctx.answerCallbackQuery();
    }

    await ctx.answerCallbackQuery();

    flows.set(
      ctx.from.id,
      {
        t:
          "admin:disconnect"
      }
    );

    return ctx.reply(
      "Kirim Telegram ID user yang mau dinonaktifkan."
    );
  }
);

/* =========================
   MESSAGE HANDLER
========================= */

bot.on(
  "message",
  async ctx => {
    const userId =
      ctx.from.id;

    const f =
      flows.get(
        userId
      );

    const waiter =
      waiters.get(
        userId
      );

    /*
      OTP / password login.
    */
    if (
      waiter &&
      (
        waiter.type ===
          "code" ||
        waiter.type ===
          "password"
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

    if (!f) {
      return;
    }

    try {
      /* =====================
         ADMIN ADD USER
      ===================== */

      if (
        admin(userId) &&
        f.t ===
          "admin:add"
      ) {
        if (
          !ctx.message.text
        ) {
          return ctx.reply(
            "❌ Kirim Telegram ID berupa angka."
          );
        }

        const id =
          Number(
            ctx.message.text.trim()
          );

        if (
          !Number.isSafeInteger(
            id
          ) ||
          id <= 0
        ) {
          return ctx.reply(
            "❌ ID Telegram tidak valid."
          );
        }

        const {
          error
        } = await sb
          .from(
            "app_users"
          )
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

      /* =====================
         ADMIN DISCONNECT
      ===================== */

      if (
        admin(userId) &&
        f.t ===
          "admin:disconnect"
      ) {
        if (
          !ctx.message.text
        ) {
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
          .from(
            "telegram_sessions"
          )
          .update({
            status:
              "disconnected"
          })
          .eq(
            "user_id",
            target.id
          );

        await sb
          .from(
            "app_users"
          )
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

      const u =
        await requireActive(
          ctx
        );

      if (!u) {
        flows.delete(
          userId
        );

        return;
      }

      /* =====================
         FORMAT PROMOSI
      ===================== */

      if (
        f.t ===
          "message" ||
        f.t ===
          "message_edit"
      ) {
        const isEdit =
          f.t ===
          "message_edit";

        /*
          FOTO
        */
        if (
          ctx.message.photo &&
          ctx.message.photo.length
        ) {
          const photo =
            ctx.message.photo[
              ctx.message.photo
                .length - 1
            ];

          const caption =
            ctx.message.caption ||
            "";

          /*
            EDIT FORMAT
          */
          if (isEdit) {
            const {
              error
            } = await sb
              .from(
                "campaigns"
              )
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

            if (error) {
              throw error;
            }

            flows.delete(
              userId
            );

            return ctx.reply(
              "✅ Format foto berhasil diubah.",
              {
                reply_markup:
                  userMenu()
              }
            );
          }

          /*
            FORMAT BARU
          */
          await createCampaign(
            u,
            {
              message:
                "",

              media_type:
                "photo",

              media_file_id:
                photo.file_id,

              caption:
                caption
            }
          );

          flows.delete(
            userId
          );

          return ctx.reply(
            "✅ Format foto berhasil disimpan.",
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

          /*
            EDIT FORMAT
          */
          if (isEdit) {
            const {
              error
            } = await sb
              .from(
                "campaigns"
              )
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

            if (error) {
              throw error;
            }

            flows.delete(
              userId
            );

            return ctx.reply(
              "✅ Format teks berhasil diubah.",
              {
                reply_markup:
                  userMenu()
              }
            );
          }

          /*
            FORMAT BARU
          */
          await createCampaign(
            u,
            {
              message:
                text,

              media_type:
                null,

              media_file_id:
                null,

              caption:
                null
            }
          );

          flows.delete(
            userId
          );

          return ctx.reply(
            "✅ Format teks berhasil disimpan.",
            {
              reply_markup:
                userMenu()
            }
          );
        }

        return ctx.reply(
          "❌ Format tidak didukung.\n\n" +
            "Kirim teks atau foto + caption."
        );
      }

      /* =====================
         SET JEDA
      ===================== */

      if (
        f.t ===
          "interval"
      ) {
        if (
          !ctx.message.text
        ) {
          return ctx.reply(
            "❌ Kirim jeda dalam bentuk teks.\nContoh: 10 menit"
          );
        }

        const minutes =
          parseMinutes(
            ctx.message.text
          );

        if (
          !minutes ||
          minutes < 1
        ) {
          return ctx.reply(
            "❌ Format jeda tidak valid.\n\n" +
              "Contoh: 10 menit / 30 menit / 1 jam."
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
          .from(
            "campaigns"
          )
          .update({
            interval_minutes:
              minutes
          })
          .eq(
            "id",
            c.id
          )
          .eq(
            "user_id",
            u.id
          );

        if (error) {
          throw error;
        }

        flows.delete(
          userId
        );

        return ctx.reply(
          `✅ Jeda disimpan: ${formatInterval(
            minutes
          )}`,
          {
            reply_markup:
              userMenu()
          }
        );
      }

      /* =====================
         SET DURASI
      ===================== */

      if (
        f.t ===
          "duration"
      ) {
        if (
          !ctx.message.text
        ) {
          return ctx.reply(
            "❌ Kirim durasi dalam bentuk teks.\nContoh: 3 hari"
          );
        }

        const hours =
          parseHours(
            ctx.message.text
          );

        if (
          !hours ||
          hours < 1
        ) {
          return ctx.reply(
            "❌ Format durasi tidak valid.\n\n" +
              "Contoh: 3 hari / 12 jam."
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
          .from(
            "campaigns"
          )
          .update({
            duration_hours:
              hours
          })
          .eq(
            "id",
            c.id
          )
          .eq(
            "user_id",
            u.id
          );

        if (error) {
          throw error;
        }

        flows.delete(
          userId
        );

        return ctx.reply(
          `✅ Durasi disimpan: ${formatDuration(
            hours
          )}`,
          {
            reply_markup:
              userMenu()
          }
        );
      }

      /* =====================
         LOGIN PHONE
      ===================== */

      if (
        f.t ===
          "phone"
      ) {
        if (
          !ctx.message.text
        ) {
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
   BOT ERROR
========================= */

bot.catch(
  err =>
    console.error(
      "BOT:",
      err.error ||
        err
    )
);

/* =========================
   RESTORE CAMPAIGNS
========================= */

async function restoreRunningCampaigns() {
  const {
    data,
    error
  } = await sb
    .from("campaigns")
    .select(
      "id,active,expires_at"
    )
    .eq(
      "active",
      true
    );

  if (error) {
    throw error;
  }

  for (
    const c of data || []
  ) {
    if (
      c.expires_at &&
      new Date(
        c.expires_at
      ) > new Date()
    ) {
      schedule(
        c.id,
        0
      );
    } else {
      await sb
        .from(
          "campaigns"
        )
        .update({
          active:
            false
        })
        .eq(
          "id",
          c.id
        );
    }
  }
}

/* =========================
   RESTORE TELEGRAM SESSIONS
========================= */

async function restoreSessions() {
  const {
    data,
    error
  } = await sb
    .from(
      "telegram_sessions"
    )
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

  for (
    const row of data || []
  ) {
    const {
      data: u
    } = await sb
      .from(
        "app_users"
      )
      .select("*")
      .eq(
        "id",
        row.user_id
      )
      .maybeSingle();

    if (
      !u ||
      u.status !==
        "active"
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
   START BOT
========================= */

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
      ok:
        true,

      service:
        "telegram-auto-bot"
    })
);

app.listen(
  Number(
    process.env.PORT ||
      3000
  ),
  () => {
    console.log(
      `HTTP server listening on ${
        process.env.PORT ||
        3000
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
      const handle of
        timers.values()
    ) {
      clearTimeout(
        handle
      );
    }

    process.exit(
      0
    );
  }
);

process.once(
  "SIGTERM",
  () => {
    for (
      const handle of
        timers.values()
    ) {
      clearTimeout(
        handle
      );
    }

    process.exit(
      0
    );
  }
);