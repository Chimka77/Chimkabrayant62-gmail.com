const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();

// CORS - Allow Telegram WebApp
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));

app.use(express.json());

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// TON CONNECT MANIFEST - CRITICAL
// Must be accessible with proper CORS
// ==========================================
app.get('/tonconnect-manifest.json', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=300');
    
    const APP_URL = process.env.APP_URL || 'https://goldhunt101.vercel.app';
    
    res.json({
        "url": APP_URL,
        "name": "GoldHunt",
        "iconUrl": `${APP_URL}/icon.png`,
        "termsOfUseUrl": `${APP_URL}/terms`,
        "privacyPolicyUrl": `${APP_URL}/privacy`
    });
});

// ==========================================
// TELEGRAM WEBAPP STARTAPP HANDLER
// This is where wallet returns after connection
// ==========================================
app.get('/startapp', (req, res) => {
    // Wallet connection returns here with parameters
    // Redirect to main app with connection state
    res.redirect('/?wallet=connected&t=' + Date.now());
});

// ==========================================
// API: Wallet Connection Status
// ==========================================
app.get('/api/wallet/status', (req, res) => {
    res.json({ status: 'ok', service: 'ton-connect' });
});

// ==========================================
// API: Save Connected Wallet
// Called by frontend after successful connection
// ==========================================
app.post('/api/wallet/connect', (req, res) => {
    const { telegramId, walletAddress, walletName } = req.body;
    
    if (!telegramId || !walletAddress) {
        return res.status(400).json({ error: 'Missing parameters' });
    }
    
    console.log('Wallet connected:', { telegramId, walletAddress, walletName });
    
    // TODO: Save to Firebase/Database
    // For now just acknowledge
    
    res.json({
        success: true,
        address: walletAddress,
        message: 'Wallet connected successfully'
    });
});

// ==========================================
// API: Disconnect Wallet
// ==========================================
app.post('/api/wallet/disconnect', (req, res) => {
    const { telegramId } = req.body;
    console.log('Wallet disconnected:', telegramId);
    res.json({ success: true });
});

// ==========================================
// HEALTH CHECK
// ==========================================
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        manifest: process.env.APP_URL + '/tonconnect-manifest.json'
    });
});

// SPA fallback - serve index.html for all routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 GoldHunt Server running on port ${PORT}`);
    console.log(`📋 Manifest: ${process.env.APP_URL || 'http://localhost:' + PORT}/tonconnect-manifest.json`);
});
