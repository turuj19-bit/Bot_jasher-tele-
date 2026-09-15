import asyncio
import logging
import os
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aiogram import Bot, Dispatcher, F
from aiogram.filters import Command, CommandStart
from aiogram.types import Message, CallbackQuery, InlineKeyboardMarkup, InlineKeyboardButton
from dotenv import load_dotenv
from telethon import TelegramClient
from telethon.errors import (
    ApiIdInvalidError,
    PhoneCodeExpiredError,
    PhoneCodeInvalidError,
    PhoneNumberInvalidError,
    SessionPasswordNeededError,
    ChatWriteForbiddenError,
    UserBannedInChannelError,
    ChannelPrivateError,
    FloodWaitError,
)
from telethon.tl.types import Channel, Chat

load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()
ADMIN_ID_RAW = os.getenv("ADMIN_ID", "").strip()
API_ID_RAW = os.getenv("API_ID", "").strip()
API_HASH = os.getenv("API_HASH", "").strip()
DATA_DIR = Path(os.path.expanduser(os.getenv("DATA_DIR", "~/.jasher_userbot"))).resolve()

if not BOT_TOKEN:
    raise RuntimeError("BOT_TOKEN belum diisi di .env")
if not ADMIN_ID_RAW.isdigit():
    raise RuntimeError("ADMIN_ID harus berupa angka.")
if not API_ID_RAW.isdigit():
    raise RuntimeError("API_ID harus berupa angka.")
if not API_HASH:
    raise RuntimeError("API_HASH belum diisi di .env")

ADMIN_ID = int(ADMIN_ID_RAW)
API_ID = int(API_ID_RAW)

DATA_DIR.mkdir(parents=True, exist_ok=True)
SESSION_DIR = DATA_DIR / "sessions"
MEDIA_DIR = DATA_DIR / "media"
SESSION_DIR.mkdir(parents=True, exist_ok=True)
MEDIA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "jasher.db"

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")
log = logging.getLogger("jasher")

bot = Bot(BOT_TOKEN)
dp = Dispatcher()

# Per-chat temporary input state. Nothing here is written to disk.
states: dict[int, dict] = {}
clients: dict[int, TelegramClient] = {}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                user_id INTEGER PRIMARY KEY,
                added_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS accounts (
                user_id INTEGER PRIMARY KEY,
                phone TEXT NOT NULL,
                session_name TEXT NOT NULL,
                logged_in INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS groups_selected (
                user_id INTEGER NOT NULL,
                chat_id INTEGER NOT NULL,
                title TEXT NOT NULL,
                PRIMARY KEY (user_id, chat_id)
            );
            CREATE TABLE IF NOT EXISTS promos (
                user_id INTEGER PRIMARY KEY,
                kind TEXT NOT NULL,
                media_path TEXT,
                content TEXT,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS settings (
                user_id INTEGER PRIMARY KEY,
                interval_minutes INTEGER NOT NULL,
                duration_minutes INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS schedules (
                user_id INTEGER PRIMARY KEY,
                started_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 1,
                last_sent_at TEXT
            );
            """
        )


def is_admin(user_id: int) -> bool:
    return user_id == ADMIN_ID


def is_allowed(user_id: int) -> bool:
    if is_admin(user_id):
        return True
    with db() as conn:
        return conn.execute("SELECT 1 FROM users WHERE user_id=?", (user_id,)).fetchone() is not None


def admin_menu() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="➕ Add User", callback_data="admin_add_user")],
    ])


def user_menu() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="➕ Add Group", callback_data="add_group"),
         InlineKeyboardButton(text="📢 Promo", callback_data="promo")],
        [InlineKeyboardButton(text="⏱ Jadwal", callback_data="schedule"),
         InlineKeyboardButton(text="📦 Stok", callback_data="stock")],
        [InlineKeyboardButton(text="▶️ Mulai", callback_data="start_schedule"),
         InlineKeyboardButton(text="⏹ Stop", callback_data="stop_schedule")],
    ])


def back_menu() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="⬅️ Menu", callback_data="back_menu")]
    ])


def login_button() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="🔐 Login Telegram", callback_data="login")],
        [InlineKeyboardButton(text="⬅️ Menu", callback_data="back_menu")],
    ])


async def answer_menu(message: Message, text: str = "Pilih menu:"):
    await message.answer(text, reply_markup=user_menu())


def get_account(user_id: int):
    with db() as conn:
        return conn.execute("SELECT * FROM accounts WHERE user_id=?", (user_id,)).fetchone()


def session_name(user_id: int) -> str:
    return str(SESSION_DIR / f"user_{user_id}")


async def get_client(user_id: int) -> TelegramClient | None:
    account = get_account(user_id)
    if not account or not account["logged_in"]:
        return None
    client = clients.get(user_id)
    if client is None:
        client = TelegramClient(session_name(user_id), API_ID, API_HASH)
        await client.connect()
        if not await client.is_user_authorized():
            with db() as conn:
                conn.execute("UPDATE accounts SET logged_in=0 WHERE user_id=?", (user_id,))
                conn.commit()
            await client.disconnect()
            return None
        clients[user_id] = client
    return client


async def disconnect_client(user_id: int) -> None:
    client = clients.pop(user_id, None)
    if client:
        await client.disconnect()


async def can_send_to_dialog(client: TelegramClient, entity) -> bool:
    """Return True only when the logged-in account can currently send there."""
    try:
        if isinstance(entity, Channel):
            if getattr(entity, "broadcast", False):
                # Broadcast channels are not group targets for this bot.
                return False
            perms = await client.get_permissions(entity, "me")
            # Telethon returns True when the account IS allowed to send.
            if hasattr(perms, "send_messages") and not perms.send_messages:
                return False
            if getattr(perms, "send_media", False) is False and getattr(entity, "megagroup", False):
                # Text is still possible in many groups; send_media is checked at send time.
                pass
            default = getattr(entity, "default_banned_rights", None)
            if default and getattr(default, "send_messages", False):
                return False
            return True
        if isinstance(entity, Chat):
            default = getattr(entity, "default_banned_rights", None)
            if default and getattr(default, "send_messages", False):
                return False
            return True
    except Exception as exc:
        log.info("Skip group permission check: %s", exc)
    return False


async def group_list(user_id: int):
    client = await get_client(user_id)
    if not client:
        return None, "Belum login Telegram."
    found = []
    try:
        async for dialog in client.iter_dialogs():
            entity = dialog.entity
            if not isinstance(entity, (Channel, Chat)):
                continue
            if isinstance(entity, Channel) and not getattr(entity, "megagroup", False):
                continue
            if getattr(entity, "left", False) or getattr(entity, "deactivated", False):
                continue
            if await can_send_to_dialog(client, entity):
                found.append((int(dialog.id), dialog.name or str(dialog.id)))
    except Exception as exc:
        return None, f"Gagal membaca grup: {exc}"
    return found, None


def selected_groups(user_id: int):
    with db() as conn:
        return conn.execute(
            "SELECT chat_id,title FROM groups_selected WHERE user_id=? ORDER BY title COLLATE NOCASE",
            (user_id,),
        ).fetchall()


def save_promo(user_id: int, kind: str, media_path: str | None, content: str | None):
    with db() as conn:
        conn.execute(
            """INSERT INTO promos(user_id,kind,media_path,content,updated_at)
               VALUES(?,?,?,?,?)
               ON CONFLICT(user_id) DO UPDATE SET
                 kind=excluded.kind, media_path=excluded.media_path,
                 content=excluded.content, updated_at=excluded.updated_at""",
            (user_id, kind, media_path, content, now_iso()),
        )
        conn.commit()


def get_promo(user_id: int):
    with db() as conn:
        return conn.execute("SELECT * FROM promos WHERE user_id=?", (user_id,)).fetchone()


def save_settings(user_id: int, interval_minutes: int, duration_minutes: int):
    with db() as conn:
        conn.execute(
            """INSERT INTO settings(user_id,interval_minutes,duration_minutes)
               VALUES(?,?,?)
               ON CONFLICT(user_id) DO UPDATE SET
                 interval_minutes=excluded.interval_minutes,
                 duration_minutes=excluded.duration_minutes""",
            (user_id, interval_minutes, duration_minutes),
        )
        conn.commit()


def get_settings(user_id: int):
    with db() as conn:
        return conn.execute("SELECT * FROM settings WHERE user_id=?", (user_id,)).fetchone()


def get_schedule(user_id: int):
    with db() as conn:
        return conn.execute("SELECT * FROM schedules WHERE user_id=?", (user_id,)).fetchone()


def set_schedule(user_id: int, expires_at: str):
    with db() as conn:
        conn.execute(
            """INSERT INTO schedules(user_id,started_at,expires_at,active,last_sent_at)
               VALUES(?,?,?,?,NULL)
               ON CONFLICT(user_id) DO UPDATE SET
                 started_at=excluded.started_at, expires_at=excluded.expires_at,
                 active=1, last_sent_at=NULL""",
            (user_id, now_iso(), expires_at, 1),
        )
        conn.commit()


def mark_schedule_sent(user_id: int):
    with db() as conn:
        conn.execute("UPDATE schedules SET last_sent_at=? WHERE user_id=?", (now_iso(), user_id))
        conn.commit()


def stop_schedule_db(user_id: int):
    with db() as conn:
        conn.execute("UPDATE schedules SET active=0 WHERE user_id=?", (user_id,))
        conn.commit()


def parse_positive(value: str) -> int | None:
    try:
        n = int(value.strip())
        return n if n > 0 else None
    except ValueError:
        return None


async def send_promo_to_group(client: TelegramClient, chat_id: int, promo) -> tuple[bool, str | None]:
    try:
        if promo["kind"] == "photo" and promo["media_path"] and Path(promo["media_path"]).exists():
            await client.send_file(chat_id, promo["media_path"], caption=promo["content"] or "")
        else:
            text = promo["content"] or ""
            if not text.strip():
                return False, "Promo kosong"
            await client.send_message(chat_id, text)
        return True, None
    except FloodWaitError as exc:
        return False, f"FloodWait {exc.seconds}s"
    except (ChatWriteForbiddenError, UserBannedInChannelError) as exc:
        return False, exc.__class__.__name__
    except (ChannelPrivateError,) as exc:
        return False, exc.__class__.__name__
    except Exception as exc:
        return False, str(exc)[:180]


async def schedule_worker(user_id: int):
    """One persistent worker per authorized user; no permission bypasses."""
    while True:
        schedule = get_schedule(user_id)
        if not schedule or not schedule["active"]:
            return
        expires = datetime.fromisoformat(schedule["expires_at"])
        if datetime.now(timezone.utc) >= expires:
            stop_schedule_db(user_id)
            try:
                await bot.send_message(user_id, "⏹ Jadwal selesai. Durasi sudah habis.", reply_markup=user_menu())
            except Exception:
                pass
            return

        settings = get_settings(user_id)
        promo = get_promo(user_id)
        groups = selected_groups(user_id)
        client = await get_client(user_id)
        if not settings or not promo or not groups or not client:
            stop_schedule_db(user_id)
            try:
                await bot.send_message(user_id, "⏹ Jadwal dihentikan karena promo/grup/login tidak tersedia.", reply_markup=user_menu())
            except Exception:
                pass
            return

        for row in groups:
            schedule = get_schedule(user_id)
            if not schedule or not schedule["active"]:
                return
            try:
                ok, error = await send_promo_to_group(client, int(row["chat_id"]), promo)
                if not ok:
                    # Restricted/private groups are skipped. We never try to bypass restrictions.
                    log.info("User %s group %s failed: %s", user_id, row["chat_id"], error)
            except Exception:
                log.exception("Send error for user %s group %s", user_id, row["chat_id"])
            await asyncio.sleep(1)

        mark_schedule_sent(user_id)
        wait_seconds = max(60, int(settings["interval_minutes"]) * 60)
        remaining = max(0, int((expires - datetime.now(timezone.utc)).total_seconds()))
        await asyncio.sleep(min(wait_seconds, remaining or wait_seconds))


workers: dict[int, asyncio.Task] = {}


def start_worker(user_id: int):
    old = workers.get(user_id)
    if old and not old.done():
        old.cancel()
    workers[user_id] = asyncio.create_task(schedule_worker(user_id))


def stop_worker(user_id: int):
    task = workers.pop(user_id, None)
    if task and not task.done():
        task.cancel()
    stop_schedule_db(user_id)


async def require_allowed(message: Message) -> bool:
    uid = message.from_user.id if message.from_user else 0
    if not is_allowed(uid):
        await message.answer("⛔ Kamu belum ditambahkan admin.")
        return False
    return True


async def show_main(message: Message):
    uid = message.from_user.id
    if is_admin(uid):
        await message.answer("🤖 JASHER\n\nMenu admin:", reply_markup=admin_menu())
    elif is_allowed(uid):
        await answer_menu(message, "🤖 JASHER\n\nPilih:")
    else:
        await message.answer("⛔ Kamu belum ditambahkan admin.")


@dp.message(CommandStart())
async def start(message: Message):
    await show_main(message)


@dp.message(Command("menu"))
async def menu_cmd(message: Message):
    await show_main(message)


@dp.message(Command("adduser"))
async def adduser(message: Message):
    if not is_admin(message.from_user.id):
        await message.answer("⛔ Akses ditolak.")
        return
    parts = (message.text or "").split()
    if len(parts) != 2 or not parts[1].isdigit():
        await message.answer("Format: /adduser USER_ID")
        return
    uid = int(parts[1])
    with db() as conn:
        conn.execute("INSERT OR IGNORE INTO users(user_id,added_at) VALUES(?,?)", (uid, now_iso()))
        conn.commit()
    await message.answer(f"✅ User {uid} sudah ditambahkan.")


@dp.callback_query(F.data == "admin_add_user")
async def admin_add_user(callback: CallbackQuery):
    if not is_admin(callback.from_user.id):
        await callback.answer("Akses ditolak", show_alert=True)
        return
    states[callback.from_user.id] = {"step": "add_user"}
    await callback.message.answer("Kirim USER ID yang mau ditambahkan.")
    await callback.answer()


@dp.callback_query(F.data == "back_menu")
async def back_menu(callback: CallbackQuery):
    states.pop(callback.from_user.id, None)
    await callback.message.answer("Menu:", reply_markup=user_menu() if not is_admin(callback.from_user.id) else admin_menu())
    await callback.answer()


@dp.callback_query(F.data == "login")
async def login_start(callback: CallbackQuery):
    uid = callback.from_user.id
    if not is_allowed(uid):
        await callback.answer("Akses ditolak", show_alert=True)
        return
    states[uid] = {"step": "phone"}
    await callback.message.answer(
        "🔐 Login Telegram\n\n"
        "Kirim nomor Telegram dalam format internasional, contoh: +628123456789.\n"
        "Kode login/2FA dipakai hanya untuk login sesi akun kamu. Jangan kirim kode ke orang lain."
    )
    await callback.answer()


@dp.callback_query(F.data == "add_group")
async def add_group(callback: CallbackQuery):
    uid = callback.from_user.id
    if not is_allowed(uid):
        await callback.answer("Akses ditolak", show_alert=True)
        return
    client = await get_client(uid)
    if not client:
        await callback.message.answer("🔐 Hubungkan akun Telegram dulu.", reply_markup=login_button())
        await callback.answer()
        return

    await callback.message.answer("🔎 Mencari grup yang akun kamu bisa kirim pesan...")
    groups, error = await group_list(uid)
    if error:
        await callback.message.answer(f"❌ {error}", reply_markup=back_menu())
        await callback.answer()
        return
    if not groups:
        await callback.message.answer("Tidak ada grup yang bisa dipilih.", reply_markup=back_menu())
        await callback.answer()
        return

    buttons = []
    for chat_id, title in groups[:50]:
        buttons.append([InlineKeyboardButton(text=f"☐ {title[:45]}", callback_data=f"pick:{chat_id}")])
    buttons.append([InlineKeyboardButton(text="✅ Selesai", callback_data="group_done")])
    buttons.append([InlineKeyboardButton(text="⬅️ Menu", callback_data="back_menu")])
    await callback.message.answer("Pilih grup yang mau dipakai:", reply_markup=InlineKeyboardMarkup(inline_keyboard=buttons))
    states[uid] = {"step": "pick_groups", "available": {str(cid): title for cid, title in groups}}
    await callback.answer()


@dp.callback_query(F.data.startswith("pick:"))
async def pick_group(callback: CallbackQuery):
    uid = callback.from_user.id
    state = states.get(uid, {})
    if state.get("step") != "pick_groups":
        await callback.answer("Daftar grup sudah tidak aktif.", show_alert=True)
        return
    chat_id = callback.data.split(":", 1)[1]
    title = state.get("available", {}).get(chat_id)
    if not title:
        await callback.answer("Grup tidak ditemukan.", show_alert=True)
        return
    with db() as conn:
        exists = conn.execute("SELECT 1 FROM groups_selected WHERE user_id=? AND chat_id=?", (uid, int(chat_id))).fetchone()
        if exists:
            conn.execute("DELETE FROM groups_selected WHERE user_id=? AND chat_id=?", (uid, int(chat_id)))
            selected = False
        else:
            conn.execute("INSERT INTO groups_selected(user_id,chat_id,title) VALUES(?,?,?)", (uid, int(chat_id), title))
            selected = True
        conn.commit()
    await callback.answer("Ditambahkan" if selected else "Dihapus")


@dp.callback_query(F.data == "group_done")
async def group_done(callback: CallbackQuery):
    uid = callback.from_user.id
    states.pop(uid, None)
    rows = selected_groups(uid)
    await callback.message.answer(f"✅ Grup tersimpan: {len(rows)}", reply_markup=user_menu())
    await callback.answer()


@dp.callback_query(F.data == "promo")
async def promo_menu(callback: CallbackQuery):
    uid = callback.from_user.id
    if not is_allowed(uid):
        await callback.answer("Akses ditolak", show_alert=True)
        return
    states[uid] = {"step": "promo"}
    await callback.message.answer(
        "📢 Promo\n\n"
        "Kirim pesan yang mau dikirim. Bisa:\n"
        "• teks saja\n"
        "• foto + caption\n\n"
        "Pesan terakhir yang kamu kirim akan jadi promo aktif."
    )
    await callback.answer()


@dp.callback_query(F.data == "schedule")
async def schedule_menu(callback: CallbackQuery):
    uid = callback.from_user.id
    if not is_allowed(uid):
        await callback.answer("Akses ditolak", show_alert=True)
        return
    states[uid] = {"step": "interval"}
    await callback.message.answer("⏱ Jadwal\n\nKirim jeda dalam menit. Contoh: 60 = setiap 1 jam.")
    await callback.answer()


@dp.callback_query(F.data == "stock")
async def stock(callback: CallbackQuery):
    uid = callback.from_user.id
    if not is_allowed(uid):
        await callback.answer("Akses ditolak", show_alert=True)
        return
    rows = selected_groups(uid)
    if not rows:
        text = "📦 Stok grup masih kosong."
    else:
        text = "📦 Stok grup:\n\n" + "\n".join(f"• {r['title']}" for r in rows)
    await callback.message.answer(text, reply_markup=back_menu())
    await callback.answer()


@dp.callback_query(F.data == "start_schedule")
async def start_schedule(callback: CallbackQuery):
    uid = callback.from_user.id
    if not is_allowed(uid):
        await callback.answer("Akses ditolak", show_alert=True)
        return
    promo = get_promo(uid)
    settings = get_settings(uid)
    groups = selected_groups(uid)
    client = await get_client(uid)
    if not client:
        await callback.message.answer("🔐 Login Telegram dulu.", reply_markup=login_button())
    elif not promo:
        await callback.message.answer("📢 Promo belum diisi.", reply_markup=user_menu())
    elif not groups:
        await callback.message.answer("➕ Belum ada grup.", reply_markup=user_menu())
    elif not settings:
        await callback.message.answer("⏱ Jadwal belum diatur.", reply_markup=user_menu())
    else:
        expires = datetime.now(timezone.utc) + timedelta(minutes=int(settings["duration_minutes"]))
        set_schedule(uid, expires.isoformat())
        start_worker(uid)
        await callback.message.answer(
            f"▶️ Mulai.\nJeda: {settings['interval_minutes']} menit\nDurasi: {settings['duration_minutes']} menit\nGrup: {len(groups)}",
            reply_markup=user_menu(),
        )
    await callback.answer()


@dp.callback_query(F.data == "stop_schedule")
async def stop_schedule(callback: CallbackQuery):
    uid = callback.from_user.id
    if not is_allowed(uid):
        await callback.answer("Akses ditolak", show_alert=True)
        return
    stop_worker(uid)
    await callback.message.answer("⏹ Jadwal dihentikan.", reply_markup=user_menu())
    await callback.answer()


@dp.message()
async def text_input(message: Message):
    uid = message.from_user.id if message.from_user else 0
    state = states.get(uid, {})
    step = state.get("step")

    if is_admin(uid) and step == "add_user":
        raw = (message.text or "").strip()
        if not raw.isdigit():
            await message.answer("USER ID harus angka. Contoh: 123456789")
            return
        target = int(raw)
        with db() as conn:
            conn.execute("INSERT OR IGNORE INTO users(user_id,added_at) VALUES(?,?)", (target, now_iso()))
            conn.commit()
        states.pop(uid, None)
        await message.answer(f"✅ User {target} sudah ditambahkan.", reply_markup=admin_menu())
        return

    if not is_allowed(uid):
        return

    if step == "phone":
        phone = (message.text or "").strip()
        if not re.fullmatch(r"\+?[0-9]{7,16}", phone):
            await message.answer("Nomor tidak valid. Contoh: +628123456789")
            return
        # Close any stale login client first so a previous attempt cannot
        # swallow/replace the new code-login session.
        await disconnect_client(uid)
        client = TelegramClient(session_name(uid), API_ID, API_HASH)
        try:
            await client.connect()

            # If this session is already authorized, keep it and skip code login.
            if await client.is_user_authorized():
                with db() as conn:
                    conn.execute(
                        "INSERT INTO accounts(user_id,phone,session_name,logged_in) VALUES(?,?,?,1) "
                        "ON CONFLICT(user_id) DO UPDATE SET phone=excluded.phone,"
                        "session_name=excluded.session_name,logged_in=1",
                        (uid, phone, session_name(uid)),
                    )
                    conn.commit()
                clients[uid] = client
                states.pop(uid, None)
                await message.answer("✅ Sesi Telegram sudah terhubung.", reply_markup=user_menu())
                return

            sent = await client.send_code_request(phone)

            with db() as conn:
                conn.execute(
                    "INSERT INTO accounts(user_id,phone,session_name,logged_in) VALUES(?,?,?,0) "
                    "ON CONFLICT(user_id) DO UPDATE SET phone=excluded.phone,"
                    "session_name=excluded.session_name,logged_in=0",
                    (uid, phone, session_name(uid)),
                )
                conn.commit()

            clients[uid] = client
            # Keep the phone_code_hash returned by Telegram explicitly. This
            # makes the next sign-in deterministic instead of relying on
            # implicit client state.
            states[uid] = {
                "step": "code",
                "phone": phone,
                "phone_code_hash": sent.phone_code_hash,
            }
            await message.answer(
                "📩 Kode login Telegram sudah diminta. "
                "Cek aplikasi Telegram di perangkat yang masih login; "
                "Telegram sering mengirim kode ke sana, bukan SMS. "
                "Kirim kode 5/6 digitnya di sini."
            )
        except (PhoneNumberInvalidError, ApiIdInvalidError) as exc:
            await client.disconnect()
            await message.answer(f"❌ Login gagal: {exc}")
        except FloodWaitError as exc:
            await client.disconnect()
            await message.answer(f"⏳ Telegram meminta menunggu {exc.seconds} detik sebelum mencoba lagi.")
        except Exception as exc:
            await client.disconnect()
            await message.answer(f"❌ Gagal meminta kode: {exc}")
        return

    if step == "code":
        code = (message.text or "").replace(" ", "").strip()
        client = clients.get(uid)
        account = get_account(uid)
        if not client or not account:
            states.pop(uid, None)
            await message.answer("Sesi login hilang. Tekan Login lagi.", reply_markup=login_button())
            return
        try:
            await client.sign_in(
                phone=account["phone"],
                code=code,
                phone_code_hash=state.get("phone_code_hash"),
            )
            with db() as conn:
                conn.execute("UPDATE accounts SET logged_in=1 WHERE user_id=?", (uid,))
                conn.commit()
            states.pop(uid, None)
            await message.answer("✅ Akun Telegram berhasil terhubung.", reply_markup=user_menu())
        except SessionPasswordNeededError:
            states[uid] = {"step": "password"}
            await message.answer("🔑 Akun memakai 2FA. Kirim password 2FA Telegram kamu.")
        except (PhoneCodeInvalidError, PhoneCodeExpiredError):
            await message.answer("❌ Kode salah/kedaluwarsa. Tekan Login lagi untuk minta kode baru.")
        except Exception as exc:
            await message.answer(f"❌ Login gagal: {exc}")
        return

    if step == "password":
        password = message.text or ""
        client = clients.get(uid)
        if not client:
            states.pop(uid, None)
            await message.answer("Sesi login hilang. Tekan Login lagi.", reply_markup=login_button())
            return
        try:
            await client.sign_in(password=password)
            with db() as conn:
                conn.execute("UPDATE accounts SET logged_in=1 WHERE user_id=?", (uid,))
                conn.commit()
            states.pop(uid, None)
            await message.answer("✅ Akun Telegram berhasil terhubung.", reply_markup=user_menu())
        except Exception as exc:
            await message.answer(f"❌ Password 2FA salah/gagal: {exc}")
        return

    if step == "interval":
        interval = parse_positive(message.text or "")
        if interval is None:
            await message.answer("Kirim angka menit, contoh: 60")
            return
        states[uid] = {"step": "duration", "interval": interval}
        await message.answer("Sekarang kirim durasi dalam menit. Contoh: 4320 = 3 hari.")
        return

    if step == "duration":
        duration = parse_positive(message.text or "")
        interval = state.get("interval")
        if duration is None or not interval:
            await message.answer("Kirim angka durasi dalam menit, contoh: 4320")
            return
        save_settings(uid, int(interval), int(duration))
        states.pop(uid, None)
        await message.answer(
            f"✅ Jadwal tersimpan.\nJeda: {interval} menit\nDurasi: {duration} menit",
            reply_markup=user_menu(),
        )
        return

    if step == "promo":
        if message.photo:
            photo = message.photo[-1]
            path = MEDIA_DIR / f"promo_{uid}_{int(datetime.now().timestamp())}.jpg"
            await bot.download(photo, destination=path)
            old = get_promo(uid)
            if old and old["media_path"] and old["media_path"] != str(path):
                try:
                    Path(old["media_path"]).unlink(missing_ok=True)
                except Exception:
                    pass
            save_promo(uid, "photo", str(path), message.caption or "")
            states.pop(uid, None)
            await message.answer("✅ Promo foto + caption tersimpan.", reply_markup=user_menu())
        elif message.text:
            save_promo(uid, "text", None, message.text)
            states.pop(uid, None)
            await message.answer("✅ Promo teks tersimpan.", reply_markup=user_menu())
        else:
            await message.answer("Kirim teks atau foto + caption.")
        return


async def main():
    init_db()
    log.info("JASHER started. Data: %s", DATA_DIR)
    try:
        await dp.start_polling(bot, allowed_updates=dp.resolve_used_update_types())
    finally:
        for uid, task in list(workers.items()):
            task.cancel()
        for uid in list(clients):
            await disconnect_client(uid)
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())
