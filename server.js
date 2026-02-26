import express from "express";
import sharp from "sharp";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import swaggerUi from "swagger-ui-express";
import swaggerJsdoc from "swagger-jsdoc";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "20mb" }));

// --- Swagger setup ---
const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Image Mask API",
      version: "1.0.0",
      description: "API for image cropping by bounding box and white background detection",
    },
    servers: [
      { url: "http://localhost:3333", description: "Local server" },
    ],
  },
  apis: [fileURLToPath(import.meta.url)],
});

app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: "Image Mask API — Swagger",
}));

// --- Temp crops setup ---
const TEMP_DIR = path.join(__dirname, "temp-crops");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);
app.use("/temp-crops", express.static(TEMP_DIR));

// Cleanup: delete files older than 30 minutes
setInterval(() => {
  const now = Date.now();
  fs.readdirSync(TEMP_DIR).forEach((file) => {
    const filePath = path.join(TEMP_DIR, file);
    const age = now - fs.statSync(filePath).mtimeMs;
    if (age > 30 * 60 * 1000) fs.unlinkSync(filePath);
  });
}, 5 * 60 * 1000);

function cleanUrl(u) {
  return String(u || "").trim().replace(/^=+/, "");
}

/**
 * @openapi
 * /crop-by-bbox:
 *   post:
 *     summary: Crop an image by bounding box
 *     description: >
 *       Fetches an image from the given URL, crops it using the provided
 *       bounding box coordinates (with optional padding), saves the result
 *       as a temporary PNG, and returns a public URL to the cropped image.
 *       Temporary files are automatically deleted after 30 minutes.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sourceUrl, bbox]
 *             properties:
 *               sourceUrl:
 *                 type: string
 *                 description: URL of the source image to crop
 *                 example: "https://example.com/photo.jpg"
 *               bbox:
 *                 type: array
 *                 items:
 *                   type: number
 *                 minItems: 4
 *                 maxItems: 4
 *                 description: "Bounding box coordinates [x1, y1, x2, y2] in pixels"
 *                 example: [100, 50, 400, 300]
 *               paddingRatio:
 *                 type: number
 *                 description: "Padding ratio relative to bbox size (default: 0.1)"
 *                 example: 0.1
 *     responses:
 *       200:
 *         description: Successfully cropped image
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 url:
 *                   type: string
 *                   description: Public URL to the cropped image
 *                   example: "http://localhost:3333/temp-crops/abc123.png"
 *       400:
 *         description: Bad request — missing parameters or failed to fetch image
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 */
app.post("/crop-by-bbox", async (req, res) => {
  try {
    let { sourceUrl, bbox, paddingRatio } = req.body;

    if (!sourceUrl || !bbox || bbox.length !== 4) {
      return res.status(400).json({ error: "Missing sourceUrl or bbox" });
    }

    sourceUrl = String(sourceUrl).trim().replace(/^=+/, "");

    const response = await fetch(sourceUrl);
    if (!response.ok) {
      return res.status(400).json({ error: "Failed to fetch image" });
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    const image = sharp(buffer);
    const meta = await image.metadata();

    const imgWidth = meta.width;
    const imgHeight = meta.height;

    let [x1, y1, x2, y2] = bbox.map(Number);

    const boxWidth = x2 - x1;
    const boxHeight = y2 - y1;

    const padding = Number(paddingRatio) || 0.1;

    const padX = Math.floor(boxWidth * padding);
    const padY = Math.floor(boxHeight * padding);

    const left = Math.max(0, x1 - padX);
    const top = Math.max(0, y1 - padY);
    const width = Math.min(imgWidth - left, boxWidth + padX * 2);
    const height = Math.min(imgHeight - top, boxHeight + padY * 2);

    const cropped = await image
      .extract({ left, top, width, height })
      .png()
      .toBuffer();

    // Save to temp file and return public URL
    const filename = `${crypto.randomUUID()}.png`;
    const filePath = path.join(TEMP_DIR, filename);
    fs.writeFileSync(filePath, cropped);

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const publicUrl = `${baseUrl}/temp-crops/${filename}`;

    return res.json({ url: publicUrl });

  } catch (err) {
    console.error("crop-by-bbox error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * @openapi
 * /check-white-bg:
 *   post:
 *     summary: Check if an image has a white background
 *     description: >
 *       Analyzes the border and corner regions of an image to determine
 *       whether it has a white background. Returns boolean result along
 *       with corner and border white-pixel ratios.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sourceUrl]
 *             properties:
 *               sourceUrl:
 *                 type: string
 *                 description: URL of the image to analyze
 *                 example: "https://example.com/photo.jpg"
 *               threshold:
 *                 type: number
 *                 description: "RGB threshold for considering a pixel white (default: 230)"
 *                 example: 230
 *     responses:
 *       200:
 *         description: Analysis result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 isWhiteBg:
 *                   type: boolean
 *                   description: Whether the image has a white background
 *                   example: true
 *                 cornerRatio:
 *                   type: number
 *                   description: Ratio of white pixels in the corner regions (0–1)
 *                   example: 0.85
 *                 borderRatio:
 *                   type: number
 *                   description: Ratio of white pixels in the border region (0–1)
 *                   example: 0.72
 *       400:
 *         description: Bad request — missing sourceUrl or failed to fetch image
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 */
app.post("/check-white-bg", async (req, res) => {
  try {
    let { sourceUrl, threshold } = req.body;

    sourceUrl = String(sourceUrl || "").trim().replace(/^=+/, "");
    if (!sourceUrl) {
      return res.status(400).json({ error: "Missing sourceUrl" });
    }

    const whiteThreshold = Number(threshold) || 230;

    const response = await fetch(sourceUrl);
    if (!response.ok) {
      return res.status(400).json({ error: "Failed to fetch image" });
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    const img = sharp(buffer).ensureAlpha();
    const meta = await img.metadata();

    const w = meta.width;
    const h = meta.height;

    const raw = await img.raw().toBuffer();
    const stride = w * 4;

    // Check border regions (top/bottom 10% and left/right 10% edges)
    const borderSize = Math.max(1, Math.floor(Math.min(w, h) * 0.1));
    let borderWhite = 0;
    let borderTotal = 0;

    // Also check the 4 corners (15% x 15% each)
    const cornerW = Math.max(1, Math.floor(w * 0.15));
    const cornerH = Math.max(1, Math.floor(h * 0.15));
    let cornerWhite = 0;
    let cornerTotal = 0;

    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const i = y * stride + x * 4;
        const r = raw[i];
        const g = raw[i + 1];
        const b = raw[i + 2];
        const a = raw[i + 3];

        const isWhite = a > 200 && r >= whiteThreshold && g >= whiteThreshold && b >= whiteThreshold;

        const isBorder = y < borderSize || y >= h - borderSize || x < borderSize || x >= w - borderSize;
        if (isBorder) {
          borderTotal++;
          if (isWhite) borderWhite++;
        }

        const isCorner =
          (x < cornerW && y < cornerH) ||
          (x >= w - cornerW && y < cornerH) ||
          (x < cornerW && y >= h - cornerH) ||
          (x >= w - cornerW && y >= h - cornerH);
        if (isCorner) {
          cornerTotal++;
          if (isWhite) cornerWhite++;
        }
      }
    }

    const borderRatio = borderTotal > 0 ? borderWhite / borderTotal : 0;
    const cornerRatio = cornerTotal > 0 ? cornerWhite / cornerTotal : 0;

    // White bg if corners are mostly white OR border is mostly white
    const isWhiteBg = cornerRatio > 0.6 || borderRatio > 0.5;

    return res.json({ isWhiteBg, cornerRatio: +cornerRatio.toFixed(3), borderRatio: +borderRatio.toFixed(3) });

  } catch (err) {
    console.error("check-white-bg error:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3333;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Image API running on http://localhost:${PORT}`);
  console.log(`   POST /crop-by-bbox`);
  console.log(`   POST /check-white-bg`);
  console.log(`   Static /temp-crops (auto-cleanup 30min)`);
  console.log(`   📖 Swagger UI: http://localhost:${PORT}/docs`);
});