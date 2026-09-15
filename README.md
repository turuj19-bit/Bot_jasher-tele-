# Telegram Auto Bot — flat ZIP

Isi ZIP sengaja tanpa folder:
- server.js
- schema.sql
- package.json
- .env.example

## Setup
1. Buat Bot Telegram dan dapatkan BOT_TOKEN.
2. Ambil API_ID dan API_HASH dari portal resmi Telegram.
3. Buat project Supabase dan jalankan `schema.sql`.
4. Salin `.env.example` menjadi `.env` lalu isi semua secret.
5. `npm install`
6. `npm start`
7. Untuk 24/7 gunakan PM2.

## Catatan
Gunakan hanya pada grup yang memang mengizinkan akun tersebut mengirim pesan. Sistem melewati grup yang tidak terdeteksi memiliki izin kirim. Jangan upload `.env`, BOT_TOKEN, API_HASH, atau service-role key ke GitHub.

Login akun memakai MTProto dan dapat meminta OTP/2FA. Kredensial login jangan disimpan sebagai log.
