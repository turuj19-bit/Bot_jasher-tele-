import asyncio, json, logging, os, sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aiogram import Bot, Dispatcher, F
from aiogram.filters import Command, CommandStart
from aiogram.types import Message, CallbackQuery, InlineKeyboardMarkup, InlineKeyboardButton
from dotenv import load_dotenv
from telethon import TelegramClient
from telethon.errors import SessionPasswordNeededError, PhoneCodeInvalidError, PhoneNumberInvalidError
from telethon.tl.types import Channel, Chat
from telethon.tl.functions.messages import CheckChatInviteRequest

load_dotenv()
BOT_TOKEN = os.getenv('BOT_TOKEN','').strip()
ADMIN_ID = int(os.getenv('ADMIN_ID','0') or 0)
API_ID = int(os.getenv('API_ID','0') or 0)
API_HASH = os.getenv('API_HASH','').strip()
SESSION_DIR = Path(os.getenv('SESSION_DIR','sessions'))
DB_PATH = os.getenv('DB_PATH','jasher.db')
if not BOT_TOKEN or not ADMIN_ID or not API_ID or not API_HASH:
    raise RuntimeError('Isi BOT_TOKEN, ADMIN_ID, API_ID, dan API_HASH di .env')
SESSION_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(level=logging.INFO, format='%(asctime)s | %(levelname)s | %(message)s')
log = logging.getLogger('jasher')
bot = Bot(BOT_TOKEN)
dp = Dispatcher()
DB = sqlite3.connect(DB_PATH, check_same_thread=False)
DB.row_factory = sqlite3.Row
DB.executescript('''
CREATE TABLE IF NOT EXISTS users (user_id INTEGER PRIMARY KEY, added_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS accounts (user_id INTEGER PRIMARY KEY, phone TEXT, session TEXT, logged_in INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS groups (user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL, title TEXT NOT NULL, selected INTEGER DEFAULT 0, PRIMARY KEY(user_id,chat_id));
CREATE TABLE IF NOT EXISTS schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL, message TEXT NOT NULL, interval_minutes INTEGER NOT NULL, expires_at TEXT NOT NULL, active INTEGER DEFAULT 1);
''')
DB.commit()
clients = {}
states = {}


def authorized(uid):
    return uid == ADMIN_ID or DB.execute('SELECT 1 FROM users WHERE user_id=?',(uid,)).fetchone() is not None

def save(sql,args=()):
    DB.execute(sql,args); DB.commit()

def main_menu():
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text='➕ Add Group', callback_data='groups'), InlineKeyboardButton(text='📝 Pesan', callback_data='message')],
        [InlineKeyboardButton(text='⏱ Jeda', callback_data='interval'), InlineKeyboardButton(text='📅 Durasi', callback_data='duration')],
        [InlineKeyboardButton(text='▶️ Mulai', callback_data='start_sched'), InlineKeyboardButton(text='⏹ Stop', callback_data='stop_sched')],
        [InlineKeyboardButton(text='📦 Stok', callback_data='stock'), InlineKeyboardButton(text='🔐 Akun', callback_data='account')],
    ])

async def get_client(uid):
    c = clients.get(uid)
    if c and c.is_connected(): return c
    row = DB.execute('SELECT session FROM accounts WHERE user_id=? AND logged_in=1',(uid,)).fetchone()
    if not row: return None
    c = TelegramClient(str(SESSION_DIR / str(uid)), API_ID, API_HASH)
    await c.connect()
    if not await c.is_user_authorized(): return None
    clients[uid]=c
    return c

@dp.message(CommandStart())
async def start(m: Message):
    uid=m.from_user.id
    if not authorized(uid): return await m.answer('⛔ Kamu belum ditambahkan.')
    await m.answer('🤖 JASHER USERBOT\n\nPilih menu. Untuk memakai akun Telegram, hubungkan akun dulu lewat 🔐 Akun.', reply_markup=main_menu())

@dp.message(Command('adduser'))
async def adduser(m: Message):
    if m.from_user.id != ADMIN_ID: return
    raw=(m.text or '').split(maxsplit=1)
    if len(raw)!=2 or not raw[1].isdigit(): return await m.answer('Format: /adduser USER_ID')
    uid=int(raw[1]); save('INSERT OR IGNORE INTO users(user_id,added_at) VALUES(?,?)',(uid,datetime.now(timezone.utc).isoformat()))
    await m.answer(f'✅ User {uid} ditambahkan. Sekarang user tersebut buka /start.')

@dp.callback_query(F.data=='account')
async def account(cb: CallbackQuery):
    if not authorized(cb.from_user.id): return await cb.answer('Akses ditolak',show_alert=True)
    row=DB.execute('SELECT phone,logged_in FROM accounts WHERE user_id=?',(cb.from_user.id,)).fetchone()
    status='✅ Terhubung' if row and row['logged_in'] else '❌ Belum terhubung'
    await cb.message.answer(f'🔐 Akun Telegram: {status}\n\nUntuk mulai koneksi: /login')
    await cb.answer()

@dp.message(Command('login'))
async def login(m: Message):
    uid=m.from_user.id
    if not authorized(uid): return
    c=await get_client(uid)
    if c: return await m.answer('✅ Akun Telegram sudah terhubung.',reply_markup=main_menu())
    await m.answer('Kirim nomor HP akun Telegram yang mau dipakai, format internasional. Contoh: +62812xxxx. Kode login akan dikirim oleh Telegram.')
    states[uid]={'step':'phone'}

@dp.message()
async def text_handler(m: Message):
    uid=m.from_user.id
    if not authorized(uid) or not m.text: return
    st=states.get(uid)
    if not st: return
    text=m.text.strip()
    if st['step']=='phone':
        c=TelegramClient(str(SESSION_DIR / str(uid)),API_ID,API_HASH)
        await c.connect()
        try:
            sent=await c.send_code_request(text)
            save('INSERT OR REPLACE INTO accounts(user_id,phone,session,logged_in) VALUES(?,?,?,0)',(uid,text,str(SESSION_DIR / str(uid))))
            clients[uid]=c; states[uid]={'step':'code','phone':text,'phone_code_hash':sent.phone_code_hash}
            await m.answer('📲 Kode sudah dikirim oleh Telegram. Kirim kode yang kamu terima di sini.')
        except PhoneNumberInvalidError:
            await c.disconnect(); await m.answer('❌ Nomor Telegram tidak valid.')
        return
    if st['step']=='code':
        c=clients.get(uid)
        try:
            await c.sign_in(st['phone'],text,phone_code_hash=st['phone_code_hash'])
        except SessionPasswordNeededError:
            states[uid]={'step':'2fa'}; return await m.answer('🔐 Akun ini memakai verifikasi 2 langkah. Masukkan password 2FA untuk menyelesaikan login.')
        except PhoneCodeInvalidError:
            return await m.answer('❌ Kode salah/kedaluwarsa. Jalankan /login lagi untuk meminta kode baru.')
        save('UPDATE accounts SET logged_in=1 WHERE user_id=?',(uid,)); states.pop(uid,None)
        await m.answer('✅ Akun Telegram berhasil terhubung.',reply_markup=main_menu()); return
    if st['step']=='2fa':
        c=clients.get(uid)
        try:
            await c.sign_in(password=text)
            save('UPDATE accounts SET logged_in=1 WHERE user_id=?',(uid,)); states.pop(uid,None)
            await m.answer('✅ Akun Telegram berhasil terhubung.',reply_markup=main_menu())
        except Exception:
            await m.answer('❌ Password 2FA tidak diterima. Coba /login lagi.')

@dp.callback_query(F.data=='groups')
async def groups(cb: CallbackQuery):
    uid=cb.from_user.id
    c=await get_client(uid)
    if not c: return await cb.answer('Hubungkan akun dulu: /login',show_alert=True)
    await cb.answer('Mengecek grup...')
    found=[]
    async for d in c.iter_dialogs():
        ent=d.entity
        is_group=isinstance(ent,Chat) or (isinstance(ent,Channel) and getattr(ent,'megagroup',False))
        if not is_group: continue
        try:
            perms=await c.get_permissions(ent,'me')
            banned=getattr(perms,'send_messages',False)
            if banned: continue
            await c.get_permissions(ent,'me')
            found.append((int(ent.id),d.name))
        except Exception: continue
    if not found: return await cb.message.answer('Tidak ada grup yang saat ini bisa dikirimi pesan oleh akun tersebut.')
    for cid,title in found:
        save('INSERT OR REPLACE INTO groups(user_id,chat_id,title,selected) VALUES(?,?,?,COALESCE((SELECT selected FROM groups WHERE user_id=? AND chat_id=?),0))',(uid,cid,title,uid,cid))
    rows=DB.execute('SELECT chat_id,title,selected FROM groups WHERE user_id=? ORDER BY title',(uid,)).fetchall()
    kb=[]
    for r in rows:
        mark='☑️' if r['selected'] else '⬜'
        kb.append([InlineKeyboardButton(text=f'{mark} {r["title"][:35]}',callback_data=f'toggle:{r["chat_id"]}')])
    kb.append([InlineKeyboardButton(text='✅ Selesai pilih',callback_data='group_done')])
    await cb.message.answer('📋 Grup yang bisa dikirimi pesan:\nTekan grup untuk memilih/membatalkan.',reply_markup=InlineKeyboardMarkup(inline_keyboard=kb))

@dp.callback_query(F.data.startswith('toggle:'))
async def toggle(cb: CallbackQuery):
    uid=cb.from_user.id; cid=int(cb.data.split(':')[1])
    row=DB.execute('SELECT selected FROM groups WHERE user_id=? AND chat_id=?',(uid,cid)).fetchone()
    if not row: return await cb.answer('Grup tidak ditemukan')
    save('UPDATE groups SET selected=? WHERE user_id=? AND chat_id=?',(0 if row['selected'] else 1,uid,cid))
    await cb.answer('Pilihan diperbarui')

@dp.callback_query(F.data=='group_done')
async def group_done(cb: CallbackQuery):
    n=DB.execute('SELECT COUNT(*) n FROM groups WHERE user_id=? AND selected=1',(cb.from_user.id,)).fetchone()['n']
    await cb.message.answer(f'✅ {n} grup dipilih.'); await cb.answer()

@dp.callback_query(F.data=='stock')
async def stock(cb: CallbackQuery):
    rows=DB.execute('SELECT title,selected FROM groups WHERE user_id=? ORDER BY title',(cb.from_user.id,)).fetchall()
    if not rows: text='📦 Belum ada grup.'
    else: text='📦 STOK GRUP\n\n'+'\n'.join(('✅ ' if r['selected'] else '⬜ ')+r['title'] for r in rows)
    await cb.message.answer(text); await cb.answer()

@dp.callback_query(F.data=='message')
async def setmsg(cb: CallbackQuery):
    states[cb.from_user.id]={'step':'message'}; await cb.message.answer('📝 Kirim pesan yang mau dikirim.'); await cb.answer()

@dp.callback_query(F.data=='interval')
async def interval(cb: CallbackQuery):
    states[cb.from_user.id]={'step':'interval'}; await cb.message.answer('⏱️ Kirim jeda dalam menit. Contoh: 60 = setiap 1 jam.'); await cb.answer()

@dp.callback_query(F.data=='duration')
async def duration(cb: CallbackQuery):
    states[cb.from_user.id]={'step':'duration'}; await cb.message.answer('📅 Kirim durasi dalam jam. Contoh: 72 = 3 hari.'); await cb.answer()

@dp.callback_query(F.data=='start_sched')
async def start_sched(cb: CallbackQuery):
    uid=cb.from_user.id
    rows=DB.execute('SELECT chat_id FROM groups WHERE user_id=? AND selected=1',(uid,)).fetchall()
    st=states.setdefault(uid,{})
    # persistent settings kept in memory only until restart; defaults are explicit
    if not st.get('message') or not st.get('interval') or not st.get('duration') or not rows:
        return await cb.message.answer('⚠️ Lengkapi Pesan, Jeda, Durasi, dan pilih minimal 1 grup.')
    expires=datetime.now(timezone.utc)+timedelta(hours=st['duration'])
    for r in rows:
        save('INSERT INTO schedules(user_id,chat_id,message,interval_minutes,expires_at,active) VALUES(?,?,?,?,?,1)',(uid,r['chat_id'],st['message'],st['interval'],expires.isoformat()))
    await cb.message.answer(f'▶️ Jadwal aktif: setiap {st["interval"]} menit selama {st["duration"]} jam.'); await cb.answer()

@dp.callback_query(F.data=='stop_sched')
async def stop_sched(cb: CallbackQuery):
    save('UPDATE schedules SET active=0 WHERE user_id=?',(cb.from_user.id,)); await cb.message.answer('⏹ Semua jadwal user ini dihentikan.'); await cb.answer()

async def worker():
    while True:
        now=datetime.now(timezone.utc)
        rows=DB.execute('SELECT * FROM schedules WHERE active=1 AND expires_at>?',(now.isoformat(),)).fetchall()
        for r in rows:
            key=f"last:{r['id']}"; last=states.get(key)
            due=last is None or (now-last).total_seconds() >= r['interval_minutes']*60
            if not due: continue
            c=await get_client(r['user_id'])
            if not c: continue
            try:
                ent=await c.get_entity(r['chat_id'])
                perms=await c.get_permissions(ent,'me')
                if getattr(perms,'send_messages',False):
                    save('UPDATE schedules SET active=0 WHERE id=?',(r['id'],)); continue
                await c.send_message(ent,r['message'])
                states[key]=now
            except Exception as exc:
                log.warning('Send failed schedule %s: %s',r['id'],exc)
                # If permission is lost, stop this target instead of retrying indefinitely.
                if 'write' in str(exc).lower() or 'permission' in str(exc).lower() or 'forbidden' in str(exc).lower():
                    save('UPDATE schedules SET active=0 WHERE id=?',(r['id'],))
        DB.execute('UPDATE schedules SET active=0 WHERE active=1 AND expires_at<=?',(now.isoformat(),)); DB.commit()
        await asyncio.sleep(15)

async def main():
    asyncio.create_task(worker())
    await dp.start_polling(bot)

if __name__=='__main__': asyncio.run(main())
