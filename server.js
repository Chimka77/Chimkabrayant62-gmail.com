// ==========================================
// GOLDHUNT REFERRAL BACKEND
// Node.js + Express + Firebase Admin
// Copy & paste this into your server.js
// ==========================================

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// 1. INITIALIZE FIREBASE ADMIN
// ==========================================
// Download your service account key from Firebase Console
// Project Settings > Service Accounts > Generate New Private Key
const serviceAccount = require('./firebase-service-account.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// ==========================================
// 2. TELEGRAM WEBAPP VALIDATION
// ==========================================
// NEVER trust client-side data. Always validate initData.
const BOT_TOKEN = 'YOUR_BOT_TOKEN_HERE'; // Replace with your @BotFather token

function validateTelegramInitData(initData) {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    urlParams.delete('hash');
    
    // Sort params alphabetically
    const dataCheckString = Array.from(urlParams.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');
    
    const secretKey = crypto
        .createHmac('sha256', 'WebAppData')
        .update(BOT_TOKEN)
        .digest();
    
    const computedHash = crypto
        .createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');
    
    return computedHash === hash;
}

function parseInitData(initData) {
    const urlParams = new URLSearchParams(initData);
    const user = JSON.parse(urlParams.get('user') || '{}');
    return {
        userId: user.id?.toString(),
        username: user.username,
        firstName: user.first_name,
        startParam: urlParams.get('start_param') || null,
        authDate: urlParams.get('auth_date'),
        hash: urlParams.get('hash')
    };
}

// ==========================================
// 3. MIDDLEWARE
// ==========================================
async function authMiddleware(req, res, next) {
    const initData = req.headers['x-telegram-init-data'];
    
    if (!initData) {
        return res.status(401).json({ error: 'Missing Telegram initData' });
    }
    
    if (!validateTelegramInitData(initData)) {
        return res.status(403).json({ error: 'Invalid Telegram initData signature' });
    }
    
    const parsed = parseInitData(initData);
    req.telegramUser = parsed;
    next();
}

// ==========================================
// 4. REFERRAL CONFIG
// ==========================================
const REFERRAL_CONFIG = {
    WELCOME_BONUS: 50,           // New user gets this
    INVITER_BONUS: 50,           // Inviter gets this
    MAX_REFERRALS_PER_DAY: 100,  // Anti-spam
    COOLDOWN_MS: 5000,           // 5 sec between referrals
    ALLOW_SELF_REFERRAL: false   // Prevent self-referral
};

// ==========================================
// 5. USER REGISTRATION (with referral)
// ==========================================
app.post('/api/user/register', async (req, res) => {
    try {
        const { telegramId, username, firstName, startParam, initData } = req.body;
        
        // Validate required fields
        if (!telegramId) {
            return res.status(400).json({ error: 'telegramId required' });
        }
        
        // Validate initData if provided
        if (initData && !validateTelegramInitData(initData)) {
            return res.status(403).json({ error: 'Invalid initData' });
        }
        
        const userRef = db.collection('users').doc(telegramId.toString());
        const userSnap = await userRef.get();
        
        // User already exists — return existing data
        if (userSnap.exists) {
            const data = userSnap.data();
            return res.json({
                success: true,
                existing: true,
                user: {
                    telegramId: data.telegramId,
                    username: data.username,
                    displayName: data.displayName,
                    gold: data.gold || 0,
                    referralCode: data.referralCode,
                    referralCount: data.referralCount || 0,
                    referredBy: data.referredBy || null
                }
            });
        }
        
        // Process referral
        let referredBy = null;
        let referralBonus = 0;
        let referralProcessed = false;
        
        if (startParam) {
            console.log('🎁 Processing referral:', startParam);
            const referrerId = await findReferrerByCode(startParam);
            
            if (referrerId && 
                referrerId !== telegramId.toString() && 
                !REFERRAL_CONFIG.ALLOW_SELF_REFERRAL) {
                
                const result = await processReferralAtomic(referrerId, telegramId, username || firstName);
                
                if (result.success) {
                    referredBy = referrerId;
                    referralProcessed = true;
                    referralBonus = REFERRAL_CONFIG.WELCOME_BONUS;
                    console.log('✅ Referral recorded:', referrerId, '->', telegramId);
                } else {
                    console.log('❌ Referral failed:', result.error);
                }
            }
        }
        
        // Create new user
        const referralCode = generateReferralCode(telegramId);
        
        await userRef.set({
            telegramId: telegramId.toString(),
            username: username || null,
            displayName: username || firstName || 'User',
            playerName: firstName || 'User',
            gold: referralBonus,
            totalMined: 0,
            rank: 'Wood',
            plan: 'Free',
            referredBy: referredBy,
            referrals: [],
            referralCount: 0,
            walletAddress: null,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
            lastActive: admin.firestore.FieldValue.serverTimestamp(),
            checkinStreak: 0,
            lastCheckin: null,
            tasksCompleted: {},
            miningSpeed: 1,
            miningSpeedMultiplier: 1,
            multiplierEndTime: null,
            adsWatched: 0,
            adsWatchTime: null,
            boostActive: false,
            lastMinerPurchase: null,
            userSetName: null,
            referralCode: referralCode,
            lastReferralTime: null,
            usedReferralCode: startParam || null,
            referralProcessed: referralProcessed,
            miningActive: false,
            miningSessionStart: null,
            totalMiningTime: 0
        });
        
        // If referral was processed, update referrer's stats
        if (referredBy && referralProcessed) {
            await notifyReferrer(referredBy, telegramId, username || firstName);
        }
        
        res.json({
            success: true,
            existing: false,
            user: {
                telegramId: telegramId.toString(),
                username: username || null,
                displayName: username || firstName || 'User',
                gold: referralBonus,
                referralCode: referralCode,
                referralCount: 0,
                referredBy: referredBy,
                referralBonus: referralBonus
            }
        });
        
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==========================================
// 6. FIND REFERRER BY CODE
// ==========================================
async function findReferrerByCode(code) {
    if (!code) return null;
    
    const cleanCode = code.toString().trim().split('?')[0].split('&')[0];
    console.log('🔍 Searching for referrer:', cleanCode);
    
    // Direct ID lookup (e.g., "ref123456" -> "123456")
    let searchId = cleanCode;
    if (cleanCode.startsWith('ref')) {
        searchId = cleanCode.replace('ref', '');
    }
    
    // Try direct document lookup first
    if (/^\d+$/.test(searchId)) {
        const directDoc = await db.collection('users').doc(searchId).get();
        if (directDoc.exists) {
            const data = directDoc.data();
            console.log('✅ Found referrer by ID:', searchId);
            return data.telegramId?.toString() || searchId;
        }
    }
    
    // Try query by referralCode field
    const snapshot = await db.collection('users')
        .where('referralCode', '==', cleanCode)
        .limit(1)
        .get();
    
    if (!snapshot.empty) {
        return snapshot.docs[0].data().telegramId?.toString();
    }
    
    // Try with "ref" prefix added
    if (!cleanCode.startsWith('ref')) {
        const snapshot2 = await db.collection('users')
            .where('referralCode', '==', 'ref' + cleanCode)
            .limit(1)
            .get();
        if (!snapshot2.empty) {
            return snapshot2.docs[0].data().telegramId?.toString();
        }
    }
    
    console.log('❌ No referrer found for code:', cleanCode);
    return null;
}

// ==========================================
// 7. ATOMIC REFERRAL PROCESSING
// ==========================================
async function processReferralAtomic(referrerId, newUserId, newUserName) {
    const referrerRef = db.collection('users').doc(referrerId.toString());
    
    try {
        await db.runTransaction(async (transaction) => {
            const referrerSnap = await transaction.get(referrerRef);
            
            if (!referrerSnap.exists) {
                throw new Error('Referrer not found');
            }
            
            const referrerData = referrerSnap.data();
            
            // Rate limit check
            const lastReferral = referrerData.lastReferralTime?.toDate?.() || null;
            const now = admin.firestore.Timestamp.now();
            if (lastReferral && (now.toMillis() - lastReferral.toMillis()) < REFERRAL_CONFIG.COOLDOWN_MS) {
                throw new Error('Rate limit: too many referrals');
            }
            
            // Daily limit check
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const todayReferrals = (referrerData.referrals || []).filter(r => {
                const joinDate = r.joinedAt?.toDate?.();
                return joinDate && joinDate >= today;
            });
            
            if (todayReferrals.length >= REFERRAL_CONFIG.MAX_REFERRALS_PER_DAY) {
                throw new Error('Daily referral limit reached');
            }
            
            // Check if already referred this user
            const existingReferrals = referrerData.referrals || [];
            const alreadyReferred = existingReferrals.find(r => r.userId === newUserId.toString());
            if (alreadyReferred) {
                throw new Error('User already referred');
            }
            
            // Update referrer
            transaction.update(referrerRef, {
                gold: admin.firestore.FieldValue.increment(REFERRAL_CONFIG.INVITER_BONUS),
                referralCount: admin.firestore.FieldValue.increment(1),
                referrals: admin.firestore.FieldValue.arrayUnion({
                    userId: newUserId.toString(),
                    username: newUserName || 'Anonymous',
                    joinedAt: admin.firestore.FieldValue.serverTimestamp(),
                    reward: REFERRAL_CONFIG.INVITER_BONUS,
                    status: 'active'
                }),
                lastReferralTime: admin.firestore.FieldValue.serverTimestamp(),
                lastUpdated: admin.firestore.FieldValue.serverTimestamp()
            });
            
            // Create referral record
            const recordRef = db.collection('referralRecords').doc();
            transaction.set(recordRef, {
                referrerId: referrerId.toString(),
                referredId: newUserId.toString(),
                referredUsername: newUserName || 'Anonymous',
                rewardAmount: REFERRAL_CONFIG.INVITER_BONUS,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                status: 'completed',
                platform: 'telegram'
            });
        });
        
        return { success: true };
        
    } catch (error) {
        console.error('Referral transaction error:', error.message);
        return { success: false, error: error.message };
    }
}

// ==========================================
// 8. NOTIFY REFERRER (push notification)
// ==========================================
async function notifyReferrer(referrerId, newUserId, newUserName) {
    try {
        // You can integrate with Telegram Bot API here to send a message
        // For now, we'll just log it
        console.log(`📢 Notifying referrer ${referrerId}: ${newUserName} joined!`);
        
        // Optional: Send Telegram message via Bot API
        // await sendTelegramMessage(referrerId, `🎉 ${newUserName} joined using your referral link! You earned 50 GOLD!`);
        
    } catch (error) {
        console.error('Notification error:', error);
    }
}

// ==========================================
// 9. GET USER REFERRAL DATA
// ==========================================
app.get('/api/user/referrals', async (req, res) => {
    try {
        const { telegramId } = req.query;
        
        if (!telegramId) {
            return res.status(400).json({ error: 'telegramId required' });
        }
        
        const userRef = db.collection('users').doc(telegramId.toString());
        const userSnap = await userRef.get();
        
        if (!userSnap.exists) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const data = userSnap.data();
        
        res.json({
            success: true,
            referralCode: data.referralCode,
            referralCount: data.referralCount || 0,
            totalReferralEarnings: (data.referrals || []).reduce((sum, r) => sum + (r.reward || 0), 0),
            referrals: (data.referrals || []).map(r => ({
                userId: r.userId,
                username: r.username,
                joinedAt: r.joinedAt?.toDate?.() || null,
                reward: r.reward,
                status: r.status
            })),
            referralLink: `https://t.me/Goldhunt101bot?startapp=${data.referralCode}`
        });
        
    } catch (error) {
        console.error('Get referrals error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==========================================
// 10. GET LEADERBOARD (referral leaderboard)
// ==========================================
app.get('/api/leaderboard/referrals', async (req, res) => {
    try {
        const { limit = 50 } = req.query;
        
        const snapshot = await db.collection('users')
            .orderBy('referralCount', 'desc')
            .limit(parseInt(limit))
            .get();
        
        const leaders = snapshot.docs.map((doc, index) => {
            const data = doc.data();
            return {
                rank: index + 1,
                telegramId: data.telegramId,
                username: data.username,
                displayName: data.displayName,
                referralCount: data.referralCount || 0,
                gold: data.gold || 0
            };
        });
        
        res.json({
            success: true,
            leaderboard: leaders
        });
        
    } catch (error) {
        console.error('Leaderboard error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==========================================
// 11. SYNC USER DATA (from frontend)
// ==========================================
app.post('/api/user/sync', async (req, res) => {
    try {
        const { telegramId, gold, totalMined, miningActive, walletAddress } = req.body;
        
        if (!telegramId) {
            return res.status(400).json({ error: 'telegramId required' });
        }
        
        const userRef = db.collection('users').doc(telegramId.toString());
        const updateData = {
            lastActive: admin.firestore.FieldValue.serverTimestamp(),
            lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        };
        
        if (gold !== undefined) updateData.gold = gold;
        if (totalMined !== undefined) updateData.totalMined = totalMined;
        if (miningActive !== undefined) updateData.miningActive = miningActive;
        if (walletAddress !== undefined) updateData.walletAddress = walletAddress;
        
        await userRef.update(updateData);
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Sync error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==========================================
// 12. HEALTH CHECK
// ==========================================
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

// ==========================================
// 13. GENERATE REFERRAL CODE
// ==========================================
function generateReferralCode(telegramId) {
    return 'ref' + telegramId.toString();
}

// ==========================================
// 14. START SERVER
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 GoldHunt server running on port ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
});

module.exports = app;
