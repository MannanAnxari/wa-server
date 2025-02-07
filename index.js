import express from "express";
import pkg from "whatsapp-web.js";
const { Client, LocalAuth, MessageMedia } = pkg;
import qrcode from "qrcode";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs from "fs-extra";
import path from "path";
import axios from "axios";
import { fileURLToPath } from "url";
// // import { '* } from "../config/env.ts";
// // const { '* } = require("../config/env");
// const { '* } = await import("../config/env.js");

const app = express();
const server = createServer(app);

const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173",
    // origin: "https://laundry-pos.axetechsolutions.com",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

app.use(
  cors({
    origin: "http://localhost:5173",
    // origin: "https://laundry-pos.axetechsolutions.com",
    methods: ["GET", "POST"],
    credentials: true,
  })
);

app.use(express.json());

const clients = new Map();
const qrCodes = new Map();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSION_DIR = path.join(process.env.TMPDIR || "/tmp", ".wwebjs_auth");

const initializeWhatsAppClient = async (businessID) => {
  const sessionDir = path.join(SESSION_DIR, `session-${businessID}`);
  await fs.ensureDir(sessionDir);

  const puppeteerOptions = {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-gpu",
    ],
    ignoreDefaultArgs: ["--disable-extensions"],
  };

  // if (CHROME_PATH) {
  //   puppeteerOptions.executablePath = CHROME_PATH;
  // }

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: businessID,
      dataPath: SESSION_DIR,
    }),
    puppeteer: puppeteerOptions,
  });

  client.on("qr", async (qr) => {
    try {
      const qrCode = await qrcode.toDataURL(qr);
      qrCodes.set(businessID, qrCode);
      io.to(businessID).emit("qr", qrCode);
    } catch (err) {
      console.error(`Error generating QR Code for user ${businessID}:`, err);
      io.to(businessID).emit("error", "Failed to generate QR code");
    }
  });

  client.on("ready", () => {
    console.log(`Client is ready for user ${businessID}!`);
    clients.get(businessID).ready = true;
    qrCodes.delete(businessID);
    io.to(businessID).emit("ready");
  });

  client.on("authenticated", () => {
    console.log(`Client authenticated for user ${businessID}`);
    io.to(businessID).emit("authenticated");
  });

  client.on("auth_failure", (msg) => {
    console.error(`Auth failure for user ${businessID}:`, msg);
    io.to(businessID).emit("auth_failure", msg);
  });

  client.on("disconnected", async (reason) => {
    console.warn(
      `Client disconnected for user ${businessID}. Reason: ${reason}`
    );
    clients.get(businessID).ready = false;
    qrCodes.delete(businessID);
    io.to(businessID).emit("disconnected", reason);

    try {
      await client.destroy();
      clients.delete(businessID);
    } catch (error) {
      console.error(`Error destroying client for user ${businessID}:`, error);
    }

    setTimeout(() => {
      initializeWhatsAppClient(businessID);
    }, 500);
  });

  try {
    await client.initialize();
  } catch (err) {
    console.error(`Error initializing client for user ${businessID}:`, err);
    handleInitializationError(err, businessID);
    throw err;
  }

  return client;
};

const handleInitializationError = (err, businessID) => {
  console.error("Puppeteer launch error:", err.message);
  if (err.message.includes("libasound.so.2")) {
    console.error(
      "Missing libasound.so.2. Please run the install-dependencies.sh script."
    );
  }
  if (err.message.includes("libatk-1.0.so.0")) {
    console.error(
      "Missing required libraries. Please install them using: sudo apt-get install -y libatk1.0-0 libatk-bridge2.0-0 libcups2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2"
    );
  }
  io.to(businessID).emit("error", "Failed to initialize WhatsApp client");
};

const destroyClient = async (businessID) => {
  if (clients.has(businessID)) {
    const clientInfo = clients.get(businessID);
    if (clientInfo.client) {
      try {
        await clientInfo.client.destroy();
      } catch (error) {
        console.error(`Error destroying client for user ${businessID}:`, error);
      }
    }
    clients.delete(businessID);
  }
};

app.get("/api/health", async (req, res) => {
  return res.json({ msg: "It works!" });
});

app.post("/api/whatsapp/login", async (req, res) => {
  const { businessID, isGeneration = false } = req.body;
  if (!businessID) {
    return res.status(400).json({ error: "Business ID is required" });
  }

  try {
    // if (clients.has(businessID)) {
    //   const clientInfo = clients.get(businessID);
    //   if (clientInfo.client && clientInfo.client.pupPage) {
    //     try {
    //       // Check if the client is actually authenticated
    //       const isAuthenticated = await clientInfo.client.isAuthenticated();
    //       if (isAuthenticated) {
    //         return res.json({ status: "already_logged_in" });
    //       } else {
    //         // If not authenticated, destroy the client and remove it from the map
    //         await destroyClient(businessID);
    //       }
    //     } catch (error) {
    //       console.error(`Error checking authentication for user ${businessID}:`, error);
    //       // If there's an error, destroy the client and remove it from the map
    //       await destroyClient(businessID);
    //     }
    //   } else {
    //     // If the client doesn't have a pupPage, it's not fully initialized
    //     clients.delete(businessID);
    //   }
    // }

    if (clients.has(businessID) && isGeneration === false) {
      const clientInfo = clients.get(businessID);
      if (clientInfo.ready) {
        return res.json({ status: "already_logged_in" });
      }
    }

    const client = await initializeWhatsAppClient(businessID);
    clients.set(businessID, { client, ready: false });
    res.json({ status: "initializing" });
  } catch (error) {
    console.error(
      `Unexpected error in login process for user ${businessID}:`,
      error
    );
    res.status(500).json({
      error: "An unexpected error occurred. Please try again: " + error.message,
    });
  }
});

app.get("/api/whatsapp/info", async (req, res) => {
  const { businessID: business_id } = req.query;
  const businessID = parseInt(business_id);

  if (!businessID || !clients.has(businessID)) {
    return res.status(400).json({ error: "Client is not logged in" });
  }

  const clientInfo = clients.get(businessID);
  if (!clientInfo.ready) {
    return res.status(400).json({ error: "Client is not logged in" });
  }

  try {
    const client = clientInfo.client;
    const userInfo = await client.getContactById(client.info.wid._serialized);

    if (!userInfo) {
      return res.status(500).json({ error: "Failed to retrieve user info" });
    }

    res.json({
      status: "success",
      userNumber: userInfo.number,
      profilePicUrl: await client.getProfilePicUrl(userInfo.id._serialized),
      userName: userInfo.pushname || "Unknown",
      userAbout: (await userInfo.getAbout()) || "Not available",
      isBusinessWa: userInfo.isBusiness,
    });
  } catch (error) {
    console.error(`Error getting info for user ${businessID}:`, error);
    res.status(500).json({ error: "Failed to get info" });
  }
});

app.post("/api/whatsapp/logout", async (req, res) => {
  const { businessID } = req.body;
  if (!businessID || !clients.has(businessID)) {
    return res.status(400).json({ error: "Invalid or missing user ID" });
  }

  const clientInfo = clients.get(businessID);
  if (!clientInfo.ready) {
    return res.status(400).json({ error: "Client is not logged in" });
  }

  try {
    try {
      if (clientInfo.client) {
        // Check if Puppeteer browser exists and is open
        const browser = clientInfo.client.pupBrowser;
        if (browser && browser.process()) {
          // Logout only if the browser is still running
          await clientInfo.client.logout();
        }
        // Destroy the client to close Puppeteer session
        await clientInfo.client.destroy();
      }
      // Remove client from the map
      clients.delete(businessID);
      console.log(`Client ${businessID} logged out and removed successfully.`);
    } catch (error) {
      console.error(`Error cleaning up for user ${businessID}:`, error);
    }

    const sessionDir = path.join(SESSION_DIR, `session-${businessID}`);
    // await removeSessionFolder(sessionDir);

    res.json({ status: "success", message: "Logged out successfully" });
  } catch (error) {
    console.error(`Error logging out for user ${businessID}:`, error);
    // Even if there's an error, we'll try to clean up as much as possible
    clients.delete(businessID);
    // try {
    //   const sessionDir = path.join(SESSION_DIR, `session-${businessID}`);
    //   await removeSessionFolder(sessionDir);
    // } catch (cleanupError) {
    //   console.error(
    //     `Error cleaning up session for user ${businessID}:`,
    //     cleanupError
    //   );
    // }
    res.status(500).json({
      error:
        "Failed to log out completely, but session has been cleared. Please restart the application.",
    });
  }
});

async function removeSessionFolder(folderPath, retries = 5, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      await fs.remove(folderPath);
      console.log(`Successfully removed session folder: ${folderPath}`);
      return;
    } catch (error) {
      console.warn(`Attempt ${i + 1} to remove session folder failed:`, error);
      if (i === retries - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

app.post("/api/whatsapp/send-message", async (req, res) => {
  const {
    businessID: business_id,
    phone_number,
    message,
    attachmentUrl,
    orderNo,
  } = req.body;

  const businessID = parseInt(business_id);

  if (!businessID || !clients.has(businessID)) {
    return res.status(400).json({ error: "Invalid or missing user ID" });
  }

  const clientInfo = clients.get(businessID);
  if (!clientInfo.ready) {
    return res.status(400).json({
      error: "WhatsApp client not ready. Please scan the QR code first.",
    });
  }

  if (!phone_number || !message) {
    return res
      .status(400)
      .json({ error: "Phone number and message are required." });
  }

  try {
    const cleanedPhoneNumber = phone_number.replace(/\D/g, "");
    const chatId = `${cleanedPhoneNumber}@c.us`;
    const isPhoneValid = await clientInfo.client.isRegisteredUser(chatId);
    if (!isPhoneValid) {
      return res.status(400).json({
        error: "The phone number is not registered on WhatsApp.",
      });
    }

    if (attachmentUrl) {
      try {
        const fileResponse = await axios.get(attachmentUrl, {
          responseType: "arraybuffer",
        });

        const fileBuffer = Buffer.from(fileResponse.data, "binary");
        const fileType = fileResponse.headers["content-type"];

        if (
          !fileType ||
          (!fileType.startsWith("image") && !fileType.startsWith("application"))
        ) {
          return res.status(400).json({
            error:
              "Invalid media file type. Please upload a valid image or document.",
          });
        }

        const media = new MessageMedia(
          fileType,
          fileBuffer.toString("base64"),
          `Invoice-${orderNo}`
        );
        await clientInfo.client.sendMessage(chatId, media, {
          caption: message,
        });
      } catch (error) {
        if (error.response && error.response.status === 404) {
          return res.status(404).json({
            error: "File not found. Please check the attachment URL.",
          });
        }

        console.error(
          `Error sending message with attachment for user ${businessID}:`,
          error
        );
        return res.status(500).json({
          error: "Failed to send message with attachment. Please try again.",
        });
      }
    } else {
      await clientInfo.client.sendMessage(chatId, message);
    }

    res.json({ status: "success", message: "Message sent successfully." });
  } catch (error) {
    console.error(`Error sending message for user ${businessID}:`, error);
    if (error.message.includes("invalid wid")) {
      return res.status(400).json({
        error:
          "Invalid phone number format. Please provide a valid phone number.",
      });
    }

    if (error.message.includes("not connected")) {
      return res
        .status(500)
        .json({ error: "WhatsApp client not connected. Please reconnect." });
    }

    return res
      .status(500)
      .json({ error: "Failed to send message. Please try again later." });
  }
});

io.on("connection", (socket) => {
  const businessID = socket.handshake.query.businessID;
  console.log(`Socket connected for business ID: ${businessID}`);

  socket.on("join", (data) => {
    if (data.businessID) {
      socket.join(data.businessID);
      console.log(`Socket ${socket.id} joined room ${data.businessID}`);

      if (clients.has(data.businessID)) {
        const clientInfo = clients.get(data.businessID);
        if (!clientInfo.ready) {
          const existingQR = qrCodes.get(data.businessID);
          if (existingQR) {
            socket.emit("qr", existingQR);
          }
        }
      }
    }
  });

  socket.on("disconnect", () => {
    console.log(`Socket disconnected from business ID: ${businessID}`);
  });
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;
