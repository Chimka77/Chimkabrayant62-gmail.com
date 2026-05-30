// ==========================================
// GOLDHUNT BACKEND — NODE.JS SERVER
// server.js
// ==========================================

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// 1. INITIALIZE FIREBASE ADMIN
// ==========================================
// Option A: Using service account JSON file
try {
    const serviceAccount = require('./firebase-service-account.json');
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log('✅ Firebase initialized via JSON file');
} catch (e) {
    // Option B: Using environment variables
    try {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
            })
        });
        console.log('✅ Firebase initialized via env vars');
    } catch (e2) {
        console.error('❌ Firebase initialization failed:', e2.message);
        process.exit(1);
    }
}

const db = admin.firestore();

// ==========================================
// 2. REFERRAL CONFIG
// ==========================================
const REFERRAL_CONFIG = {
    WELCOME_BONUS: 50,
    INVITER_BONUS: 50,
    MAX_REFERRALS_PER_DAY: 100,
    COOLDOWN_MS: 5000,
    ALLOW_SELF_REFERRAL: false
};

// ==========================================
// 3. HELPER FUNCTIONS
// ==========================================
function generateReferralCode(telegramId) {
    return 'ref' + telegramId.toString();
}

async function findReferrerByCode(code) {
    if (!code) return null;
    
    const cleanCode = code.toString().trim().split('?')[0].split('&')[0];
    console.log('🔍 Searching for referrer:', cleanCode);
    
    let searchId = cleanCode;
    if (cleanCode.startsWith('ref')) {
        searchId = cleanCode.replace('ref', '');
    }
    
    // Direct ID lookup
    if (/^\d+$/.test(searchId)) {
        const directDoc = await db.collection('users').doc(searchId).get();
        if (directDoc.exists) {
            const data = directDoc.data();
            console.log('✅ Found referrer by ID:', searchId);
            return data.telegramId?.toString() || searchId;
        }
    }
    
    // Query by referralCode
    const snapshot = await db.collection('users')
        .where('referralCode', '==', cleanCode)
        .limit(1)
        .get();
    
    if (!snapshot.empty) {
        return snapshot.docs[0].data().telegramId?.toString();
    }
    
    // Try with ref prefix
    if (!cleanCode.startsWith('ref')) {
        const snapshot2 = await db.collection('users')
            .where('referralCode', '==', 'ref' + cleanCode)
            .limit(1)
            .get();
        if (!snapshot2.empty) {
            return snapshot2.docs[0].data().telegramId?.toString();
        }
    }
    
    console.log('❌ No referrer found');
    return null;
}

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
                throw new Error('Rate limit');
            }
            
            // Daily limit check
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const todayReferrals = (referrerData.referrals || []).filter(r => {
                const joinDate = r.joinedAt?.toDate?.();
                return joinDate && joinDate >= today;
            });
            
            if (todayReferrals.length >= REFERRAL_CONFIG.MAX_REFERRALS_PER_DAY) {
                throw new Error('Daily limit reached');
            }
            
            // Check if already referred
            const existingReferrals = referrerData.referrals || [];
            const alreadyReferred = existingReferrals.find(r => r.userId === newUserId.toString());
            if (alreadyReferred) {
                throw new Error('Already referred');
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
        console.error('❌ Referral transaction error:', error.message);
        return { success: false, error: error.message };
    }
}

// ==========================================
// 4. ROUTES
// ==========================================

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        firebase: !!db
    });
});

// User registration
app.post('/api/user/register', async (req, res) => {
    try {
        const { telegramId, username, firstName, startParam } = req.body;
        
        if (!telegramId) {
            return res.status(400).json({ error: 'telegramId required' });
        }
        
        const userRef = db.collection('users').doc(telegramId.toString());
        const userSnap = await userRef.get();
        
        // User already exists
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
            
            if (referrerId && referrerId !== telegramId.toString()) {
                const result = await processReferralAtomic(referrerId, telegramId, username || firstName);
                
                if (result.success) {
                    referredBy = referrerId;
                    referralProcessed = true;
                    referralBonus = REFERRAL_CONFIG.WELCOME_BONUS;
                    console.log('✅ Referral recorded successfully');
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
        console.error('❌ Registration error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

// Get user referrals
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
        console.error('❌ Get referrals error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Referral leaderboard
app.get('/api/leaderboard/referrals', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 100);
        
        const snapshot = await db.collection('users')
            .orderBy('referralCount', 'desc')
            .limit(limit)
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
        console.error('❌ Leaderboard error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Sync user data
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
        console.error('❌ Sync error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==========================================
// 5. START SERVER
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 GoldHunt server running on port ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
    console.log(`👤 Register: POST http://localhost:${PORT}/api/user/register`);
});
