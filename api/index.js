const express = require('express');

const app = express();
app.use(express.json());

// ==========================================
// CORS HEADERS - CRITICAL FOR TON CONNECT
// ==========================================
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

// ==========================================
// TON CONNECT MANIFEST
// This is what the wallet app reads
// ==========================================
app.get('/tonconnect-manifest.json', (req, res) => {
    const APP_URL = process.env.APP_URL || 'https://goldhunt101.vercel.app';
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=300');
    
    res.json({
        "url": APP_URL,
        "name": "GoldHunt",
        "iconUrl": `${APP_URL}/icon.png`,
        "termsOfUseUrl": `${APP_URL}/terms`,
        "privacyPolicyUrl": `${APP_URL}/privacy`
    });
});

// ==========================================
// API: Health Check
// ==========================================
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        app_url: process.env.APP_URL || 'https://goldhunt101.vercel.app'
    });
});

// ==========================================
// API: Wallet Connect
// ==========================================
app.post('/api/wallet/connect', (req, res) => {
    const { telegramId, walletAddress, walletName } = req.body;
    
    console.log('Wallet connected:', {
        telegramId,
        walletAddress,
        walletName,
        time: new Date().toISOString()
    });
    
    // TODO: Save to your Firebase here
    // For now just return success
    
    res.json({
        success: true,
        message: 'Wallet connected',
        address: walletAddress
    });
});

// ==========================================
// API: Wallet Disconnect
// ==========================================
app.post('/api/wallet/disconnect', (req, res) => {
    const { telegramId } = req.body;
    console.log('Wallet disconnected:', telegramId);
    
    res.json({ success: true });
});

// ==========================================
// STATIC FILES & SPA FALLBACK
// ==========================================
// For Vercel, we need to handle static files differently
// In production, Vercel handles static files automatically
// This is for local development

const path = require('path');
const fs = require('fs');

// Try to serve static files from root
app.use((req, res, next) => {
    // Skip API routes
    if (req.path.startsWith('/api/') || req.path === '/tonconnect-manifest.json') {
        return next();
    }
    
    const filePath = path.join(process.cwd(), req.path);
    
    // If file exists, serve it
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return res.sendFile(filePath);
    }
    
    next();
});

// SPA fallback - serve index.html for all other routes
app.get('*', (req, res) => {
    const indexPath = path.join(process.cwd(), 'index.html');
    
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(404).send('index.html not found. Please upload your frontend.');
    }
});

// ==========================================
// ERROR HANDLER
// ==========================================
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
    });
});

// ==========================================
// LOCAL DEVELOPMENT
// ==========================================
if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
        console.log(`📋 Manifest: http://localhost:${PORT}/tonconnect-manifest.json`);
    });
}

// Export for Vercel
module.exports = app;
