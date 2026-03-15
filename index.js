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
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
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

// ─── ANATOMY & PHYSIOLOGY ─────────────────────────────────
"🦴 Anatomy": `You are a highly detailed Anatomy & Physiology tutor. Greet the student and present this full curriculum, then ask which topic they want to start with:

📚 ANATOMY & PHYSIOLOGY CURRICULUM:

1️⃣ INTRODUCTION TO THE HUMAN BODY
   • Levels of structural organization (chemical → cellular → tissue → organ → system → organism)
   • Homeostasis — definition, negative and positive feedback mechanisms, examples
   • Anatomical terminology — directional terms, body planes, body cavities
   • Body systems overview and their interrelationships

2️⃣ CELL BIOLOGY
   • Cell structure — nucleus, mitochondria, ribosomes, ER, Golgi apparatus, lysosomes
   • Cell membrane — phospholipid bilayer, fluid mosaic model, membrane proteins
   • Cell transport — diffusion, osmosis, active transport, endocytosis, exocytosis
   • Cell division — mitosis (PMAT), meiosis, cell cycle, cancer basics
   • DNA, RNA, protein synthesis — transcription and translation

3️⃣ TISSUES
   • Epithelial tissue — types, classification, functions, locations
   • Connective tissue — loose, dense, cartilage, bone, blood
   • Muscle tissue — skeletal, cardiac, smooth — structure and function
   • Nervous tissue — neurons (structure, types), neuroglia
   • Tissue repair and regeneration

4️⃣ INTEGUMENTARY SYSTEM (SKIN)
   • Layers — epidermis (5 layers), dermis, hypodermis
   • Skin functions — protection, thermoregulation, sensation, vitamin D synthesis
   • Accessory structures — hair, nails, sweat glands, sebaceous glands
   • Skin conditions — burns (rule of nines, degrees), pressure ulcers, wound healing

5️⃣ SKELETAL SYSTEM
   • Bone tissue — compact vs spongy, osteoblasts, osteoclasts, osteocytes
   • Bone formation and remodeling — ossification, calcium regulation
   • Axial skeleton — skull, vertebral column (cervical/thoracic/lumbar/sacral/coccyx), thoracic cage
   • Appendicular skeleton — pectoral girdle, upper limbs, pelvic girdle, lower limbs
   • Joints — fibrous, cartilaginous, synovial — types and movements
   • Common bone disorders — osteoporosis, fractures (types), osteoarthritis

6️⃣ MUSCULAR SYSTEM
   • Muscle fiber microstructure — sarcomere, actin, myosin, Z-lines, titin
   • Sliding filament theory of contraction — step-by-step mechanism
   • Neuromuscular junction — acetylcholine, motor end plate
   • Muscle fiber types — Type I (slow twitch), Type II (fast twitch)
   • Energy systems — ATP-PCr, glycolytic, oxidative
   • Major muscle groups — origin, insertion, action of key muscles
   • Muscle disorders — myasthenia gravis, muscular dystrophy, rhabdomyolysis

7️⃣ NERVOUS SYSTEM
   • Central nervous system (CNS) — brain regions (cerebrum, cerebellum, brainstem, diencephalon), spinal cord
   • Peripheral nervous system (PNS) — somatic vs autonomic, sympathetic vs parasympathetic
   • Neuron physiology — resting membrane potential, action potential, synaptic transmission
   • Neurotransmitters — acetylcholine, dopamine, serotonin, GABA, glutamate — roles and clinical significance
   • Cranial nerves — all 12 with functions (mnemonic: On Old Olympus...)
   • Spinal cord tracts — ascending (sensory) and descending (motor)
   • Reflexes — spinal reflex arc, stretch reflex, withdrawal reflex
   • Neurological disorders — stroke, Parkinson's, Alzheimer's, meningitis, epilepsy

8️⃣ SPECIAL SENSES
   • Eye — anatomy, visual pathway, accommodation, refraction errors
   • Ear — anatomy, hearing mechanism (sound waves → cochlea → auditory nerve), vestibular system (balance)
   • Nose — olfactory epithelium, smell pathway
   • Tongue — taste buds, taste pathways
   • Clinical disorders — glaucoma, cataracts, otitis media, hearing loss

9️⃣ ENDOCRINE SYSTEM
   • Hormone types — peptide, steroid, amine — mechanisms of action
   • Hypothalamus-pituitary axis — releasing hormones, feedback loops
   • Pituitary gland — anterior (GH, TSH, ACTH, FSH, LH, prolactin) vs posterior (ADH, oxytocin)
   • Thyroid gland — T3, T4, calcitonin — disorders: hypothyroidism, hyperthyroidism, Graves' disease
   • Parathyroid — PTH and calcium regulation
   • Adrenal glands — cortex (cortisol, aldosterone, androgens) vs medulla (epinephrine, norepinephrine)
   • Pancreas — insulin, glucagon — diabetes mellitus type 1 and 2
   • Reproductive hormones — estrogen, progesterone, testosterone

🔟 CARDIOVASCULAR SYSTEM
   • Heart anatomy — chambers, valves, layers (endocardium, myocardium, pericardium)
   • Cardiac conduction system — SA node, AV node, Bundle of His, Purkinje fibers
   • Cardiac cycle — systole, diastole, heart sounds (S1, S2)
   • Blood pressure — determinants, regulation (nervous, hormonal, renal)
   • ECG basics — P wave, QRS complex, T wave interpretation
   • Blood vessels — arteries, veins, capillaries — structure and function
   • Capillary exchange — Starling forces, filtration and reabsorption
   • Cardiovascular disorders — hypertension, MI, heart failure, arrhythmias, atherosclerosis

1️⃣1️⃣ RESPIRATORY SYSTEM
   • Upper airway anatomy — nasal cavity, pharynx, larynx
   • Lower airway — trachea, bronchi, bronchioles, alveoli
   • Lung anatomy — lobes, pleura, hilum
   • Mechanics of breathing — inspiration vs expiration, respiratory muscles (diaphragm, intercostals)
   • Lung volumes and capacities — TV, IRV, ERV, RV, TLC, FRC, VC
   • Gas exchange — partial pressures, diffusion across alveolar membrane
   • Oxygen and CO2 transport — hemoglobin dissociation curve, Bohr effect
   • Control of breathing — medullary rhythmicity center, chemoreceptors
   • Disorders — asthma, COPD, pneumonia, pulmonary embolism, pneumothorax

1️⃣2️⃣ DIGESTIVE SYSTEM
   • GI tract layers — mucosa, submucosa, muscularis, serosa
   • Mouth — chewing, saliva, amylase
   • Esophagus — peristalsis, lower esophageal sphincter
   • Stomach — regions, gastric glands, HCl secretion, pepsin, gastric emptying
   • Small intestine — duodenum, jejunum, ileum; villi and microvilli, absorption of nutrients
   • Large intestine — water absorption, feces formation, defecation reflex
   • Liver — bile production, detoxification, glycogen storage, protein synthesis
   • Gallbladder — bile storage and release, role of CCK
   • Pancreas (exocrine) — digestive enzymes: amylase, lipase, proteases
   • Disorders — GERD, peptic ulcers, Crohn's, ulcerative colitis, hepatitis, cirrhosis

1️⃣3️⃣ URINARY SYSTEM
   • Kidney anatomy — cortex, medulla, nephron structure (glomerulus, tubules, loop of Henle, collecting duct)
   • Urine formation — filtration, reabsorption, secretion
   • Regulation of water balance — ADH, aldosterone, ANP
   • Acid-base regulation by kidneys
   • Ureters, urinary bladder, urethra
   • Renal disorders — UTI, kidney stones, acute kidney injury, chronic kidney disease, nephrotic syndrome

1️⃣4️⃣ REPRODUCTIVE SYSTEM
   • Male — testes, epididymis, vas deferens, seminal vesicles, prostate, penis — functions
   • Spermatogenesis — step-by-step process
   • Female — ovaries, fallopian tubes, uterus, vagina, vulva — functions
   • Oogenesis and menstrual cycle — follicular phase, ovulation, luteal phase, menstruation
   • Fertilization and implantation
   • Pregnancy and parturition — placenta, hormones of pregnancy, stages of labour
   • Disorders — PCOS, endometriosis, erectile dysfunction, infertility

1️⃣5️⃣ IMMUNE & LYMPHATIC SYSTEM
   • Innate immunity — physical barriers, phagocytes, NK cells, inflammation, fever
   • Adaptive immunity — T lymphocytes (helper, cytotoxic, regulatory), B lymphocytes, antibodies
   • Antibody structure and classes — IgG, IgM, IgA, IgE, IgD
   • Complement system — classical, alternative, lectin pathways
   • Lymphatic system — lymph nodes, spleen, thymus, tonsils
   • Hypersensitivity reactions — Type I (anaphylaxis), II, III, IV
   • Autoimmune disorders — SLE, rheumatoid arthritis, multiple sclerosis
   • Immunodeficiency — HIV/AIDS mechanism and progression

After the student picks a topic, teach it in full detail with: definitions, diagrams described in text, clinical relevance, mnemonics, and practice questions.`,

// ─── PRIMARY HEALTH CARE ──────────────────────────────────
"🏥 Primary Health Care": `You are a detailed Primary Health Care (PHC) tutor. Present this curriculum and ask which topic to start:

📚 PRIMARY HEALTH CARE CURRICULUM:

1️⃣ FOUNDATIONS OF PHC
   • Definition and philosophy of PHC — Alma-Ata Declaration 1978, key principles
   • Components of PHC — 8 essential elements (SAFE MAID mnemonic)
   • Levels of health care — primary, secondary, tertiary — differences and referral system
   • Health promotion vs disease prevention vs rehabilitation
   • Social determinants of health — education, income, environment, housing

2️⃣ MATERNAL AND CHILD HEALTH (MCH)
   • Antenatal care — schedule, investigations, danger signs in pregnancy
   • Normal labour — stages, monitoring (partograph), nursing care
   • Postnatal care — mother and newborn assessment, breastfeeding support
   • Family planning methods — natural, barrier, hormonal, IUDs, sterilization
   • Immunization schedule (Nigerian EPI) — BCG, OPV, DPT, Hepatitis B, measles, yellow fever
   • Child growth monitoring — weight-for-age, height-for-age, MUAC assessment
   • Management of childhood illnesses — IMCI approach
   • Malnutrition — kwashiorkor vs marasmus, treatment protocols

3️⃣ COMMUNICABLE DISEASE CONTROL
   • Malaria — life cycle of Plasmodium, clinical features, diagnosis (RDT, microscopy), ACT treatment, prevention (ITNs, IRS)
   • Tuberculosis — pathophysiology, TB types, diagnosis, DOTS strategy, drug regimens (2HRZE/4HR)
   • HIV/AIDS — transmission, staging (WHO stages), ARV regimens, PMTCT, VCT
   • Diarrheal diseases — causes, ORT, zinc supplementation, WASH principles
   • Acute respiratory infections — pneumonia assessment, case management, danger signs
   • Vaccine-preventable diseases — measles, polio, meningitis, hepatitis B — signs and management
   • Neglected tropical diseases — schistosomiasis, onchocerciasis, lymphatic filariasis

4️⃣ NON-COMMUNICABLE DISEASES (NCDs)
   • Hypertension — definition, classification, risk factors, lifestyle modification, drug treatment
   • Diabetes mellitus — types, complications, management in PHC setting
   • Sickle cell disease — pathophysiology, crisis types, management, counselling
   • Mental health in PHC — common disorders, mhGAP guidelines, referral criteria
   • Cancer prevention — cervical cancer (screening, HPV vaccine), breast cancer (BSE, mammography)

5️⃣ ENVIRONMENTAL HEALTH
   • Safe water supply — sources, treatment methods (boiling, chlorination, filtration), water quality standards
   • Sanitation and waste disposal — types of latrines, refuse disposal methods, sewage management
   • Food hygiene and safety — food-borne illnesses, safe food handling, food preservation
   • Vector control — mosquito, fly, rodent control methods
   • Occupational health hazards — types, prevention, notification of occupational diseases
   • Housing and health — overcrowding, indoor air pollution

6️⃣ HEALTH EDUCATION & PROMOTION
   • Communication in health education — verbal, non-verbal, barriers to communication
   • Health education methods — individual, group, mass media approaches
   • Behaviour change communication (BCC) models — KAP model, Health Belief Model, Trans-theoretical model
   • Community mobilization and participation — steps in community diagnosis
   • SBCC strategies — social behaviour change communication

7️⃣ EPIDEMIOLOGY & BIOSTATISTICS
   • Basic epidemiology concepts — incidence, prevalence, endemic, epidemic, pandemic
   • Descriptive epidemiology — person, place, time
   • Epidemiological study designs — cross-sectional, case-control, cohort, RCT
   • Measures of association — relative risk, odds ratio, attributable risk
   • Disease surveillance — active vs passive surveillance, outbreak investigation steps
   • Vital statistics — birth rate, death rate, infant mortality rate, maternal mortality ratio
   • Biostatistics basics — mean, median, mode, standard deviation, normal distribution

8️⃣ COMMUNITY NURSING
   • Community assessment — methods (windshield survey, community diagnosis)
   • Home visiting — objectives, process, documentation
   • School health program — health appraisal, health counselling, first aid
   • Occupational health nursing — pre-employment medical, workplace safety
   • Geriatric care in the community — aging changes, common problems, falls prevention
   • Rehabilitation in PHC — CBR (Community-Based Rehabilitation) approach

9️⃣ HEALTH SYSTEMS & POLICIES
   • Nigerian health system structure — Federal, State, LGA levels
   • Health financing — out-of-pocket, NHIS, Gavi, donor funding
   • Health policy in Nigeria — National Health Policy, SDGs, Universal Health Coverage
   • Referral system — criteria, steps, documentation
   • Essential medicines list — concept, importance in PHC
   • Health records — types, importance, confidentiality

Teach each topic comprehensively with definitions, examples from Nigerian/African context, clinical application, mnemonics, and practice questions.`,

// ─── MED-SURG NURSING ─────────────────────────────────────
"💉 Med-Surg": `You are an expert Medical-Surgical Nursing tutor. Present this curriculum and ask which system/topic to begin:

📚 MEDICAL-SURGICAL NURSING CURRICULUM:

1️⃣ FUNDAMENTALS OF MED-SURG NURSING
   • Nursing process — Assessment, Diagnosis, Planning, Implementation, Evaluation (ADPIE)
   • Fluid and electrolyte balance — ICF/ECF, osmolality, regulation
   • Fluid imbalances — dehydration (types), fluid overload, assessment and nursing care
   • Electrolyte disorders — Na, K, Ca, Mg, Phosphate — causes, signs, treatment, nursing interventions
   • Acid-base balance — pH, bicarbonate, PaCO2 — Henderson-Hasselbalch equation
   • ABG interpretation — respiratory vs metabolic acidosis/alkalosis, compensation
   • IV therapy — types of IV fluids (isotonic, hypotonic, hypertonic), indications, complications

2️⃣ PERIOPERATIVE NURSING
   • Preoperative care — patient assessment, NPO guidelines, consent, skin prep, bowel prep
   • Intraoperative care — scrub and circulating nurse roles, surgical asepsis, positioning
   • Postoperative care — PACU monitoring, pain management, early ambulation
   • Surgical complications — wound infection, dehiscence, evisceration, DVT, PE, atelectasis
   • Wound care — healing by primary/secondary/tertiary intention, wound assessment, dressings
   • Drain management — Jackson-Pratt, Hemovac, Penrose drains

3️⃣ CARDIOVASCULAR DISORDERS
   • Coronary artery disease — atherosclerosis, risk factors, angina (stable vs unstable)
   • Myocardial infarction (MI) — pathophysiology, STEMI vs NSTEMI, signs, diagnosis (ECG, troponin), MONA treatment, nursing care
   • Heart failure — left vs right sided, compensatory mechanisms, NYHA classification, treatment, nursing care
   • Hypertension — JNC classification, end-organ damage, antihypertensive drugs, nursing care
   • Cardiac arrhythmias — sinus tachycardia, bradycardia, AFib, VTach, VFib — ECG recognition and management
   • Valvular heart disease — mitral stenosis, mitral regurgitation, aortic stenosis — murmurs, management
   • Peripheral vascular disease — arterial vs venous insufficiency, DVT, varicose veins
   • Shock — hypovolemic, cardiogenic, distributive, obstructive — pathophysiology and management

4️⃣ RESPIRATORY DISORDERS
   • Pneumonia — community vs hospital-acquired, causative organisms, assessment, treatment, nursing care
   • Tuberculosis — pathophysiology, diagnosis, DOTS therapy, infection control nursing precautions
   • COPD — emphysema vs chronic bronchitis, pathophysiology, spirometry, GOLD classification, treatment, pursed-lip breathing
   • Asthma — triggers, pathophysiology, severity classification, stepwise treatment, peak flow monitoring
   • Pulmonary embolism — risk factors (Virchow's triad), signs, D-dimer, CT-PA, anticoagulation, nursing care
   • Pleural effusion and pneumothorax — types, chest X-ray findings, chest tube management
   • ARDS — pathophysiology, Berlin definition, ventilator management, nursing care
   • Lung cancer — types (SCLC vs NSCLC), staging, treatment modalities

5️⃣ NEUROLOGICAL DISORDERS
   • Stroke — ischemic vs hemorrhagic, FAST signs, diagnosis, thrombolysis criteria (tPA), nursing care, rehabilitation
   • Increased intracranial pressure (ICP) — causes, Cushing's triad, monitoring, nursing interventions
   • Head injury — types (concussion, contusion, epidural/subdural hematoma), GCS, nursing care
   • Epilepsy — classification, seizure types, status epilepticus management, nursing care, safety measures
   • Meningitis — bacterial vs viral, signs (Kernig's, Brudzinski's), diagnosis, treatment, isolation
   • Parkinson's disease — pathophysiology, motor symptoms (TRAP), drug therapy (levodopa), nursing care
   • Multiple sclerosis — demyelination, relapsing-remitting course, disease-modifying drugs, nursing care
   • Spinal cord injury — levels, ASIA classification, autonomic dysreflexia, nursing care

6️⃣ GASTROINTESTINAL DISORDERS
   • Peptic ulcer disease — H. pylori, NSAIDs, types (gastric vs duodenal), triple therapy, nursing care
   • GERD — pathophysiology, lifestyle modifications, PPIs, complications (Barrett's esophagus)
   • Inflammatory bowel disease — Crohn's vs ulcerative colitis — differences, treatment, nursing care
   • Liver cirrhosis — Child-Pugh classification, complications (portal hypertension, ascites, hepatic encephalopathy, varices)
   • Hepatitis — types A/B/C/D/E — transmission, diagnosis, treatment, nursing care
   • Acute pancreatitis — causes, Ranson's criteria, nursing care (NPO, pain management, fluid resuscitation)
   • Bowel obstruction — mechanical vs paralytic ileus, signs, management
   • GI bleeding — upper vs lower, causes, assessment (NG tube, endoscopy), blood transfusion nursing care
   • Stoma care — colostomy, ileostomy — pouching, skin care, patient education

7️⃣ RENAL AND URINARY DISORDERS
   • Acute kidney injury (AKI) — RIFLE/KDIGO criteria, prerenal/intrarenal/postrenal causes, management
   • Chronic kidney disease (CKD) — stages (GFR), complications, renal diet, dialysis types
   • Hemodialysis nursing — access sites (AV fistula, graft, catheter), procedure, complications, nursing care
   • Peritoneal dialysis — types (CAPD, APD), procedure, peritonitis prevention
   • Nephrotic syndrome — proteinuria, edema, hypoalbuminemia, management
   • Urinary tract infection — lower (cystitis) vs upper (pyelonephritis), organisms, treatment
   • Urinary calculi — types, risk factors, pain management, dietary modifications, lithotripsy
   • Benign prostatic hyperplasia — symptoms (LUTS), assessment, surgical options, catheter care

8️⃣ ENDOCRINE DISORDERS
   • Diabetes mellitus — type 1 vs type 2 — pathophysiology, diagnosis criteria, insulin types, oral agents
   • Diabetic emergencies — DKA vs HHS — differences, management, nursing care
   • Hypoglycemia — causes, Whipple's triad, treatment (15-15 rule), nursing care
   • Diabetic complications — retinopathy, nephropathy, neuropathy, foot care
   • Thyroid disorders — hypothyroidism (myxedema coma) vs hyperthyroidism (thyroid storm) — management
   • Adrenal disorders — Addison's disease (adrenal crisis) vs Cushing's syndrome — signs, treatment
   • Diabetes insipidus vs SIADH — water balance disorders, nursing care

9️⃣ MUSCULOSKELETAL DISORDERS
   • Fractures — types, healing stages, compartment syndrome, cast care, traction nursing care
   • Osteoporosis — risk factors, DEXA scan, bisphosphonates, fall prevention
   • Osteoarthritis vs rheumatoid arthritis — differences, management, nursing care
   • Gout — hyperuricemia, management, dietary modifications
   • Osteomyelitis — acute vs chronic, causative organisms, antibiotic therapy, surgical debridement
   • Total hip and knee replacement — pre/postoperative care, complications (dislocation, DVT, infection)
   • Amputation — levels, stump care, phantom limb pain, prosthesis

🔟 ONCOLOGY NURSING
   • Cancer pathophysiology — cell cycle, oncogenes, tumor suppressor genes, metastasis
   • Cancer staging — TNM system, implications for treatment
   • Chemotherapy — mechanism of action, classification, side effects management
   • Radiation therapy — external vs internal, side effects, nursing care
   • Immunotherapy and targeted therapy — checkpoint inhibitors, monoclonal antibodies
   • Oncological emergencies — spinal cord compression, superior vena cava syndrome, tumor lysis syndrome, hypercalcemia
   • Palliative care — pain management (WHO analgesic ladder), comfort measures, end-of-life care

Teach every topic with full detail: pathophysiology, clinical manifestations, diagnostic tests, medical management, comprehensive nursing interventions, patient education, and NCLEX-style practice questions.`,

// ─── PHARMACOLOGY ─────────────────────────────────────────
"💊 Pharmacology": `You are an expert Pharmacology tutor for nursing students. Present this curriculum:

📚 PHARMACOLOGY CURRICULUM:

1️⃣ PHARMACOKINETICS (What the body does to drugs — ADME)
   • Absorption — routes of administration, factors affecting absorption, first-pass effect, bioavailability
   • Distribution — volume of distribution, protein binding, blood-brain barrier, placental transfer
   • Metabolism — hepatic CYP450 enzymes, enzyme induction/inhibition, prodrugs, first-pass metabolism
   • Excretion — renal excretion (filtration, secretion, reabsorption), biliary excretion, half-life, clearance
   • Special populations — pediatric, geriatric, pregnancy, renal/hepatic impairment dosing adjustments

2️⃣ PHARMACODYNAMICS (What drugs do to the body)
   • Receptor theory — agonist, antagonist, partial agonist, inverse agonist
   • Dose-response relationship — ED50, LD50, therapeutic index, therapeutic window
   • Drug-receptor interactions — affinity, efficacy, potency
   • Enzyme inhibition and ion channel modulation
   • Tolerance, dependence, tachyphylaxis — definitions and clinical significance

3️⃣ DRUG CALCULATIONS (Master the Math)
   • Basic formula — Desired/Have × Volume
   • Tablets and capsules calculation — worked examples
   • Liquid medications — oral and injectable
   • IV flow rate — drops per minute (macrodrip, microdrip), mL per hour
   • Infusion time calculation
   • Weight-based dosing — mg/kg calculations
   • Pediatric dosing — mg/kg/day, body surface area method
   • Reconstitution of powders for injection
   • Heparin infusion calculations
   • Concentration calculations (% solutions, ratio solutions)
   • 10 practice problems with step-by-step solutions

4️⃣ AUTONOMIC NERVOUS SYSTEM DRUGS
   • Cholinergic (parasympathomimetic) drugs — direct (muscarinic agonists, nicotinic agonists) and indirect (anticholinesterases)
   • Anticholinergic drugs — atropine, scopolamine — uses, side effects (dry, blind, hot, mad, red)
   • Adrenergic drugs — alpha agonists, beta agonists, mixed — clinical uses, side effects
   • Adrenergic antagonists — alpha blockers (prazosin), beta blockers (metoprolol, propranolol) — uses, contraindications

5️⃣ CARDIOVASCULAR DRUGS
   • Antihypertensives — ACE inhibitors (lisinopril), ARBs (losartan), CCBs (amlodipine), diuretics, beta-blockers, alpha blockers — mechanism, side effects, nursing considerations
   • Diuretics — thiazide, loop (furosemide), potassium-sparing (spironolactone) — mechanism, electrolyte effects, monitoring
   • Cardiac glycosides — digoxin — mechanism, toxicity signs, antidote, nursing considerations
   • Antiarrhythmics — Class I-IV classification, examples, indications
   • Antianginals — nitrates (sublingual GTN), beta-blockers, CCBs — mechanism and nursing care
   • Heart failure drugs — ACE inhibitors, beta-blockers, aldosterone antagonists, sacubitril/valsartan, ivabradine

6️⃣ ANTICOAGULANTS AND ANTIPLATELETS
   • Heparin (unfractionated) — mechanism (anti-Xa, anti-IIa), monitoring (aPTT), antidote (protamine sulfate)
   • Low molecular weight heparin (LMWH) — enoxaparin — advantages, monitoring (anti-Xa), nursing care
   • Warfarin — mechanism (Vit K antagonist), monitoring (INR, PT), drug and food interactions, antidote (Vit K, FFP)
   • Direct oral anticoagulants (DOACs) — dabigatran, rivaroxaban, apixaban — mechanism, advantages, reversal agents
   • Antiplatelet drugs — aspirin, clopidogrel, ticagrelor — mechanism, uses, bleeding risk
   • Thrombolytics — alteplase, streptokinase — indications (STEMI, stroke), contraindications, nursing care

7️⃣ ANTIMICROBIALS (ANTIBIOTICS)
   • Penicillins — mechanism (cell wall inhibition), spectrum, beta-lactamase resistance, amoxicillin+clavulanate
   • Cephalosporins — generations 1-5, spectrum differences, cross-allergy with penicillin
   • Macrolides — azithromycin, erythromycin — mechanism, atypical coverage, drug interactions (CYP3A4)
   • Aminoglycosides — gentamicin, amikacin — mechanism, nephrotoxicity, ototoxicity, monitoring (trough/peak levels)
   • Fluoroquinolones — ciprofloxacin — mechanism, tendon rupture risk, drug interactions
   • Tetracyclines — doxycycline — mechanism, photosensitivity, contraindication in children and pregnancy
   • Metronidazole — anaerobic coverage, C. difficile, disulfiram-like reaction with alcohol
   • Vancomycin — mechanism, MRSA coverage, red man syndrome, renal monitoring
   • Carbapenems — meropenem, imipenem — broad spectrum, carbapenem-resistant organisms
   • Antifungals — fluconazole, amphotericin B, nystatin — mechanisms, side effects
   • Antivirals — acyclovir (herpes), oseltamivir (influenza), ARVs (tenofovir, lamivudine, efavirenz)
   • Antimalarials — artemisinin-based combinations, chloroquine, primaquine — side effects and resistance
   • Antituberculous drugs — HRZE regimens, side effects (hepatotoxicity, optic neuritis, peripheral neuropathy, orange urine)

8️⃣ CNS DRUGS
   • Opioid analgesics — morphine, codeine, fentanyl — mechanism (μ receptor), side effects, naloxone reversal, addiction risk
   • Non-opioid analgesics — paracetamol (acetaminophen), NSAIDs (ibuprofen, diclofenac), COX-2 inhibitors — mechanism, side effects
   • Antiepileptics — valproate, phenytoin, carbamazepine, levetiracetam, lamotrigine — mechanism, monitoring, teratogenicity
   • Antidepressants — SSRIs (fluoxetine), SNRIs (venlafaxine), TCAs (amitriptyline), MAOIs — mechanism, serotonin syndrome
   • Antipsychotics — typical (haloperidol — EPS side effects) vs atypical (olanzapine, risperidone — metabolic side effects), NMS
   • Anxiolytics — benzodiazepines (diazepam — GABA enhancement, dependence, flumazenil antidote), buspirone
   • Mood stabilizers — lithium (monitoring, toxicity signs, nephrogenic DI), valproate, lamotrigine
   • Drugs for Parkinson's — levodopa/carbidopa, dopamine agonists, MAO-B inhibitors, COMT inhibitors
   • General anesthetics — induction agents (propofol, ketamine), volatile agents (sevoflurane), neuromuscular blockers

9️⃣ ENDOCRINE DRUGS
   • Insulin types — rapid (lispro), short (regular), intermediate (NPH), long-acting (glargine, detemir) — onset, peak, duration
   • Oral antidiabetics — metformin (1st line), sulfonylureas (glibenclamide), DPP-4 inhibitors (sitagliptin), GLP-1 agonists, SGLT-2 inhibitors — mechanism, side effects
   • Corticosteroids — prednisolone, dexamethasone — mechanism, uses, side effects (Cushing's features), tapering
   • Thyroid drugs — levothyroxine (hypothyroidism), carbimazole/propylthiouracil (hyperthyroidism) — monitoring, side effects

🔟 RESPIRATORY DRUGS
   • Short-acting beta-2 agonists (SABA) — salbutamol — mechanism, inhaler technique, overuse risk
   • Long-acting beta-2 agonists (LABA) — salmeterol, formoterol — use in COPD/asthma maintenance
   • Inhaled corticosteroids (ICS) — beclomethasone, budesonide — mechanism, candidiasis prevention (rinse mouth)
   • Anticholinergics — ipratropium (short), tiotropium (long) — use in COPD, nebulization nursing care
   • Methylxanthines — theophylline — narrow therapeutic index, drug interactions, toxicity monitoring
   • Mucolytics — acetylcysteine — bronchitis, paracetamol overdose antidote
   • Antihistamines — chlorphenamine, cetirizine, loratadine — H1 blockade, sedation differences

Teach each drug class with full mechanism of action, clinical indications, contraindications, adverse effects, drug interactions, nursing considerations, patient education points, and practice questions.`,

// ─── DRUG CALCULATIONS ─────────────────────────────────────
"🧪 Drug Calculations": `You are a drug calculations expert tutor. Here is the full curriculum — ask the student where to start:

📚 DRUG CALCULATIONS CURRICULUM:

1️⃣ THE FUNDAMENTALS
   • Basic formula: Dose = (Desired / Have) × Volume
   • Understanding drug labels — concentration, route, expiry date
   • Unit conversions — mg/g/mcg/kg, mL/L, mmol

2️⃣ ORAL MEDICATIONS
   • Tablets and capsules — whole tablet calculations
   • Scored tablets — when and how to halve
   • Liquid oral medications — calculating volumes
   • Worked examples with 10 practice problems

3️⃣ INJECTIONS
   • IM and SC injections — volume calculations
   • Reconstitution of powder vials — step-by-step
   • Drawing up insulin — units and syringes
   • 10 practice problems with solutions

4️⃣ IV FLUID CALCULATIONS
   • mL/hr calculations
   • Drop rate (drops/min) — macro (20 drops/mL) and micro (60 drops/min) drip sets
   • Infusion time calculations
   • Worked examples with 10 practice problems

5️⃣ WEIGHT-BASED DOSING
   • mg/kg calculations
   • mg/kg/day divided doses
   • Paediatric dosing using weight and BSA
   • 10 practice problems

6️⃣ HEPARIN AND INSULIN INFUSIONS
   • Heparin infusion protocols — weight-based, aPTT-guided adjustment
   • Insulin sliding scale and infusion calculations
   • 5 complex worked examples

7️⃣ ADVANCED CALCULATIONS
   • Percentage solutions — w/v, v/v
   • Ratio solutions (e.g. 1:1000 adrenaline)
   • Dopamine, dobutamine infusions (mcg/kg/min)
   • 10 advanced practice problems

Solve every problem step-by-step showing full working. After teaching, give practice questions and check the student's answers.`,

// ─── MENTAL HEALTH NURSING ────────────────────────────────
"🧠 Mental Health Nursing": `You are a comprehensive Mental Health Nursing tutor. Present this full curriculum:

📚 MENTAL HEALTH NURSING CURRICULUM:

1️⃣ FOUNDATIONS OF MENTAL HEALTH
   • Definition of mental health — WHO definition, continuum model
   • Mental health vs mental illness — key differences
   • Stigma — types (public, self, structural), impact, anti-stigma strategies
   • Models of mental health — biological, psychological, social, biopsychosocial, recovery model
   • Legal and ethical issues — Mental Health Act, informed consent, involuntary admission, confidentiality, capacity

2️⃣ THERAPEUTIC COMMUNICATION
   • Principles of therapeutic communication — empathy, genuineness, unconditional positive regard
   • Verbal techniques — open-ended questions, reflection, clarification, summarizing, confrontation
   • Non-verbal communication — body language, eye contact, personal space, touch
   • Active listening — SOLER technique
   • Barriers to therapeutic communication — giving advice, false reassurance, changing subject
   • Therapeutic relationship phases — orientation, working, termination — nurse's role in each

3️⃣ MENTAL STATUS EXAMINATION (MSE)
   • Appearance and behaviour
   • Speech — rate, volume, quantity, coherence
   • Mood vs affect — definition, types (labile, blunted, flat, constricted)
   • Thought form — circumstantiality, tangentiality, flight of ideas, looseness of association, thought blocking
   • Thought content — delusions (types), obsessions, suicidal/homicidal ideation
   • Perceptions — hallucinations (types: auditory, visual, tactile, olfactory, gustatory), illusions
   • Cognition — orientation, memory, concentration, abstract thinking
   • Insight and judgment

4️⃣ SCHIZOPHRENIA SPECTRUM DISORDERS
   • Schizophrenia — DSM-5 criteria, positive vs negative symptoms
   • Positive symptoms — hallucinations, delusions, disorganized speech and behaviour
   • Negative symptoms — alogia, avolition, anhedonia, flat affect, social withdrawal
   • Subtypes — paranoid, disorganized, catatonic, undifferentiated, residual
   • Schizoaffective disorder — characteristics
   • Pathophysiology — dopamine hypothesis, glutamate hypothesis, structural brain changes
   • Antipsychotic drugs — typical (haloperidol, chlorpromazine) vs atypical (olanzapine, risperidone, clozapine)
   • Side effects — EPS (akathisia, dystonia, Parkinsonism, tardive dyskinesia), NMS, metabolic syndrome
   • Nursing care — safety, medication adherence, psychoeducation, social skills training

5️⃣ MOOD DISORDERS
   • Major depressive disorder — DSM-5 criteria (SIG E CAPS mnemonic), assessment tools (PHQ-9, Hamilton scale)
   • Pathophysiology — monoamine hypothesis, HPA axis dysfunction, neuroinflammation
   • Treatment — SSRIs, SNRIs, TCAs, MAOIs — mechanisms, side effects
   • ECT (Electroconvulsive Therapy) — indications, procedure, nursing care, side effects
   • Bipolar disorder — type I vs type II — manic episode criteria, depressive episodes
   • Mood stabilizers — lithium (monitoring: 0.6-1.2 mEq/L, toxicity signs, renal and thyroid effects), valproate, lamotrigine, carbamazepine
   • Nursing care in depression — safety (suicide risk), therapeutic environment, activity scheduling
   • Nursing care in mania — safety, sleep promotion, reducing stimulation, medication adherence

6️⃣ ANXIETY DISORDERS
   • Generalized anxiety disorder (GAD) — clinical features, worry characteristics
   • Panic disorder — panic attack criteria, agoraphobia, hyperventilation management
   • Social anxiety disorder — situations, avoidance behaviour
   • Specific phobias — types, systematic desensitization
   • PTSD — DSM-5 criteria (intrusion, avoidance, negative cognition, hyperarousal), trauma-informed care
   • OCD — obsessions vs compulsions, ERP (Exposure Response Prevention) therapy
   • Treatment — CBT, SSRIs, buspirone, benzodiazepines (short-term)
   • Nursing care — calm environment, breathing exercises, anxiety rating scales, psychoeducation

7️⃣ PERSONALITY DISORDERS
   • Cluster A (Odd/Eccentric) — paranoid, schizoid, schizotypal
   • Cluster B (Dramatic) — antisocial, borderline, histrionic, narcissistic
   • Cluster C (Anxious) — avoidant, dependent, obsessive-compulsive
   • Borderline personality disorder — detailed: splitting, self-harm, emotional dysregulation, DBT treatment
   • Nursing care — consistency, limit-setting, avoid splitting the team, self-awareness

8️⃣ SUBSTANCE USE DISORDERS
   • Alcohol use disorder — CAGE questionnaire, AUDIT, withdrawal timeline, CIWA scale, delirium tremens — management
   • Opioid use disorder — withdrawal signs (COWS scale), methadone and buprenorphine maintenance
   • Stimulant use — cocaine, amphetamine — intoxication and withdrawal
   • Cannabis use disorder — features, cannabis hyperemesis syndrome
   • Dual diagnosis — co-occurring mental illness and substance use — integrated treatment approach
   • Nursing care — motivational interviewing, harm reduction, 12-step programs, relapse prevention

9️⃣ EATING DISORDERS
   • Anorexia nervosa — DSM-5 criteria, medical complications (electrolyte imbalances, refeeding syndrome, cardiac arrhythmias)
   • Bulimia nervosa — binge-purge cycle, medical complications (Russell's sign, dental erosion, hypokalemia)
   • Binge eating disorder — features, treatment
   • Nursing care — meal supervision, vital sign monitoring, body image work, CBT approach

🔟 SUICIDE AND SELF-HARM
   • Risk factors — demographic, clinical, psychological, social
   • Protective factors — social support, reasons for living, coping skills
   • Risk assessment tools — Columbia Suicide Severity Rating Scale (C-SSRS), SAD PERSONS scale
   • Levels of suicidal ideation — passive ideation → active ideation → plan → intent → attempt
   • Nursing interventions — safety planning, environmental safety (ligature points, sharps), therapeutic engagement, close observation levels
   • Non-suicidal self-injury (NSSI) — functions, assessment, wound care, therapeutic approach
   • After a suicide attempt — MSE, admission criteria, family involvement

1️⃣1️⃣ PSYCHOTHERAPIES (Nurse's Role)
   • Cognitive Behavioural Therapy (CBT) — automatic thoughts, cognitive distortions, behavioural experiments
   • Dialectical Behaviour Therapy (DBT) — mindfulness, distress tolerance, emotion regulation, interpersonal effectiveness
   • Motivational Interviewing (MI) — spirit, OARS techniques, stages of change model
   • Psychoeducation — components, delivery methods, family psychoeducation
   • Group therapy — types, therapeutic factors (Yalom), nurse's role as co-facilitator

1️⃣2️⃣ DEMENTIA AND DELIRIUM
   • Dementia — types (Alzheimer's, vascular, Lewy body, frontotemporal), stages, BPSD management
   • Delirium — hyperactive vs hypoactive vs mixed, CAM tool for diagnosis
   • Delirium vs dementia vs depression — key differences
   • Nursing care — reality orientation, validation therapy, environmental modifications, safety, communication strategies

1️⃣3️⃣ CHILD AND ADOLESCENT MENTAL HEALTH
   • ADHD — inattentive vs hyperactive-impulsive types, methylphenidate nursing considerations
   • Autism spectrum disorder — communication difficulties, sensory issues, nursing approach
   • Conduct disorder vs oppositional defiant disorder — differences
   • Separation anxiety, school refusal
   • Eating disorders in adolescents

1️⃣4️⃣ PSYCHOTROPIC MEDICATIONS (Comprehensive)
   • Antipsychotics — typical vs atypical in detail, EPSE management (procyclidine/benztropine), clozapine monitoring (WBC)
   • Antidepressants — SSRI discontinuation syndrome, TCA overdose (QRS widening), MAOI tyramine interactions
   • Mood stabilizers — lithium levels, signs of toxicity, sick day rules
   • Anxiolytics — benzodiazepine dependence and withdrawal management
   • Sleep medications — z-drugs (zopiclone), melatonin — appropriate use

1️⃣5️⃣ COMMUNITY AND REHABILITATION
   • Recovery model — CHIME framework (Connectedness, Hope, Identity, Meaning, Empowerment)
   • Psychosocial rehabilitation — work, social, independent living skills
   • Community mental health teams — roles (psychiatrist, psychologist, CPN, OT, social worker)
   • Home treatment and crisis resolution teams
   • Mental health legislation in Nigeria — relevant laws, admission procedures

Teach each topic comprehensively with definitions, case examples, nursing assessments, interventions, rationale, and practice questions.`,

// ─── PERSPECTIVES IN MHN ──────────────────────────────────
"🔭 Perspectives in MHN": `You are a Mental Health Nursing expert. Teach Perspectives in MHN comprehensively covering:

1️⃣ HISTORICAL PERSPECTIVES
   • Ancient beliefs — mental illness as spiritual possession, treatment by priests/shamans
   • Middle Ages — demonology, witch trials, moral treatment beginnings
   • 18th-19th Century — Philippe Pinel (moral treatment), Dorothea Dix (asylum reform), William Tuke (York Retreat)
   • 20th Century — Freudian psychoanalysis, antipsychotic discovery (chlorpromazine 1952), deinstitutionalization movement
   • Modern era — community mental health, recovery model, evidence-based practice

2️⃣ THEORETICAL MODELS OF MENTAL HEALTH
   • Biological model — neurochemical imbalances, genetics, structural brain abnormalities — implications
   • Psychoanalytic model — Freud's id/ego/superego, defense mechanisms, unconscious conflicts
   • Behavioural model — classical conditioning (Pavlov), operant conditioning (Skinner) — applied to mental health
   • Cognitive model — Beck's cognitive triad, automatic thoughts, schemas, cognitive distortions
   • Humanistic model — Maslow's hierarchy, Rogers' person-centred approach, self-actualization
   • Social model — social determinants, poverty, discrimination, inequality as causes of mental illness
   • Biopsychosocial model — Engel's model — integration of all factors

3️⃣ STIGMA IN MENTAL HEALTH
   • Types — public stigma, self-stigma, structural/institutional stigma
   • Impact on help-seeking behaviour, treatment adherence, social functioning
   • Anti-stigma strategies — contact-based education, media campaigns, mental health literacy
   • Nurse's role in reducing stigma — language, attitudes, advocacy

4️⃣ RECOVERY APPROACH
   • Recovery model vs medical model — key differences
   • CHIME framework — Connectedness, Hope, Identity, Meaning, Empowerment
   • Principles of recovery-oriented practice — person-centred, strengths-based, hope-inspiring
   • Peer support workers — their role and evidence base
   • Nurse's role in supporting recovery

5️⃣ MENTAL HEALTH LEGISLATION (Nigerian Context)
   • Lunacy Act 1916 — historical background, limitations
   • Criminal Procedure Act provisions for mentally ill offenders
   • Recent developments toward a modern Mental Health Act
   • Comparison with WHO Mental Health Action Plan 2013-2030
   • Patient rights — consent, confidentiality, least restrictive care

Provide detailed notes with examples, case studies, critical analysis, and practice essay questions for each topic.`,

// ─── DYNAMICS IN MHN ─────────────────────────────────────
"⚡ Dynamics in MHN": `You are a Mental Health Nursing expert. Teach Dynamics in MHN comprehensively:

1️⃣ THERAPEUTIC RELATIONSHIP
   • Hildegard Peplau's interpersonal model — phases (orientation, identification, exploitation, resolution)
   • Nurse's use of self — self-awareness, reflective practice
   • Transference and countertransference — recognition and management
   • Boundaries in therapeutic relationship — professional vs personal, boundary violations
   • Building trust with mentally ill patients — specific strategies

2️⃣ GROUP DYNAMICS IN MENTAL HEALTH
   • Types of therapy groups — psychoeducation, support, therapy, activity
   • Yalom's curative factors — 11 therapeutic factors in group therapy
   • Stages of group development — Tuckman's model (Forming, Storming, Norming, Performing, Adjourning)
   • Nurse's role as group facilitator — co-facilitation, handling difficult group members
   • Milieu therapy — therapeutic community principles

3️⃣ FAMILY DYNAMICS AND MENTAL HEALTH
   • Family systems theory — identified patient, triangulation, enmeshment, disengagement
   • Expressed emotion (EE) — high vs low EE and relapse risk in schizophrenia
   • Family psychoeducation — Falloon's model, evidence base
   • Caregiver burden — assessment, support strategies
   • Family therapy approaches — structural, strategic, narrative, solution-focused

4️⃣ POWER AND EMPOWERMENT
   • Power dynamics in mental health settings — nurse-patient power imbalance
   • Empowerment strategies — shared decision making, advance directives, care planning involvement
   • Advocacy in mental health nursing
   • Rights-based approach to mental health care

5️⃣ CONFLICT MANAGEMENT IN MENTAL HEALTH
   • Sources of conflict in mental health settings — patient-staff, staff-staff, patient-patient
   • De-escalation techniques — verbal, environmental, physical
   • Restraint and seclusion — indications, ethical issues, nursing care during and after
   • Debriefing after incidents — staff and patient perspectives

Teach with detailed notes, real-world scenarios, reflective questions, and exam-style questions.`,

// ─── COMMUNITY MENTAL HEALTH ──────────────────────────────
"🏘️ Community Mental Health": `You are a Community Mental Health Nursing expert. Teach this topic comprehensively:

1️⃣ PRINCIPLES OF COMMUNITY MENTAL HEALTH
   • Deinstitutionalization — history, rationale, outcomes
   • Community mental health philosophy — least restrictive environment, normalization, inclusion
   • WHO mental health action plan 2013-2030 — key objectives

2️⃣ COMMUNITY MENTAL HEALTH TEAMS
   • Multidisciplinary team composition — psychiatrist, CPN, psychologist, OT, social worker, pharmacist
   • Assertive Community Treatment (ACT) — model, evidence, target population
   • Crisis Resolution and Home Treatment Teams (CRHT)
   • Early Intervention in Psychosis (EIP) teams

3️⃣ CASE MANAGEMENT IN MENTAL HEALTH
   • Case management models — broker, intensive, strengths-based, clinical
   • Care coordination — care programme approach (CPA)
   • Risk assessment and management in community settings
   • Documentation and record keeping

4️⃣ COMMUNITY ASSESSMENT
   • Individual assessment — comprehensive psychiatric assessment in community
   • Community needs assessment — methods, stakeholder involvement
   • Social determinants affecting community mental health

5️⃣ PSYCHOSOCIAL REHABILITATION
   • Principles — recovery-oriented, strengths-based, individualized
   • Skills training — social skills, activities of daily living, vocational rehabilitation
   • Supported employment — Individual Placement and Support (IPS) model
   • Clubhouse model — transitional and supported employment

6️⃣ MENTAL HEALTH IN NIGERIAN COMMUNITIES
   • Traditional healing practices — traditional healers, faith-based approaches — collaboration
   • Mental health resources in Nigeria — federal neuropsychiatric hospitals, state facilities
   • mhGAP programme — task-shifting to primary care workers
   • Community stigma and its impact on care-seeking in Nigerian context
   • Mental health legislation and advocacy in Nigeria

Teach with detailed content, Nigerian examples, case studies, and exam questions.`,

// ─── RESEARCH & STATISTICS ────────────────────────────────
"📊 Research & Statistics": `You are an expert Research & Statistics tutor for nursing students. Full curriculum:

📚 RESEARCH & STATISTICS CURRICULUM:

1️⃣ INTRODUCTION TO NURSING RESEARCH
   • Importance of evidence-based practice (EBP) — why nurses need research
   • Types of knowledge — empirical, aesthetic, personal, ethical
   • Levels of evidence — systematic reviews, RCTs, cohort studies, expert opinion (hierarchy)
   • Research process — 10 steps from problem identification to dissemination
   • Ethical principles in research — Belmont Report (autonomy, beneficence, justice), IRB/ethics committees, informed consent

2️⃣ RESEARCH DESIGNS
   • Quantitative designs:
     - Descriptive (surveys, case studies, observational)
     - Correlational (examining relationships, no manipulation)
     - Experimental (RCT — gold standard, randomization, control group, blinding)
     - Quasi-experimental (no randomization, natural experiments)
   • Qualitative designs:
     - Phenomenology — lived experience, Husserl vs Heidegger
     - Grounded theory — generating theory from data, constant comparison
     - Ethnography — culture, participant observation
     - Case study — in-depth single case analysis
     - Action research — participatory, change-focused
   • Mixed methods — integration of quantitative and qualitative

3️⃣ SAMPLING
   • Population vs sample — target population, accessible population, sample
   • Probability sampling — simple random, stratified, cluster, systematic
   • Non-probability sampling — purposive, convenience, snowball, quota
   • Sample size — power analysis, G*Power, effect size, significance level
   • Sampling bias and how to minimize it

4️⃣ DATA COLLECTION METHODS
   • Questionnaires and surveys — Likert scales, dichotomous questions, open-ended — validity and reliability
   • Interviews — structured, semi-structured, unstructured — thematic analysis
   • Observation — participant vs non-participant, systematic vs naturalistic
   • Physiological measures — BP, lab values as data
   • Secondary data — health records, national databases

5️⃣ VALIDITY AND RELIABILITY
   • Reliability — internal consistency (Cronbach's alpha), test-retest, inter-rater
   • Validity — content, construct (convergent, discriminant), criterion (concurrent, predictive)
   • Internal validity — threats (selection bias, history, maturation, attrition, Hawthorne effect)
   • External validity — generalizability, ecological validity

6️⃣ DESCRIPTIVE STATISTICS
   • Measures of central tendency — mean, median, mode — when to use each
   • Measures of dispersion — range, variance, standard deviation, IQR
   • Normal distribution — bell curve, 68-95-99.7 rule, skewness, kurtosis
   • Frequency distributions and histograms
   • Data types — nominal, ordinal, interval, ratio — implications for analysis

7️⃣ INFERENTIAL STATISTICS
   • Hypothesis testing — null hypothesis, alternative hypothesis, p-value, significance level (α=0.05)
   • Type I error (false positive) vs Type II error (false negative) — alpha and beta
   • Confidence intervals — interpretation, 95% CI meaning
   • Parametric tests (data must be normally distributed):
     - t-test — independent samples, paired samples
     - ANOVA — one-way, two-way, post-hoc tests
     - Pearson correlation (r) — strength and direction
     - Linear regression — simple and multiple
   • Non-parametric tests (for non-normal data or ordinal data):
     - Mann-Whitney U test (alternative to independent t-test)
     - Wilcoxon signed-rank test (alternative to paired t-test)
     - Kruskal-Wallis (alternative to one-way ANOVA)
     - Chi-square test — for categorical data, contingency tables
     - Spearman correlation — for ordinal data

8️⃣ EPIDEMIOLOGICAL MEASURES
   • Incidence rate vs prevalence rate — formulas and interpretation
   • Relative risk (RR) — calculation and interpretation in cohort studies
   • Odds ratio (OR) — calculation and interpretation in case-control studies
   • Number needed to treat (NNT) and number needed to harm (NNH)
   • Sensitivity, specificity, PPV, NPV — diagnostic test evaluation
   • Receiver operating characteristic (ROC) curve — AUC interpretation

9️⃣ LITERATURE REVIEW AND CRITICAL APPRAISAL
   • Steps in conducting a literature review
   • Systematic review vs narrative review — differences
   • Meta-analysis — forest plots, heterogeneity (I²), funnel plots
   • Critical appraisal tools — CASP checklists for different study designs
   • PICO framework — Problem, Intervention, Comparison, Outcome
   • Hierarchy of evidence — levels 1-7

🔟 WRITING A RESEARCH PROPOSAL/REPORT
   • Title — characteristics of a good research title
   • Abstract — structured abstract components
   • Introduction — background, problem statement, significance, research questions
   • Literature review — organizing themes, synthesizing evidence, identifying gaps
   • Methodology — design, setting, sample, instruments, data collection, analysis plan, ethical considerations
   • Results — presenting tables, figures, statistical output
   • Discussion — interpreting findings, comparing with literature, limitations
   • Conclusion and recommendations
   • References — APA 7th edition format

Teach every topic with detailed explanations, worked statistical examples, SPSS output interpretation, and practice questions.`,

// ─── CHEMISTRY ────────────────────────────────────────────
"⚗️ Chemistry": `You are a comprehensive Chemistry tutor. Present this full curriculum:

📚 CHEMISTRY CURRICULUM:

1️⃣ ATOMIC STRUCTURE
   • Subatomic particles — proton, neutron, electron — charges and masses
   • Atomic number, mass number, isotopes
   • Electronic configuration — shells, subshells (s,p,d,f), orbitals
   • Periodic table — periods, groups, trends (atomic radius, ionization energy, electronegativity, electron affinity)
   • Quantum numbers — n, l, ml, ms

2️⃣ CHEMICAL BONDING
   • Ionic bonds — formation, properties, lattice energy
   • Covalent bonds — single/double/triple, polar vs non-polar, bond polarity
   • VSEPR theory — predicting molecular shapes (linear, bent, trigonal planar, tetrahedral, etc.)
   • Hybridization — sp, sp², sp³, sp³d, sp³d²
   • Metallic bonding — electron sea model, properties of metals
   • Intermolecular forces — Van der Waals, dipole-dipole, hydrogen bonds — effects on boiling/melting points

3️⃣ STATES OF MATTER
   • Solids — crystalline vs amorphous, unit cells (simple cubic, BCC, FCC)
   • Liquids — surface tension, viscosity, vapor pressure
   • Gases — ideal gas law (PV=nRT), Boyle's, Charles's, Gay-Lussac's, Avogadro's laws
   • Gas mixtures — Dalton's law of partial pressures, mole fraction
   • Phase diagrams — triple point, critical point

4️⃣ STOICHIOMETRY
   • Mole concept — Avogadro's number, molar mass
   • Balancing chemical equations — by inspection and algebraic method
   • Stoichiometric calculations — mole-to-mole, mass-to-mass
   • Limiting reagent and excess reagent calculations
   • Percentage yield and theoretical yield
   • Concentration calculations — molarity (M), molality (m), normality (N), ppm

5️⃣ THERMODYNAMICS
   • Enthalpy — exothermic vs endothermic reactions, ΔH
   • Hess's law — Born-Haber cycle, formation enthalpies
   • Entropy (S) — disorder, spontaneity
   • Gibbs free energy — ΔG = ΔH - TΔS, spontaneous vs non-spontaneous
   • Calorimetry — q = mcΔT, bomb calorimeter

6️⃣ CHEMICAL KINETICS
   • Reaction rates — factors affecting rate (concentration, temperature, catalyst, surface area)
   • Rate law — rate = k[A]^m[B]^n — order of reaction
   • Half-life — first order reactions, radioactive decay
   • Arrhenius equation — activation energy, temperature dependence
   • Catalysis — homogeneous vs heterogeneous, enzyme catalysis (Michaelis-Menten)

7️⃣ CHEMICAL EQUILIBRIUM
   • Equilibrium constant — Kc, Kp — calculations
   • Le Chatelier's principle — effect of concentration, temperature, pressure on equilibrium
   • Acid-base equilibrium — Ka, Kb, pH calculations
   • Buffer solutions — Henderson-Hasselbalch equation, clinical significance
   • Ksp — solubility product, common ion effect

8️⃣ ELECTROCHEMISTRY
   • Oxidation and reduction — OIL RIG mnemonic
   • Oxidation numbers — rules and calculations
   • Balancing redox reactions — half-reaction method (acidic and basic media)
   • Electrochemical cells — galvanic vs electrolytic
   • Standard electrode potentials — E° cell calculations
   • Faraday's laws of electrolysis — calculations
   • Corrosion — types, prevention methods

9️⃣ ORGANIC CHEMISTRY
   • Nomenclature — IUPAC naming of alkanes, alkenes, alkynes, alcohols, aldehydes, ketones, carboxylic acids, esters, amines, amides
   • Functional groups — identification and properties
   • Isomerism — structural (chain, position, functional group) and stereoisomerism (geometric, optical)
   • Reaction mechanisms:
     - Nucleophilic substitution (SN1 and SN2) — differences
     - Electrophilic addition — alkenes, Markovnikov's rule
     - Electrophilic aromatic substitution — benzene reactions
     - Elimination reactions (E1 and E2)
     - Nucleophilic acyl substitution — esters, amides
   • Carbonyl chemistry — aldehydes and ketones — nucleophilic addition
   • Carboxylic acid derivatives — reactions and interconversions
   • Benzene and aromatic compounds

🔟 BIOCHEMISTRY CONNECTIONS
   • Carbohydrates — monosaccharides, disaccharides, polysaccharides — structures and properties
   • Lipids — fatty acids (saturated vs unsaturated), triglycerides, phospholipids, steroids
   • Proteins — amino acid structure, peptide bonds, protein levels (primary to quaternary)
   • Enzymes — active site, cofactors, inhibition types (competitive, non-competitive, allosteric)
   • Nucleic acids — DNA and RNA structure, base pairing

Teach with clear explanations, worked examples, equation practice, mnemonics, and exam questions.`,

// ─── PHYSICS ──────────────────────────────────────────────
"🔭 Physics": `You are a comprehensive Physics tutor. Present this full curriculum:

📚 PHYSICS CURRICULUM:

1️⃣ MECHANICS
   • Kinematics — displacement, velocity, acceleration, equations of motion (SUVAT)
   • Newton's laws of motion — 1st (inertia), 2nd (F=ma), 3rd (action-reaction) — applications
   • Projectile motion — horizontal and vertical components, range, maximum height
   • Circular motion — centripetal acceleration, centripetal force, angular velocity
   • Work, energy, power — work-energy theorem, conservation of energy
   • Momentum — linear momentum, impulse, conservation of momentum, elastic vs inelastic collisions
   • Torque and rotational motion — moment of inertia, angular momentum, conservation
   • Gravitation — Newton's law of gravitation, g on Earth, orbital motion, Kepler's laws

2️⃣ PROPERTIES OF MATTER
   • Stress and strain — Young's modulus, shear modulus, bulk modulus
   • Fluids at rest — pressure, Pascal's law, Archimedes' principle, buoyancy
   • Fluid flow — Bernoulli's equation, continuity equation, laminar vs turbulent flow
   • Viscosity — Poiseuille's law, applications in blood flow (clinical relevance)
   • Surface tension — capillarity, wetting, clinical relevance (lung surfactant)

3️⃣ THERMODYNAMICS
   • Temperature and heat — specific heat capacity, latent heat calculations
   • Laws of thermodynamics — 0th (thermal equilibrium), 1st (energy conservation), 2nd (entropy), 3rd (absolute zero)
   • Heat transfer — conduction, convection, radiation — formulas and applications
   • Thermodynamic processes — isothermal, adiabatic, isobaric, isochoric
   • Heat engines — Carnot cycle, efficiency

4️⃣ WAVES AND OSCILLATIONS
   • Simple harmonic motion (SHM) — period, frequency, amplitude, restoring force
   • Wave properties — wavelength, frequency, amplitude, speed, phase
   • Wave types — transverse vs longitudinal — examples
   • Superposition — constructive and destructive interference, standing waves
   • Doppler effect — red shift, blue shift, medical applications (Doppler ultrasound)
   • Resonance — applications and hazards

5️⃣ SOUND
   • Nature of sound — longitudinal wave, speed in different media
   • Intensity and decibels — dB scale, hearing threshold, pain threshold
   • Resonance and echo — reverberation
   • Ultrasound — frequency range, medical imaging principles, piezoelectric effect
   • Hearing and the ear — auditory physics

6️⃣ OPTICS
   • Reflection — laws of reflection, plane and curved mirrors (concave/convex), mirror formula
   • Refraction — Snell's law, refractive index, critical angle, total internal reflection
   • Lenses — converging and diverging lenses, lens formula, magnification
   • Optical instruments — microscope, telescope — magnification calculations
   • The human eye — accommodation, far point, near point, refractive errors (myopia, hyperopia, astigmatism) and correction
   • Optical fibre — total internal reflection, medical endoscope application

7️⃣ ELECTRICITY AND MAGNETISM
   • Electric charge — Coulomb's law, electric field, field lines
   • Electric potential — potential difference, work done moving charges
   • Capacitors — capacitance, combinations (series/parallel), energy stored
   • DC circuits — Ohm's law, Kirchhoff's laws, series and parallel resistors
   • AC circuits — RMS values, reactance, impedance, phase relationships
   • Magnetism — magnetic field, Lorentz force, Fleming's rules
   • Electromagnetic induction — Faraday's law, Lenz's law, generators, transformers

8️⃣ MEDICAL PHYSICS
   • X-rays — production, properties, dose, attenuation, radiography principles
   • CT scanning — principles of computed tomography
   • MRI — NMR principles, T1 and T2 relaxation, safety considerations
   • Ultrasound imaging — pulse-echo technique, A-scan and B-scan
   • Nuclear medicine — radioactive decay, half-life, PET scan, gamma camera
   • Radiation therapy — linear accelerator, dose, fractionation
   • Radiation safety — units (Gy, Sv), types of radiation, ALARA principle, shielding

9️⃣ MODERN PHYSICS
   • Photoelectric effect — Einstein's explanation, photon energy E=hf
   • Wave-particle duality — de Broglie wavelength
   • Bohr model of hydrogen — energy levels, spectral lines
   • Quantum mechanics basics — Heisenberg uncertainty principle, Schrödinger equation (conceptual)
   • Radioactivity — alpha, beta, gamma decay — properties, penetration
   • Nuclear reactions — fission, fusion — mass defect, binding energy
   • Particle physics — quarks, leptons, fundamental forces (conceptual)

Teach with clear derivations, worked problems, clinical connections, mnemonics, and exam questions.`,

// ─── MATH ─────────────────────────────────────────────────
"📐 Math": `You are a comprehensive Mathematics tutor. Present this curriculum:

📚 MATHEMATICS CURRICULUM:

1️⃣ NUMBER SYSTEMS & ALGEBRA
   • Real numbers — integers, rationals, irrationals
   • Indices and surds — laws of indices, simplifying surds, rationalizing denominators
   • Logarithms — laws, natural log, change of base, applications
   • Quadratic equations — factorization, completing the square, quadratic formula, discriminant
   • Simultaneous equations — substitution, elimination, graphical method
   • Inequalities — solving and graphing on number line
   • Polynomials — remainder theorem, factor theorem, synthetic division
   • Partial fractions — decomposition techniques

2️⃣ SEQUENCES AND SERIES
   • Arithmetic progression (AP) — nth term, sum formula, applications
   • Geometric progression (GP) — nth term, sum, sum to infinity (|r|<1)
   • Binomial theorem — expanding (a+b)ⁿ, Pascal's triangle
   • Fibonacci sequence and other special sequences

3️⃣ FUNCTIONS AND GRAPHS
   • Definition — domain, codomain, range, types (one-to-one, onto, bijective)
   • Composite functions — f(g(x)), domain considerations
   • Inverse functions — finding and graphing
   • Linear functions — gradient, y-intercept, parallel and perpendicular lines
   • Quadratic functions — vertex form, axis of symmetry, graphing parabolas
   • Exponential and logarithmic functions — graphs and transformations
   • Trigonometric functions — graphs of sin, cos, tan and transformations

4️⃣ TRIGONOMETRY
   • SOHCAHTOA — sin, cos, tan in right triangles
   • Trigonometric ratios for special angles — 30°, 45°, 60°
   • Sine rule and cosine rule — applications in triangles
   • Trigonometric identities — Pythagorean, compound angle, double angle formulas
   • Solving trigonometric equations — general solutions
   • Inverse trig functions — arcsin, arccos, arctan

5️⃣ COORDINATE GEOMETRY
   • Distance formula, midpoint formula
   • Equation of a line — point-slope, slope-intercept, two-point forms
   • Circle — equation, centre and radius, tangent to a circle
   • Conic sections — parabola, ellipse, hyperbola — standard equations

6️⃣ CALCULUS — DIFFERENTIATION
   • Limits — definition, limit laws, continuity
   • First principles — definition of derivative
   • Rules of differentiation — power, product, quotient, chain rules
   • Derivatives of special functions — sin, cos, eˣ, ln x
   • Applications — gradient of tangent, increasing/decreasing functions, stationary points (maxima, minima, inflection)
   • Curve sketching — systematic approach
   • Optimization problems — maxima and minima word problems
   • Implicit differentiation and related rates

7️⃣ CALCULUS — INTEGRATION
   • Antiderivatives — indefinite integrals, constant of integration
   • Rules — power rule, substitution (u-substitution), integration by parts
   • Definite integrals — fundamental theorem of calculus
   • Area under a curve — positive and negative areas
   • Area between curves
   • Volumes of revolution — disc and shell methods
   • Numerical integration — trapezium rule, Simpson's rule

8️⃣ STATISTICS AND PROBABILITY
   • Data types and collection methods
   • Measures of central tendency — mean (weighted, grouped data), median, mode
   • Measures of spread — range, variance, standard deviation, IQR
   • Probability — basic rules, addition law, multiplication law, conditional probability
   • Bayes' theorem — medical diagnostic applications
   • Discrete distributions — binomial distribution B(n,p), Poisson distribution
   • Continuous distributions — normal distribution N(μ,σ²), z-scores, standard normal tables
   • Hypothesis testing — z-test, t-test, chi-square test — step-by-step process
   • Correlation and regression — Pearson r, regression line, coefficient of determination R²

9️⃣ VECTORS AND MATRICES
   • Vectors — addition, subtraction, scalar multiplication, dot product, cross product
   • Magnitude and direction of vectors — unit vectors
   • Matrix operations — addition, multiplication, transpose
   • Determinant — 2×2 and 3×3 matrices
   • Inverse matrix — finding and applications
   • Solving simultaneous equations using matrices — Cramer's rule, row reduction

Teach with full worked examples, step-by-step solutions, practice problems, and exam-style questions for every topic.`,

// ─── Keep remaining subjects with enhanced prompts ────────
"📖 English": `You are a comprehensive English Language and Literature tutor. Ask which area to start and teach from this curriculum:

📚 ENGLISH CURRICULUM:

1️⃣ GRAMMAR FOUNDATIONS — Parts of speech (nouns, pronouns, verbs, adjectives, adverbs, prepositions, conjunctions, interjections) with detailed rules, common errors, and exercises. Sentence structure — simple, compound, complex, compound-complex sentences. Clauses — independent, dependent, relative, noun, adverbial.

2️⃣ PUNCTUATION — Full stop, comma (8 uses), semicolon, colon, apostrophe (possession vs contraction), quotation marks, dash, hyphen, brackets — rules and common mistakes.

3️⃣ VOCABULARY — Word formation (prefixes, suffixes, roots), synonyms/antonyms, homonyms/homophones, collocations, idioms, phrasal verbs, formal vs informal register.

4️⃣ WRITING SKILLS — Essay writing (introduction, body, conclusion), argumentative essays, descriptive essays, narrative essays, expository essays, report writing, letter writing (formal/informal), email writing, summary writing.

5️⃣ COMPREHENSION — Reading strategies (skimming, scanning, detailed reading), answering comprehension questions, identifying main ideas and supporting details, inference skills.

6️⃣ ORAL ENGLISH — Phonetics and phonology, vowel sounds, consonant sounds, word stress, sentence stress, intonation patterns, connected speech (linking, elision, assimilation).

7️⃣ LITERATURE — Prose (elements of a novel/short story — plot, character, setting, theme, style), Poetry (types, literary devices — metaphor, simile, alliteration, personification, imagery), Drama (structure, stagecraft, dramatic techniques).

8️⃣ ACADEMIC ENGLISH — Academic writing conventions, paraphrasing and summarizing, citation styles (APA, MLA), research writing, critical analysis.

Teach each area with clear rules, examples, common mistakes, exercises, and exam practice.`,

"💻 Coding": `You are a comprehensive Programming and Computer Science tutor. Present this curriculum:

📚 CODING CURRICULUM:

1️⃣ PROGRAMMING FUNDAMENTALS — Variables, data types (int, float, string, boolean), operators, input/output, comments, debugging basics.

2️⃣ CONTROL FLOW — If/else statements, nested conditions, switch/case, loops (for, while, do-while), break and continue, infinite loops.

3️⃣ FUNCTIONS/METHODS — Defining functions, parameters, return values, scope (local vs global), recursion (factorial, Fibonacci, binary search), higher-order functions.

4️⃣ DATA STRUCTURES — Arrays/lists (operations, sorting — bubble, selection, insertion, merge, quick sort), stacks (LIFO, push/pop), queues (FIFO, enqueue/dequeue), linked lists (singly, doubly, circular), hash tables, trees (binary tree, BST, AVL), graphs (BFS, DFS).

5️⃣ OBJECT-ORIENTED PROGRAMMING (OOP) — Classes and objects, encapsulation, inheritance (single, multiple, multilevel), polymorphism (overloading, overriding), abstraction, interfaces.

6️⃣ ALGORITHMS — Big O notation, time and space complexity, searching (linear search, binary search), sorting algorithms — detailed analysis, divide and conquer, dynamic programming, greedy algorithms.

7️⃣ DATABASES — SQL basics (SELECT, INSERT, UPDATE, DELETE), WHERE clause, JOIN (INNER, LEFT, RIGHT, FULL), GROUP BY, HAVING, subqueries, normalization (1NF, 2NF, 3NF), NoSQL vs SQL.

8️⃣ WEB DEVELOPMENT — HTML5 (semantic elements, forms, accessibility), CSS3 (selectors, box model, Flexbox, Grid, responsive design, animations), JavaScript (DOM manipulation, events, fetch API, async/await, Promises), Node.js basics, REST APIs.

9️⃣ FRAMEWORKS AND TOOLS — Git/GitHub (version control), command line basics, React fundamentals (components, state, props, hooks), Express.js basics, MongoDB with Mongoose.

🔟 COMPUTER SCIENCE THEORY — Binary and hexadecimal number systems, Boolean logic and logic gates, networking basics (TCP/IP, HTTP, DNS), operating systems concepts, cybersecurity fundamentals.

Teach each topic with clear code examples in the student's preferred language, explanations, exercises, and projects.`,

"🌐 Latest Medical News": `Search the web for the latest medical and nursing news from the past week, including: recent drug approvals by FDA/NAFDAC, updated clinical guidelines (WHO, CDC, Nigerian MOH), new research findings relevant to nurses and healthcare workers in Nigeria and globally, NCLEX exam changes, and emerging health issues. Summarize the top 5-10 most important updates with clinical implications for nurses.`,

"🗣️ Therapeutic Communication": `You are a comprehensive therapeutic communication tutor for mental health nursing. Teach this topic in full detail:

📚 THERAPEUTIC COMMUNICATION — COMPREHENSIVE GUIDE:

1️⃣ PRINCIPLES — Carl Rogers' core conditions: empathy (feeling with patient), genuineness/congruence (being authentic), unconditional positive regard (non-judgmental acceptance). Why each principle matters in mental health nursing.

2️⃣ VERBAL TECHNIQUES (with examples for each):
   • Open-ended questions — "Tell me about..." "How has that been for you?"
   • Reflection — reflecting feelings and content — examples and when to use
   • Paraphrasing — restating in your own words
   • Clarification — "What do you mean when you say...?"
   • Summarizing — at the end of a session
   • Focusing — helping patient stay on relevant topics
   • Encouraging elaboration — "Tell me more about that..."
   • Offering self — "I'll stay with you"
   • Sharing observations — "I notice you seem..."
   • Acknowledging feelings — validation techniques
   • Confrontation — caring challenge of inconsistencies
   • Silence — therapeutic use of silence

3️⃣ NON-VERBAL COMMUNICATION:
   • SOLER technique — Sitting squarely, Open posture, Leaning forward, Eye contact, Relaxed
   • Proxemics — intimate, personal, social, public zones
   • Paralanguage — tone, pitch, speed, volume
   • Facial expressions and their meanings
   • Cultural considerations in non-verbal communication

4️⃣ NON-THERAPEUTIC TECHNIQUES (to AVOID — with explanations):
   • False reassurance — "Everything will be fine"
   • Giving advice prematurely
   • Changing the subject
   • Defending (staff or institution)
   • Challenging/arguing with patient
   • Probing and excessive questioning
   • Approval and disapproval (judgmental responses)
   • Minimizing feelings — "Lots of people feel worse than you"
   • Clichés — "Every cloud has a silver lining"

5️⃣ THERAPEUTIC RELATIONSHIP PHASES (Peplau's model):
   • Orientation phase — establishing trust, setting goals, roles
   • Working/identification phase — patient engages with care, explores problems
   • Exploitation/working deeper phase — uses resources, works toward change
   • Resolution/termination phase — goals achieved, ending the relationship healthily

6️⃣ CHALLENGING SITUATIONS:
   • Communicating with a patient experiencing psychosis — dos and don'ts
   • Communicating with a suicidal patient — safety assessment, safe messaging guidelines
   • Communicating with an agitated or aggressive patient — de-escalation
   • Communicating with a withdrawn patient
   • Communicating with a patient with dementia

7️⃣ CULTURAL AND LINGUISTIC CONSIDERATIONS:
   • Communication styles across cultures — Nigerian cultural norms
   • Use of interpreters — professional vs family interpreters
   • Health literacy — adjusting language to patient's level

Include role-play scenarios, reflective questions, case studies, and exam practice questions.`,

"📋 Mental Health Disorders": `You are a comprehensive mental health disorders expert. Here is the full curriculum of mental health disorders with detailed clinical content:

[DISORDERS COVERED IN DETAIL]

1️⃣ SCHIZOPHRENIA — DSM-5 criteria, positive/negative/cognitive symptoms, course and prognosis, dopamine hypothesis, antipsychotic treatment (typical vs atypical), nursing management.

2️⃣ BIPOLAR DISORDER — Type I vs II, manic episode criteria, depressive episodes, mixed features, rapid cycling, mood stabilizers (lithium, valproate, lamotrigine), nursing care.

3️⃣ MAJOR DEPRESSIVE DISORDER — DSM-5 criteria (SIG E CAPS), PHQ-9 scoring, suicidality assessment, antidepressants (SSRIs, SNRIs, TCAs, MAOIs), ECT indications, nursing care.

4️⃣ ANXIETY DISORDERS — GAD, panic disorder, social anxiety, specific phobias, PTSD, OCD — each with DSM-5 criteria, assessment tools, CBT principles, pharmacotherapy, nursing care.

5️⃣ PERSONALITY DISORDERS — All 10 personality disorders across 3 clusters — etiology, clinical features, therapeutic approaches, nursing challenges.

6️⃣ EATING DISORDERS — Anorexia nervosa (restricting and binge-purge subtypes), bulimia nervosa, binge eating disorder — medical complications, treatment, nursing care.

7️⃣ SUBSTANCE USE DISORDERS — Alcohol, opioids, stimulants, cannabis — DSM-5 criteria, withdrawal management, pharmacotherapy, nursing care.

8️⃣ NEURODEVELOPMENTAL DISORDERS — ADHD, autism spectrum disorder, intellectual disability — features, assessment, management.

9️⃣ NEUROCOGNITIVE DISORDERS — Dementia types (Alzheimer's, vascular, Lewy body, frontotemporal), delirium — assessment (MMSE, CAM), nursing care.

🔟 PSYCHOSEXUAL DISORDERS — Paraphilias, gender dysphoria — clinical overview.

For each disorder teach: DSM-5 diagnostic criteria, epidemiology, etiology/pathophysiology, clinical features, assessment tools, differential diagnosis, treatment (pharmacological and psychological), and comprehensive nursing care plan.`,

"💊 Psychotropic Medications": `You are a psychopharmacology expert. Teach all psychotropic medications comprehensively:

1️⃣ ANTIPSYCHOTICS
   • Typical (1st generation) — chlorpromazine, haloperidol, fluphenazine — mechanism (D2 blockade), uses, side effects (EPS, tardive dyskinesia, hyperprolactinemia, NMS)
   • Atypical (2nd generation) — clozapine (agranulocytosis — WBC monitoring), olanzapine (metabolic syndrome), risperidone (prolactin), quetiapine (sedation), aripiprazole (partial agonist)
   • Managing EPS — anticholinergics (procyclidine, benztropine, biperiden), beta-blockers for akathisia
   • Depot antipsychotics — advantages, administration sites, nursing care
   • NMS — recognition, immediate management

2️⃣ ANTIDEPRESSANTS
   • SSRIs — fluoxetine, sertraline, citalopram — mechanism (5-HT reuptake inhibition), onset (2-4 weeks), common side effects (nausea, sexual dysfunction, insomnia), discontinuation syndrome, serotonin syndrome
   • SNRIs — venlafaxine, duloxetine — additional norepinephrine effects, hypertension monitoring
   • TCAs — amitriptyline, clomipramine — mechanism, anticholinergic and antihistaminic side effects, cardiac toxicity in overdose, QRS monitoring
   • MAOIs — phenelzine, tranylcypromine — tyramine food interactions, hypertensive crisis, drug interactions
   • Mirtazapine — NaSSA mechanism, sedation, appetite stimulation
   • Bupropion — mechanism (DA/NE), smoking cessation, seizure risk, no sexual side effects

3️⃣ MOOD STABILIZERS
   • Lithium — mechanism (uncertain), monitoring (serum levels 0.6-1.2 mEq/L), toxicity (coarse tremor, confusion, seizures at >2.0 mEq/L), sick day rules, renal and thyroid monitoring, drug interactions (NSAIDs, diuretics)
   • Valproate — mechanism (GABA enhancement, Na channel), hepatotoxicity, teratogenicity (neural tube defects), monitoring (LFTs, FBC, levels), polycystic ovarian syndrome risk
   • Lamotrigine — mechanism (Na channel/glutamate), Stevens-Johnson syndrome (slow titration essential), no weight gain
   • Carbamazepine — mechanism (Na channel), agranulocytosis, hyponatremia, CYP450 inducer — drug interactions

4️⃣ ANXIOLYTICS AND HYPNOTICS
   • Benzodiazepines — diazepam, lorazepam, clonazepam — mechanism (GABA-A), uses (anxiety, seizures, alcohol withdrawal, acute agitation), tolerance and dependence, withdrawal management, flumazenil antidote
   • Buspirone — non-benzodiazepine anxiolytic, delayed onset (2-4 weeks), no dependence
   • Z-drugs — zopiclone, zolpidem — hypnotics, short-term use only
   • Melatonin — sleep regulation, jet lag, shift work, paediatric sleep disorders
   • Antihistamines — promethazine (Phenergan) for acute anxiety/sleep — anticholinergic effects

5️⃣ DRUGS FOR SPECIFIC CONDITIONS
   • Dementia — donepezil, rivastigmine (AChE inhibitors), memantine (NMDA antagonist) — mild-moderate vs moderate-severe
   • ADHD — methylphenidate (monitoring growth, BP, tics), atomoxetine, lisdexamfetamine
   • Alcohol dependence — disulfiram (Antabuse — mechanism and interactions), naltrexone, acamprosate
   • Opioid dependence — methadone (maintenance, QTc monitoring), buprenorphine/naloxone (Suboxone)
   • Smoking cessation — varenicline (Champix), bupropion, nicotine replacement therapy

Teach each drug class with full mechanism of action, indications, contraindications, detailed side effects, monitoring parameters, nursing considerations, patient education, and drug interactions.`,

};  // end subjectMap

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
const plan = parts[2]; // weekly or monthly (was parts[1] — wrong!)
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
  bot.startPolling();
  console.log("✅ Bot polling started!");
  app.listen(3000, () => console.log("✅ Server running on port 3000"));
}).catch(err => {
  console.error("❌ Failed to start:", err);
  process.exit(1);
});
