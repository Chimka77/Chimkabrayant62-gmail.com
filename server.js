const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { TonConnect, toUserFriendlyAddress } = require('@tonconnect/sdk');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// MIDDLEWARE
// ==========================================
app.use(cors({
    origin: ['https://goldhuntpro.vercel.app', 'https://t.me', '*'],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-TonConnect-Auth']
}));
app.use(express.json());

// ==========================================
// SERVE STATIC FILES (YOUR FRONTEND)
// ==========================================
// Place your index.html, CSS, JS files in a "public" folder
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// TON CONNECT MANIFEST
// ==========================================
const MANIFEST = {
    url: "https://your-backend-url.com",  // Update this
    name: "GoldHunt Mining Game",
    iconUrl: "https://your-backend-url.com/icon.png",
    termsOfUseUrl: "https://your-backend-url.com/terms",
    privacyPolicyUrl: "https://your-backend-url.com/privacy"
};

// Serve manifest with proper headers
app.get('/tonconnect-manifest.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(MANIFEST);
});

// ==========================================
// ROOT ROUTE - SERVE INDEX.HTML
// ==========================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==========================================
// IN-MEMORY STORAGE
// ==========================================
class InMemoryStorage {
    constructor() {
        this.store = new Map();
    }
    async setItem(key, value) {
        this.store.set(key, value);
    }
    async getItem(key) {
        return this.store.get(key) || null;
    }
    async removeItem(key) {
        this.store.delete(key);
    }
}

// ==========================================
// TON CONNECT SDK
// ==========================================
const tonConnect = new TonConnect({
    manifestUrl: 'https://your-backend-url.com/tonconnect-manifest.json',
    storage: new InMemoryStorage()
});

// ==========================================
// WALLET AUTHENTICATION
// ==========================================
app.post('/api/wallet/connect', async (req, res) => {
    try {
        const { proof, account, telegramId } = req.body;

        if (!proof || !account || !telegramId) {
            return res.status(400).json({ 
                success: false, 
                error: 'Missing required fields' 
            });
        }

        const isValid = await verifyTonProof(proof, account);

        if (!isValid) {
            return res.status(401).json({ 
                success: false, 
                error: 'Invalid TON proof signature' 
            });
        }

        const userFriendlyAddress = toUserFriendlyAddress(account.address, {
            testOnly: account.chain === '-3'
        });

        await saveWalletToUser(telegramId, {
            address: userFriendlyAddress,
            rawAddress: account.address,
            chain: account.chain,
            walletStateInit: account.walletStateInit,
            connectedAt: new Date().toISOString()
        });

        res.json({
            success: true,
            address: userFriendlyAddress,
            message: 'Wallet connected successfully'
        });

    } catch (error) {
        console.error('Wallet connect error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// ==========================================
// VERIFY TON PROOF
// ==========================================
async function verifyTonProof(proof, account) {
    try {
        const { timestamp, domain, payload, signature } = proof;
        
        if (domain.value !== 'your-backend-url.com' && 
            domain.value !== 't.me') {
            console.error('Domain mismatch:', domain.value);
            return false;
        }

        const now = Math.floor(Date.now() / 1000);
        if (Math.abs(now - timestamp) > 300) {
            console.error('Timestamp expired');
            return false;
        }

        const isValid = await tonConnect.verifyMessageSignature(
            account.address,
            createProofMessage(proof, account),
            signature
        );

        return isValid;

    } catch (error) {
        console.error('Proof verification error:', error);
        return false;
    }
}

function createProofMessage(proof, account) {
    const { timestamp, domain, payload } = proof;
    const domainBuffer = Buffer.from(domain.value);
    const timestampBuffer = Buffer.alloc(8);
    timestampBuffer.writeBigUInt64BE(BigInt(timestamp));
    
    const message = Buffer.concat([
        Buffer.from('ton-proof-item-v2/'),
        Buffer.from(account.address),
        domainBuffer,
        timestampBuffer,
        Buffer.from(payload || '')
    ]);

    return crypto.createHash('sha256').update(message).digest();
}

// ==========================================
// DISCONNECT WALLET
// ==========================================
app.post('/api/wallet/disconnect', async (req, res) => {
    try {
        const { telegramId } = req.body;
        
        if (!telegramId) {
            return res.status(400).json({ 
                success: false, 
                error: 'Missing telegramId' 
            });
        }

        await removeWalletFromUser(telegramId);

        res.json({
            success: true,
            message: 'Wallet disconnected'
        });

    } catch (error) {
        console.error('Wallet disconnect error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// ==========================================
// GET WALLET STATUS
// ==========================================
app.get('/api/wallet/status/:telegramId', async (req, res) => {
    try {
        const { telegramId } = req.params;
        const wallet = await getWalletByUser(telegramId);

        if (!wallet) {
            return res.json({
                connected: false,
                address: null
            });
        }

        res.json({
            connected: true,
            address: wallet.address,
            connectedAt: wallet.connectedAt
        });

    } catch (error) {
        console.error('Wallet status error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// ==========================================
// DATABASE FUNCTIONS (Replace with Firebase)
// ==========================================
async function saveWalletToUser(telegramId, walletData) {
    console.log('💾 Saving wallet for user:', telegramId, walletData.address);
}

async function removeWalletFromUser(telegramId) {
    console.log('🗑️ Removing wallet for user:', telegramId);
}

async function getWalletByUser(telegramId) {
    return null;
}

// ==========================================
// HEALTH CHECK
// ==========================================
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        service: 'GoldHunt TON Connect',
        timestamp: new Date().toISOString()
    });
});

// ==========================================
// START
// ==========================================
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📁 Frontend: http://localhost:${PORT}`);
    console.log(`📋 Manifest: http://localhost:${PORT}/tonconnect-manifest.json`);
});

module.exports = app;
