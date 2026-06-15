// server.js - GoldHunt Backend for Vercel Serverless
const express = require('express');
const cors = require('cors');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// ==========================================
// TON CONNECT MANIFEST (REQUIRED)
// ==========================================
app.get('/tonconnect-manifest.json', (req, res) => {
  res.json({
    "url": "https://your-project.vercel.app",
    "name": "GoldHunt - Mining Game",
    "iconUrl": "https://your-project.vercel.app/icon.png",
    "termsOfUseUrl": "https://your-project.vercel.app/terms",
    "privacyPolicyUrl": "https://your-project.vercel.app/privacy"
  });
});

// ==========================================
// HEALTH CHECK
// ==========================================
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    time: new Date().toISOString(),
    service: 'GoldHunt API'
  });
});

// ==========================================
// TON CONNECT WALLET CONNECTION ENDPOINT
// ==========================================
app.post('/api/ton-connect', async (req, res) => {
  try {
    const { walletAddress, telegramId } = req.body;
    
    if (!walletAddress || !telegramId) {
      return res.status(400).json({ error: 'Missing walletAddress or telegramId' });
    }

    // Here you would save to Firebase or your database
    // For now, just return success
    res.json({ 
      success: true, 
      walletAddress,
      telegramId,
      connected: true,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('TON Connect error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// ADSGRAM REWARD CALLBACK (if needed)
// ==========================================
app.post('/api/ad-reward', async (req, res) => {
  try {
    const { telegramId, adType, reward } = req.body;
    
    if (!telegramId) {
      return res.status(400).json({ error: 'Missing telegramId' });
    }

    // Process ad reward - update user in Firebase
    res.json({ 
      success: true, 
      telegramId,
      reward: reward || 0,
      message: 'Reward processed'
    });
  } catch (error) {
    console.error('Ad reward error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// REFERRAL VALIDATION
// ==========================================
app.get('/api/validate-referral/:code', async (req, res) => {
  try {
    const { code } = req.params;
    
    if (!code || !/^\d+$/.test(code)) {
      return res.status(400).json({ valid: false, error: 'Invalid referral code' });
    }

    // Check if user exists in Firebase
    // For now, return valid if it's a number
    res.json({ 
      valid: true, 
      referrerId: code,
      referrerName: 'User ' + code
    });
  } catch (error) {
    console.error('Referral validation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// STATIC FILES (for local dev, Vercel handles this)
// ==========================================
if (process.env.NODE_ENV !== 'production') {
  app.use(express.static('public'));
}

// ==========================================
// ERROR HANDLING
// ==========================================
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong!' });
});

// ==========================================
// VERCEL SERVERLESS EXPORT (CRITICAL!)
// ==========================================
// DO NOT use app.listen() on Vercel!
module.exports = app;
