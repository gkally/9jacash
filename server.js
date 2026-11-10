const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const crypto = require("crypto");
const app = express();
const PORT = process.env.PORT || 1000;

// Dynamic import for node-fetch v3+
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// ========== JSONBin CONFIGURATION ==========
const JSONBIN_API_KEY = '$2a$10$KfWK47Dmzq1NBJ/I6yvwMeJy1.Ntk5f9Ub1TIUSfeFoEXaPLHPuNG';
const USERS_BIN_ID = '6aeeb979ac6210605a747452';
const PAYCODES_BIN_ID = '6af2dfb0ac6210605a7c673c'; // <-- YOUR NEW PAYCODES BIN ID

const USERS_URL = `https://api.jsonbin.io/v3/b/${USERS_BIN_ID}`;
const PAYCODES_URL = `https://api.jsonbin.io/v3/b/${PAYCODES_BIN_ID}`;

const headers = {
  'Content-Type': 'application/json',
  'X-Master-Key': JSONBIN_API_KEY,
  'X-Bin-Version': 'latest'
};

app.use(express.json());
app.use(express.static("public"));
app.use(cookieParser());
app.use(cors());

// Admin session store
const adminTokens = new Map();
const ADMIN_PIN = "338989";
const ADMIN_SESSION_DURATION = 3600000;

function generateAdminToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isAdminAuthenticated(req) {
  const token = req.cookies?.admin_token;
  if (!token) return false;
  const expiry = adminTokens.get(token);
  if (!expiry || Date.now() > expiry) {
    adminTokens.delete(token);
    return false;
  }
  return true;
}

// ========== REFERRAL HELPER FUNCTIONS ==========
function generateReferralCode(phone, fullName) {
  const randomPart = crypto.randomBytes(3).toString('hex').toUpperCase();
  const namePart = fullName.replace(/\s/g, '').slice(0, 2).toUpperCase();
  return `${namePart}${randomPart}`.slice(0, 6);
}

async function isReferralCodeUnique(code, users) {
  return !users.some(user => user.referralCode === code);
}

async function getUniqueReferralCode(phone, fullName, users) {
  let code = generateReferralCode(phone, fullName);
  let attempts = 0;
  while (!(await isReferralCodeUnique(code, users)) && attempts < 5) {
    code = generateReferralCode(phone, fullName + attempts);
    attempts++;
  }
  return code;
}

// ========== JSONBin Helpers ==========
async function readJSONBin(url) {
  try {
    const response = await fetch(url, { method: 'GET', headers: headers });
    if (response.status === 404) return [];
    if (!response.ok) {
      const errText = await response.text();
      console.error(`❌ JSONBin Read Error [${response.status}]:`, errText);
      return [];
    }
    const data = await response.json();
    return data.record || [];
  } catch (error) {
    console.error('❌ JSONBin Connection Error:', error.message);
    return [];
  }
}

async function writeJSONBin(url, data) {
  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: headers,
      body: JSON.stringify(data)
    });
    if (!response.ok) {
      const errText = await response.text();
      console.error(`❌ JSONBin Write Error [${response.status}]:`, errText);
      return null;
    }
    return await response.json();
  } catch (error) {
    console.error('❌ JSONBin Write Connection Error:', error.message);
    return null;
  }
}

const readUsers = async () => await readJSONBin(USERS_URL);
const writeUsers = async (data) => await writeJSONBin(USERS_URL, data);

const readPayCodes = async () => await readJSONBin(PAYCODES_URL);
const writePayCodes = async (data) => await writeJSONBin(PAYCODES_URL, data);

// ========== MIGRATION: Add referral fields to existing users ==========
async function initializeJSONBin() {
  try {
    let users = await readUsers();
    if (!Array.isArray(users)) { await writeUsers([]); users = []; }
    if (users.length === 0) await writeUsers([]);

    let paycodes = await readPayCodes();
    if (!Array.isArray(paycodes)) { await writePayCodes([]); paycodes = []; }
    if (paycodes.length === 0) await writePayCodes([]);

    console.log('✅ JSONBins ready (Users & PayCodes)');
  } catch (error) {
    console.error('❌ Error initializing JSONBin:', error.message);
  }
}

// ========== USER ROUTES ==========

// **REGISTRATION with Referral Support**
app.post("/register", async (req, res) => {
  try {
    const { fullName, phone, pin, referralCode } = req.body;

    if (!fullName || !phone || !pin) return res.status(400).json({ message: "All fields are required" });

    let users = await readUsers();
    if (users.some(user => user.phone === phone)) return res.status(400).json({ message: "Phone number already registered" });

    let referrer = null;
    let referralBonus = 0;

    if (referralCode && referralCode.trim() !== "") {
      referrer = users.find(user => user.referralCode === referralCode);
      if (!referrer) return res.status(400).json({ message: "Invalid referral code" });
      if (referrer.phone === phone) return res.status(400).json({ message: "You cannot refer yourself" });
      referralBonus = 500;
    }

    const newUser = {
      fullName, phone, pin,
      balance: 90000 + referralBonus,
      active: true,
      transactions: [],
      referralCode: await getUniqueReferralCode(phone, fullName, users),
      referredBy: referrer ? referrer.phone : null,
      referralCount: 0,
      referredUsers: []
    };

    if (referrer) {
      newUser.transactions.push({
        type: "credit", amount: 500, receiver: "Referral Bonus", bank: "System", account: "Referral",
        description: `Bonus from referring user ${referrer.fullName}`,
        date: new Date().toLocaleString(), timestamp: new Date().toISOString(), balanceAfter: newUser.balance
      });
    }

    newUser.transactions.push({
      type: "credit", amount: 90000, receiver: "Registration Bonus", bank: "System", account: "Welcome",
      description: "Welcome bonus for joining",
      date: new Date().toLocaleString(), timestamp: new Date().toISOString(), balanceAfter: newUser.balance
    });

    if (referrer) {
      const referrerIndex = users.findIndex(u => u.phone === referrer.phone);
      if (referrerIndex !== -1) {
        users[referrerIndex].balance += 1000;
        users[referrerIndex].referralCount = (users[referrerIndex].referralCount || 0) + 1;
        users[referrerIndex].referredUsers = users[referrerIndex].referredUsers || [];
        users[referrerIndex].referredUsers.push(phone);
        users[referrerIndex].transactions.push({
          type: "credit", amount: 1000, receiver: "Referral Reward", bank: "System", account: "Referral",
          description: `Bonus for referring ${fullName}`,
          date: new Date().toLocaleString(), timestamp: new Date().toISOString(), balanceAfter: users[referrerIndex].balance
        });
      }
    }

    users.push(newUser);
    await writeUsers(users);

    res.cookie("phone", phone, { httpOnly: true, maxAge: 3600000 });
    res.json({
      message: `Registration successful!${referrer ? ' Referral bonus applied!' : ''}`,
      redirect: "/dashboard.html",
      user: { fullName, phone, balance: newUser.balance, referralCode: newUser.referralCode }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ message: "Registration failed. Please try again." });
  }
});

// **USER LOGIN**
app.post("/login", async (req, res) => {
  try {
    const { phone, pin } = req.body;
    if (!phone || !pin) return res.status(400).json({ message: "Phone and PIN are required" });

    let users = await readUsers();
    const user = users.find(user => user.phone === phone && user.pin === pin);

    if (!user) return res.status(400).json({ message: "Invalid phone or PIN" });
    if (user.active === false) return res.status(403).json({ message: "Account is deactivated. Contact admin." });

    res.cookie("phone", phone, { httpOnly: true, maxAge: 3600000 });
    res.json({
      message: "Login successful",
      redirect: "/dashboard.html",
      user: { fullName: user.fullName, balance: user.balance, referralCode: user.referralCode }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: "Login failed. Please try again." });
  }
});

// **DASHBOARD DATA**
app.get("/dashboard", async (req, res) => {
  try {
    const phone = req.cookies.phone;
    if (!phone) return res.status(401).json({ message: "Unauthorized. Please log in." });

    let users = await readUsers();
    let user = users.find(user => user.phone === phone);

    if (!user) return res.status(400).json({ message: "User not found" });
    if (user.active === false) { res.clearCookie("phone"); return res.status(403).json({ message: "Account deactivated" }); }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const referralLink = `${baseUrl}/register.html?ref=${user.referralCode}`;

    res.json({
      fullName: user.fullName, balance: user.balance, phone: user.phone,
      transactionCount: user.transactions.length, referralCode: user.referralCode,
      referralLink: referralLink, referralCount: user.referralCount || 0
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ message: "Server error" });
  }
});

// **GET USER BALANCE**
app.get("/balance", async (req, res) => {
  try {
    const phone = req.cookies.phone;
    if (!phone) return res.status(401).json({ message: "Unauthorized. Please log in." });

    let users = await readUsers();
    let user = users.find(user => user.phone === phone);

    if (!user) return res.status(400).json({ message: "User not found" });
    if (user.active === false) { res.clearCookie("phone"); return res.status(403).json({ message: "Account deactivated" }); }

    res.json({ balance: user.balance, formattedBalance: `₦${user.balance.toLocaleString()}` });
  } catch (error) {
    console.error('Balance error:', error);
    res.status(500).json({ message: "Server error" });
  }
});

// **TRANSFER MONEY**
app.post("/transfer", async (req, res) => {
  try {
    const phone = req.cookies.phone;
    if (!phone) return res.status(401).json({ message: "Unauthorized. Please log in." });

    const { receiverName, receiverAccount, bank, amount } = req.body;
    if (!receiverName || !receiverAccount || !bank || !amount) return res.status(400).json({ message: "All fields are required" });

    let users = await readUsers();
    let sender = users.find(user => user.phone === phone);

    if (!sender) return res.status(400).json({ message: "User not found" });
    if (sender.active === false) { res.clearCookie("phone"); return res.status(403).json({ message: "Account deactivated" }); }

    const transferAmount = parseFloat(amount);
    if (isNaN(transferAmount) || transferAmount <= 0) return res.status(400).json({ message: "Invalid amount" });

    if (sender.transactions.length === 0 && transferAmount < 100000) {
      return res.status(400).json({ message: "First transfer must be at least ₦100,000", requiredAmount: 100000 });
    }

    if (transferAmount > sender.balance) {
      return res.status(400).json({
        message: `Insufficient funds! Your balance is ₦${sender.balance.toLocaleString()}`,
        depositRedirect: "/dashboard.html", currentBalance: sender.balance, requiredAmount: transferAmount
      });
    }

    sender.balance -= transferAmount;
    const transaction = {
      type: "debit", amount: transferAmount, receiver: receiverName, bank, account: receiverAccount,
      date: new Date().toLocaleString(), timestamp: new Date().toISOString(), balanceAfter: sender.balance
    };

    sender.transactions.push(transaction);
    await writeUsers(users);

    res.json({
      message: "Transfer successful", newBalance: sender.balance,
      formattedBalance: `₦${sender.balance.toLocaleString()}`, transaction: transaction
    });
  } catch (error) {
    console.error('Transfer error:', error);
    res.status(500).json({ message: "Transfer failed. Please try again." });
  }
});

// **TRANSACTION HISTORY**
app.get("/history", async (req, res) => {
  try {
    const phone = req.cookies.phone;
    if (!phone) return res.status(401).json({ message: "Unauthorized. Please log in." });

    let users = await readUsers();
    let user = users.find(user => user.phone === phone);

    if (!user) return res.status(400).json({ message: "User not found" });
    if (user.active === false) { res.clearCookie("phone"); return res.status(403).json({ message: "Account deactivated" }); }

    res.json({
      transactions: user.transactions, totalTransactions: user.transactions.length,
      user: { fullName: user.fullName, balance: user.balance }
    });
  } catch (error) {
    console.error('History error:', error);
    res.status(500).json({ message: "Server error" });
  }
});

// **LOGOUT**
app.post("/logout", (req, res) => {
  res.clearCookie("phone");
  res.json({ message: "Logged out successfully", redirect: "/login.html" });
});

// **CHECK SESSION**
app.get("/check-session", async (req, res) => {
  try {
    const phone = req.cookies.phone;
    if (!phone) return res.json({ loggedIn: false });

    let users = await readUsers();
    let user = users.find(user => user.phone === phone);

    if (!user || user.active === false) { res.clearCookie("phone"); return res.json({ loggedIn: false }); }

    res.json({
      loggedIn: true,
      user: { fullName: user.fullName, phone: user.phone, balance: user.balance, referralCode: user.referralCode }
    });
  } catch (error) {
    console.error('Session check error:', error);
    res.json({ loggedIn: false });
  }
});

// ========== ADMIN ROUTES ==========
app.post("/admin/login", (req, res) => {
  const { pin } = req.body;
  if (pin !== ADMIN_PIN) return res.status(401).json({ message: "Invalid admin access PIN" });

  const token = generateAdminToken();
  adminTokens.set(token, Date.now() + ADMIN_SESSION_DURATION);
  res.cookie("admin_token", token, { httpOnly: true, maxAge: ADMIN_SESSION_DURATION, sameSite: "strict" });
  res.json({ message: "Admin authenticated", success: true });
});

app.post("/admin/logout", (req, res) => {
  const token = req.cookies?.admin_token;
  if (token) adminTokens.delete(token);
  res.clearCookie("admin_token");
  res.json({ message: "Logged out" });
});

function requireAdmin(req, res, next) {
  if (!isAdminAuthenticated(req)) return res.status(403).json({ message: "Admin access required. Please login at /admin.html" });
  next();
}

app.get("/admin/users", requireAdmin, async (req, res) => {
  try {
    let users = await readUsers();
    const safeUsers = users.map(({ pin, ...rest }) => rest);
    res.json({ users: safeUsers });
  } catch (error) {
    console.error('Admin get users error:', error);
    res.status(500).json({ message: "Server error" });
  }
});

app.get("/admin/user/:phone", requireAdmin, async (req, res) => {
  try {
    const phone = req.params.phone;
    let users = await readUsers();
    const user = users.find(u => u.phone === phone);
    if (!user) return res.status(404).json({ message: "User not found" });

    const { pin, ...safeUser } = user;
    res.json({ user: safeUser });
  } catch (error) {
    console.error('Admin get user error:', error);
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/admin/user/credit", requireAdmin, async (req, res) => {
  try {
    const { phone, amount } = req.body;
    if (!phone || amount === undefined) return res.status(400).json({ message: "Phone and amount are required" });

    const creditAmount = parseFloat(amount);
    if (isNaN(creditAmount) || creditAmount <= 0) return res.status(400).json({ message: "Invalid amount" });

    let users = await readUsers();
    const userIndex = users.findIndex(u => u.phone === phone);
    if (userIndex === -1) return res.status(404).json({ message: "User not found" });

    users[userIndex].balance += creditAmount;
    users[userIndex].transactions.push({
      type: "credit", amount: creditAmount, receiver: "Admin Credit", bank: "System", account: "N/A",
      date: new Date().toLocaleString(), timestamp: new Date().toISOString(), balanceAfter: users[userIndex].balance
    });

    await writeUsers(users);
    res.json({ message: `Credited ₦${creditAmount.toLocaleString()} to ${users[userIndex].fullName}`, newBalance: users[userIndex].balance });
  } catch (error) {
    console.error('Admin credit error:', error);
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/admin/user/debit", requireAdmin, async (req, res) => {
  try {
    const { phone, amount } = req.body;
    if (!phone || amount === undefined) return res.status(400).json({ message: "Phone and amount are required" });

    const debitAmount = parseFloat(amount);
    if (isNaN(debitAmount) || debitAmount <= 0) return res.status(400).json({ message: "Invalid amount" });

    let users = await readUsers();
    const userIndex = users.findIndex(u => u.phone === phone);
    if (userIndex === -1) return res.status(404).json({ message: "User not found" });

    if (users[userIndex].balance < debitAmount) return res.status(400).json({ message: "Insufficient balance" });

    users[userIndex].balance -= debitAmount;
    users[userIndex].transactions.push({
      type: "debit", amount: debitAmount, receiver: "Admin Debit", bank: "System", account: "N/A",
      date: new Date().toLocaleString(), timestamp: new Date().toISOString(), balanceAfter: users[userIndex].balance
    });

    await writeUsers(users);
    res.json({ message: `Debited ₦${debitAmount.toLocaleString()} from ${users[userIndex].fullName}`, newBalance: users[userIndex].balance });
  } catch (error) {
    console.error('Admin debit error:', error);
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/admin/user/activate", requireAdmin, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ message: "Phone required" });

    let users = await readUsers();
    const userIndex = users.findIndex(u => u.phone === phone);
    if (userIndex === -1) return res.status(404).json({ message: "User not found" });

    users[userIndex].active = true;
    await writeUsers(users);
    res.json({ message: `User ${users[userIndex].fullName} activated` });
  } catch (error) {
    console.error('Admin activate error:', error);
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/admin/user/deactivate", requireAdmin, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ message: "Phone required" });

    let users = await readUsers();
    const userIndex = users.findIndex(u => u.phone === phone);
    if (userIndex === -1) return res.status(404).json({ message: "User not found" });

    users[userIndex].active = false;
    await writeUsers(users);
    res.json({ message: `User ${users[userIndex].fullName} deactivated` });
  } catch (error) {
    console.error('Admin deactivate error:', error);
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/admin/user/changepin", requireAdmin, async (req, res) => {
  try {
    const { phone, newPin } = req.body;
    if (!phone || !newPin) return res.status(400).json({ message: "Phone and newPin required" });
    if (typeof newPin !== 'string' || newPin.trim().length === 0) return res.status(400).json({ message: "Invalid PIN" });

    let users = await readUsers();
    const userIndex = users.findIndex(u => u.phone === phone);
    if (userIndex === -1) return res.status(404).json({ message: "User not found" });

    users[userIndex].pin = newPin;
    await writeUsers(users);
    res.json({ message: `PIN changed for ${users[userIndex].fullName}` });
  } catch (error) {
    console.error('Admin changepin error:', error);
    res.status(500).json({ message: "Server error" });
  }
});

// ========== NEW: PAY CODE ROUTES ==========

// 1. Admin generates a code
app.post("/admin/generate-paycode", requireAdmin, async (req, res) => {
  try {
    const { username, amount, accountNumber, accountName, bankName } = req.body;
    if (!username || !amount || !accountNumber || !accountName || !bankName) {
      return res.status(400).json({ message: "All fields are required" });
    }

    const code = "PAY-" + crypto.randomBytes(3).toString('hex').toUpperCase();
    
    let paycodes = await readPayCodes();
    const newPayCode = {
      code, username, amount: parseFloat(amount), accountNumber, accountName, bankName,
      status: "pending", timestamp: Date.now()
    };

    paycodes.push(newPayCode);
    await writePayCodes(paycodes);

    res.json({ message: "Code generated successfully", code });
  } catch (error) {
    console.error("Generate code error:", error);
    res.status(500).json({ message: "Server error generating code" });
  }
});

// 2. User verifies the code (Fetches details)
app.get("/pay/verify/:code", async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    let paycodes = await readPayCodes();
    const record = paycodes.find(p => p.code === code);

    if (!record) return res.status(404).json({ message: "Invalid or expired payment code." });
    if (record.status === "used") return res.status(400).json({ message: "This code has already been used." });

    res.json(record);
  } catch (error) {
    res.status(500).json({ message: "Server error verifying code" });
  }
});

// 3. User marks code as used
app.post("/pay/complete", async (req, res) => {
  try {
    const { code } = req.body;
    let paycodes = await readPayCodes();
    const idx = paycodes.findIndex(p => p.code === code.toUpperCase());
    
    if (idx === -1) return res.status(404).json({ message: "Code not found" });
    
    paycodes[idx].status = "used";
    paycodes[idx].usedAt = new Date().toISOString();
    await writePayCodes(paycodes);

    res.json({ message: "Payment confirmed" });
  } catch (error) {
    res.status(500).json({ message: "Server error completing payment" });
  }
});

// ========== TEST ENDPOINT ==========
app.get("/test", (req, res) => {
  res.json({
    status: "OK",
    message: "9jacash API with PayCode features is running perfectly",
    timestamp: new Date().toISOString(),
    bins: {
      usersBinId: USERS_BIN_ID,
      paycodesBinId: PAYCODES_BIN_ID
    },
    referralBonus: { referrer: 1000, newUser: 500 }
  });
});

// ========== START SERVER ==========
app.listen(PORT, async () => {
  console.log(`\n========================================`);
  console.log(`🚀 9jacash Banking Server`);
  console.log(`========================================`);
  console.log(`Server URL: http://localhost:${PORT}`);
  console.log(`Admin Panel: http://localhost:${PORT}/admin.html`);
  console.log(`========================================\n`);

  await initializeJSONBin();
  console.log('✅ Server is ready and connected to JSONBin');
  console.log('✅ Referral bonus: Referrer gets ₦1,000, New user gets ₦500');
  console.log(`✅ Test the server at: http://localhost:${PORT}/test\n`);
});
