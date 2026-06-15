const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// ==========================================
// TON CONNECT MANIFEST (REQUIRED FOR TON CONNECT)
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
// API ROUTES
// ==========================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    time: new Date().toISOString(),
    service: 'GoldHunt API'
  });
});

// TON Connect wallet save
app.post('/api/ton-connect', async (req, res) => {
  try {
    const { walletAddress, telegramId } = req.body;
    
    if (!walletAddress || !telegramId) {
      return res.status(400).json({ error: 'Missing walletAddress or telegramId' });
    }

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

// Ad reward callback
app.post('/api/ad-reward', async (req, res) => {
  try {
    const { telegramId, adType, reward } = req.body;
    
    if (!telegramId) {
      return res.status(400).json({ error: 'Missing telegramId' });
    }

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

// Referral validation
app.get('/api/validate-referral/:code', async (req, res) => {
  try {
    const { code } = req.params;
    
    if (!code || !/^\d+$/.test(code)) {
      return res.status(400).json({ valid: false, error: 'Invalid referral code' });
    }

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
// STATIC FILES & SPA FALLBACK
// ==========================================
app.use(express.static('public'));

// Fallback to index.html for SPA routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==========================================
// ERROR HANDLING
// ==========================================
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong!' });
});

// ==========================================
// VERCEL SERVERLESS EXPORT (NO app.listen!)
// ==========================================
module.exports = app;
