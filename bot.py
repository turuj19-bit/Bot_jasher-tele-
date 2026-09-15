import asyncio
import os
import sqlite3
from pathlib import Path
from datetime import datetime

from aiogram import Bot, Dispatcher, F
from aiogram.filters import Command
from aiogram.types import Message, CallbackQuery
from aiogram.types import InlineKeyboardMarkup, InlineKeyboardButton

from telethon import TelegramClient
from telethon.errors import SessionPasswordNeededError


# =========================================================
# CONFIG
# =========================================================

BOT_TOKEN = os.getenv("BOT_TOKEN", "")
API_ID = int(os.getenv("API_ID", "0"))
API_HASH = os.getenv("API_HASH", "")
ADMIN_ID = int(os.getenv("ADMIN_ID", "0"))

DATA_DIR = Path(
    os.getenv("DATA_DIR", "~/.jasher_userbot")
).expanduser()

DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = DATA_DIR / "bot.db"

SESSION_DIR = DATA_DIR / "sessions"
SESSION_DIR.mkdir(parents=True, exist_ok=True)


# =========================================================
# BOT
# =========================================================

bot = Bot(BOT_TOKEN)
dp = Dispatcher()


# Telegram clients per user
clients: dict[int, TelegramClient] = {}

# Login / input states
states: dict[int, dict] = {}

# Running campaign workers
workers: dict[int, asyncio.Task] = {}


# =========================================================
# DATABASE
# =========================================================

def db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def init_db():
    con = db()

    con.execute("""
        CREATE TABLE IF NOT EXISTS users (
            user_id INTEGER PRIMARY KEY,
            created_at TEXT NOT NULL
        )
    """)

    con.execute("""
        CREATE TABLE IF NOT EXISTS accounts (
            user_id INTEGER PRIMARY KEY,
            phone TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    """)

    con.execute("""
        CREATE TABLE IF NOT EXISTS targets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            chat_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            UNIQUE(user_id, chat_id)
        )
    """)

    con.execute("""
        CREATE TABLE IF NOT EXISTS campaigns (
            user_id INTEGER PRIMARY KEY,
            promo TEXT NOT NULL,
            interval_seconds INTEGER NOT NULL DEFAULT 60,
            duration_seconds INTEGER NOT NULL DEFAULT 3600
        )
    """)

    con.commit()
    con.close()


def is_allowed(uid: int) -> bool:
    if uid == ADMIN_ID:
        return True

    con = db()

    row = con.execute(
        "SELECT 1 FROM users WHERE user_id=?",
        (uid,)
    ).fetchone()

    con.close()

    return row is not None


def save_user(uid: int):
    con = db()

    con.execute(
        """
        INSERT OR IGNORE INTO users(user_id, created_at)
        VALUES(?, ?)
        """,
        (uid, datetime.utcnow().isoformat())
    )

    con.commit()
    con.close()


def save_account(uid: int, phone: str):
    con = db()

    con.execute(
        """
        INSERT INTO accounts(user_id, phone, created_at)
        VALUES(?, ?, ?)

        ON CONFLICT(user_id)
        DO UPDATE SET phone=excluded.phone
        """,
        (
            uid,
            phone,
            datetime.utcnow().isoformat()
        )
    )

    con.commit()
    con.close()


def get_account(uid: int):
    con = db()

    row = con.execute(
        "SELECT * FROM accounts WHERE user_id=?",
        (uid,)
    ).fetchone()

    con.close()

    return row


# =========================================================
# TELEGRAM SESSION
# =========================================================

def session_name(uid: int) -> str:
    return str(
        SESSION_DIR / f"user_{uid}"
    )


async def get_client(uid: int):

    client = clients.get(uid)

    if client is None:
        client = TelegramClient(
            session_name(uid),
            API_ID,
            API_HASH
        )

        clients[uid] = client

    if not client.is_connected():
        await client.connect()

    return client


# =========================================================
# MENUS
# =========================================================

def main_menu():

    return InlineKeyboardMarkup(
        inline_keyboard=[

            [
                InlineKeyboardButton(
                    text="🔐 Login Telegram",
                    callback_data="login"
                ),

                InlineKeyboardButton(
                    text="➕ Add Group",
                    callback_data="add_group"
                )
            ],

            [
                InlineKeyboardButton(
                    text="📢 Promo",
                    callback_data="promo"
                ),

                InlineKeyboardButton(
                    text="⏱ Jadwal",
                    callback_data="schedule"
                )
            ],

            [
                InlineKeyboardButton(
                    text="▶️ Mulai",
                    callback_data="start"
                ),

                InlineKeyboardButton(
                    text="⏹ Stop",
                    callback_data="stop"
                )
            ]
        ]
    )


def back_menu():

    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="⬅️ Menu",
                    callback_data="menu"
                )
            ]
        ]
    )


# =========================================================
# /START
# =========================================================

@dp.message(Command("start"))
async def start_cmd(message: Message):

    uid = message.from_user.id

    if not is_allowed(uid):
        await message.answer(
            "❌ Kamu belum diizinkan menggunakan bot."
        )
        return

    save_user(uid)

    await message.answer(
        "Panel User\n\n"
        "Pilih menu:",
        reply_markup=main_menu()
    )


# =========================================================
# ADMIN ADD USER
# =========================================================

@dp.message(Command("adduser"))
async def adduser_cmd(message: Message):

    if message.from_user.id != ADMIN_ID:
        return

    parts = message.text.split()

    if len(parts) != 2 or not parts[1].isdigit():

        await message.answer(
            "Format:\n"
            "/adduser USER_ID"
        )

        return

    uid = int(parts[1])

    save_user(uid)

    await message.answer(
        f"✅ User {uid} berhasil ditambahkan."
    )


# =========================================================
# BACK TO MENU
# =========================================================

@dp.callback_query(F.data == "menu")
async def menu_cb(call: CallbackQuery):

    await call.answer()

    uid = call.from_user.id

    if not is_allowed(uid):
        return

    await call.message.edit_text(
        "Panel User\n\n"
        "Pilih menu:",
        reply_markup=main_menu()
    )


# =========================================================
# LOGIN TELEGRAM
# =========================================================

@dp.callback_query(F.data == "login")
async def login_start(call: CallbackQuery):

    await call.answer()

    uid = call.from_user.id

    if not is_allowed(uid):
        return

    states[uid] = {
        "step": "phone"
    }

    await call.message.edit_text(
        "🔐 Login Telegram\n\n"
        "Kirim nomor Telegram kamu.\n\n"
        "Contoh:\n"
        "+628123456789"
    )


# =========================================================
# ADD GROUP
# =========================================================

@dp.callback_query(F.data == "add_group")
async def add_group_cb(call: CallbackQuery):

    await call.answer()

    uid = call.from_user.id

    if not is_allowed(uid):
        return

    client = await get_client(uid)

    if not await client.is_user_authorized():

        await call.message.edit_text(
            "❌ Akun Telegram belum login.\n\n"
            "Tekan 🔐 Login Telegram terlebih dahulu.",
            reply_markup=back_menu()
        )

        return

    await call.message.edit_text(
        "⏳ Mengambil daftar grup..."
    )

    groups = []

    async for dialog in client.iter_dialogs():

        if not dialog.is_group and not dialog.is_channel:
            continue

        entity = dialog.entity

        try:

            perms = await client.get_permissions(
                entity,
                "me"
            )

            # FIX:
            # Jangan menolak grup ketika user sebenarnya
            # mempunyai izin mengirim pesan.
            #
            # Hanya skip jika Telegram secara eksplisit
            # mengatakan send_messages = False.

            if getattr(
                perms,
                "send_messages",
                None
            ) is False:

                continue

        except Exception:
            pass

        groups.append(
            (
                dialog.id,
                dialog.name
            )
        )

    if not groups:

        await call.message.edit_text(
            "❌ Tidak ada grup/channel "
            "yang bisa digunakan untuk mengirim.",
            reply_markup=back_menu()
        )

        return

    buttons = []

    for chat_id, title in groups[:50]:

        buttons.append(
            [
                InlineKeyboardButton(
                    text=title[:50],
                    callback_data=f"pick_group:{chat_id}"
                )
            ]
        )

    buttons.append(
        [
            InlineKeyboardButton(
                text="⬅️ Menu",
                callback_data="menu"
            )
        ]
    )

    await call.message.edit_text(
        "➕ Pilih grup/channel:",
        reply_markup=InlineKeyboardMarkup(
            inline_keyboard=buttons
        )
    )


# =========================================================
# SELECT GROUP
# =========================================================

@dp.callback_query(
    F.data.startswith("pick_group:")
)
async def pick_group(call: CallbackQuery):

    await call.answer()

    uid = call.from_user.id

    if not is_allowed(uid):
        return

    chat_id = int(
        call.data.split(":", 1)[1]
    )

    client = await get_client(uid)

    try:

        entity = await client.get_entity(
            chat_id
        )

        title = getattr(
            entity,
            "title",
            str(chat_id)
        )

        con = db()

        con.execute(
            """
            INSERT OR IGNORE INTO targets(
                user_id,
                chat_id,
                title
            )
            VALUES(?, ?, ?)
            """,
            (
                uid,
                chat_id,
                title
            )
        )

        con.commit()
        con.close()

        await call.message.edit_text(
            f"✅ Grup berhasil ditambahkan:\n\n"
            f"{title}",
            reply_markup=back_menu()
        )

    except Exception as e:

        await call.message.edit_text(
            f"❌ Gagal menambahkan grup:\n{e}",
            reply_markup=back_menu()
        )


# =========================================================
# PROMO
# =========================================================

@dp.callback_query(F.data == "promo")
async def promo_cb(call: CallbackQuery):

    await call.answer()

    uid = call.from_user.id

    if not is_allowed(uid):
        return

    states[uid] = {
        "step": "promo"
    }

    await call.message.edit_text(
        "📢 Kirim teks promo yang ingin digunakan."
    )


# =========================================================
# SCHEDULE
# =========================================================

@dp.callback_query(F.data == "schedule")
async def schedule_cb(call: CallbackQuery):

    await call.answer()

    uid = call.from_user.id

    if not is_allowed(uid):
        return

    states[uid] = {
        "step": "schedule_interval"
    }

    await call.message.edit_text(
        "⏱ Masukkan interval dalam detik.\n\n"
        "Contoh:\n"
        "60"
    )


# =========================================================
# START CAMPAIGN
# =========================================================

@dp.callback_query(F.data == "start")
async def start_campaign(call: CallbackQuery):

    await call.answer()

    uid = call.from_user.id

    if not is_allowed(uid):
        return

    task = workers.get(uid)

    if task and not task.done():

        await call.message.edit_text(
            "▶️ Campaign sudah berjalan.",
            reply_markup=back_menu()
        )

        return

    client = await get_client(uid)

    if not await client.is_user_authorized():

        await call.message.edit_text(
            "❌ Login Telegram terlebih dahulu.",
            reply_markup=back_menu()
        )

        return

    con = db()

    camp = con.execute(
        "SELECT * FROM campaigns WHERE user_id=?",
        (uid,)
    ).fetchone()

    targets = con.execute(
        "SELECT * FROM targets WHERE user_id=?",
        (uid,)
    ).fetchall()

    con.close()

    if not camp:

        await call.message.edit_text(
            "❌ Promo dan jadwal belum diatur.",
            reply_markup=back_menu()
        )

        return

    if not camp["promo"]:

        await call.message.edit_text(
            "❌ Promo masih kosong.",
            reply_markup=back_menu()
        )

        return

    if not targets:

        await call.message.edit_text(
            "❌ Belum ada grup.\n"
            "Pilih ➕ Add Group.",
            reply_markup=back_menu()
        )

        return

    workers[uid] = asyncio.create_task(
        run_campaign(uid)
    )

    await call.message.edit_text(
        "▶️ Campaign dimulai.",
        reply_markup=back_menu()
    )


# =========================================================
# STOP CAMPAIGN
# =========================================================

@dp.callback_query(F.data == "stop")
async def stop_campaign(call: CallbackQuery):

    await call.answer()

    uid = call.from_user.id

    task = workers.get(uid)

    if task and not task.done():

        task.cancel()

        workers.pop(uid, None)

        await call.message.edit_text(
            "⏹ Campaign dihentikan.",
            reply_markup=back_menu()
        )

    else:

        await call.message.edit_text(
            "⏹ Tidak ada campaign yang berjalan.",
            reply_markup=back_menu()
        )


# =========================================================
# CAMPAIGN WORKER
# =========================================================

async def run_campaign(uid: int):

    try:

        while True:

            con = db()

            camp = con.execute(
                "SELECT * FROM campaigns WHERE user_id=?",
                (uid,)
            ).fetchone()

            targets = con.execute(
                "SELECT * FROM targets WHERE user_id=?",
                (uid,)
            ).fetchall()

            con.close()

            if not camp or not targets:
                return

            client = await get_client(uid)

            for target in targets:

                try:

                    await client.send_message(
                        target["chat_id"],
                        camp["promo"]
                    )

                except Exception:
                    pass

            await asyncio.sleep(
                max(
                    1,
                    int(camp["interval_seconds"])
                )
            )

    except asyncio.CancelledError:
        return


# =========================================================
# ALL TEXT INPUT
# =========================================================

@dp.message()
async def text_handler(message: Message):

    uid = message.from_user.id

    if not is_allowed(uid):
        return

    state = states.get(uid, {})

    step = state.get("step")


    # =====================================================
    # PHONE
    # =====================================================

    if step == "phone":

        phone = message.text.strip()

        old_client = clients.get(uid)

        if old_client:

            try:

                if old_client.is_connected():
                    await old_client.disconnect()

            except Exception:
                pass


        client = TelegramClient(
            session_name(uid),
            API_ID,
            API_HASH
        )

        await client.connect()


        try:

            # IMPORTANT:
            # Simpan hasil request ini.
            # phone_code_hash harus berasal dari request
            # kode yang sama.

            sent = await client.send_code_request(
                phone
            )

        except Exception as e:

            await client.disconnect()

            states.pop(uid, None)

            await message.answer(
                f"❌ Gagal meminta kode Telegram:\n\n{e}",
                reply_markup=back_menu()
            )

            return


        save_account(
            uid,
            phone
        )

        clients[uid] = client


        # =================================================
        # FIX PHONE_CODE_HASH
        # =================================================

        states[uid] = {

            "step": "code",

            "phone": phone,

            "phone_code_hash":
                sent.phone_code_hash

        }


        await message.answer(
            "📩 Kode Telegram sudah diminta.\n\n"
            "Masukkan kode terbaru yang dikirim "
            "Telegram ke akun kamu."
        )

        return


    # =====================================================
    # CODE
    # =====================================================

    if step == "code":

        code = (
            message.text
            .strip()
            .replace(" ", "")
        )

        account = get_account(uid)

        client = clients.get(uid)


        if not account or not client:

            states.pop(uid, None)

            await message.answer(
                "❌ Sesi login tidak ditemukan.\n\n"
                "Tekan 🔐 Login Telegram lagi.",
                reply_markup=back_menu()
            )

            return


        phone_code_hash = state.get(
            "phone_code_hash"
        )


        if not phone_code_hash:

            states.pop(uid, None)

            await message.answer(
                "❌ phone_code_hash tidak tersedia.\n\n"
                "Mulai login lagi.",
                reply_markup=back_menu()
            )

            return


        try:

            # =================================================
            # FIX:
            # Pakai phone_code_hash dari request yang sama.
            # =================================================

            await client.sign_in(
                phone=account["phone"],
                code=code,
                phone_code_hash=phone_code_hash
            )


        except SessionPasswordNeededError:

            states[uid] = {
                "step": "password"
            }

            await message.answer(
                "🔑 Akun Telegram ini menggunakan 2FA.\n\n"
                "Masukkan password 2FA Telegram."
            )

            return


        except Exception as e:

            await message.answer(
                "❌ Telegram menolak kode tersebut "
                "atau kode sudah kedaluwarsa.\n\n"
                "Pastikan kode yang dimasukkan adalah "
                "kode terbaru dari permintaan login ini.\n\n"
                f"Detail: {e}",
                reply_markup=back_menu()
            )

            return


        states.pop(uid, None)


        await message.answer(
            "✅ Telegram berhasil terhubung ke bot.",
            reply_markup=main_menu()
        )

        return


    # =====================================================
    # 2FA PASSWORD
    # =====================================================

    if step == "password":

        password = message.text

        client = clients.get(uid)


        if not client:

            states.pop(uid, None)

            await message.answer(
                "❌ Sesi login tidak ditemukan.",
                reply_markup=back_menu()
            )

            return


        try:

            await client.sign_in(
                password=password
            )

        except Exception as e:

            await message.answer(
                f"❌ Password 2FA gagal:\n\n{e}"
            )

            return


        states.pop(uid, None)


        await message.answer(
            "✅ Telegram berhasil terhubung ke bot.",
            reply_markup=main_menu()
        )

        return


    # =====================================================
    # PROMO
    # =====================================================

    if step == "promo":

        promo = message.text.strip()

        if not promo:

            await message.answer(
                "❌ Promo tidak boleh kosong."
            )

            return


        con = db()

        con.execute(
            """
            INSERT INTO campaigns(
                user_id,
                promo,
                interval_seconds,
                duration_seconds
            )
            VALUES(?, ?, 60, 3600)

            ON CONFLICT(user_id)
            DO UPDATE SET promo=excluded.promo
            """,
            (
                uid,
                promo
            )
        )

        con.commit()
        con.close()

        states.pop(uid, None)


        await message.answer(
            "✅ Promo berhasil disimpan.",
            reply_markup=main_menu()
        )

        return


    # =====================================================
    # SCHEDULE
    # =====================================================

    if step == "schedule_interval":

        try:

            interval = int(
                message.text.strip()
            )

            if interval < 1:
                raise ValueError

        except ValueError:

            await message.answer(
                "❌ Masukkan angka detik yang valid.\n\n"
                "Contoh: 60"
            )

            return


        con = db()

        existing = con.execute(
            "SELECT promo FROM campaigns WHERE user_id=?",
            (uid,)
        ).fetchone()


        promo = existing["promo"] if existing else ""


        con.execute(
            """
            INSERT INTO campaigns(
                user_id,
                promo,
                interval_seconds,
                duration_seconds
            )
            VALUES(?, ?, ?, 3600)

            ON CONFLICT(user_id)
            DO UPDATE SET
                interval_seconds=excluded.interval_seconds
            """,
            (
                uid,
                promo,
                interval
            )
        )

        con.commit()
        con.close()

        states.pop(uid, None)


        await message.answer(
            "✅ Interval jadwal berhasil disimpan.",
            reply_markup=main_menu()
        )

        return


    # =====================================================
    # DEFAULT
    # =====================================================

    await message.answer(
        "Pilih menu:",
        reply_markup=main_menu()
    )


# =========================================================
# MAIN
# =========================================================

async def main():

    init_db()

    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())