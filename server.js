// ==========================================
// GOLDHUNT BACKEND - VERCEL SERVERLESS VERSION
// ==========================================

const express = require('express');
const cors = require('cors');

// Initialize Express
const app = express();

app.use(cors());
app.use(express.json());

// ==========================================
// FIREBASE ADMIN SETUP
// ==========================================

let admin;
let db;

try {
    // For Vercel, use environment variables instead of serviceAccountKey.json
    const serviceAccount = {
        type: "service_account",
        project_id: process.env.FIREBASE_PROJECT_ID,
        private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        client_email: process.env.FIREBASE_CLIENT_EMAIL
    };

    admin = require('firebase-admin');
    
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    }
    
    db = admin.firestore();
    console.log('✅ Firebase Admin initialized');
    
} catch (error) {
    console.error('❌ Firebase Admin initialization failed:', error.message);
    // Continue without Firebase for now, or handle gracefully
}

// ==========================================
// HEALTH CHECK (REQUIRED FOR VERCEL)
// ==========================================

app.get('/', (req, res) => {
    res.json({ 
        status: 'GoldHunt API is running!',
        timestamp: new Date().toISOString()
    });
});

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        firebase: db ? 'connected' : 'disconnected'
    });
});

// ==========================================
// REFERRAL SYSTEM ENDPOINTS
// ==========================================

// 1. Process referral when new user joins
app.post('/api/referral/process', async (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({ 
                success: false, 
                error: 'Database not connected' 
            });
        }

        const { newUserId, referralCode, newUserName, newUserUsername } = req.body;
        
        if (!newUserId || !referralCode) {
            return res.status(400).json({ 
                success: false, 
                error: 'Missing required fields' 
            });
        }
        
        // Find referrer by referral code
        const referrerQuery = await db.collection('users')
            .where('referralCode', '==', referralCode)
            .limit(1)
            .get();
        
        if (referrerQuery.empty) {
            return res.status(404).json({ 
                success: false, 
                error: 'Referrer not found' 
            });
        }
        
        const referrerDoc = referrerQuery.docs[0];
        const referrerId = referrerDoc.id;
        const referrerData = referrerDoc.data();
        
        // Prevent self-referral
        if (referrerId === newUserId.toString()) {
            return res.status(400).json({ 
                success: false, 
                error: 'Cannot refer yourself' 
            });
        }
        
        // Check if already referred
        const existingReferral = await db.collection('referralRecords')
            .where('referredId', '==', newUserId.toString())
            .limit(1)
            .get();
        
        if (!existingReferral.empty) {
            return res.status(400).json({ 
                success: false, 
                error: 'User already referred' 
            });
        }
        
        // Rate limit check
        const lastReferralTime = referrerData.lastReferralTime?.toDate?.();
        if (lastReferralTime && (Date.now() - lastReferralTime) < 5000) {
            return res.status(429).json({ 
                success: false, 
                error: 'Rate limit exceeded' 
            });
        }
        
        // Atomic batch write
        const batch = db.batch();
        const timestamp = admin.firestore.FieldValue.serverTimestamp();
        
        // Update referrer
        const referrerRef = db.collection('users').doc(referrerId);
        batch.update(referrerRef, {
            gold: admin.firestore.FieldValue.increment(50),
            referralCount: admin.firestore.FieldValue.increment(1),
            referrals: admin.firestore.FieldValue.arrayUnion({
                userId: newUserId.toString(),
                username: newUserUsername || newUserName || 'Anonymous',
                joinedAt: timestamp,
                reward: 50,
                status: 'active'
            }),
            lastReferralTime: timestamp,
            lastUpdated: timestamp
        });
        
        // Create referral record
        const referralRecordRef = db.collection('referralRecords').doc();
        batch.set(referralRecordRef, {
            referrerId: referrerId,
            referredId: newUserId.toString(),
            referredUsername: newUserUsername || newUserName || 'Anonymous',
            rewardAmount: 50,
            createdAt: timestamp,
            status: 'completed',
            platform: 'telegram'
        });
        
        // Update new user
        const newUserRef = db.collection('users').doc(newUserId.toString());
        batch.update(newUserRef, {
            referredBy: referrerId,
            usedReferralCode: referralCode,
            referralProcessed: true,
            lastUpdated: timestamp
        });
        
        await batch.commit();
        
        res.json({ 
            success: true, 
            message: 'Referral processed successfully',
            referrerBonus: 50
        });
        
    } catch (error) {
        console.error('Referral processing error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// 2. Get user's referral stats
app.get('/api/referral/stats/:userId', async (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({ 
                success: false, 
                error: 'Database not connected' 
            });
        }

        const { userId } = req.params;
        
        const userDoc = await db.collection('users').doc(userId).get();
        
        if (!userDoc.exists) {
            return res.status(404).json({ 
                success: false, 
                error: 'User not found' 
            });
        }
        
        const userData = userDoc.data();
        
        res.json({
            success: true,
            referralCode: userData.referralCode,
            referralCount: userData.referralCount || 0,
            referrals: userData.referrals || [],
            totalEarned: (userData.referralCount || 0) * 50
        });
        
    } catch (error) {
        console.error('Error fetching referral stats:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// 3. Get referral leaderboard
app.get('/api/referral/leaderboard', async (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({ 
                success: false, 
                error: 'Database not connected' 
            });
        }

        const snapshot = await db.collection('users')
            .orderBy('referralCount', 'desc')
            .limit(20)
            .get();
        
        const leaderboard = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            leaderboard.push({
                userId: doc.id,
                displayName: data.displayName || data.username || 'Anonymous',
                referralCount: data.referralCount || 0,
                totalEarned: (data.referralCount || 0) * 50
            });
        });
        
        res.json({ success: true, leaderboard });
        
    } catch (error) {
        console.error('Error fetching referral leaderboard:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// 4. Validate referral code
app.get('/api/referral/validate/:code', async (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({ 
                success: false, 
                error: 'Database not connected' 
            });
        }

        const { code } = req.params;
        
        const snapshot = await db.collection('users')
            .where('referralCode', '==', code)
            .limit(1)
            .get();
        
        res.json({
            success: true,
            valid: !snapshot.empty,
            referrerId: snapshot.empty ? null : snapshot.docs[0].id
        });
        
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// ==========================================
// USER MANAGEMENT ENDPOINTS
// ==========================================

// Get user count (for halving calculation)
app.get('/api/users/count', async (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({ 
                success: false, 
                error: 'Database not connected' 
            });
        }

        const snapshot = await db.collection('users').get();
        res.json({ 
            success: true, 
            count: snapshot.size 
        });
        
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Reset all user gold (admin only)
app.post('/api/admin/reset-gold', async (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({ 
                success: false, 
                error: 'Database not connected' 
            });
        }

        const { adminKey } = req.body;
        
        if (adminKey !== process.env.ADMIN_SECRET_KEY) {
            return res.status(401).json({ 
                success: false, 
                error: 'Unauthorized' 
            });
        }
        
        const batch = db.batch();
        const snapshot = await db.collection('users').get();
        
        snapshot.forEach(doc => {
            batch.update(doc.ref, {
                gold: 0,
                totalMined: 0,
                miningActive: false,
                miningSessionStart: null,
                sessionGold: 0,
                lastUpdated: admin.firestore.FieldValue.serverTimestamp()
            });
        });
        
        await batch.commit();
        
        res.json({ 
            success: true, 
            message: `Reset ${snapshot.size} users` 
        });
        
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// ==========================================
// EXPORT FOR VERCEL (IMPORTANT!)
// ==========================================

module.exports = app;
