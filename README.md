# JASHER Userbot Scheduler

Telegram bot dengan 2 tampilan:

- **Admin**: hanya mengelola user lewat `➕ Add User` atau `/adduser USER_ID`.
- **User yang sudah ditambahkan**: panel sederhana `➕ Add Group`, `📢 Promo`, `⏱ Jadwal`, `📦 Stok`, `▶️ Mulai`, `⏹ Stop`.

## Cara kerja

1. Isi `.env` dari `.env.example`.
2. Jalankan `pip install -r requirements.txt`.
3. Jalankan `python bot.py`.
4. Admin buka `/start` lalu tambahkan Telegram User ID pengguna.
5. Pengguna yang sudah ditambahkan buka `/start`.
6. Tekan **Add Group**. Jika belum login, bot meminta login akun Telegram pengguna.
7. Setelah login, bot hanya menampilkan grup yang akun tersebut masih boleh kirim pesan.
8. Tekan **Promo**, lalu kirim teks atau foto + caption. Itu yang akan dikirim.
9. Tekan **Jadwal**, isi jeda lalu durasi. Contoh 60 menit dan 4320 menit (3 hari).
10. Tekan **Mulai**.

## Catatan penting

- `schema_fixed.sql` dari project lama tidak dipakai oleh versi ini dan sengaja tidak diubah.
- Data baru disimpan di `DATA_DIR`, termasuk session Telegram dan database SQLite, supaya tidak perlu masuk GitHub.
- Jangan upload `.env` atau file session Telegram ke GitHub.
- Bot tidak mencoba membypass grup yang melarang pengiriman. Jika izin kirim dicabut atau Telegram menolak pengiriman, target tersebut tidak dipaksa/dibypass.
- Gunakan hanya pada grup yang memang mengizinkan pengiriman promosi dan sesuai aturan Telegram/grup.
