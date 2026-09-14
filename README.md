# JASHER MANAGER

Bot Telegram untuk menjadwalkan pesan promosi ke target yang secara eksplisit
sudah dimasukkan ke whitelist/diizinkan.

## Fitur

- Admin-only control
- Template promosi di Supabase
- Target whitelist
- Campaign dengan interval dan durasi
- Auto-stop ketika durasi habis
- Campaign tetap dimuat setelah restart VPS
- Log berhasil/gagal
- Tidak melakukan scraping member
- Tidak mencari target secara otomatis
- Tidak mengirim unsolicited private messages
- Tidak mencoba bypass permission Telegram

## Instalasi

Ubuntu 24.04:

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip
mkdir -p ~/jasher-bot
cd ~/jasher-bot
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

1. Jalankan `schema.sql` di Supabase SQL Editor.
2. Salin `.env.example` menjadi `.env`.
3. Isi BOT_TOKEN, ADMIN_ID, SUPABASE_URL, dan SUPABASE_KEY.
4. Jalankan:

```bash
python bot.py
```

## Perintah

```text
/start
/menu

/addpromo Nama Promo
Isi pesan promosi

/addtarget CHAT_ID|Nama Grup
/blocktarget CHAT_ID

/campaign Nama|PROMO_ID|INTERVAL_MENIT|DURASI_JAM

/stop CAMPAIGN_ID
```

Contoh 3 hari dengan jeda 1 jam:

```text
/campaign Promo3Hari|1|60|72
```

Catatan:
- Bot harus memiliki hak mengirim pesan pada grup target.
- Hanya target dengan `allowed=true` yang diproses.
- Untuk keamanan, gunakan server key/service-role key Supabase hanya di VPS.
- Jangan pernah mengirim token bot, service key, password VPS, atau private key ke chat.
