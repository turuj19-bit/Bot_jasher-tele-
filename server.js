require("dotenv").config();

const express = require("express");
const { Bot, InlineKeyboard } = require("grammy");
const { createClient } = require("@supabase/supabase-js");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const ws = require("ws");

const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean)
);

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    realtime: {
      transport: ws
    }
  }
);

const bot = new Bot(process.env.BOT_TOKEN);

const clients = new Map();
const flows = new Map();
const waiters = new Map();
const timers = new Map();
const uiMessages = new Map();

/*
  Tempel URL FOTO BANNER di sini.
  Contoh:
  const START_BANNER_URL = "https://domain.com/banner.jpg";
*/
const START_BANNER_URL = "";

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
   UI HELPERS
========================= */

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeButtonText(value, max = 30) {
  let text = String(value ?? "Tanpa Nama")
    .replace(
      /[\u0000-\u001F\u007F-\u009F]/g,
      ""
    );

  return Array.from(text)
    .filter(ch => {
      const cp = ch.codePointAt(0);
      return cp !== undefined && cp >= 0x20;
    })
    .slice(0, max)
    .join("");
}

async function saveUiMessage(
  userId,
  msg,
  isMedia = false
) {
  if (!msg) return;

  uiMessages.set(userId, {
    chatId: msg.chat.id,
    messageId: msg.message_id,
    isMedia
  });
}

async function renderUi(
  userId,
  text,
  keyboard,
  options = {}
) {
  const saved = uiMessages.get(userId);

  const extra = {
    reply_markup: keyboard
  };

  if (options.parse_mode) {
    extra.parse_mode = options.parse_mode;
  }

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
      if (
        /message is not modified/i.test(
          String(e.message || e)
        )
      ) {
        return;
      }

      try {
        await bot.api.deleteMessage(
          saved.chatId,
          saved.messageId
        );
      } catch (_) {}

      uiMessages.delete(userId);
    }
  }

  const msg =
    await bot.api.sendMessage(
      userId,
      text,
      extra
    );

  await saveUiMessage(
    userId,
    msg,
    false
  );

  return msg;
}

async function renderStart(
  ctx,
  text,
  keyboard
) {
  if (
    START_BANNER_URL &&
    /^https?:\/\//i.test(
      START_BANNER_URL
    )
  ) {
    const msg =
      await ctx.replyWithPhoto(
        START_BANNER_URL,
        {
          caption: text,
          parse_mode: "HTML",
          reply_markup: keyboard
        }
      );

    await saveUiMessage(
      ctx.from.id,
      msg,
      true
    );

    return msg;
  }

  return renderUi(
    ctx.from.id,
    text,
    keyboard,
    {
      parse_mode: "HTML"
    }
  );
}

async function replaceUi(
  ctx,
  text,
  keyboard,
  options = {}
) {
  return renderUi(
    ctx.from.id,
    text,
    keyboard,
    options
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
  const {
    data,
    error
  } = await sb
    .from("app_users")
    .select("*")
    .eq(
      "telegram_user_id",
      tgId
    )
    .maybeSingle();

  if (error) throw error;

  return data;
}

async function requireActive(ctx) {
  const u =
    await getUser(
      ctx.from.id
    );

  if (
    !u ||
    u.status !== "active"
  ) {
    await replaceUi(
      ctx,
      "❌ <b>Akun belum aktif.</b>\n\n" +
        "Hubungi admin untuk mengaktifkan akun.",
      new InlineKeyboard(),
      {
        parse_mode: "HTML"
      }
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

      if (
        await c.checkAuthorization()
      ) {
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
    .eq(
      "user_id",
      u.id
    )
    .maybeSingle();

  if (error) throw error;

  if (!data?.session_string) {
    return null;
  }

  c =
    await createTelegramClient(
      data.session_string
    );

  try {
    await c.connect();

    if (
      !(await c.checkAuthorization())
    ) {
      return null;
    }

    clients.set(
      u.id,
      c
    );

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
  const c =
    await clientFor(u);

  if (!c) {
    throw new Error(
      "Akun Telegram belum terhubung. Silakan kaitkan akun lagi."
    );
  }

  const dialogs =
    await c.getDialogs({
      limit: 500
    });

  const rows = [];

  for (
    const d of dialogs
  ) {
    const entity =
      d.entity;

    if (!entity) continue;

    const isGroup =
      Boolean(d.isGroup);

    const isChannel =
      Boolean(d.isChannel);

    if (
      !isGroup &&
      !isChannel
    ) {
      continue;
    }

    let canSend = true;

    if (
      isChannel &&
      entity.className ===
        "Channel" &&
      entity.broadcast
    ) {
      canSend = false;

      try {
        const me =
          await c.getInputEntity(
            "me"
          );

        const participant =
          await c.invoke(
            new Api.channels.GetParticipant(
              {
                channel:
                  entity,
                userId:
                  me
              }
            )
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

    if (
      isGroup ||
      (
        isChannel &&
        !entity.broadcast
      )
    ) {
      canSend = true;

      try {
        if (
          entity.className ===
          "Channel"
        ) {
          const me =
            await c.getInputEntity(
              "me"
            );

          const participant =
            await c.invoke(
              new Api.channels.GetParticipant(
                {
                  channel:
                    entity,
                  userId:
                    me
                }
              )
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
      user_id:
        u.id,

      telegram_group_id:
        String(
          entity.id?.value ??
          entity.id
        ),

      title:
        d.title ||
        entity.title ||
        "Tanpa Nama",

      can_send:
        canSend
    });
  }

  if (rows.length) {
    const {
      error
    } = await sb
      .from("groups")
      .upsert(
        rows,
        {
          onConflict:
            "user_id,telegram_group_id"
        }
      );

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
    .eq(
      "user_id",
      u.id
    )
    .order(
      "title",
      {
        ascending: true
      }
    );

  if (error) throw error;

  return data || [];
}

function groupKeyboard(rows) {
  const kb =
    new InlineKeyboard();

  let number = 1;

  for (
    const g of rows
  ) {
    const title =
      safeButtonText(
        g.title,
        28
      );

    kb
      .text(
        `${g.enabled ? "✅" : "⬜"} ${String(
          number
        ).padStart(2, "0")} • ${title}`,
        `group:toggle:${g.id}`
      )
      .row();

    number++;
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
      return replaceUi(
        ctx,
        "👥 <b>Daftar Grup</b>\n\n" +
          "❌ Belum ada grup yang terbaca.\n\n" +
          "Pastikan akun Telegram yang terhubung sudah masuk ke grup tersebut.",
        new InlineKeyboard()
          .text(
            "🔄 Coba Refresh",
            "group:refresh"
          )
          .row()
          .text(
            "⬅️ Menu",
            "menu:user"
          ),
        {
          parse_mode:
            "HTML"
        }
      );
    }

    const enabled =
      rows.filter(
        x => x.enabled
      ).length;

    return replaceUi(
      ctx,
      `👥 <b>Daftar Grup</b>\n\n` +
        `Pilih grup untuk ON/OFF.\n` +
        `🟢 Aktif: <b>${enabled}</b>/${rows.length}`,
      groupKeyboard(
        rows
      ),
      {
        parse_mode:
          "HTML"
      }
    );
  } catch (e) {
    console.error(
      "GROUP LIST:",
      e
    );

    return replaceUi(
      ctx,
      `❌ <b>Gagal mengambil grup</b>\n\n${escapeHtml(
        String(
          e.message || e
        ).slice(0, 500)
      )}`,
      backMenu(),
      {
        parse_mode:
          "HTML"
      }
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
    .eq(
      "user_id",
      u.id
    )
    .order(
      "created_at",
      {
        ascending: false
      }
    )
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
        String(
          c.caption
        ).slice(0, 300)
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
        ).toLocaleString(
          "id-ID"
        )}`
      : ""
  ]
    .filter(Boolean)
    .join("\n");
}

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
      user_id:
        u.id,

      name:
        null,

      promotion_id:
        null,

      interval_minutes:
        defaultInterval,

      duration_hours:
        defaultDuration,

      started_at:
        now.toISOString(),

      expires_at:
        initialExpires.toISOString(),

      active:
        false,

      message:
        payload.message ||
        "",

      media_type:
        payload.media_type ||
        null,

      media_file_id:
        payload.media_file_id ||
        null,

      caption:
        payload.caption ||
        null
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

  const buffer =
    Buffer.from(
      arrayBuffer
    );

  /*
    FIX FOTO:
    GramJS menggunakan nama file untuk
    menentukan apakah file dikirim sebagai
    foto atau document.

    Buffer biasa tidak mempunyai extension,
    jadi kita beri nama .jpg.
  */
  buffer.name = "photo.jpg";

  return buffer;
}

/* =========================
   SEND CAMPAIGN
========================= */

async function fire(
  campaignId
) {
  const {
    data: c,
    error:
      campaignError
  } = await sb
    .from("campaigns")
    .select("*")
    .eq(
      "id",
      campaignId
    )
    .maybeSingle();

  if (campaignError) {
    console.error(
      "CAMPAIGN LOAD:",
      campaignError
    );

    return;
  }

  if (
    !c ||
    !c.active
  ) {
    return;
  }

  if (
    !c.expires_at ||
    new Date(
      c.expires_at
    ) <= new Date()
  ) {
    await sb
      .from("campaigns")
      .update({
        active:
          false
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
    error:
      linksError
  } = await sb
    .from(
      "campaign_groups"
    )
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

  /*
    FIX ENTITY:
    Ambil semua dialog Telegram sekali,
    lalu mapping ID -> entity.
  */
  const dialogs =
    await cl.getDialogs({
      limit: 500
    });

  const entityMap =
    new Map();

  for (
    const d of dialogs
  ) {
    const entity =
      d.entity;

    if (
      !entity ||
      (
        !d.isGroup &&
        !d.isChannel
      )
    ) {
      continue;
    }

    const rawId =
      String(
        entity.id?.value ??
        entity.id
      );

    entityMap.set(
      rawId,
      entity
    );
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
        entityMap.get(
          String(
            g.telegram_group_id
          )
        );

      if (!target) {
        throw new Error(
          `Entity grup ${g.telegram_group_id} tidak ditemukan di dialog Telegram`
        );
      }

      if (
        c.media_file_id &&
        photoBuffer
      ) {
        /*
          FIX UTAMA:
          - Buffer sudah punya nama photo.jpg
          - forceDocument false
          Dengan ini GramJS akan mengirimnya
          sebagai foto, bukan document/file.
        */
        await cl.sendFile(
          target,
          {
            file:
              photoBuffer,

            caption:
              c.caption || "",

            forceDocument:
              false
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
            ).slice(
              0,
              1000
            )
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
              t:
                "code"
            }
          );

          await renderUi(
            botUserId,
            "📩 <b>Kode Telegram sudah dikirim.</b>\n\nBalas dengan kode OTP.",
            cancelMenu(),
            {
              parse_mode:
                "HTML"
            }
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
              t:
                "password"
            }
          );

          await renderUi(
            botUserId,
            "🔐 <b>Verifikasi 2 langkah</b>\n\nBalas dengan password Telegram kamu.",
            cancelMenu(),
            {
              parse_mode:
                "HTML"
            }
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

    await renderUi(
      botUserId,
      "✅ <b>Akun Telegram berhasil terhubung.</b>\n\n" +
        "Sesi sudah disimpan dan bisa digunakan kembali setelah server restart.",
      userMenu(),
      {
        parse_mode:
          "HTML"
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
        const name =
          escapeHtml(
            ctx.from.first_name ||
              ctx.from.username ||
              "Admin"
          );

        return renderUi(
          ctx.from.id,
          `🛠 <b>Admin Dashboard</b>\n\n` +
            `👋 Halo, <b>${name}</b>\n` +
            `🆔 ID: <code>${ctx.from.id}</code>\n\n` +
            `Pilih menu yang ingin digunakan.`,
          adminMenu(),
          {
            parse_mode:
              "HTML"
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
        const name =
          escapeHtml(
            ctx.from.first_name ||
              ctx.from.username ||
              "User"
          );

        const text =
          `👋 <b>Halo, ${name}!</b>\n\n` +
          `🆔 Telegram ID: <code>${ctx.from.id}</code>\n\n` +
          `🤖 Bot ini digunakan untuk mengatur pengiriman promosi otomatis ke grup yang kamu pilih.\n\n` +
          `Atur grup, format pesan, jeda, durasi, lalu jalankan campaign dari menu di bawah.\n\n` +
          `👇 <b>Pilih menu:</b>`;

        return renderStart(
          ctx,
          text,
          userMenu()
        );
      }

      return renderUi(
        ctx.from.id,
        "❌ <b>Akun belum aktif</b>\n\n" +
          "Kirim Telegram ID kamu ke admin untuk diaktifkan.",
        new InlineKeyboard(),
        {
          parse_mode:
            "HTML"
        }
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

    const name =
      escapeHtml(
        ctx.from.first_name ||
          ctx.from.username ||
          "User"
      );

    return replaceUi(
      ctx,
      `👋 <b>Halo, ${name}!</b>\n\n` +
        `🆔 Telegram ID: <code>${ctx.from.id}</code>\n\n` +
        `🤖 Atur grup, format promosi, jeda, durasi, dan campaign dari menu di bawah.\n\n` +
        `👇 <b>Pilih menu:</b>`,
      userMenu(),
      {
        parse_mode:
          "HTML"
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

      return replaceUi(
        ctx,
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
        backMenu(),
        {
          parse_mode:
            "HTML"
        }
      );
    } catch (e) {
      return replaceUi(
        ctx,
        `❌ Gagal mengambil status: ${escapeHtml(
          String(
            e.message || e
          ).slice(0, 500)
        )}`,
        backMenu(),
        {
          parse_mode:
            "HTML"
        }
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
        t:
          "message"
      }
    );

    return replaceUi(
      ctx,
      "📝 <b>Buat Format Promosi</b>\n\n" +
        "Kirim salah satu:\n\n" +
        "• Teks biasa\n" +
        "• Foto saja\n" +
        "• Foto + caption\n\n" +
        "Pesan akan disimpan sebagai format promosi.",
      cancelMenu(),
      {
        parse_mode:
          "HTML"
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
        return replaceUi(
          ctx,
          "❌ Belum ada format promosi.\n\n" +
            "Gunakan 📝 Buat Format terlebih dahulu.",
          userMenu()
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

      return replaceUi(
        ctx,
        "✏️ <b>Ubah Format Promosi</b>\n\n" +
          "Kirim format baru:\n\n" +
          "• Teks\n" +
          "• Foto\n" +
          "• Foto + caption\n\n" +
          "Format lama akan diganti.",
        cancelMenu(),
        {
          parse_mode:
            "HTML"
        }
      );
    } catch (e) {
      return replaceUi(
        ctx,
        `❌ Gagal membuka format: ${escapeHtml(
          String(
            e.message || e
          ).slice(0, 500)
        )}`,
        backMenu(),
        {
          parse_mode:
            "HTML"
        }
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
      return replaceUi(
        ctx,
        "❌ Buat format promosi dulu.",
        backMenu()
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

    return replaceUi(
      ctx,
      "⏱ <b>Set Jeda</b>\n\n" +
        "Contoh:\n" +
        "• 10 menit\n" +
        "• 30 menit\n" +
        "• 1 jam\n\n" +
        "Minimal 1 menit.",
      cancelMenu(),
      {
        parse_mode:
          "HTML"
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
      return replaceUi(
        ctx,
        "❌ Buat format promosi dulu.",
        backMenu()
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

    return replaceUi(
      ctx,
      "📅 <b>Set Durasi</b>\n\n" +
        "Contoh:\n" +
        "• 3 hari\n" +
        "• 12 jam\n" +
        "• 30 jam",
      cancelMenu(),
      {
        parse_mode:
          "HTML"
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
      return replaceUi(
        ctx,
        "❌ Belum ada format promosi.",
        backMenu()
      );
    }

    if (
      !c.message &&
      !c.media_file_id
    ) {
      return replaceUi(
        ctx,
        "❌ Format promosi belum dibuat.",
        backMenu()
      );
    }

    if (
      !c.interval_minutes ||
      c.interval_minutes < 1
    ) {
      return replaceUi(
        ctx,
        "❌ Set jeda terlebih dahulu.",
        backMenu()
      );
    }

    if (
      !c.duration_hours ||
      c.duration_hours < 1
    ) {
      return replaceUi(
        ctx,
        "❌ Set durasi terlebih dahulu.",
        backMenu()
      );
    }

    const {
      data: gs,
      error:
        groupError
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
      return replaceUi(
        ctx,
        `❌ Gagal mengambil grup:\n${escapeHtml(
          String(
            groupError.message ||
              groupError
          ).slice(0, 500)
        )}`,
        backMenu(),
        {
          parse_mode:
            "HTML"
        }
      );
    }

    if (!gs?.length) {
      return replaceUi(
        ctx,
        "❌ Belum ada grup aktif.\n\n" +
          "Buka Add Group lalu aktifkan grup.",
        backMenu()
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

    const {
      error:
        deleteError
    } = await sb
      .from(
        "campaign_groups"
      )
      .delete()
      .eq(
        "campaign_id",
        c.id
      );

    if (deleteError) {
      return replaceUi(
        ctx,
        `❌ Gagal membersihkan grup campaign:\n${escapeHtml(
          String(
            deleteError.message ||
              deleteError
          ).slice(0, 500)
        )}`,
        backMenu(),
        {
          parse_mode:
            "HTML"
        }
      );
    }

    const {
      error:
        linkError
    } = await sb
      .from(
        "campaign_groups"
      )
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
      return replaceUi(
        ctx,
        `❌ Gagal menyimpan grup campaign:\n${escapeHtml(
          String(
            linkError.message ||
              linkError
          ).slice(0, 500)
        )}`,
        backMenu(),
        {
          parse_mode:
            "HTML"
        }
      );
    }

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
      return replaceUi(
        ctx,
        `❌ Gagal memulai campaign:\n${escapeHtml(
          String(
            error.message ||
              error
          ).slice(0, 500)
        )}`,
        backMenu(),
        {
          parse_mode:
            "HTML"
        }
      );
    }

    schedule(
      c.id,
      0
    );

    return replaceUi(
      ctx,
      "▶️ <b>Campaign dimulai.</b>\n\n" +
        `⏱ Jeda: ${formatInterval(
          c.interval_minutes
        )}\n` +
        `📅 Durasi: ${formatDuration(
          c.duration_hours
        )}\n` +
        `👥 Grup: ${gs.length}\n\n` +
        "Pesan akan dikirim ke grup aktif sesuai jeda.",
      userMenu(),
      {
        parse_mode:
          "HTML"
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
      return replaceUi(
        ctx,
        `❌ Gagal mengambil campaign:\n${escapeHtml(
          String(
            error.message ||
              error
          ).slice(0, 500)
        )}`,
        backMenu(),
        {
          parse_mode:
            "HTML"
        }
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

    return replaceUi(
      ctx,
      data?.length
        ? "⏹ <b>Campaign dihentikan.</b>"
        : "ℹ️ Tidak ada campaign yang sedang berjalan.",
      userMenu(),
      {
        parse_mode:
          "HTML"
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
      return replaceUi(
        ctx,
        "ℹ️ <b>Sesi akun sudah tersimpan.</b>\n\n" +
          "Jika akun masih terhubung, tidak perlu login ulang.",
        userMenu(),
        {
          parse_mode:
            "HTML"
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

    return replaceUi(
      ctx,
      "🔐 <b>Kirim nomor Telegram</b>\n\n" +
        "Contoh: <b>+628123456789</b>",
      cancelMenu(),
      {
        parse_mode:
          "HTML"
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

    return replaceUi(
      ctx,
      "🏠 <b>Menu utama</b>\n\n" +
        "Pilih menu yang ingin digunakan.",
      userMenu(),
      {
        parse_mode:
          "HTML"
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

    return replaceUi(
      ctx,
      "➕ <b>Add User</b>\n\n" +
        "Kirim numeric Telegram ID user.",
      new InlineKeyboard(),
      {
        parse_mode:
          "HTML"
      }
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
      return replaceUi(
        ctx,
        `❌ ${escapeHtml(
          String(
            error.message ||
              error
          ).slice(0, 500)
        )}`,
        adminMenu(),
        {
          parse_mode:
            "HTML"
        }
      );
    }

    return replaceUi(
      ctx,
      `👥 <b>Total User</b>\n\nJumlah user: <b>${
        count || 0
      }</b>`,
      adminMenu(),
      {
        parse_mode:
          "HTML"
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
      return replaceUi(
        ctx,
        `❌ ${escapeHtml(
          String(
            error.message ||
              error
          ).slice(0, 500)
        )}`,
        adminMenu(),
        {
          parse_mode:
            "HTML"
        }
      );
    }

    const text =
      data?.length
        ? data
            .map(
              (x, i) =>
                `${i + 1}. ${
                  escapeHtml(
                    x.first_name ||
                      "-"
                  )
                } | <code>${
                  x.telegram_user_id
                }</code>`
            )
            .join("\n")
        : "Belum ada user aktif.";

    return replaceUi(
      ctx,
      `🟢 <b>User Aktif</b>\n\n${text}`,
      adminMenu(),
      {
        parse_mode:
          "HTML"
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

    return replaceUi(
      ctx,
      "🔌 <b>Putuskan User</b>\n\n" +
        "Kirim Telegram ID user yang mau dinonaktifkan.",
      new InlineKeyboard(),
      {
        parse_mode:
          "HTML"
      }
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
      OTP / password.
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
        return renderUi(
          userId,
          "❌ Kirim teks saja untuk input ini.",
          cancelMenu()
        );
      }

      const text =
        ctx.message.text.trim();

      if (!text) {
        return renderUi(
          userId,
          "❌ Input kosong.",
          cancelMenu()
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
          return renderUi(
            userId,
            "❌ Kirim Telegram ID berupa angka.",
            adminMenu()
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
          return renderUi(
            userId,
            "❌ ID Telegram tidak valid.",
            adminMenu()
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

        return renderUi(
          userId,
          "✅ <b>User berhasil diaktifkan.</b>",
          adminMenu(),
          {
            parse_mode:
              "HTML"
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
          return renderUi(
            userId,
            "❌ Kirim Telegram ID user.",
            adminMenu()
          );
        }

        const target =
          await getUser(
            Number(
              ctx.message.text.trim()
            )
          );

        if (!target) {
          return renderUi(
            userId,
            "❌ User tidak ditemukan.",
            adminMenu()
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

        return renderUi(
          userId,
          "✅ <b>User diputuskan.</b>",
          adminMenu(),
          {
            parse_mode:
              "HTML"
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

            return renderUi(
              userId,
              "✅ <b>Format foto berhasil diubah.</b>",
              userMenu(),
              {
                parse_mode:
                  "HTML"
              }
            );
          }

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

          return renderUi(
            userId,
            "✅ <b>Format foto berhasil disimpan.</b>",
            userMenu(),
            {
              parse_mode:
                "HTML"
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
            return renderUi(
              userId,
              "❌ Format promosi tidak boleh kosong.",
              cancelMenu()
            );
          }

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

            return renderUi(
              userId,
              "✅ <b>Format teks berhasil diubah.</b>",
              userMenu(),
              {
                parse_mode:
                  "HTML"
              }
            );
          }

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

          return renderUi(
            userId,
            "✅ <b>Format teks berhasil disimpan.</b>",
            userMenu(),
            {
              parse_mode:
                "HTML"
            }
          );
        }

        return renderUi(
          userId,
          "❌ Format tidak didukung.\n\nKirim teks atau foto + caption.",
          cancelMenu()
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
          return renderUi(
            userId,
            "❌ Kirim jeda dalam bentuk teks.\nContoh: 10 menit",
            cancelMenu()
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
          return renderUi(
            userId,
            "❌ Format jeda tidak valid.\n\nContoh: 10 menit / 30 menit / 1 jam.",
            cancelMenu()
          );
        }

        const c =
          await latestCampaign(
            u
          );

        if (!c) {
          return renderUi(
            userId,
            "❌ Buat format promosi dulu.",
            userMenu()
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

        return renderUi(
          userId,
          `✅ <b>Jeda disimpan:</b> ${formatInterval(
            minutes
          )}`,
          userMenu(),
          {
            parse_mode:
              "HTML"
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
          return renderUi(
            userId,
            "❌ Kirim durasi dalam bentuk teks.\nContoh: 3 hari",
            cancelMenu()
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
          return renderUi(
            userId,
            "❌ Format durasi tidak valid.\n\nContoh: 3 hari / 12 jam.",
            cancelMenu()
          );
        }

        const c =
          await latestCampaign(
            u
          );

        if (!c) {
          return renderUi(
            userId,
            "❌ Buat format promosi dulu.",
            userMenu()
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

        return renderUi(
          userId,
          `✅ <b>Durasi disimpan:</b> ${formatDuration(
            hours
          )}`,
          userMenu(),
          {
            parse_mode:
              "HTML"
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
          return renderUi(
            userId,
            "❌ Kirim nomor Telegram dalam bentuk teks.",
            cancelMenu()
          );
        }

        const phone =
          ctx.message.text.trim();

        if (
          !/^\+\d{7,15}$/.test(
            phone
          )
        ) {
          return renderUi(
            userId,
            "❌ Nomor tidak valid.\n\nGunakan format internasional.\nContoh: +628123456789",
            cancelMenu()
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

      /*
        Kalau login dibatalkan,
        jangan kirim pesan kedua.
      */
      if (
        String(
          e.message || e
        ) ===
        "Login dibatalkan."
      ) {
        return;
      }

      return renderUi(
        userId,
        `❌ ${escapeHtml(
          String(
            e.message || e
          ).slice(0, 700)
        )}`,
        userMenu(),
        {
          parse_mode:
            "HTML"
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