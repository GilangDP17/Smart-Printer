
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage
} = require("@whiskeysockets/baileys");

const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

// ===============================
// KONFIGURASI
// ===============================

// Ganti sesuai nama printer di Windows
const PRINTER_NAME = "EPSON L3210 Series";

// Sesuaikan jika lokasi SumatraPDF berbeda
const SUMATRA_PATH =
  "C:\\Users\\Gilang\\AppData\\Local\\SumatraPDF\\SumatraPDF.exe";

  
// Ganti PIN ini sebelum digunakan customer
const ACCESS_PIN = "5678";

// Folder penyimpanan
const UPLOAD_DIR = path.join(__dirname, "uploads");
const ARCHIVE_DIR = path.join(__dirname, "Arsip");
const LOG_DIR = path.join(__dirname, "LOG");

// Buat folder jika belum tersedia
for (const dir of [UPLOAD_DIR, ARCHIVE_DIR, LOG_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

// ===============================
// DATA SEMENTARA
// ===============================

const authenticatedUsers = new Set();
const pendingFiles = new Map();
const printQueue = [];

let isProcessing = false;

// ===============================
// FUNGSI LOG
// ===============================

function writeLog(message) {
  const date = new Date();
  const day = date.toLocaleDateString("en-CA", {
    timeZone: "Asia/Jakarta"
  });

  const logFile = path.join(LOG_DIR, `${day}.txt`);

  fs.appendFileSync(
    logFile,
    `[${new Date().toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta"
    })}] ${message}\n`
  );
}

// ===============================
// FUNGSI CETAK PDF
// ===============================

async function printPDF(filePath, paper) {
  if (!fs.existsSync(SUMATRA_PATH)) {
    throw new Error(
      "SumatraPDF tidak ditemukan. Periksa SUMATRA_PATH."
    );
  }

  if (!fs.existsSync(filePath)) {
    throw new Error("File PDF tidak ditemukan.");
  }

  const settings = `paper=${paper},fit`;

  await execFileAsync(
    SUMATRA_PATH,
    [
      "-print-to",
      PRINTER_NAME,
      "-print-settings",
      settings,
      "-silent",
      filePath
    ],
    {
      timeout: 120000,
      windowsHide: true
    }
  );
}

// ===============================
// PROSES ANTREAN CETAK
// ===============================

async function processQueue(sock) {
  if (isProcessing) return;

  isProcessing = true;

  try {
    while (printQueue.length > 0) {
      const job = printQueue.shift();

      try {
        await sock.sendMessage(job.from, {
          text: `⏳ Dokumen "${job.originalName}" sedang dikirim ke printer.`
        });

        await printPDF(job.filePath, job.paper);

        // Arsipkan setelah perintah cetak berhasil dikirim
        const archiveName =
          `${Date.now()}_${job.fileName}`;

        const archivePath = path.join(
          ARCHIVE_DIR,
          archiveName
        );

        fs.renameSync(job.filePath, archivePath);

        writeLog(
          `${job.from} | ${job.originalName} | ${job.paper} | Perintah cetak dikirim`
        );

        await sock.sendMessage(job.from, {
          text:
            `✅ Perintah cetak dokumen berhasil dikirim ke printer.\n\n` +
            `Nama file: ${job.originalName}\n` +
            `Ukuran kertas: ${job.paper}\n\n` +
            `Silakan tunggu hasil cetak dari Epson L3210.`
        });

      } catch (error) {
        console.error("Gagal mencetak:", error);

        writeLog(
          `${job.from} | ${job.originalName} | GAGAL: ${error.message}`
        );

        await sock.sendMessage(job.from, {
          text:
            `❌ Dokumen "${job.originalName}" gagal dikirim ke printer.\n` +
            `Silakan hubungi operator.`
        });
      }
    }
  } finally {
    isProcessing = false;
  }
}

// ===============================
// MENERIMA DOKUMEN
// ===============================

async function handleDocument(sock, msg, from) {
  if (!authenticatedUsers.has(from)) {
    await sock.sendMessage(from, {
      text: "🔐 Silakan masukkan PIN terlebih dahulu."
    });
    return;
  }

  const document = msg.message.documentMessage;

  if (document.mimetype !== "application/pdf") {
    await sock.sendMessage(from, {
      text: "Mohon maaf, saat ini hanya PDF yang didukung."
    });
    return;
  }

  const buffer = await downloadMediaMessage(
    msg,
    "buffer",
    {}
  );

  const originalName =
    document.fileName || "dokumen.pdf";

  const safeName = originalName.replace(
    /[^a-zA-Z0-9._-]/g,
    "_"
  );

  const fileName = `${Date.now()}_${safeName}`;
  const filePath = path.join(UPLOAD_DIR, fileName);

  fs.writeFileSync(filePath, buffer);

  pendingFiles.set(from, {
    fileName,
    filePath,
    originalName
  });

  await sock.sendMessage(from, {
    text:
      `✅ Dokumen berhasil diterima.\n\n` +
      `Nama file: ${originalName}\n\n` +
      `Pilih ukuran kertas:\n` +
      `1. A4\n` +
      `2. F4\n\n` +
      `Ketik angka 1 atau 2.`
  });

  writeLog(`${from} | Menerima ${originalName}`);
}

// ===============================
// MENERIMA PESAN TEKS
// ===============================

async function handleText(sock, from, text) {
  const message = text.trim();

  // Autentikasi PIN
  if (!authenticatedUsers.has(from)) {
    if (message === ACCESS_PIN) {
      authenticatedUsers.add(from);

      await sock.sendMessage(from, {
        text:
          "✅ PIN benar.\n\n" +
          "Selamat datang di layanan Smart Printer.\n" +
          "Silakan kirim dokumen PDF."
      });
    } else {
      await sock.sendMessage(from, {
        text: "🔐 Masukkan PIN untuk menggunakan layanan."
      });
    }

    return;
  }

  // Periksa apakah pelanggan sudah mengirim dokumen
  const pending = pendingFiles.get(from);

  if (!pending) {
    await sock.sendMessage(from, {
      text: "Silakan kirim dokumen PDF terlebih dahulu."
    });
    return;
  }

  let paper;

  if (message === "1") {
    paper = "A4";
  } else if (message === "2") {
    paper = "F4";
  } else {
    await sock.sendMessage(from, {
      text: "Pilihan tidak valid. Ketik 1 untuk A4 atau 2 untuk F4."
    });
    return;
  }

  printQueue.push({
    from,
    ...pending,
    paper
  });

  pendingFiles.delete(from);

  const queueNumber = printQueue.length;

  await sock.sendMessage(from, {
    text:
      `📥 Dokumen masuk antrean cetak.\n` +
      `Nomor antrean: ${queueNumber}\n` +
      `Ukuran kertas: ${paper}`
  });

  processQueue(sock);
}

// ===============================
// START BOT
// ===============================

async function startBot() {
  const { state, saveCreds } =
    await useMultiFileAuthState("auth_info");

  const sock = makeWASocket({
    auth: state,
    browser: ["Smart Printer", "Chrome", "1.0.0"]
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("Scan QR WhatsApp berikut:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("✅ WhatsApp berhasil terhubung.");
    }

    if (connection === "close") {
      const statusCode =
        lastDisconnect?.error?.output?.statusCode;

      if (statusCode !== DisconnectReason.loggedOut) {
        console.log("Koneksi terputus. Mencoba menyambungkan ulang...");
        startBot();
      } else {
        console.log("WhatsApp logout. Hubungkan ulang dengan scan QR.");
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const from = msg.key.remoteJid;

      // Abaikan status WhatsApp
      if (from === "status@broadcast") continue;

      try {
        const content = msg.message;

        if (content.documentMessage) {
          await handleDocument(sock, msg, from);
        } else {
          const text =
            content.conversation ||
            content.extendedTextMessage?.text;

          if (text) {
            await handleText(sock, from, text);
          }
        }
      } catch (error) {
        console.error("Kesalahan pesan:", error);

        await sock.sendMessage(from, {
          text: "❌ Terjadi kesalahan saat memproses pesan."
        });
      }
    }
  });
}

startBot().catch(console.error);
