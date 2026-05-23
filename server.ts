import express from "express";
import path from "path";
import dns from "dns";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";

// Lazy initialize Gemini clients to prevent early server startup issues if key is unconfigured
let aiInstance: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY environment variable is missing in Settings > Secrets. Please configure it to enable live camera verification.");
  }
  if (!aiInstance) {
    aiInstance = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        }
      }
    });
  }
  return aiInstance;
}

// Fallback lookup list of member IDs in case the network spreadsheet fetch is unavailable or slow
const FALLBACK_MEMBERS = [
  { memberId: "HL1001", name: "Amit Kumar", goal: "Weight Loss" },
  { memberId: "HL1002", name: "Priyanka Sharma", goal: "Weight Gain" },
  { memberId: "HL1003", name: "Rahul Verma", goal: "Muscle Building" },
  { memberId: "HL1004", name: "Sneha Gupta", goal: "Healthy Fitness" },
  { memberId: "HL1005", name: "Aarav Singh", goal: "Kids Progress" },
];

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Use larger JSON payload limit to safely receive high quality base64 camera frames
  app.use(express.json({ limit: "15mb" }));
  app.use(express.urlencoded({ extended: true, limit: "15mb" }));

  // API endpoint to search for a member ID from the live Google sheet spreadsheet CSV
  app.get("/api/members", async (req, res) => {
    try {
      console.log("Fetching live Google Sheet members data...");
      // Export URL for specific tab/GID
      const sheetCsvUrl = "https://docs.google.com/spreadsheets/d/1krG5NFJ2Uo2tP90fgh9ZeuIJRN80GRkcbik63KXX2Es/export?format=csv&gid=339189941";
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000); // 6s timeout

      const response = await fetch(sheetCsvUrl, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP status ${response.status} when fetching Google Sheet`);
      }

      const csvText = await response.text();
      const rows = parseCSV(csvText);
      
      if (rows.length === 0) {
        console.warn("Google Sheet parsed but empty. Serving fallback records.");
        return res.json({ source: "fallback", data: FALLBACK_MEMBERS });
      }

      console.log(`Successfully fetched and parsed ${rows.length} member rows from Google Sheet`);
      return res.json({ source: "live_google_sheet", data: rows });
    } catch (error: any) {
      console.error("Error fetching live Google Sheet. Serving fallback records:", error.message);
      return res.json({ source: "fallback", data: FALLBACK_MEMBERS, error: error.message });
    }
  });

  // Direct high-precision Gemini Vision check endpoint
  app.post("/api/verify-image", async (req, res) => {
    try {
      const { image, task } = req.body;
      if (!image) {
        return res.status(400).json({ error: "No image provided" });
      }
      if (!task) {
        return res.status(400).json({ error: "No task metadata provided" });
      }

      const client = getGeminiClient();

      // Extract raw base64 data portion if the canvas output prefix is present
      let base64Data = image;
      let mimeType = "image/jpeg";
      if (image.includes(";base64,")) {
        const parts = image.split(";base64,");
        base64Data = parts[1];
        mimeType = parts[0].split(":")[1] || "image/jpeg";
      }

      const taskTitle = task.titleEn || "";
      const taskDesc = task.descriptionEn || "";
      const requiredProduct = task.requiredProduct || "";
      const isHerbalifeProduct = !!task.isHerbalifeProduct;

      console.log(`Analyzing captured image. Task: "${taskTitle}" (Herbalife: ${isHerbalifeProduct})`);

      const prompt = `
You are the AI vision assistant for a Herbalife Daily Care & Wellness Tracker app.
Analyse the attached snapshot to verify the following user task/routine:

Task Title: "${taskTitle}"
Task Description: "${taskDesc}"
Is Herbalife brand specific: ${isHerbalifeProduct ? "YES" : "NO"}
Required product (if applicable): "${requiredProduct}"

STRICT EVALUATION INSTRUCTIONS:
1. Identify the primary object, scene, or activity shown in this image.
2. If it is high-junk/unhealthy/processed fast food (e.g. burger, pizza, fries, samosa, coke, soda, processed sweets, sugary items), return success=false. Show a warning that junk/processed food is strictly prohibited under their diet plan.
3. If the image shows walls, doors, gates, floor, computer, keyboard, a blank scene, or any unrelated household objects completely different from what is required (like standard gates, doors, or furniture), set success=false AND matched=false. In Hindi/English details, explain that an unrelated object (like a gate/furniture) was detected instead of the food/activity, and tell them to show the correct item.
4. If it's a Herbalife brand product task: Look for a container, bottle, logo, or powder scoop corresponding to "${requiredProduct}". If not visible or a random unrelated item is scanned, set success=false.
5. If the item or activity is correct and wholesome (e.g., fruit for fruit tasks, water for hydration tasks, yoga/stretching for workouts, healthy roti/dal plate for lunch/dinner), set success=true and matched=true.

Return a JSON object in this exact schema structure:
{
  "success": boolean,
  "detectedLabel": string,
  "details": string,
  "matched": boolean
}

Do not include any Markdown blocks around the JSON in the response. Provide pure JSON only.
`;

      const response = await client.models.generateContent({
        model: "gemini-3.5-flash",
        contents: [
          {
            inlineData: {
              data: base64Data,
              mimeType: mimeType
            }
          },
          prompt
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            required: ["success", "detectedLabel", "details", "matched"],
            properties: {
              success: { type: Type.BOOLEAN, description: "True if the item is correct, healthy, or matches the guidelines." },
              detectedLabel: { type: Type.STRING, description: "Compact label of the detected object (e.g., 'Wooden Gate', 'Water Glass', 'Formula 1 Container')." },
              details: { type: Type.STRING, description: "Encouraging or restrictive feedback in English and Hindi." },
              matched: { type: Type.BOOLEAN, description: "True if the object relates to the task; false if it's completely irrelevant like a door or gate." }
            }
          }
        }
      });

      const textResult = response.text || "{}";
      const cleanedText = textResult.trim();
      const resultJson = JSON.parse(cleanedText);

      console.log("Analyzed successfully:", resultJson);
      return res.json(resultJson);

    } catch (error: any) {
      console.error("Gemini Vision check error:", error.message);
      
      // Fallback response with a warning if API key is not configured or fails
      return res.json({
        success: false,
        detectedLabel: "Unrecognized Item",
        details: `Verification system is currently offline or API key is not configured. Please add the GEMINI_API_KEY to secrets. [Error: ${error.message}]`,
        matched: false
      });
    }
  });

  // Helper routine to parse CSV without external libraries
  function parseCSV(text: string) {
    const lines = text.split(/\r?\n/);
    if (lines.length < 2) return [];

    // Parse the headers
    const headerLine = lines[0];
    const headers = splitCSVRow(headerLine).map(h => h.trim().toLowerCase());

    // Identify crucial header indexes
    // Google Sheets may contain headings like: 'ID', 'Member ID', 'Name', 'Goal', 'Target Plan' etc.
    let memberIdIdx = headers.findIndex(h => h.includes("member") || h.includes("id") || h === "code");
    let nameIdx = headers.findIndex(h => h.includes("name") || h.includes("naam"));
    let goalIdx = headers.findIndex(h => h.includes("goal") || h.includes("plan") || h.includes("target"));

    // Fallbacks if heading styles didn't match perfectly
    if (memberIdIdx === -1) memberIdIdx = 0;
    if (nameIdx === -1) nameIdx = 1;
    if (goalIdx === -1) goalIdx = 2;

    const results = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;

      const cells = splitCSVRow(line);
      // Construct entry safely
      const rawId = cells[memberIdIdx] || "";
      const rawName = cells[nameIdx] || "";
      const rawGoal = cells[goalIdx] || "";

      if (rawId.trim()) {
        results.push({
          memberId: rawId.trim(),
          name: rawName.trim() || `User ${rawId.trim()}`,
          goal: mapRawGoalToStandard(rawGoal.trim()),
        });
      }
    }
    return results;
  }

  // Parses a simple CSV line, supporting double quotes with commas
  function splitCSVRow(line: string): string[] {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current.replace(/^"|"$/g, "").trim());
        current = "";
      } else {
        current += char;
      }
    }
    result.push(current.replace(/^"|"$/g, "").trim());
    return result;
  }

  // Maps loose terms to standardized target plan strings
  function mapRawGoalToStandard(goalStr: string): string {
    const lower = goalStr.toLowerCase();
    if (lower.includes("loss") || lower.includes("ghatana") || lower.includes("kam karna") || lower.includes("weightloss") || lower.includes("vajan ghatane")) {
      return "Weight Loss";
    }
    if (lower.includes("gain") || lower.includes("badhana") || lower.includes("weightgain") || lower.includes("vajan badhane")) {
      return "Weight Gain";
    }
    if (lower.includes("muscle") || lower.includes("building") || lower.includes("mushal") || lower.includes("mussel")) {
      return "Muscle Building";
    }
    if (lower.includes("fit") || lower.includes("fitness") || lower.includes("healthy") || lower.includes("lifestyle")) {
      return "Healthy Fitness";
    }
    if (lower.includes("child") || lower.includes("kid") || lower.includes("bacha") || lower.includes("dino")) {
      return "Kids Progress";
    }
    return goalStr; // fallback to original string if not mapped
  }

  // Serve static assets or mount Vite dev server
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
