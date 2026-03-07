import TelegramBot from "node-telegram-bot-api";
import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import crypto from "crypto";
import { MongoClient } from "mongodb";
import "dotenv/config";

// ─── Config ───────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const BOT_URL = process.env.BOT_URL || "https://your-app.replit.app";
const MONGO_URI = process.env.MONGO_URI;
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(id => Number(id.trim())).filter(Boolean);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "sage_admin_2025";

// ─── Plans ────────────────────────────────────────────────
const PLANS = {
  free: { messagesPerDay: 5, label: "Free" },
  weekly: { price: 500, label: "Weekly ₦500", days: 7 },
  monthly: { price: 2000, label: "Monthly ₦2,000", days: 30 },
};

// ─── Promo Codes ─────────────────────────────────────────
const PROMO_CODES = {
  "SAGE2WEEKS": { days: 14, maxUses: 20, label: "2 Weeks Free Premium", plan: "promo" },
  "SAGELAUNCH": { days: 7,  maxUses: 50, label: "1 Week Free Premium",  plan: "promo" },
};
// Track who used each promo code (stored in MongoDB)
async function usePromoCode(userId, code) {
  const promo = PROMO_CODES[code.toUpperCase()];
  if (!promo) return { success: false, reason: "invalid" };

  // Check if already used by this user
  const alreadyUsed = await db.collection("promo_uses").findOne({ userId, code: code.toUpperCase() });
  if (alreadyUsed) return { success: false, reason: "already_used" };

  // Check total uses
  const totalUses = await db.collection("promo_uses").countDocuments({ code: code.toUpperCase() });
  if (totalUses >= promo.maxUses) return { success: false, reason: "expired" };

  // Record use
  await db.collection("promo_uses").insertOne({
    userId, code: code.toUpperCase(),
    date: new Date().toISOString(),
  });

  // Activate premium
  await activatePremium(userId, promo.days, promo.plan);
  return { success: true, promo, usesLeft: promo.maxUses - totalUses - 1 };
}

// ─── Language System ─────────────────────────────────────
const LANGUAGES = {
  en: { name: "English 🇬🇧", flag: "🇬🇧" },
  pidgin: { name: "Pidgin English 🇳🇬", flag: "🇳🇬" },
  ig: { name: "Igbo 🇳🇬", flag: "🇳🇬" },
  fr: { name: "Français 🇫🇷", flag: "🇫🇷" },
  es: { name: "Español 🇪🇸", flag: "🇪🇸" },
};

const LANG_INSTRUCTIONS = {
  en: "Always respond in clear, standard English.",
  pidgin: "Always respond in Nigerian Pidgin English. Use natural Pidgin expressions like 'wetin', 'abi', 'na so', 'make you', 'no wahala', 'e easy', 'you sabi'. Keep it friendly and natural.",
  ig: "Always respond in Igbo language. Use proper Igbo words and grammar. You can occasionally add English translations in brackets for technical medical terms.",
  fr: "Réponds toujours en français. Utilise un français clair et professionnel adapté aux étudiants.",
  es: "Responde siempre en español. Usa un español claro y profesional adecuado para estudiantes.",
};

// ─── MongoDB Connection ───────────────────────────────────
let db;
async function connectDB() {
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db("sage_bot");
    console.log("✅ Connected to MongoDB Atlas!");

    // Create indexes for faster queries
    await db.collection("users").createIndex({ userId: 1 }, { unique: true });
    await db.collection("analytics").createIndex({ date: 1 });
    await db.collection("transactions").createIndex({ date: -1 });
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err.message);
    process.exit(1);
  }
}

// ─── DB Helpers ───────────────────────────────────────────
async function getUser(userId) {
  let user = await db.collection("users").findOne({ userId });
  if (!user) {
    user = {
      userId,
      firstName: "",
      history: [],
      messageCount: 0,
      lastReset: new Date().toDateString(),
      premium: false,
      premiumExpiry: null,
      joinedAt: new Date().toISOString(),
    };
    await db.collection("users").insertOne(user);
  }
  return user;
}

async function updateUser(userId, updates) {
  await db.collection("users").updateOne({ userId }, { $set: updates });
}

async function isPremium(userId) {
  const user = await getUser(userId);
  if (!user.premium) return false;
  if (user.premiumExpiry && new Date() > new Date(user.premiumExpiry)) {
    await updateUser(userId, { premium: false, premiumExpiry: null });
    return false;
  }
  return true;
}

async function canSendMessage(userId) {
  if (await isPremium(userId)) return true;
  const user = await getUser(userId);
  const today = new Date().toDateString();
  if (user.lastReset !== today) {
    await updateUser(userId, { messageCount: 0, lastReset: today });
    return true;
  }
  return user.messageCount < PLANS.free.messagesPerDay;
}

async function incrementMessageCount(userId) {
  if (await isPremium(userId)) return;
  await db.collection("users").updateOne({ userId }, { $inc: { messageCount: 1 } });
}

async function messagesLeft(userId) {
  if (await isPremium(userId)) return "unlimited";
  const user = await getUser(userId);
  const today = new Date().toDateString();
  if (user.lastReset !== today) return PLANS.free.messagesPerDay;
  return Math.max(0, PLANS.free.messagesPerDay - user.messageCount);
}

async function activatePremium(userId, days, plan) {
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + days);
  await updateUser(userId, { premium: true, premiumExpiry: expiry.toISOString(), premiumPlan: plan || "weekly" });
}

async function isMonthlyPremium(userId) {
  if (!await isPremium(userId)) return false;
  const user = await getUser(userId);
  return user.premiumPlan === "monthly";
}

async function getHistory(userId) {
  const user = await getUser(userId);
  return user.history || [];
}

async function addToHistory(userId, role, content) {
  const user = await getUser(userId);
  const history = user.history || [];
  history.push({ role, content });
  if (history.length > 20) history.splice(0, history.length - 20);
  await updateUser(userId, { history });
}

async function clearHistory(userId) {
  await updateUser(userId, { history: [] });
}

// ─── Analytics DB ─────────────────────────────────────────
async function trackMessage(userId, topic) {
  const today = new Date().toDateString();
  await db.collection("analytics").updateOne(
    { date: today },
    {
      $addToSet: { totalUsers: userId, activeToday: userId },
      $inc: { totalMessages: 1, [`topics.${topic || "General"}`]: 1 },
    },
    { upsert: true }
  );
}

async function trackRevenue(amount, plan, userId) {
  await db.collection("transactions").insertOne({
    userId, amount, plan,
    date: new Date().toISOString(),
  });
  await db.collection("analytics").updateOne(
    { date: new Date().toDateString() },
    { $inc: { totalRevenue: amount }, $addToSet: { premiumUsers: userId } },
    { upsert: true }
  );
}

async function getAnalytics() {
  const today = new Date().toDateString();
  const todayData = await db.collection("analytics").findOne({ date: today }) || {};

  // All time stats
  const allUsers = await db.collection("users").countDocuments();
  const premiumUsers = await db.collection("users").countDocuments({ premium: true });
  const totalMsgs = await db.collection("analytics").aggregate([
    { $group: { _id: null, total: { $sum: "$totalMessages" } } }
  ]).toArray();
  const totalRevData = await db.collection("transactions").aggregate([
    { $group: { _id: null, total: { $sum: "$amount" } } }
  ]).toArray();
  const recentTransactions = await db.collection("transactions")
    .find().sort({ date: -1 }).limit(10).toArray();

  // Top topics all time
  const topicPipeline = await db.collection("analytics").aggregate([
    { $project: { topics: { $objectToArray: "$topics" } } },
    { $unwind: "$topics" },
    { $group: { _id: "$topics.k", count: { $sum: "$topics.v" } } },
    { $sort: { count: -1 } },
    { $limit: 5 }
  ]).toArray();

  return {
    totalUsers: allUsers,
    activeToday: (todayData.activeToday || []).length,
    premiumUsers,
    freeUsers: allUsers - premiumUsers,
    totalMessages: totalMsgs[0]?.total || 0,
    totalRevenue: totalRevData[0]?.total || 0,
    topTopics: topicPipeline.map(t => ({ name: t._id, count: t.count })),
    recentTransactions,
    conversionRate: allUsers > 0 ? ((premiumUsers / allUsers) * 100).toFixed(1) : 0,
  };
}

// ─── Feedback & Support Storage ──────────────────────────
async function saveFeedback(userId, firstName, type, text, rating = null) {
  await db.collection("feedback").insertOne({
    userId, firstName, type, text, rating,
    date: new Date().toISOString(),
    resolved: false,
  });
}

async function getFeedbackStats() {
  const total = await db.collection("feedback").countDocuments();
  const ratings = await db.collection("feedback").find({ rating: { $ne: null } }).toArray();
  const avgRating = ratings.length > 0
    ? (ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length).toFixed(1)
    : "N/A";
  const unresolved = await db.collection("feedback").countDocuments({ type: "support", resolved: false });
  const recent = await db.collection("feedback").find().sort({ date: -1 }).limit(5).toArray();
  return { total, avgRating, totalRatings: ratings.length, unresolved, recent };
}

// Track message count for auto-rating prompt
async function shouldAskRating(userId) {
  const user = await getUser(userId);
  const count = user.messageCount || 0;
  const lastRatingPrompt = user.lastRatingPrompt || 0;
  return count > 0 && count % 10 === 0 && lastRatingPrompt !== count;
}

// ─── Image Library ────────────────────────────────────────
const IMAGES = {
  heart: "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e5/Diagram_of_the_human_heart_%28cropped%29.svg/800px-Diagram_of_the_human_heart_%28cropped%29.svg.png",
  lungs: "https://upload.wikimedia.org/wikipedia/commons/thumb/6/6e/Lungs_diagram_simple.svg/800px-Lungs_diagram_simple.svg.png",
  brain: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/12/Human_brain_NIH.jpg/800px-Human_brain_NIH.jpg",
  kidney: "https://upload.wikimedia.org/wikipedia/commons/thumb/d/d9/Kidney_cross-section.svg/800px-Kidney_cross-section.svg.png",
  liver: "https://upload.wikimedia.org/wikipedia/commons/thumb/5/58/Liver_anterior.jpg/800px-Liver_anterior.jpg",
  skeleton: "https://upload.wikimedia.org/wikipedia/commons/thumb/5/58/Anterior_view_of_human_skeleton.jpg/800px-Anterior_view_of_human_skeleton.jpg",
  spine: "https://upload.wikimedia.org/wikipedia/commons/thumb/8/8c/Vertebral_column.png/400px-Vertebral_column.png",
  digestive: "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c5/Digestive_system_diagram_en.svg/800px-Digestive_system_diagram_en.svg.png",
  neuron: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/10/Blausen_0657_MultipolarNeuron.png/800px-Blausen_0657_MultipolarNeuron.png",
  eye: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1e/Schematic_diagram_of_the_human_eye_en.svg/800px-Schematic_diagram_of_the_human_eye_en.svg.png",
  ear: "https://upload.wikimedia.org/wikipedia/commons/thumb/d/df/Ear_anatomy.svg/800px-Ear_anatomy.svg.png",
  wound_stages: "https://upload.wikimedia.org/wikipedia/commons/thumb/5/5d/Wound_Healing.png/800px-Wound_Healing.png",
  pressure_ulcer: "https://upload.wikimedia.org/wikipedia/commons/thumb/0/08/Donogal_Stages.png/800px-Donogal_Stages.png",
  maslow: "https://upload.wikimedia.org/wikipedia/commons/thumb/3/33/MaslowsHierarchyOfNeeds.svg/800px-MaslowsHierarchyOfNeeds.svg.png",
  adpie: "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3e/Nursing_Process.png/600px-Nursing_Process.png",
  ecg_normal: "https://upload.wikimedia.org/wikipedia/commons/thumb/9/9e/SinusRhythmLabels.svg/800px-SinusRhythmLabels.svg.png",
  fluid_electrolytes: "https://upload.wikimedia.org/wikipedia/commons/thumb/5/5d/Electrolyte_imbalance.png/600px-Electrolyte_imbalance.png",
  vital_signs: "https://upload.wikimedia.org/wikipedia/commons/thumb/5/5e/Vital_signs.jpg/800px-Vital_signs.jpg",
};

function detectImageRequest(text) {
  const t = text.toLowerCase();
  if (t.includes("heart") || t.includes("cardiac") || t.includes("cardiovascular")) return IMAGES.heart;
  if (t.includes("lung") || t.includes("respiratory") || t.includes("pulmonary")) return IMAGES.lungs;
  if (t.includes("brain") || t.includes("neuro") || t.includes("cerebr")) return IMAGES.brain;
  if (t.includes("kidney") || t.includes("renal")) return IMAGES.kidney;
  if (t.includes("liver") || t.includes("hepat")) return IMAGES.liver;
  if (t.includes("skeleton") || t.includes("bone") || t.includes("skeletal")) return IMAGES.skeleton;
  if (t.includes("spine") || t.includes("vertebr") || t.includes("spinal")) return IMAGES.spine;
  if (t.includes("digest") || t.includes("bowel") || t.includes("intestin")) return IMAGES.digestive;
  if (t.includes("neuron") || t.includes("nerve cell")) return IMAGES.neuron;
  if (t.includes("eye") || t.includes("ocular")) return IMAGES.eye;
  if (t.includes("ear") || t.includes("hearing")) return IMAGES.ear;
  if (t.includes("wound") || t.includes("dressing")) return IMAGES.wound_stages;
  if (t.includes("pressure ulcer") || t.includes("bedsore")) return IMAGES.pressure_ulcer;
  if (t.includes("maslow")) return IMAGES.maslow;
  if (t.includes("adpie") || t.includes("nursing process")) return IMAGES.adpie;
  if (t.includes("ecg") || t.includes("ekg")) return IMAGES.ecg_normal;
  if (t.includes("electrolyte") || t.includes("fluid balance")) return IMAGES.fluid_electrolytes;
  if (t.includes("vital sign")) return IMAGES.vital_signs;
  return null;
}

// ─── Claude with Web Search ───────────────────────────────
async function askSage(userId, userMessage) {
  await addToHistory(userId, "user", userMessage);
  const history = await getHistory(userId);
  const user = await getUser(userId);
  const lang = user.language || "en";
  const langInstruction = LANG_INSTRUCTIONS[lang] || LANG_INSTRUCTIONS.en;
  const monthlyPremium = await isMonthlyPremium(userId);

  const systemPrompt = `You are Sage, a warm and knowledgeable Medical & Nursing tutor. Subjects: Anatomy & Physiology, Primary Health Care, Med-Surg, NCLEX prep, Research & Statistics, Mental Health Nursing (Perspectives, Dynamics, Community), Pharmacology (drug classifications, mechanisms, side effects, nursing considerations, drug calculations, pharmacokinetics, cardiovascular/respiratory/CNS/antibiotic drugs, anticoagulants, IV medications), Physics, Chemistry, Math, Science, English, Coding.
Teaching style: Use nursing process (ADPIE), mnemonics (ROME, ABCs, Maslow), simple language, clinical application.
For NCLEX: use 4-option format, wait for answer, explain all options.
For Research & Statistics: explain research designs, sampling methods, data analysis, hypothesis testing, and how to write a research proposal.
For Mental Health Nursing: cover therapeutic communication, mental health disorders, psychotropic medications, community mental health resources, legal and ethical issues.
${monthlyPremium ? "Web search: Use for latest drug approvals, updated guidelines, recent NCLEX changes, current research." : "Do not use web search for this user."}
Keep responses concise for Telegram. Use *bold* and _italic_ for emphasis.
LANGUAGE INSTRUCTION: ${langInstruction}`;

  const requestBody = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    system: systemPrompt,
    messages: history,
  };

  const headers = {
    "Content-Type": "application/json",
    "x-api-key": ANTHROPIC_KEY,
    "anthropic-version": "2023-06-01",
  };

  // Only enable web search for monthly premium subscribers
  if (monthlyPremium) {
    headers["anthropic-beta"] = "web-search-2025-03-05";
    requestBody.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }];
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
  });

  const data = await response.json();
  const reply = data.content?.filter(b => b.type === "text")?.map(b => b.text)?.join("") || "Sorry, please try again.";
  const usedWebSearch = data.content?.some(b => b.type === "tool_use" && b.name === "web_search");
  await addToHistory(userId, "assistant", reply);
  return { reply, usedWebSearch };
}

// ─── Paystack ─────────────────────────────────────────────
async function createPaystackLink(userId, plan, email) {
  const amount = PLANS[plan].price * 100;
  const ref = `sage_${userId}_${plan}_${Date.now()}`;
  const res = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      email, amount, reference: ref,
      callback_url: `${BOT_URL}/paystack/callback`,
      metadata: { userId: String(userId), plan, days: PLANS[plan].days },
    }),
  });
  const data = await res.json();
  return data.status ? data.data.authorization_url : null;
}

// ─── Bot & Express ────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const app = express();
app.use(express.json());

// ─── Admin Web Dashboard ──────────────────────────────────
app.get("/admin", async (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) {
    return res.send(`<html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f172a">
      <div style="background:#1e293b;padding:40px;border-radius:16px;text-align:center;color:white;width:320px">
        <h2 style="color:#f59e0b">🔐 Sage Admin</h2>
        <p style="color:#94a3b8;margin-bottom:20px">Enter admin password</p>
        <form action="/admin" method="get">
          <input name="password" type="password" placeholder="Password" style="width:100%;padding:12px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:white;margin-bottom:12px;box-sizing:border-box"/>
          <button type="submit" style="width:100%;padding:12px;background:#f59e0b;border:none;border-radius:8px;color:white;font-weight:bold;cursor:pointer">Login →</button>
        </form>
      </div></body></html>`);
  }

  const stats = await getAnalytics();
  const maxTopic = stats.topTopics[0]?.count || 1;

  res.send(`<html>
  <head>
    <title>Sage Admin</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}
      .header{background:linear-gradient(135deg,#92400e,#b45309);padding:20px 28px;display:flex;align-items:center;justify-content:space-between}
      .header h1{font-size:20px}
      .header span{font-size:12px;color:rgba(255,255,255,0.7)}
      .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;padding:20px 28px}
      .card{background:#1e293b;border-radius:12px;padding:18px;border:1px solid #334155}
      .card .label{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
      .card .value{font-size:28px;font-weight:700;color:#f59e0b}
      .card .sub{font-size:11px;color:#64748b;margin-top:4px}
      .section{padding:0 28px 20px}
      .section h2{font-size:13px;color:#64748b;margin-bottom:14px;text-transform:uppercase;letter-spacing:1px}
      .topic-row{display:flex;align-items:center;gap:10px;margin-bottom:8px}
      .topic-name{width:160px;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .bar-bg{flex:1;background:#334155;border-radius:4px;height:6px}
      .bar-fill{height:6px;border-radius:4px;background:linear-gradient(90deg,#f59e0b,#d97706)}
      .topic-count{font-size:12px;color:#64748b;width:30px;text-align:right}
      .tx-list{background:#1e293b;border-radius:12px;border:1px solid #334155;overflow:hidden}
      .tx-item{padding:12px 18px;border-bottom:1px solid #334155;display:flex;justify-content:space-between;align-items:center;font-size:13px}
      .tx-item:last-child{border-bottom:none}
      .badge{padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600}
      .badge.weekly{background:#1e3a5f;color:#60a5fa}
      .badge.monthly{background:#3b1f6b;color:#a78bfa}
      .refresh-btn{background:#334155;border:none;color:#94a3b8;padding:7px 14px;border-radius:8px;cursor:pointer;font-size:12px}
      @media(max-width:600px){.grid,.section{padding:14px}.header{padding:14px}}
    </style>
  </head>
  <body>
    <div class="header">
      <div><h1>🎓 Sage Admin Dashboard</h1><span>${new Date().toLocaleString("en-NG")}</span></div>
      <button class="refresh-btn" onclick="location.reload()">🔄 Refresh</button>
    </div>
    <div class="grid">
      <div class="card"><div class="label">Total Users</div><div class="value">${stats.totalUsers}</div><div class="sub">All time</div></div>
      <div class="card"><div class="label">Active Today</div><div class="value">${stats.activeToday}</div><div class="sub">Unique users</div></div>
      <div class="card"><div class="label">Premium Users</div><div class="value">${stats.premiumUsers}</div><div class="sub">Conversion: ${stats.conversionRate}%</div></div>
      <div class="card"><div class="label">Total Revenue</div><div class="value">₦${stats.totalRevenue.toLocaleString()}</div><div class="sub">${stats.recentTransactions.length} transactions</div></div>
      <div class="card"><div class="label">Total Messages</div><div class="value">${stats.totalMessages.toLocaleString()}</div><div class="sub">All time</div></div>
      <div class="card"><div class="label">Free Users</div><div class="value">${stats.freeUsers}</div><div class="sub">On free plan</div></div>
    </div>
    <div class="section">
      <h2>🔥 Top Topics</h2>
      ${stats.topTopics.length === 0 ? '<p style="color:#64748b;font-size:13px">No data yet</p>' :
        stats.topTopics.map(t => `
          <div class="topic-row">
            <div class="topic-name">${t.name}</div>
            <div class="bar-bg"><div class="bar-fill" style="width:${(t.count/maxTopic*100).toFixed(0)}%"></div></div>
            <div class="topic-count">${t.count}</div>
          </div>`).join("")}
    </div>
    <div class="section">
      <h2>💰 Recent Transactions</h2>
      <div class="tx-list">
        ${stats.recentTransactions.length === 0
          ? '<div class="tx-item" style="color:#64748b">No transactions yet</div>'
          : stats.recentTransactions.map(r => `
            <div class="tx-item">
              <span>User #${r.userId}</span>
              <span class="badge ${r.plan}">${r.plan}</span>
              <span style="color:#4ade80">+₦${r.amount.toLocaleString()}</span>
              <span style="color:#64748b;font-size:11px">${new Date(r.date).toLocaleDateString("en-NG")}</span>
            </div>`).join("")}
      </div>
    </div>

    <div class="section">
      <h2>⭐ Recent Feedback & Ratings</h2>
      <div class="tx-list">
        ${(await getFeedbackStats()).recent.length === 0
          ? '<div class="tx-item" style="color:#64748b">No feedback yet</div>'
          : (await getFeedbackStats()).recent.map(f => `
            <div class="tx-item" style="flex-wrap:wrap;gap:6px">
              <span style="font-weight:600">${f.firstName || "User"}</span>
              <span class="badge ${f.type === 'support' ? 'monthly' : f.type === 'rating' ? 'weekly' : 'weekly'}">${f.type}</span>
              ${f.rating ? `<span style="color:#f59e0b">${"⭐".repeat(f.rating)}</span>` : ""}
              <span style="color:#94a3b8;font-size:12px;flex-basis:100%">${f.text ? f.text.substring(0, 80) + (f.text.length > 80 ? "..." : "") : ""}</span>
              <span style="color:#64748b;font-size:11px">${new Date(f.date).toLocaleDateString("en-NG")}</span>
              ${f.type === "support" && !f.resolved ? '<span style="color:#f87171;font-size:11px">● Unresolved</span>' : ""}
            </div>`).join("")}
      </div>
    </div>
  </body></html>`);
});

// ─── Paystack Webhook ─────────────────────────────────────
app.post("/paystack/webhook", async (req, res) => {
  const hash = crypto.createHmac("sha512", PAYSTACK_SECRET).update(JSON.stringify(req.body)).digest("hex");
  if (hash !== req.headers["x-paystack-signature"]) return res.status(401).send("Unauthorized");
  if (req.body.event === "charge.success") {
    const { userId, plan, days } = req.body.data.metadata;
    const amount = req.body.data.amount / 100;
    await activatePremium(Number(userId), Number(days), plan);
    await trackRevenue(amount, plan, Number(userId));
    const user = await getUser(Number(userId));
    bot.sendMessage(userId,
      `🎉 *Payment confirmed! Welcome to Sage Premium!*\n\n` +
      `✅ Plan: *${PLANS[plan].label}*\n` +
      `📅 Expires: *${new Date(user.premiumExpiry).toLocaleDateString("en-NG", { day: "numeric", month: "long", year: "numeric" })}*\n\n` +
      `Unlimited access + diagrams + real-time updates! 📚🌐`,
      { parse_mode: "Markdown" }
    );
  }
  res.sendStatus(200);
});

app.get("/paystack/callback", (req, res) => {
  res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#0f172a;color:white">
    <h2 style="color:#f59e0b">✅ Payment Successful!</h2>
    <p>Go back to Telegram and start studying with Sage 📚</p>
  </body></html>`);
});

// ─── Keyboards ────────────────────────────────────────────
const MAIN_KEYBOARD = {
  reply_markup: {
    keyboard: [
      ["🦴 Anatomy", "🏥 Primary Health Care"],
      ["💉 Med-Surg", "📋 NCLEX Practice"],
      ["🧠 Mental Health Nursing", "📊 Research & Statistics"],
      ["💊 Pharmacology", "🧪 Drug Calculations"],
      ["📐 Math", "🔬 Science"],
      ["⚗️ Chemistry", "🔭 Physics"],
      ["📖 English", "💻 Coding"],
      ["🌐 Latest Medical News", "⭐ Go Premium"],
      ["🌍 Language", "📊 My Status"],
      ["🔄 Reset", "❓ Help"],
      ["⭐ Rate Sage", "📝 Feedback", "🆘 Support"],
      ["🎟️ Redeem Code"],
    ],
    resize_keyboard: true,
  },
};

const MENTAL_HEALTH_KEYBOARD = {
  reply_markup: {
    keyboard: [
      ["🔭 Perspectives in MHN", "⚡ Dynamics in MHN"],
      ["🏘️ Community Mental Health", "💊 Psychotropic Medications"],
      ["🗣️ Therapeutic Communication", "📋 Mental Health Disorders"],
      ["🔙 Back to Main Menu"],
    ],
    resize_keyboard: true,
  },
};

const PHARMACOLOGY_KEYBOARD = {
  reply_markup: {
    keyboard: [
      ["💉 Drug Classifications", "⚗️ Mechanism of Action"],
      ["⚠️ Side Effects & ADRs", "🩺 Nursing Considerations"],
      ["🧮 Drug Calculations", "📦 Pharmacokinetics"],
      ["💊 Cardiovascular Drugs", "🫁 Respiratory Drugs"],
      ["🧠 CNS Drugs", "🦠 Antibiotics & Antimicrobials"],
      ["🩸 Anticoagulants", "💉 IV Medications"],
      ["🔙 Back to Main Menu"],
    ],
    resize_keyboard: true,
  },
};

const LANGUAGE_KEYBOARD = {
  reply_markup: {
    keyboard: [
      ["🇬🇧 English", "🇳🇬 Pidgin English"],
      ["🇳🇬 Igbo", "🇫🇷 Français"],
      ["🇪🇸 Español"],
      ["🔙 Back to Main Menu"],
    ],
    resize_keyboard: true,
  },
};

const NCLEX_KEYBOARD = {
  reply_markup: {
    keyboard: [
      ["🫀 Cardiovascular", "🫁 Respiratory"],
      ["🧠 Neurological", "🦷 Musculoskeletal"],
      ["💊 Pharmacology", "🧪 Lab Values"],
      ["⚡ Priority Questions", "🔬 Infection Control"],
      ["🔙 Back to Main Menu"],
    ],
    resize_keyboard: true,
  },
};

const subjectMap = {
  "🦴 Anatomy": "I want to study Anatomy & Physiology. Ask me what body system or topic I need help with.",
  "🏥 Primary Health Care": "I want to study Primary Health Care. Ask me what PHC topic I need help with.",
  "💉 Med-Surg": "I want to study Medical-Surgical Nursing. Ask me what med-surg topic I need help with.",
  "🫀 Cardiovascular": "Give me an NCLEX question on Cardiovascular nursing. Wait for my answer.",
  "🫁 Respiratory": "Give me an NCLEX question on Respiratory nursing. Wait for my answer.",
  "🧠 Neurological": "Give me an NCLEX question on Neurological nursing. Wait for my answer.",
  "🦷 Musculoskeletal": "Give me an NCLEX question on Musculoskeletal nursing. Wait for my answer.",
  "💊 Pharmacology": "Give me an NCLEX pharmacology question. Wait for my answer.",
  "🧪 Lab Values": "Quiz me on important NCLEX lab values.",
  "⚡ Priority Questions": "Give me NCLEX priority/delegation questions using Maslow and ABCs. Wait for my answer.",
  "🔬 Infection Control": "Give me an NCLEX infection control question. Wait for my answer.",
  "📐 Math": "I want to study Math. Ask me what topic I need help with.",
  "🔬 Science": "I want to study Science. Ask me what topic I need help with.",
  "📖 English": "I want to study English. Ask me what topic I need help with.",
  "💻 Coding": "I want to study Coding. Ask me what topic I need help with.",
  "⚗️ Chemistry": "I want to study Chemistry. Ask me what specific chemistry topic I need help with — could be organic, inorganic, physical chemistry, chemical equations, or lab work.",
  "🔭 Physics": "I want to study Physics. Ask me what specific physics topic I need help with — could be mechanics, waves, electricity, magnetism, optics, thermodynamics, or modern physics.",
  "💊 Pharmacology": null,
  "🧪 Drug Calculations": "Teach me how to calculate drug doses step by step. Cover the basic formula (Dose = Desired/Have × Volume), IV drip rates, weight-based dosing, pediatric dosing, and give me practice problems to solve.",
  "💉 Drug Classifications": "Teach me the major drug classifications in nursing pharmacology — their general mechanisms, common examples, side effects, and nursing considerations.",
  "⚗️ Mechanism of Action": "Explain how drugs work at a molecular and cellular level — receptor theory, agonists and antagonists, enzyme inhibition, ion channels. Give clinical examples.",
  "⚠️ Side Effects & ADRs": "Teach me about drug side effects and adverse drug reactions (ADRs) — how to identify them, report them, and the most important ones nurses must watch for.",
  "🩺 Nursing Considerations": "Teach me the most important nursing considerations in pharmacology — the 6 rights of medication administration, patient education, high-alert medications, and medication errors.",
  "🧮 Drug Calculations": "Give me drug calculation practice problems step by step. Cover tablets, liquids, injections, IV drip rates, and weight-based doses.",
  "📦 Pharmacokinetics": "Teach me pharmacokinetics — absorption, distribution, metabolism, and excretion (ADME). Cover first-pass effect, half-life, bioavailability, and how they affect nursing practice.",
  "💊 Cardiovascular Drugs": "Teach me about cardiovascular drugs — antihypertensives, diuretics, cardiac glycosides, antiarrhythmics, antianginals. Cover drug class, action, side effects, nursing considerations.",
  "🫁 Respiratory Drugs": "Teach me about respiratory drugs — bronchodilators, corticosteroids, antihistamines, decongestants, mucolytics. Cover drug class, action, side effects, nursing considerations.",
  "🧠 CNS Drugs": "Teach me about CNS drugs — analgesics, sedatives, hypnotics, antiepileptics, antidepressants, antipsychotics. Cover drug class, action, side effects, nursing considerations.",
  "🦠 Antibiotics & Antimicrobials": "Teach me about antibiotics and antimicrobials — penicillins, cephalosporins, macrolides, aminoglycosides, fluoroquinolones, antifungals, antivirals. Cover spectrum, resistance, side effects, nursing considerations.",
  "🩸 Anticoagulants": "Teach me about anticoagulants and thrombolytics — heparin, warfarin, NOACs, aspirin, thrombolytics. Cover mechanism, monitoring, antidotes, nursing considerations.",
  "💉 IV Medications": "Teach me about IV medications in nursing — IV push vs infusion, compatibility, calculation of IV drip rates, common IV drugs and their nursing considerations.",
  "🌐 Latest Medical News": "Search the web for the latest medical and nursing news, recent drug approvals, updated clinical guidelines, and NCLEX changes. Summarize the most important updates.",
  "📊 Research & Statistics": "I want to study Research & Statistics in nursing. Ask me what specific topic I need help with — could be research designs, sampling, hypothesis testing, data analysis, literature review, or writing a research proposal.",
  "🧠 Mental Health Nursing": null,
  "🔭 Perspectives in MHN": "I want to study Perspectives in Mental Health Nursing. Ask me what specific topic I need help with — could be historical perspectives, models of mental health, stigma, recovery approach, or the biopsychosocial model.",
  "⚡ Dynamics in MHN": "I want to study Dynamics in Mental Health Nursing. Ask me what specific topic I need help with — could be therapeutic relationships, group dynamics, family dynamics, power and empowerment, or conflict management in mental health settings.",
  "🏘️ Community Mental Health": "I want to study Community Mental Health Nursing. Ask me what specific topic I need help with — could be community assessment, case management, psychosocial rehabilitation, outreach programs, or mental health legislation in Nigeria.",
  "💊 Psychotropic Medications": "Teach me about psychotropic medications used in mental health nursing — antipsychotics, antidepressants, mood stabilizers, anxiolytics. Cover drug class, action, side effects, and nursing considerations.",
  "🗣️ Therapeutic Communication": "Teach me therapeutic communication techniques used in mental health nursing — active listening, empathy, reflection, clarification, and how to handle challenging patient behaviors.",
  "📋 Mental Health Disorders": "Give me an overview of major mental health disorders — schizophrenia, bipolar disorder, depression, anxiety disorders, personality disorders. Cover signs, symptoms, and nursing management.",
};

// ─── Commands ─────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const user = await getUser(msg.from.id);
  await updateUser(msg.from.id, { firstName: msg.from.first_name });
  await clearHistory(msg.from.id);
  await trackMessage(msg.from.id, null);
  bot.sendMessage(msg.chat.id,
    `👋 Hi *${msg.from.first_name}*! I'm *Sage*, your personal Medical & Nursing Tutor 📚\n\n` +
    `🦴 Anatomy _(diagrams included)_\n🏥 Primary Health Care\n💉 Med-Surg Nursing\n📋 NCLEX Practice\n🧠 Mental Health Nursing\n💊 Pharmacology _(with drug calculations)_\n📊 Research & Statistics\n⚗️ Chemistry | 🔭 Physics\n🌐 Real-time Updates _(monthly premium)_\n+ Math, Science, English & Coding!\n\n` +
    `🌍 *Available in:* English, Pidgin, Igbo, Français, Español\n\n` +
    `🆓 *Free:* ${PLANS.free.messagesPerDay} messages/day\n⭐ *Weekly:* ₦500 | *Monthly:* ₦2,000 _(+ web search)_\n\nPick a subject to get started!`,
    { parse_mode: "Markdown", ...MAIN_KEYBOARD }
  );
});

// ─── Telegram Stars payment ───────────────────────────────
// Stars prices: 1 XTR ≈ ₦50 approx. Weekly=10 Stars, Monthly=40 Stars
const STARS_PRICES = {
  weekly: { stars: 10, label: "Weekly — 10 ⭐ Stars" },
  monthly: { stars: 40, label: "Monthly — 40 ⭐ Stars" },
};

async function sendStarsInvoice(chatId, userId, plan) {
  const p = STARS_PRICES[plan];
  await bot.sendInvoice(
    chatId,
    `Sage Premium — ${PLANS[plan].label}`,
    `Unlock unlimited messages, diagrams & real-time medical updates for ${plan === "weekly" ? "7 days" : "30 days"}.`,
    `stars_${userId}_${plan}_${Date.now()}`,
    "",  // empty provider_token = Telegram Stars
    "XTR",
    [{ label: PLANS[plan].label, amount: p.stars }]
  );
}

// Handle Stars pre-checkout
bot.on("pre_checkout_query", async (query) => {
  await bot.answerPreCheckoutQuery(query.id, true);
});

// Handle successful Stars payment
bot.on("message", async (msg) => {
  if (!msg.successful_payment) return;
  const payload = msg.successful_payment.invoice_payload;
  const parts = payload.split("_");
  const plan = parts[1]; // weekly or monthly
  const userId = msg.from.id;
  if (!PLANS[plan]) return;
  await activatePremium(userId, PLANS[plan].days, plan);
  await trackRevenue(PLANS[plan].price, plan, userId);
  const user = await getUser(userId);
  bot.sendMessage(userId,
    `🌟 *Telegram Stars Payment Confirmed!*\n\n` +
    `✅ Plan: *${PLANS[plan].label}*\n` +
    `📅 Expires: *${new Date(user.premiumExpiry).toLocaleDateString("en-NG", { day: "numeric", month: "long", year: "numeric" })}*\n\n` +
    `Unlimited access + diagrams + real-time updates! 📚🌐`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/premium|⭐ Go Premium/, async (msg) => {
  const userId = msg.from.id;
  if (await isPremium(userId)) {
    const user = await getUser(userId);
    const expiry = new Date(user.premiumExpiry).toLocaleDateString("en-NG", { day: "numeric", month: "long", year: "numeric" });
    return bot.sendMessage(msg.chat.id, `⭐ You already have *Premium*!\n\n📅 Expires: *${expiry}*`, { parse_mode: "Markdown" });
  }

  // Show plan selection with payment method choice
  bot.sendMessage(msg.chat.id,
    `⭐ *Sage Premium Plans*\n\n` +
    `1️⃣ *Weekly — ₦500/week* _(10 ⭐ Stars)_\n` +
    `✅ Unlimited messages\n` +
    `✅ All subjects & diagrams\n\n` +
    `2️⃣ *Monthly — ₦2,000/month* _(40 ⭐ Stars)_ — _best value!_\n` +
    `✅ Everything in Weekly\n` +
    `✅ 🌐 Real-time web search\n` +
    `✅ Latest drug approvals & guidelines\n\n` +
    `💳 *How would you like to pay?*\n\n` +
    `A — *Nigerian Bank* (Transfer, USSD, Opay, Palmpay, Cards)\n` +
    `B — *Telegram Stars* (pay inside Telegram)\n\n` +
    `Reply with plan + method:\n` +
    `\`1A\` Weekly/Bank | \`1B\` Weekly/Stars\n` +
    `\`2A\` Monthly/Bank | \`2B\` Monthly/Stars`,
    { parse_mode: "Markdown" }
  );

  bot.once("message", async (reply) => {
    if (reply.from.id !== userId) return;
    const input = reply.text.trim().toUpperCase();
    const planNum = input[0];
    const method = input[1];
    const plan = planNum === "1" ? "weekly" : planNum === "2" ? "monthly" : null;

    if (!plan || !["A", "B"].includes(method)) {
      return bot.sendMessage(msg.chat.id,
        `❌ Invalid choice. Try /premium again.\nFormat: \`1A\`, \`1B\`, \`2A\`, or \`2B\``,
        { parse_mode: "Markdown" }
      );
    }

    // Telegram Stars payment
    if (method === "B") {
      return sendStarsInvoice(msg.chat.id, userId, plan);
    }

    // Nigerian bank payment via Paystack
    bot.sendMessage(msg.chat.id,
      `📧 Please reply with your *email address* to generate a secure payment link.\nExample: \`myname@gmail.com\``,
      { parse_mode: "Markdown" }
    );

    bot.once("message", async (emailReply) => {
      if (emailReply.from.id !== userId) return;
      const email = emailReply.text.trim();
      if (!email.includes("@")) {
        return bot.sendMessage(msg.chat.id, "❌ Invalid email. Try /premium again.");
      }
      const link = await createPaystackLink(userId, plan, email);
      if (!link) return bot.sendMessage(msg.chat.id, "⚠️ Could not generate payment link. Try again.");
      bot.sendMessage(msg.chat.id,
        `💳 *Complete your payment:*\n\nPlan: *${PLANS[plan].label}*\n\n👉 [Tap here to pay securely](${link})\n\n_Supports: Bank Transfer, USSD, Cards, Opay, Palmpay_\n\n✅ Activated *instantly* after payment!`,
        { parse_mode: "Markdown" }
      );
    });
  });
});

bot.onText(/\/status|📊 My Status/, async (msg) => {
  const userId = msg.from.id;
  const premium = await isPremium(userId);
  const left = await messagesLeft(userId);
  const user = await getUser(userId);
  const expiry = premium ? new Date(user.premiumExpiry).toLocaleDateString("en-NG", { day: "numeric", month: "long", year: "numeric" }) : null;
  bot.sendMessage(msg.chat.id,
    `📊 *Your Account Status*\n\nPlan: *${premium ? "⭐ Premium" : "🆓 Free"}*\n` +
    (premium ? `Expires: *${expiry}*\nMessages: *Unlimited*\n` : `Messages left today: *${left}/${PLANS.free.messagesPerDay}*\n`) +
    `Diagrams: ✅ | Web Search: ✅\n\n` +
    `${premium ? "Full access to everything! 🎉" : "Upgrade → /premium"}`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/admin/, async (msg) => {
  if (!ADMIN_IDS.includes(msg.from.id)) return bot.sendMessage(msg.chat.id, "⛔ Unauthorized.");
  const stats = await getAnalytics();
  const topTopics = stats.topTopics.map(t => `${t.name}: ${t.count}`).join("\n") || "No data yet";
  bot.sendMessage(msg.chat.id,
    `🔐 *Sage Admin Stats*\n\n👥 Total Users: *${stats.totalUsers}*\n📅 Active Today: *${stats.activeToday}*\n` +
    `⭐ Premium: *${stats.premiumUsers}* (${stats.conversionRate}%)\n💰 Revenue: *₦${stats.totalRevenue.toLocaleString()}*\n` +
    `💬 Messages: *${stats.totalMessages.toLocaleString()}*\n\n🔥 *Top Topics:*\n${topTopics}\n\n` +
    `🌐 Dashboard: ${BOT_URL}/admin?password=${ADMIN_PASSWORD}`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  if (!ADMIN_IDS.includes(msg.from.id)) return bot.sendMessage(msg.chat.id, "⛔ Unauthorized.");
  const allUsers = await db.collection("users").find({}, { projection: { userId: 1 } }).toArray();
  let sent = 0;
  for (const u of allUsers) {
    try { await bot.sendMessage(u.userId, `📢 *Message from Sage:*\n\n${match[1]}`, { parse_mode: "Markdown" }); sent++; } catch (e) {}
  }
  bot.sendMessage(msg.chat.id, `✅ Broadcast sent to *${sent}* users.`, { parse_mode: "Markdown" });
});

bot.onText(/\/reset|🔄 Reset/, async (msg) => {
  await clearHistory(msg.from.id);
  bot.sendMessage(msg.chat.id, "🔄 Session reset! What would you like to study today?", MAIN_KEYBOARD);
});

bot.onText(/\/help|❓ Help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `📚 *Sage — Medical & Nursing Tutor*\n\n🦴 Anatomy _(diagrams included)_\n🏥 PHC | 💉 Med-Surg | 📋 NCLEX\n🌐 Live Updates | 📐 Math | 📖 English\n\n` +
    `/start /premium /status /redeem /reset /help\n\n` +
    `🌍 *Languages:* English, Pidgin, Igbo, Français, Español\n` +
    `🆓 *Free:* ${PLANS.free.messagesPerDay} msgs/day\n` +
    `⭐ *Weekly ₦500:* Unlimited messages\n` +
    `⭐ *Monthly ₦2,000:* Unlimited + 🌐 Web Search`,
    { parse_mode: "Markdown", ...MAIN_KEYBOARD }
  );
});

// ─── Main Message Handler ─────────────────────────────────
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  if (["🔄 Reset", "❓ Help", "⭐ Go Premium", "📊 My Status", "⭐ Rate Sage", "📝 Feedback", "🆘 Support", "🎟️ Redeem Code"].includes(msg.text)) return;

  const userId = msg.from.id;
  const chatId = msg.chat.id;
  let content = msg.text.trim();

  if (content === "🔙 Back to Main Menu") return bot.sendMessage(chatId, "Main menu — pick a subject:", MAIN_KEYBOARD);
  if (content === "📋 NCLEX Practice") return bot.sendMessage(chatId, `📋 *NCLEX Practice* — Choose a topic:`, { parse_mode: "Markdown", ...NCLEX_KEYBOARD });
  if (content === "🧠 Mental Health Nursing") return bot.sendMessage(chatId, `🧠 *Mental Health Nursing* — Choose a topic:`, { parse_mode: "Markdown", ...MENTAL_HEALTH_KEYBOARD });
  if (content === "💊 Pharmacology") return bot.sendMessage(chatId, `💊 *Pharmacology* — Choose a topic:`, { parse_mode: "Markdown", ...PHARMACOLOGY_KEYBOARD });

  // Redeem Code button
  if (content === "🎟️ Redeem Code") {
    return bot.emit("text", { ...msg, text: "/redeem" });
  }

  // Language selection
  if (content === "🌍 Language") {
    const user = await getUser(userId);
    const current = LANGUAGES[user.language || "en"]?.name || "English";
    return bot.sendMessage(chatId,
      `🌍 *Language Settings*\n\nCurrent language: *${current}*\n\nChoose your preferred language:`,
      { parse_mode: "Markdown", ...LANGUAGE_KEYBOARD }
    );
  }

  const langMap = {
    "🇬🇧 English": "en",
    "🇳🇬 Pidgin English": "pidgin",
    "🇳🇬 Igbo": "ig",
    "🇫🇷 Français": "fr",
    "🇪🇸 Español": "es",
  };
  if (langMap[content]) {
    const newLang = langMap[content];
    await updateUser(userId, { language: newLang });
    const confirmMessages = {
      en: "✅ Language set to *English*! Let's continue learning 📚",
      pidgin: "✅ Language don change to *Pidgin English*! Make we continue learn 📚",
      ig: "✅ Asụsụ agbanwee na *Igbo*! Ka anyị gaa n'ihu na mmụta 📚",
      fr: "✅ Langue définie sur *Français*! Continuons à apprendre 📚",
      es: "✅ Idioma configurado en *Español*! Continuemos aprendiendo 📚",
    };
    return bot.sendMessage(chatId, confirmMessages[newLang], { parse_mode: "Markdown", ...MAIN_KEYBOARD });
  }

  if (!await canSendMessage(userId)) {
    return bot.sendMessage(chatId,
      `⛔ *Daily limit reached!*\n\nYou've used all *${PLANS.free.messagesPerDay} free messages* today.\n\n🔓 Upgrade → /premium\n\n_Or wait until tomorrow._`,
      { parse_mode: "Markdown" }
    );
  }

  const imageUrl = detectImageRequest(content);
  const topicLabel = subjectMap[content] ? content.replace(/[^\w\s]/gi, "").trim() : "Custom Question";
  await trackMessage(userId, topicLabel);
  if (subjectMap[content]) content = subjectMap[content];

  bot.sendChatAction(chatId, "typing");
  await incrementMessageCount(userId);

  // Auto-prompt rating every 10 messages
  if (await shouldAskRating(userId)) {
    await updateUser(userId, { lastRatingPrompt: (await getUser(userId)).messageCount });
    setTimeout(async () => {
      await bot.sendMessage(chatId,
        `⭐ *Quick check-in!*\n\nYou've been studying hard! How is Sage helping you so far?\n\nTap *⭐ Rate Sage* to leave a quick rating — it helps us improve! 😊`,
        { parse_mode: "Markdown" }
      );
    }, 3000);
  }

  try {
    if (imageUrl) {
      await bot.sendPhoto(chatId, imageUrl, { caption: `🖼️ _Diagram for reference — explanation below_ 👇`, parse_mode: "Markdown" }).catch(() => {});
    }

    const { reply, usedWebSearch } = await askSage(userId, content);
    const left = await messagesLeft(userId);
    const footer = !await isPremium(userId) && typeof left === "number" && left <= 2
      ? `\n\n_⚠️ ${left} free message${left !== 1 ? "s" : ""} left today. /premium for unlimited._` : "";
    const searchBadge = usedWebSearch ? `\n\n🌐 _Updated with latest web information_ _(Monthly Premium)_` : "";
    const fullReply = reply + searchBadge + footer;

    const isNclexTopic = ["🫀 Cardiovascular","🫁 Respiratory","🧠 Neurological","🦷 Musculoskeletal","💊 Pharmacology","🧪 Lab Values","⚡ Priority Questions","🔬 Infection Control"].includes(msg.text);
    const isMentalHealthTopic = ["🔭 Perspectives in MHN","⚡ Dynamics in MHN","🏘️ Community Mental Health","💊 Psychotropic Medications","🗣️ Therapeutic Communication","📋 Mental Health Disorders"].includes(msg.text);
    const isPharmaTopic = ["💉 Drug Classifications","⚗️ Mechanism of Action","⚠️ Side Effects & ADRs","🩺 Nursing Considerations","🧮 Drug Calculations","📦 Pharmacokinetics","💊 Cardiovascular Drugs","🫁 Respiratory Drugs","🧠 CNS Drugs","🦠 Antibiotics & Antimicrobials","🩸 Anticoagulants","💉 IV Medications"].includes(msg.text);
    const keyboard = isNclexTopic ? NCLEX_KEYBOARD : isMentalHealthTopic ? MENTAL_HEALTH_KEYBOARD : isPharmaTopic ? PHARMACOLOGY_KEYBOARD : MAIN_KEYBOARD;

    if (fullReply.length <= 4000) {
      await bot.sendMessage(chatId, fullReply, { parse_mode: "Markdown", ...keyboard });
    } else {
      const chunks = reply.match(/.{1,4000}/gs) || [];
      for (const chunk of chunks) await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
    }
  } catch (err) {
    console.error("Error:", err);
    bot.sendMessage(chatId, "⚠️ Something went wrong. Please try again.", MAIN_KEYBOARD);
  }
});

// ─── Auto Cleanup ─────────────────────────────────────────
async function runCleanup() {
  try {
    const now = new Date();

    // 1. Delete analytics older than 90 days
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const analyticsResult = await db.collection("analytics").deleteMany({
      date: { $lt: ninetyDaysAgo.toDateString() }
    });

    // 2. Clear chat history of users inactive for 30+ days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const inactiveResult = await db.collection("users").updateMany(
      {
        "history.0": { $exists: true },
        lastReset: { $lt: thirtyDaysAgo.toDateString() }
      },
      { $set: { history: [] } }
    );

    // 3. Delete resolved support tickets older than 90 days
    const ninetyDaysAgoISO = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const feedbackResult = await db.collection("feedback").deleteMany({
      resolved: true,
      date: { $lt: ninetyDaysAgoISO }
    });

    // 4. Delete transactions older than 1 year
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const txResult = await db.collection("transactions").deleteMany({
      date: { $lt: oneYearAgo.toISOString() }
    });

    // 4. Remove expired premium flags
    const expiredResult = await db.collection("users").updateMany(
      {
        premium: true,
        premiumExpiry: { $lt: now.toISOString() }
      },
      { $set: { premium: false, premiumExpiry: null } }
    );

    console.log(`🧹 Cleanup done:
    - Analytics deleted: ${analyticsResult.deletedCount} old records
    - Inactive histories cleared: ${inactiveResult.modifiedCount} users
    - Old transactions deleted: ${txResult.deletedCount} records
    - Expired premiums fixed: ${expiredResult.modifiedCount} users`);

    // Notify admin on Telegram
    for (const adminId of ADMIN_IDS) {
      bot.sendMessage(adminId,
        `🧹 *Auto Cleanup Complete*\n\n` +
        `📊 Analytics deleted: *${analyticsResult.deletedCount}* old records\n` +
        `💬 Histories cleared: *${inactiveResult.modifiedCount}* inactive users\n` +
        `💳 Old transactions removed: *${txResult.deletedCount}*\n` +
        `⭐ Expired premiums fixed: *${expiredResult.modifiedCount}*\n` +
        `📝 Old feedback removed: *${feedbackResult.deletedCount}*\n\n` +
        `_Next cleanup in 7 days_ 🗓️`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
    }
  } catch (err) {
    console.error("❌ Cleanup error:", err.message);
  }
}

// Run cleanup every 7 days automatically
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
setInterval(runCleanup, SEVEN_DAYS);

// Also run cleanup once on startup (after 1 min delay)
setTimeout(runCleanup, 60 * 1000);

// ─── ⭐ Rate Sage ─────────────────────────────────────────
bot.onText(/\/rate|⭐ Rate Sage/, async (msg) => {
  await bot.sendMessage(msg.chat.id,
    `⭐ *Rate Your Experience with Sage*\n\nHow would you rate Sage as your tutor?\n\n` +
    `5⭐ — Excellent, love it!\n` +
    `4⭐ — Very good\n` +
    `3⭐ — Good, needs improvement\n` +
    `2⭐ — Fair\n` +
    `1⭐ — Poor\n\n` +
    `Reply with a number from *1 to 5*:`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        keyboard: [["⭐ 5", "⭐⭐ 4", "⭐⭐⭐ 3"], ["⭐⭐⭐⭐ 2", "⭐⭐⭐⭐⭐ 1"]],
        resize_keyboard: true,
        one_time_keyboard: true,
      }
    }
  );

  bot.once("message", async (reply) => {
    if (reply.from.id !== msg.from.id) return;
    const text = reply.text?.trim() || "";
    const ratingMatch = text.match(/[1-5]/);
    if (!ratingMatch) return bot.sendMessage(msg.chat.id, "❌ Please reply with a number between 1 and 5.", { ...{ reply_markup: { remove_keyboard: true } } });

    const rating = parseInt(ratingMatch[0]);
    const stars = "⭐".repeat(rating);

    // Ask for optional comment
    await bot.sendMessage(msg.chat.id,
      `${stars} Thanks for rating *${rating}/5*!\n\nWould you like to leave a comment? _(optional)_\n\nType your comment or tap *Skip*:`,
      {
        parse_mode: "Markdown",
        reply_markup: { keyboard: [["Skip"]], resize_keyboard: true, one_time_keyboard: true }
      }
    );

    bot.once("message", async (commentReply) => {
      if (commentReply.from.id !== msg.from.id) return;
      const comment = commentReply.text === "Skip" ? null : commentReply.text;

      await saveFeedback(msg.from.id, msg.from.first_name, "rating", comment || "No comment", rating);
      await updateUser(msg.from.id, { lastRatingPrompt: (await getUser(msg.from.id)).messageCount });

      const responses = {
        5: `🎉 Wow! Thank you so much *${msg.from.first_name}*! Your support means everything. Keep studying hard! 📚`,
        4: `😊 Thank you *${msg.from.first_name}*! Glad you're enjoying Sage. We'll keep improving!`,
        3: `🙏 Thank you *${msg.from.first_name}*! Your feedback helps us get better. We'll work on it!`,
        2: `😔 Sorry to hear that *${msg.from.first_name}*. We'll work hard to improve your experience!`,
        1: `😢 We're really sorry *${msg.from.first_name}*. Please use 🆘 Support to tell us what went wrong — we want to fix it!`,
      };

      await bot.sendMessage(msg.chat.id, responses[rating], { parse_mode: "Markdown", ...{reply_markup: {remove_keyboard: true}} });

      // Notify admins of low ratings
      if (rating <= 2) {
        for (const adminId of ADMIN_IDS) {
          bot.sendMessage(adminId,
            `⚠️ *Low Rating Alert!*\n\n` +
            `User: *${msg.from.first_name}* (ID: ${msg.from.id})\n` +
            `Rating: *${rating}/5* ${stars}\n` +
            `Comment: _${comment || "No comment"}_\n\n` +
            `Consider reaching out to this user.`,
            { parse_mode: "Markdown" }
          ).catch(() => {});
        }
      }

      // Notify admins of all ratings
      for (const adminId of ADMIN_IDS) {
        bot.sendMessage(adminId,
          `⭐ *New Rating Received*\n\nUser: *${msg.from.first_name}*\nRating: *${rating}/5* ${stars}\n${comment ? `Comment: _${comment}_` : ""}`,
          { parse_mode: "Markdown" }
        ).catch(() => {});
      }

      // Restore main keyboard
      setTimeout(() => bot.sendMessage(msg.chat.id, "Back to studying! 📚", { reply_markup: { remove_keyboard: true }, ...MAIN_KEYBOARD }), 1000);
    });
  });
});

// ─── 📝 Feedback ──────────────────────────────────────────
bot.onText(/\/feedback|📝 Feedback/, async (msg) => {
  await bot.sendMessage(msg.chat.id,
    `📝 *Send Feedback to Sage Team*\n\n` +
    `Your feedback helps us improve! Please tell us:\n\n` +
    `💡 What subjects do you want added?\n` +
    `🔧 What features would you like?\n` +
    `📚 What topics need better explanations?\n` +
    `✨ Any other suggestions?\n\n` +
    `Type your feedback below:`,
    { parse_mode: "Markdown", reply_markup: { keyboard: [["Cancel"]], resize_keyboard: true, one_time_keyboard: true } }
  );

  bot.once("message", async (reply) => {
    if (reply.from.id !== msg.from.id) return;
    if (reply.text === "Cancel") return bot.sendMessage(msg.chat.id, "Cancelled. Back to studying! 📚", MAIN_KEYBOARD);

    await saveFeedback(msg.from.id, msg.from.first_name, "feedback", reply.text);

    await bot.sendMessage(msg.chat.id,
      `✅ *Feedback received! Thank you ${msg.from.first_name}!* 🙏\n\n_Your feedback has been sent to the Sage team. We read every single message and use it to make Sage better for you!_`,
      { parse_mode: "Markdown", ...MAIN_KEYBOARD }
    );

    // Forward feedback to all admins instantly
    for (const adminId of ADMIN_IDS) {
      bot.sendMessage(adminId,
        `📝 *New Feedback Received!*\n\n` +
        `From: *${msg.from.first_name}* (ID: ${msg.from.id})\n` +
        `Plan: *${await isPremium(msg.from.id) ? "⭐ Premium" : "🆓 Free"}*\n\n` +
        `💬 _${reply.text}_\n\n` +
        `Reply to this user: /reply_${msg.from.id}`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
    }
  });
});

// ─── 🆘 Support ───────────────────────────────────────────
bot.onText(/\/support|🆘 Support/, async (msg) => {
  await bot.sendMessage(msg.chat.id,
    `🆘 *Contact Support*\n\n` +
    `Need help? We're here for you! Please describe your issue:\n\n` +
    `💳 Payment issues\n` +
    `🤖 Bot not responding\n` +
    `⭐ Premium not activated\n` +
    `📚 Subject not covered\n` +
    `🐛 Any other problem\n\n` +
    `Type your message below and our team will get back to you shortly:`,
    { parse_mode: "Markdown", reply_markup: { keyboard: [["Cancel"]], resize_keyboard: true, one_time_keyboard: true } }
  );

  bot.once("message", async (reply) => {
    if (reply.from.id !== msg.from.id) return;
    if (reply.text === "Cancel") return bot.sendMessage(msg.chat.id, "Cancelled. Back to studying! 📚", MAIN_KEYBOARD);

    await saveFeedback(msg.from.id, msg.from.first_name, "support", reply.text);

    await bot.sendMessage(msg.chat.id,
      `✅ *Support request received!*\n\n` +
      `Hi *${msg.from.first_name}*, your message has been sent to our support team.\n\n` +
      `⏰ We typically respond within *a few hours*.\n\n` +
      `_Thank you for your patience!_ 🙏`,
      { parse_mode: "Markdown", ...MAIN_KEYBOARD }
    );

    // Alert all admins instantly with priority
    for (const adminId of ADMIN_IDS) {
      bot.sendMessage(adminId,
        `🚨 *NEW SUPPORT REQUEST!*\n\n` +
        `From: *${msg.from.first_name}* (ID: ${msg.from.id})\n` +
        `Plan: *${await isPremium(msg.from.id) ? "⭐ Premium" : "🆓 Free"}*\n` +
        `Time: *${new Date().toLocaleString("en-NG")}*\n\n` +
        `🗣️ _${reply.text}_\n\n` +
        `To reply, use:\n/reply_${msg.from.id} <your message>`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
    }
  });
});

// ─── Admin reply to user ──────────────────────────────────
bot.onText(/\/reply_(\d+) (.+)/, async (msg, match) => {
  if (!ADMIN_IDS.includes(msg.from.id)) return bot.sendMessage(msg.chat.id, "⛔ Unauthorized.");
  const targetUserId = Number(match[1]);
  const replyText = match[2];
  try {
    await bot.sendMessage(targetUserId,
      `📩 *Message from Sage Support Team:*\n\n${replyText}\n\n_If you need more help, tap 🆘 Support anytime._`,
      { parse_mode: "Markdown" }
    );
    bot.sendMessage(msg.chat.id, `✅ Reply sent to user ${targetUserId}`, { parse_mode: "Markdown" });
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ Could not send message to user ${targetUserId}. They may have blocked the bot.`);
  }
});

// ─── /redeem — Promo Code ────────────────────────────────
bot.onText(/\/redeem/, async (msg) => {
  const userId = msg.from.id;

  if (await isPremium(userId)) {
    const user = await getUser(userId);
    const expiry = new Date(user.premiumExpiry).toLocaleDateString("en-NG", { day: "numeric", month: "long", year: "numeric" });
    return bot.sendMessage(msg.chat.id,
      `⭐ You already have *Premium* access!\n\n📅 Expires: *${expiry}*`,
      { parse_mode: "Markdown" }
    );
  }

  await bot.sendMessage(msg.chat.id,
    `🎟️ *Redeem a Promo Code*\n\nDo you have a promo code? Type it below:\n\n_Example:_ \`SAGE2WEEKS\``,
    { parse_mode: "Markdown", reply_markup: { keyboard: [["Cancel"]], resize_keyboard: true, one_time_keyboard: true } }
  );

  bot.once("message", async (reply) => {
    if (reply.from.id !== userId) return;
    if (reply.text === "Cancel") return bot.sendMessage(msg.chat.id, "Cancelled! 👍", MAIN_KEYBOARD);

    const code = reply.text.trim().toUpperCase();
    const result = await usePromoCode(userId, code);

    if (!result.success) {
      const reasons = {
        invalid: "❌ *Invalid promo code!*\n\nPlease check the code and try again.",
        already_used: "⚠️ *You have already used this promo code!*\n\nEach code can only be used once per user.",
        expired: "😔 *This promo code has reached its maximum uses.*\n\nAll free slots have been taken. Upgrade via /premium",
      };
      return bot.sendMessage(msg.chat.id, reasons[result.reason] || "❌ Invalid code.", { parse_mode: "Markdown", ...MAIN_KEYBOARD });
    }

    const user = await getUser(userId);
    const expiry = new Date(user.premiumExpiry).toLocaleDateString("en-NG", { day: "numeric", month: "long", year: "numeric" });

    await bot.sendMessage(msg.chat.id,
      `🎉 *Promo Code Accepted!*\n\n` +
      `✅ *${result.promo.label}* activated!\n` +
      `📅 Expires: *${expiry}*\n` +
      `🎟️ Slots remaining: *${result.usesLeft}/${result.promo.maxUses}*\n\n` +
      `You now have *full Premium access* — unlimited messages, diagrams & all subjects!\n\n` +
      `Study hard and enjoy! 📚🎓`,
      { parse_mode: "Markdown", ...MAIN_KEYBOARD }
    );

    // Notify admin
    for (const adminId of ADMIN_IDS) {
      bot.sendMessage(adminId,
        `🎟️ *Promo Code Used!*\n\n` +
        `User: *${msg.from.first_name}* (ID: ${userId})\n` +
        `Code: *${code}*\n` +
        `Plan: *${result.promo.label}*\n` +
        `Slots Left: *${result.usesLeft}/${result.promo.maxUses}*`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
    }
  });
});

// ─── /grantpremium — Admin manually gives premium ─────────
bot.onText(/\/grantpremium (\d+)/, async (msg, match) => {
  if (!ADMIN_IDS.includes(msg.from.id)) return bot.sendMessage(msg.chat.id, "⛔ Unauthorized.");
  const targetId = Number(match[1]);

  await activatePremium(targetId, 14, "promo");
  const user = await getUser(targetId);
  const expiry = new Date(user.premiumExpiry).toLocaleDateString("en-NG", { day: "numeric", month: "long", year: "numeric" });

  // Notify the user
  bot.sendMessage(targetId,
    `🎁 *Congratulations ${user.firstName || ""}!*\n\n` +
    `You have been granted *2 Weeks Free Premium* by the Sage team! 🎉\n\n` +
    `📅 Expires: *${expiry}*\n\n` +
    `Enjoy unlimited messages, diagrams, all subjects and more!\n` +
    `Happy studying! 📚`,
    { parse_mode: "Markdown", ...MAIN_KEYBOARD }
  ).catch(() => {});

  // Confirm to admin
  bot.sendMessage(msg.chat.id,
    `✅ *2 weeks premium granted to user ${targetId}*\n📅 Expires: *${expiry}*`,
    { parse_mode: "Markdown" }
  );
});

// ─── /revokepremium — Admin removes premium ───────────────
bot.onText(/\/revokepremium (\d+)/, async (msg, match) => {
  if (!ADMIN_IDS.includes(msg.from.id)) return bot.sendMessage(msg.chat.id, "⛔ Unauthorized.");
  const targetId = Number(match[1]);
  await updateUser(targetId, { premium: false, premiumExpiry: null, premiumPlan: null });
  bot.sendMessage(msg.chat.id, `✅ Premium removed from user ${targetId}.`);
  bot.sendMessage(targetId,
    `ℹ️ Your premium access has been updated. Tap /premium to subscribe.`,
    { parse_mode: "Markdown" }
  ).catch(() => {});
});

// ─── /promostats — Admin checks promo code usage ──────────
bot.onText(/\/promostats/, async (msg) => {
  if (!ADMIN_IDS.includes(msg.from.id)) return bot.sendMessage(msg.chat.id, "⛔ Unauthorized.");
  let statsMsg = `🎟️ *Promo Code Stats*\n\n`;
  for (const [code, promo] of Object.entries(PROMO_CODES)) {
    const uses = await db.collection("promo_uses").countDocuments({ code });
    const remaining = promo.maxUses - uses;
    const bar = "▓".repeat(Math.round(uses/promo.maxUses*10)) + "░".repeat(10 - Math.round(uses/promo.maxUses*10));
    statsMsg += `*${code}*\n${bar} ${uses}/${promo.maxUses} used | *${remaining} slots left*\n\n`;
  }
  bot.sendMessage(msg.chat.id, statsMsg, { parse_mode: "Markdown" });
});

// Manual cleanup command for admin
bot.onText(/\/cleanup/, async (msg) => {
  if (!ADMIN_IDS.includes(msg.from.id)) return bot.sendMessage(msg.chat.id, "⛔ Unauthorized.");
  bot.sendMessage(msg.chat.id, "🧹 Running cleanup...");
  await runCleanup();
});

// ─── Start ────────────────────────────────────────────────
connectDB().then(() => {
  console.log("✅ Sage Bot is fully running with MongoDB!");
  app.listen(3000, () => console.log("✅ Server running on port 3000"));
}).catch(err => {
  console.error("❌ Failed to start:", err);
  process.exit(1);
});
