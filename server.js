const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');

// ==========================================
// FIREBASE ADMIN INITIALIZATION
// ==========================================
let db;

try {
    if (process.env.FIREBASE_PRIVATE_KEY) {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
            })
        });
        console.log('✅ Firebase initialized via environment variables');
    } else {
        const serviceAccount = require('./firebase-service-account.json');
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log('✅ Firebase initialized via service account file');
    }
    db = admin.firestore();
} catch (error) {
    console.error('❌ Firebase initialization failed:', error.message);
    db = null;
}

const app = express();

// ==========================================
// MIDDLEWARE
// ==========================================
app.use(cors({
    origin: '*',
    methods: ['POST', 'GET'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// ==========================================
// SERVE STATIC FILES (YOUR GAME)
// ==========================================
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// REFERRAL CONFIGURATION
// ==========================================
const REFERRAL_REWARD = 50;
const RATE_LIMIT_MS = 5000;

// ==========================================
// HELPER: Find referrer by code
// ==========================================
async function findReferrerByCode(code) {
    if (!code || !db) return null;
    
    const cleanCode = code.toString().trim().split('?')[0].split('&')[0];
    console.log('🔍 Searching for referrer with code:', cleanCode);
    
    let searchId = cleanCode;
    if (cleanCode.startsWith('ref')) {
        searchId = cleanCode.replace('ref', '');
    }
    
    if (!/^\d+$/.test(searchId)) {
        console.log('❌ Invalid code format:', searchId);
        return null;
    }
    
    try {
        const directDoc = await db.collection('users').doc(searchId).get();
        if (directDoc.exists) {
            const data = directDoc.data();
            console.log('✅ Found referrer by ID:', searchId);
            return {
                id: searchId,
                telegramId: data.telegramId?.toString() || searchId,
                referralCode: data.referralCode || ('ref' + searchId)
            };
        }
    } catch (e) {
        console.error('Error in direct lookup:', e.message);
    }
    
    try {
        const snapshot = await db.collection('users')
            .where('referralCode', '==', cleanCode)
            .limit(1)
            .get();
        
        if (!snapshot.empty) {
            const data = snapshot.docs[0].data();
            return {
                id: snapshot.docs[0].id,
                telegramId: data.telegramId?.toString(),
                referralCode: data.referralCode
            };
        }
    } catch (e) {
        console.error('Error in field lookup:', e.message);
    }
    
    console.log('❌ No referrer found for code:', cleanCode);
    return null;
}

// ==========================================
// API: Process Referral
// ==========================================
app.post('/api/referral/process', async (req, res) => {
    try {
        if (!db) {
            return res.status(503).json({
                success: false,
                error: 'Database not available'
            });
        }
        
        const { newUserId, newUserName, referralCode, timestamp } = req.body;
        
        if (!newUserId || !referralCode) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: newUserId and referralCode'
            });
        }
        
        const newUserIdStr = newUserId.toString();
        const cleanCode = referralCode.toString().trim();
        
        console.log('🔄 Processing referral:', {
            newUserId: newUserIdStr,
            referralCode: cleanCode,
            newUserName: newUserName || 'Anonymous'
        });
        
        // Self-referral check
        let potentialSelfId = cleanCode;
        if (cleanCode.startsWith('ref')) {
            potentialSelfId = cleanCode.replace('ref', '');
        }
        
        if (potentialSelfId === newUserIdStr) {
            console.log('🚫 Self-referral blocked:', newUserIdStr);
            return res.status(403).json({
                success: false,
                error: 'Self-referral not allowed'
            });
        }
        
        const referrer = await findReferrerByCode(cleanCode);
        
        if (!referrer) {
            return res.status(404).json({
                success: false,
                error: 'Invalid referral code - referrer not found'
            });
        }
        
        if (referrer.id === newUserIdStr || referrer.telegramId === newUserIdStr) {
            return res.status(403).json({
                success: false,
                error: 'Self-referral not allowed'
            });
        }
        
        // Check if new user already referred
        const newUserRef = db.collection('users').doc(newUserIdStr);
        const newUserDoc = await newUserRef.get();
        
        if (newUserDoc.exists) {
            const newUserData = newUserDoc.data();
            if (newUserData.referredBy || newUserData.referralProcessed) {
                return res.status(409).json({
                    success: false,
                    error: 'User already referred by someone else'
                });
            }
        }
        
        // Rate limiting
        const referrerRef = db.collection('users').doc(referrer.id);
        const referrerDoc = await referrerRef.get();
        
        if (referrerDoc.exists) {
            const referrerData = referrerDoc.data();
            const lastReferralTime = referrerData.lastReferralTime?.toDate?.() || null;
            
            if (lastReferralTime) {
                const now = new Date();
                const timeDiff = now - lastReferralTime;
                if (timeDiff < RATE_LIMIT_MS) {
                    return res.status(429).json({
                        success: false,
                        error: 'Rate limit - please wait before next referral'
                    });
                }
            }
            
            const existingReferrals = referrerData.referrals || [];
            const alreadyReferred = existingReferrals.find(r => r.userId === newUserIdStr);
            if (alreadyReferred) {
                return res.status(409).json({
                    success: false,
                    error: 'Already referred'
                });
            }
        }
        
        // Atomic transaction
        const batch = db.batch();
        const now = admin.firestore.FieldValue.serverTimestamp();
        
        batch.update(referrerRef, {
            gold: admin.firestore.FieldValue.increment(REFERRAL_REWARD),
            referralCount: admin.firestore.FieldValue.increment(1),
            referrals: admin.firestore.FieldValue.arrayUnion({
                userId: newUserIdStr,
                username: newUserName || 'Anonymous',
                joinedAt: now,
                reward: REFERRAL_REWARD,
                status: 'active'
            }),
            lastReferralTime: now,
            lastUpdated: now
        });
        
        const recordRef = db.collection('referralRecords').doc();
        batch.set(recordRef, {
            referrerId: referrer.id,
            referredId: newUserIdStr,
            referredUsername: newUserName || 'Anonymous',
            rewardAmount: REFERRAL_REWARD,
            createdAt: now,
            status: 'completed',
            platform: 'telegram',
            referralCodeUsed: cleanCode
        });
        
        await batch.commit();
        
        console.log('✅ Referral processed:', {
            referrer: referrer.id,
            newUser: newUserIdStr,
            reward: REFERRAL_REWARD
        });
        
        return res.json({
            success: true,
            referrerId: referrer.id,
            bonus: REFERRAL_REWARD,
            message: 'Referral processed successfully'
        });
        
    } catch (error) {
        console.error('❌ Referral processing error:', error);
        return res.status(500).json({
            success: false,
            error: 'Internal server error: ' + error.message
        });
    }
});

// ==========================================
// API: Get Referral Stats
// ==========================================
app.get('/api/referral/stats/:userId', async (req, res) => {
    try {
        if (!db) {
            return res.status(503).json({ error: 'Database not available' });
        }
        
        const { userId } = req.params;
        const userDoc = await db.collection('users').doc(userId).get();
        
        if (!userDoc.exists) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const data = userDoc.data();
        return res.json({
            referralCount: data.referralCount || 0,
            referrals: data.referrals || [],
            referralCode: data.referralCode || ('ref' + userId),
            totalReferralEarnings: (data.referrals || []).reduce((sum, r) => sum + (r.reward || 0), 0)
        });
        
    } catch (error) {
        console.error('Stats error:', error);
        return res.status(500).json({ error: 'Internal error' });
    }
});

// ==========================================
// API: Health Check
// ==========================================
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        firebaseConnected: !!db,
        timestamp: new Date().toISOString() 
    });
});

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 GoldHunt running on port ${PORT}`);
    console.log(`🎮 Game: http://localhost:${PORT}`);
    console.log(`📊 API Health: http://localhost:${PORT}/api/health`);
});

module.exports = app;
