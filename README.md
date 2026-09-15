# JASHER USERBOT

Bot pengelola akun user Telegram. Admin menambahkan user berdasarkan Telegram USER ID dengan `/adduser USER_ID`. User tersebut kemudian `/start` dan menghubungkan akun Telegramnya melalui `/login`.

## Alur
1. Admin: `/adduser USER_ID`
2. User: `/start`
3. User: **🔐 Akun → /login**
4. Masukkan nomor HP akun Telegram. Telegram mengirim kode login melalui aplikasi/notifikasi resminya.
5. Masukkan kode tersebut di chat bot. Jika akun memakai 2FA, user diminta password 2FA.
6. **➕ Add Group** otomatis membaca grup yang diikuti akun dan hanya menampilkan grup yang saat itu bisa dikirimi pesan.
7. Pilih grup, **📝 Pesan**, **⏱ Jeda** (menit), **📅 Durasi** (jam), lalu **▶️ Mulai**.
8. Jadwal berhenti otomatis saat durasi habis. Jika hak kirim ke suatu grup dicabut, jadwal untuk target tersebut dihentikan.

## Catatan penting
- USER ID saja tidak cukup untuk login ke akun Telegram. Login MTProto membutuhkan nomor akun dan kode verifikasi Telegram; password 2FA juga mungkin diperlukan.
- Jangan pernah meminta atau membagikan kode/password Telegram kepada pihak lain. Jalankan bot di VPS milik sendiri dan lindungi folder `sessions/` karena berisi sesi login.
- Hanya gunakan pada grup/tempat yang memang mengizinkan akun tersebut mengirim promosi. Jangan gunakan untuk spam atau membypass pembatasan Telegram.
