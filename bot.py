import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone

from aiogram import Bot, Dispatcher, F
from aiogram.filters import Command, CommandStart
from aiogram.types import Message, CallbackQuery, InlineKeyboardMarkup, InlineKeyboardButton
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()
ADMIN_ID_RAW = os.getenv("ADMIN_ID", "").strip()
SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip()
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "").strip()

if not BOT_TOKEN:
    raise RuntimeError("BOT_TOKEN belum diisi di .env")
if not ADMIN_ID_RAW.isdigit():
    raise RuntimeError("ADMIN_ID harus berupa angka.")
if not SUPABASE_URL or not SUPABASE_KEY:
    raise RuntimeError("SUPABASE_URL/SUPABASE_KEY belum diisi.")

ADMIN_ID = int(ADMIN_ID_RAW)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
)
log = logging.getLogger("jasher")

bot = Bot(BOT_TOKEN)
dp = Dispatcher()
scheduler = AsyncIOScheduler(timezone="Asia/Jakarta")
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# This project intentionally supports only explicitly approved targets.
# It does not discover members, scrape groups, bypass permissions, or
# automate unsolicited private messages.

def is_admin_user(user_id: int | None) -> bool:
    return user_id == ADMIN_ID

def menu() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [
            InlineKeyboardButton(text="📝 Promo", callback_data="promo_list"),
            InlineKeyboardButton(text="🎯 Target", callback_data="target_list"),
        ],
        [
            InlineKeyboardButton(text="🚀 Campaign", callback_data="campaign_list"),
            InlineKeyboardButton(text="📊 Status", callback_data="status"),
        ],
        [
            InlineKeyboardButton(text="📋 Log", callback_data="log_list"),
        ],
    ])

async def require_admin_message(message: Message) -> bool:
    if not is_admin_user(message.from_user.id if message.from_user else None):
        await message.answer("⛔ Akses ditolak.")
        return False
    return True

async def require_admin_callback(callback: CallbackQuery) -> bool:
    if not is_admin_user(callback.from_user.id):
        await callback.answer("Akses ditolak.", show_alert=True)
        return False
    return True

async def db_insert(table: str, payload: dict):
    return supabase.table(table).insert(payload).execute()

async def send_to_approved_target(chat_id: str, content: str):
    target = (
        supabase.table("targets")
        .select("chat_id,allowed")
        .eq("chat_id", chat_id)
        .eq("allowed", True)
        .limit(1)
        .execute()
    )
    if not target.data:
        return False, "Target tidak ada di whitelist."

    try:
        await bot.send_message(chat_id=chat_id, text=content)
        return True, None
    except Exception as exc:
        log.warning("Send failed to %s: %s", chat_id, exc)
        return False, str(exc)

async def execute_campaign(campaign_id: int):
    try:
        result = (
            supabase.table("campaigns")
            .select("*")
            .eq("id", campaign_id)
            .eq("active", True)
            .limit(1)
            .execute()
        )
        if not result.data:
            remove_campaign_job(campaign_id)
            return

        campaign = result.data[0]
        now = datetime.now(timezone.utc)
        expires = datetime.fromisoformat(
            campaign["expires_at"].replace("Z", "+00:00")
        )

        if now >= expires:
            (
                supabase.table("campaigns")
                .update({"active": False})
                .eq("id", campaign_id)
                .execute()
            )
            remove_campaign_job(campaign_id)
            return

        promo = (
            supabase.table("promotions")
            .select("content")
            .eq("id", campaign["promotion_id"])
            .eq("active", True)
            .limit(1)
            .execute()
        )
        if not promo.data:
            log.warning("Promo %s tidak ditemukan/aktif.", campaign["promotion_id"])
            return

        targets = (
            supabase.table("targets")
            .select("chat_id")
            .eq("allowed", True)
            .execute()
        )

        for target in targets.data:
            chat_id = str(target["chat_id"])
            ok, error = await send_to_approved_target(chat_id, promo.data[0]["content"])
            try:
                await db_insert("logs", {
                    "campaign_id": campaign_id,
                    "chat_id": chat_id,
                    "status": "success" if ok else "failed",
                    "error": error,
                })
            except Exception as exc:
                log.warning("Gagal menyimpan log: %s", exc)

            await asyncio.sleep(2)

    except Exception:
        log.exception("execute_campaign(%s) gagal", campaign_id)

def remove_campaign_job(campaign_id: int):
    job_id = f"campaign:{campaign_id}"
    job = scheduler.get_job(job_id)
    if job:
        scheduler.remove_job(job_id)

def add_campaign_job(campaign: dict):
    campaign_id = int(campaign["id"])
    interval = int(campaign["interval_minutes"])
    if interval < 1:
        return

    expires = datetime.fromisoformat(
        campaign["expires_at"].replace("Z", "+00:00")
    )
    if expires <= datetime.now(timezone.utc):
        return

    scheduler.add_job(
        execute_campaign,
        "interval",
        minutes=interval,
        args=[campaign_id],
        id=f"campaign:{campaign_id}",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
        misfire_grace_time=60,
    )

async def load_active_campaigns():
    result = (
        supabase.table("campaigns")
        .select("*")
        .eq("active", True)
        .execute()
    )
    for campaign in result.data:
        add_campaign_job(campaign)

@dp.message(CommandStart())
async def start(message: Message):
    if not await require_admin_message(message):
        return
    await message.answer(
        "🤖 JASHER MANAGER\n\n"
        "Scheduler promosi berbasis whitelist siap.",
        reply_markup=menu(),
    )

@dp.message(Command("menu"))
async def menu_cmd(message: Message):
    if not await require_admin_message(message):
        return
    await message.answer("Pilih menu:", reply_markup=menu())

@dp.message(Command("addpromo"))
async def addpromo(message: Message):
    if not await require_admin_message(message):
        return

    lines = (message.text or "").split("\n", 2)
    if len(lines) < 3 or not lines[1].strip() or not lines[2].strip():
        await message.answer(
            "Format:\n"
            "/addpromo Nama Promo\n"
            "Isi pesan promosi di baris berikutnya."
        )
        return

    result = await db_insert("promotions", {
        "name": lines[1].strip(),
        "content": lines[2].strip(),
        "active": True,
    })
    await message.answer(
        f"✅ Promo dibuat. ID: {result.data[0]['id']}"
        if result.data else "❌ Promo gagal dibuat."
    )

@dp.message(Command("addtarget"))
async def addtarget(message: Message):
    if not await require_admin_message(message):
        return

    value = (message.text or "").replace("/addtarget", "", 1).strip()
    if "|" not in value:
        await message.answer("Format:\n/addtarget CHAT_ID|Nama Grup")
        return

    chat_id, title = [x.strip() for x in value.split("|", 1)]
    if not chat_id or not title:
        await message.answer("❌ CHAT_ID dan nama grup wajib diisi.")
        return

    try:
        result = (
            supabase.table("targets")
            .upsert({
                "chat_id": chat_id,
                "title": title,
                "allowed": True,
            }, on_conflict="chat_id")
            .execute()
        )
        await message.answer(
            "✅ Target masuk whitelist."
            if result.data else "❌ Target gagal disimpan."
        )
    except Exception as exc:
        await message.answer(f"❌ Gagal: {exc}")

@dp.message(Command("blocktarget"))
async def blocktarget(message: Message):
    if not await require_admin_message(message):
        return

    chat_id = (message.text or "").replace("/blocktarget", "", 1).strip()
    if not chat_id:
        await message.answer("Format:\n/blocktarget CHAT_ID")
        return

    result = (
        supabase.table("targets")
        .update({"allowed": False})
        .eq("chat_id", chat_id)
        .execute()
    )
    await message.answer(
        "🔴 Target dinonaktifkan."
        if result.data else "⚠️ Target tidak ditemukan."
    )

@dp.message(Command("campaign"))
async def campaign(message: Message):
    if not await require_admin_message(message):
        return

    value = (message.text or "").replace("/campaign", "", 1).strip()
    parts = [x.strip() for x in value.split("|")]
    if len(parts) != 4:
        await message.answer(
            "Format:\n"
            "/campaign Nama|PROMO_ID|INTERVAL_MENIT|DURASI_JAM\n\n"
            "Contoh 3 hari + jeda 1 jam:\n"
            "/campaign Promo3Hari|1|60|72"
        )
        return

    name, promo_id_raw, interval_raw, duration_raw = parts
    try:
        promo_id = int(promo_id_raw)
        interval = int(interval_raw)
        duration = int(duration_raw)
        if interval < 1 or duration < 1:
            raise ValueError
    except ValueError:
        await message.answer("❌ ID promo, interval, dan durasi harus angka positif.")
        return

    promo = (
        supabase.table("promotions")
        .select("id")
        .eq("id", promo_id)
        .eq("active", True)
        .limit(1)
        .execute()
    )
    if not promo.data:
        await message.answer("❌ Promo tidak ditemukan atau nonaktif.")
        return

    now = datetime.now(timezone.utc)
    expires = now + timedelta(hours=duration)

    result = await db_insert("campaigns", {
        "name": name,
        "promotion_id": promo_id,
        "interval_minutes": interval,
        "duration_hours": duration,
        "started_at": now.isoformat(),
        "expires_at": expires.isoformat(),
        "active": True,
    })

    if not result.data:
        await message.answer("❌ Campaign gagal dibuat.")
        return

    created = result.data[0]
    add_campaign_job(created)

    await message.answer(
        f"✅ Campaign aktif.\n\n"
        f"ID: {created['id']}\n"
        f"Jeda: {interval} menit\n"
        f"Durasi: {duration} jam\n"
        f"Berakhir: {expires.astimezone().strftime('%d-%m-%Y %H:%M WIB')}"
    )

@dp.message(Command("stop"))
async def stop(message: Message):
    if not await require_admin_message(message):
        return

    raw = (message.text or "").replace("/stop", "", 1).strip()
    if not raw.isdigit():
        await message.answer("Format:\n/stop CAMPAIGN_ID")
        return

    campaign_id = int(raw)
    result = (
        supabase.table("campaigns")
        .update({"active": False})
        .eq("id", campaign_id)
        .execute()
    )
    remove_campaign_job(campaign_id)
    await message.answer(
        f"🛑 Campaign {campaign_id} dihentikan."
        if result.data else "❌ Campaign tidak ditemukan."
    )

@dp.callback_query(F.data == "promo_list")
async def promo_list(callback: CallbackQuery):
    if not await require_admin_callback(callback):
        return
    result = supabase.table("promotions").select("*").order("id", desc=True).limit(20).execute()
    if not result.data:
        text = "📝 Belum ada promo."
    else:
        text = "📝 PROMO\n\n" + "\n".join(
            f"ID {p['id']} | {p['name']} | {'ON' if p['active'] else 'OFF'}"
            for p in result.data
        )
    await callback.message.answer(text)
    await callback.answer()

@dp.callback_query(F.data == "target_list")
async def target_list(callback: CallbackQuery):
    if not await require_admin_callback(callback):
        return
    result = supabase.table("targets").select("*").order("id", desc=True).limit(50).execute()
    if not result.data:
        text = "🎯 Belum ada target."
    else:
        text = "🎯 TARGET WHITELIST\n\n" + "\n".join(
            f"{t['chat_id']} | {t['title']} | {'🟢' if t['allowed'] else '🔴'}"
            for t in result.data
        )
    await callback.message.answer(text)
    await callback.answer()

@dp.callback_query(F.data == "campaign_list")
async def campaign_list(callback: CallbackQuery):
    if not await require_admin_callback(callback):
        return
    result = supabase.table("campaigns").select("*").order("id", desc=True).limit(20).execute()
    if not result.data:
        text = "🚀 Belum ada campaign."
    else:
        text = "🚀 CAMPAIGN\n\n" + "\n".join(
            f"ID {c['id']} | {c['name']} | {'🟢' if c['active'] else '🔴'} | "
            f"{c['interval_minutes']}m / {c['duration_hours']}h"
            for c in result.data
        )
    await callback.message.answer(text)
    await callback.answer()

@dp.callback_query(F.data == "status")
async def status(callback: CallbackQuery):
    if not await require_admin_callback(callback):
        return
    active = sum(1 for j in scheduler.get_jobs() if j.id.startswith("campaign:"))
    await callback.message.answer(
        f"📊 STATUS\n\nCampaign scheduler aktif: {active}"
    )
    await callback.answer()

@dp.callback_query(F.data == "log_list")
async def log_list(callback: CallbackQuery):
    if not await require_admin_callback(callback):
        return
    result = supabase.table("logs").select("*").order("id", desc=True).limit(30).execute()
    if not result.data:
        text = "📋 Belum ada log."
    else:
        text = "📋 LOG\n\n" + "\n".join(
            f"{'✅' if x['status']=='success' else '❌'} "
            f"C{x['campaign_id']} | {x['chat_id']} | {x['status']}"
            for x in result.data
        )
    await callback.message.answer(text)
    await callback.answer()

async def main():
    await load_active_campaigns()
    scheduler.start()
    log.info("Bot started.")
    try:
        await dp.start_polling(bot, allowed_updates=dp.resolve_used_update_types())
    finally:
        scheduler.shutdown(wait=False)
        await bot.session.close()

if __name__ == "__main__":
    asyncio.run(main())
