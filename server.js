const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// ==========================================
// FIREBASE ADMIN INITIALIZATION
// ==========================================
// Download service account key from Firebase Console > Project Settings > Service Accounts
const serviceAccount = require('./firebase-service-account.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();

// ==========================================
// MIDDLEWARE
// ==========================================
app.use(cors({
    origin: '*', // Restrict this in production to your domain
    methods: ['POST', 'GET'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// ==========================================
// REFERRAL CONFIGURATION
// ==========================================
const REFERRAL_REWARD = 50;
const RATE_LIMIT_MS = 5000; // 5 seconds between referrals from same referrer

// ==========================================
// HELPER: Find referrer by code
// ==========================================
async function findReferrerByCode(code) {
    if (!code) return null;
    
    const cleanCode = code.toString().trim().split('?')[0].split('&')[0];
    console.log('🔍 Searching for referrer with code:', cleanCode);
    
    // Try direct ID lookup first (code = ref123456 -> userId = 123456)
    let searchId = cleanCode;
    if (cleanCode.startsWith('ref')) {
        searchId = cleanCode.replace('ref', '');
    }
    
    // Validate it's a numeric Telegram ID
    if (!/^\d+$/.test(searchId)) {
        console.log('❌ Invalid code format - not numeric:', searchId);
        return null;
    }
    
    // Check if user exists with this ID
    const directDoc = await db.collection('users').doc(searchId).get();
    if (directDoc.exists) {
        const data = directDoc.data();
        console.log('✅ Found referrer by direct ID:', searchId);
        return {
            id: searchId,
            telegramId: data.telegramId?.toString() || searchId,
            referralCode: data.referralCode || ('ref' + searchId)
        };
    }
    
    // Fallback: Search by referralCode field
    const snapshot = await db.collection('users')
        .where('referralCode', '==', cleanCode)
        .limit(1)
        .get();
    
    if (!snapshot.empty) {
        const data = snapshot.docs[0].data();
        console.log('✅ Found referrer by referralCode field:', snapshot.docs[0].id);
        return {
            id: snapshot.docs[0].id,
            telegramId: data.telegramId?.toString(),
            referralCode: data.referralCode
        };
    }
    
    // Try with 'ref' prefix if not already present
    if (!cleanCode.startsWith('ref')) {
        const snapshot2 = await db.collection('users')
            .where('referralCode', '==', 'ref' + cleanCode)
            .limit(1)
            .get();
        
        if (!snapshot2.empty) {
            const data = snapshot2.docs[0].data();
            console.log('✅ Found referrer with ref prefix:', snapshot2.docs[0].id);
            return {
                id: snapshot2.docs[0].id,
                telegramId: data.telegramId?.toString(),
                referralCode: data.referralCode
            };
        }
    }
    
    console.log('❌ No referrer found for code:', cleanCode);
    return null;
}

// ==========================================
// API: Process Referral (SECURE - Called from frontend)
// ==========================================
app.post('/api/referral/process', async (req, res) => {
    try {
        const { newUserId, newUserName, referralCode, timestamp } = req.body;
        
        // Validation
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
        
        // ANTI-CHEAT 1: Self-referral check
        // Extract potential ID from code
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
        
        // Find the referrer
        const referrer = await findReferrerByCode(cleanCode);
        
        if (!referrer) {
            return res.status(404).json({
                success: false,
                error: 'Invalid referral code - referrer not found'
            });
        }
        
        // ANTI-CHEAT 2: Double-check self-referral
        if (referrer.id === newUserIdStr || referrer.telegramId === newUserIdStr) {
            console.log('🚫 Self-referral blocked (after lookup):', newUserIdStr);
            return res.status(403).json({
                success: false,
                error: 'Self-referral not allowed'
            });
        }
        
        // ANTI-CHEAT 3: Check if new user already has a referrer
        const newUserRef = db.collection('users').doc(newUserIdStr);
        const newUserDoc = await newUserRef.get();
        
        if (newUserDoc.exists) {
            const newUserData = newUserDoc.data();
            if (newUserData.referredBy || newUserData.referralProcessed) {
                console.log('🚫 User already has a referrer:', newUserIdStr);
                return res.status(409).json({
                    success: false,
                    error: 'User already referred by someone else'
                });
            }
        }
        
        // ANTI-CHEAT 4: Rate limiting - check last referral time
        const referrerRef = db.collection('users').doc(referrer.id);
        const referrerDoc = await referrerRef.get();
        
        if (referrerDoc.exists) {
            const referrerData = referrerDoc.data();
            const lastReferralTime = referrerData.lastReferralTime?.toDate?.() || null;
            
            if (lastReferralTime) {
                const now = new Date();
                const timeDiff = now - lastReferralTime;
                if (timeDiff < RATE_LIMIT_MS) {
                    console.log('🚫 Rate limit hit for referrer:', referrer.id);
                    return res.status(429).json({
                        success: false,
                        error: 'Rate limit - please wait before next referral'
                    });
                }
            }
            
            // ANTI-CHEAT 5: Check if this user was already referred by this referrer
            const existingReferrals = referrerData.referrals || [];
            const alreadyReferred = existingReferrals.find(r => r.userId === newUserIdStr);
            if (alreadyReferred) {
                console.log('🚫 User already in referrer list:', newUserIdStr);
                return res.status(409).json({
                    success: false,
                    error: 'Already referred'
                });
            }
        }
        
        // ==========================================
        // ATOMIC TRANSACTION: Update both users
        // ==========================================
        const batch = db.batch();
        const now = admin.firestore.FieldValue.serverTimestamp();
        
        // 1. Update referrer: add gold, increment count, add to referrals array
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
        
        // 2. Create referral record for audit trail
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
        
        // Commit the batch
        await batch.commit();
        
        console.log('✅ Referral processed successfully:', {
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
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 GoldHunt Referral Backend running on port ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
});

module.exports = app;
