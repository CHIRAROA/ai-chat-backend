require("dotenv").config();

const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const OpenAI = require("openai");
const { GoogleGenAI } = require("@google/genai");

const app = express();

app.use(cors());
app.use(express.json());
						
// ====================== API KEY CHECKS ======================
if (!process.env.GROQ_API_KEY) {
  console.log("GROQ_API_KEY not found in .env file");
}

if (!process.env.GEMINI_API_KEY) {
  console.log("GEMINI_API_KEY not found in .env file");
}

if (!process.env.DB_HOST) {
  console.log("DB_HOST not found in .env file");
}

// ====================== API CLIENTS ======================
const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

const gemini = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// ====================== MYSQL CONNECTION ======================
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 4000, // TiDB uses 4000
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: "utf8mb4",
  ssl: {
    minVersion: "TLSv1.2",
    rejectUnauthorized: true,
  },
});

db.connect((err) => {
  if (err) {
    console.log("Database connection failed:", err);
  } else {
    console.log("MySQL Connected");
  }
});

// ====================== TEST ROUTE ======================
app.get("/", (req, res) => {
  res.send("Server is running");
});

const PORT = process.env.PORT || 5000;

// ====================== SIGNUP API ======================
app.post("/signup", (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: "Name, email and password are required" });
  }

  const checkSql = "SELECT * FROM users WHERE email = ?";

  db.query(checkSql, [email], (checkErr, checkResult) => {
    if (checkErr) {
      console.log("Signup check error:", checkErr);
      return res.status(500).json({ error: "Database error during signup" });
    }

    if (checkResult.length > 0) {
      return res.status(400).json({ error: "Email already registered" });
    }

    const sql = "INSERT INTO users (name, email, password) VALUES (?, ?, ?)";

    db.query(sql, [name, email, password], (err, result) => {
      if (err) {
        console.log("Signup error:", err);
        return res.status(500).json({ error: "Signup failed" });
      }

      res.json({
        message: "User registered successfully",
        userId: result.insertId,
      });
    });
  });
});

// ====================== LOGIN API ======================
app.post("/login", (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  const sql = "SELECT * FROM users WHERE email = ? AND password = ?";

  db.query(sql, [email, password], (err, result) => {
    if (err) {
      console.log("Login error:", err);
      return res.status(500).json({ error: "Login failed" });
    }

    if (result.length > 0) {
      return res.json({
        message: "Login successful",
        user_id: result[0].user_id,
        name: result[0].name,
      });
    } else {
      return res.status(401).json({ error: "Invalid email or password" });
    }
  });
});

// ====================== CREATE CHAT API ======================
app.post("/chats", (req, res) => {
  const { user_id, chat_title, is_private } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: "user_id is required" });
  }

  const sql = "INSERT INTO chats (user_id, chat_title, is_private) VALUES (?, ?, ?)";

  db.query(sql, [user_id, chat_title || "New Chat", is_private ? 1 : 0], (err, result) => {
    if (err) {
      console.log("Error creating chat:", err);
      return res.status(500).json({ error: "Failed to create chat" });
    }

    res.json({
      message: "Chat created successfully",
      chatId: result.insertId,
      is_private: is_private ? 1 : 0,
    });
  });
});

// ====================== GET USER CHATS API ======================
app.get("/chats/:userId", (req, res) => {
  const userId = req.params.userId;
  const mode = req.query.mode || "normal";

  let sql = "";
  let values = [];

  if (mode === "private") {
    sql = `
      SELECT * FROM chats
      WHERE user_id = ? AND is_private = 1
      ORDER BY created_at DESC, chat_id DESC
    `;
    values = [userId];
  } else {
    sql = `
      SELECT * FROM chats
      WHERE user_id = ? AND is_private = 0
      ORDER BY created_at DESC, chat_id DESC
    `;
    values = [userId];
  }

  db.query(sql, values, (err, result) => {
    if (err) {
      console.log("Error fetching chats:", err);
      return res.status(500).json({ error: "Failed to fetch chats" });
    }

    res.json(result);
  });
});

// ====================== GET ALL CHATS API ======================
app.get("/chats", (req, res) => {
  const sql = "SELECT * FROM chats ORDER BY chat_id DESC";

  db.query(sql, (err, result) => {
    if (err) {
      console.log("Error fetching all chats:", err);
      return res.status(500).json({ error: "Database error" });
    }

    res.json(result);
  });
});

// ====================== MARK CHAT PRIVATE API ======================
app.put("/chats/:chatId/private", (req, res) => {
  const chatId = req.params.chatId;

  const sql = "UPDATE chats SET is_private = 1 WHERE chat_id = ?";

  db.query(sql, [chatId], (err, result) => {
    if (err) {
      console.log("Error updating private chat:", err);
      return res.status(500).json({ error: "Failed to mark chat as private" });
    }

    res.json({
      success: true,
      message: "Chat marked as private",
      affectedRows: result.affectedRows,
    });
  });
});

// ====================== GET MESSAGES API ======================
app.get("/messages/:chatId", (req, res) => {
  const chatId = req.params.chatId;

  const sql = "SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp ASC, message_id ASC";

  db.query(sql, [chatId], (err, result) => {
    if (err) {
      console.log("Error fetching messages:", err);
      return res.status(500).json({ error: "Failed to fetch messages" });
    }

    res.json(result);
  });
});

// ====================== SEND MESSAGE API ======================
app.post("/messages", (req, res) => {
  const { chat_id, message_text, ai_provider } = req.body;

  if (!chat_id || !message_text) {
    return res.status(400).json({ error: "chat_id and message_text are required" });
  }

  console.log("Selected provider from frontend:", ai_provider);

  const userSql =
    "INSERT INTO messages (chat_id, sender, message_text) VALUES (?, 'user', ?)";

  db.query(userSql, [chat_id, message_text], async (err) => {
    if (err) {
      console.log("Error saving user message:", err);
      return res.status(500).json({ error: "DB error while saving user message" });
    }

    const generatedTitle = generateChatTitle(message_text);

    const updateTitleSql = `
      UPDATE chats
      SET chat_title = ?
      WHERE chat_id = ?
      AND (chat_title = 'New Chat' OR chat_title IS NULL OR chat_title = '')
    `;

    db.query(updateTitleSql, [generatedTitle, chat_id], async (titleErr) => {
      if (titleErr) {
        console.log("Error updating chat title:", titleErr);
      }

      try {
        const history = await getConversationHistory(chat_id);
        const aiReply = await getAIReply(history, ai_provider);

        const aiSql =
          "INSERT INTO messages (chat_id, sender, message_text) VALUES (?, 'ai', ?)";

        db.query(aiSql, [chat_id, aiReply], (err2) => {
          if (err2) {
            console.log("Error saving AI message:", err2);
            return res.status(500).json({ error: "DB error while saving AI reply" });
          }

          res.json({
            success: true,
            userMessage: message_text,
            aiMessage: aiReply,
            chatTitle: generatedTitle,
          });
        });
      } catch (apiError) {
        console.log("API Error Status:", apiError?.status);
        console.log("API Error Message:", apiError?.message);
        console.log("Full API Error:", apiError);

        let fallbackReply = "Sorry, AI service is not available right now.";

        if (apiError?.status === 401) {
          fallbackReply = `Invalid API key for ${ai_provider}.`;
        } else if (apiError?.status === 429) {
          fallbackReply = `Rate limit or quota exceeded for ${ai_provider}.`;
        }

        const aiSql =
          "INSERT INTO messages (chat_id, sender, message_text) VALUES (?, 'ai', ?)";

        db.query(aiSql, [chat_id, fallbackReply], (err2) => {
          if (err2) {
            console.log("Error saving fallback AI message:", err2);
            return res.status(500).json({ error: "DB error while saving fallback reply" });
          }

          res.json({
            success: false,
            userMessage: message_text,
            aiMessage: fallbackReply,
            chatTitle: generatedTitle,
            error: "API call failed",
          });
        });
      }
    });
  });
});

// ====================== START SERVER ======================

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});

// ====================== HELPER FUNCTION: GET CONVERSATION HISTORY ======================
function getConversationHistory(chat_id) {
  return new Promise((resolve, reject) => {
    const sql = `
      SELECT sender, message_text
      FROM messages
      WHERE chat_id = ?
      ORDER BY timestamp ASC, message_id ASC
    `;

    db.query(sql, [chat_id], (err, result) => {
      if (err) {
        return reject(err);
      }

      const history = result.map((msg) => ({
        sender: msg.sender,
        message_text: msg.message_text,
      }));

      resolve(history.slice(-10));
    });
  });
}

// ====================== HELPER FUNCTION FOR AI ======================
async function getAIReply(history, ai_provider) {
  let aiReply = "";
  const provider = (ai_provider || "").toLowerCase();

  console.log("Normalized provider:", provider);

  if (provider === "gemini") {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("Gemini API key missing");
    }

    const geminiContents = [
      {
        role: "user",
        parts: [
          {
            text:
              "Answer in a clean and readable way. You may use markdown for headings, bullet points, numbered lists, tables, and code blocks when needed. Do not use LaTeX unless the user asks for it.",
          },
        ],
      },
    ];

    history.forEach((msg) => {
      if (msg.sender === "user") {
        geminiContents.push({
          role: "user",
          parts: [{ text: msg.message_text }],
        });
      } else {
        geminiContents.push({
          role: "model",
          parts: [{ text: msg.message_text }],
        });
      }
    });

    const geminiResponse = await gemini.models.generateContent({
      model: "gemini-2.5-flash",
      contents: geminiContents,
    });

    aiReply = geminiResponse.text || "No response from Gemini.";
  } else if (
    provider === "grok" ||
    provider === "claude" ||
    provider === "chatgpt"
  ) {
    if (!process.env.GROQ_API_KEY) {
      throw new Error("Groq API key missing");
    }

    const groqMessages = [
      {
        role: "system",
        content: `You are a helpful AI assistant.

IMPORTANT RULES:
- Keep answers clean and readable
- Use markdown when needed for headings, bullet points, numbered lists, tables, and code blocks
- Do not use LaTeX unless the user asks for it
- The user selected ${ai_provider}`,
      },
    ];

    history.forEach((msg) => {
      if (msg.sender === "user") {
        groqMessages.push({
          role: "user",
          content: msg.message_text,
        });
      } else {
        groqMessages.push({
          role: "assistant",
          content: msg.message_text,
        });
      }
    });

    const groqResponse = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: groqMessages,
      temperature: 0.7,
      max_tokens: 300,
    });

    aiReply =
      groqResponse.choices[0].message.content ||
      `No response from ${ai_provider}`;
  } else {
    aiReply = `${ai_provider || "This model"} is not connected yet.`;
  }

  return aiReply;
}

// ====================== HELPER FUNCTION FOR CHAT TITLE ======================
function generateChatTitle(message) {
  const words = message.trim().split(/\s+/).slice(0, 5);
  return words.join(" ");
}