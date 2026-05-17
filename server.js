const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Serve frontend files from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Firebase Admin
let admin;
let db;

try {
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
    console.log('Firebase connected');
    
} catch (error) {
    console.error('Firebase error:', error.message);
}

// Serve index.html for root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        firebase: db ? 'connected' : 'disconnected'
    });
});

// Referral process
app.post('/api/referral/process', async (req, res) => {
    try {
        if (!db) return res.status(500).json({ success: false, error: 'DB not connected' });

        const { newUserId, referralCode, newUserName, newUserUsername } = req.body;
        if (!newUserId || !referralCode) {
            return res.status(400).json({ success: false, error: 'Missing fields' });
        }

        const referrerQuery = await db.collection('users')
            .where('referralCode', '==', referralCode)
            .limit(1).get();

        if (referrerQuery.empty) {
            return res.status(404).json({ success: false, error: 'Referrer not found' });
        }

        const referrerDoc = referrerQuery.docs[0];
        const referrerId = referrerDoc.id;

        if (referrerId === newUserId.toString()) {
            return res.status(400).json({ success: false, error: 'Cannot self-refer' });
        }

        const existing = await db.collection('referralRecords')
            .where('referredId', '==', newUserId.toString())
            .limit(1).get();

        if (!existing.empty) {
            return res.status(400).json({ success: false, error: 'Already referred' });
        }

        const batch = db.batch();
        const timestamp = admin.firestore.FieldValue.serverTimestamp();

        batch.update(db.collection('users').doc(referrerId), {
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

        batch.set(db.collection('referralRecords').doc(), {
            referrerId: referrerId,
            referredId: newUserId.toString(),
            referredUsername: newUserUsername || newUserName || 'Anonymous',
            rewardAmount: 50,
            createdAt: timestamp,
            status: 'completed',
            platform: 'telegram'
        });

        batch.update(db.collection('users').doc(newUserId.toString()), {
            referredBy: referrerId,
            usedReferralCode: referralCode,
            referralProcessed: true,
            lastUpdated: timestamp
        });

        await batch.commit();

        res.json({ success: true, message: 'Referral processed', referrerBonus: 50 });

    } catch (error) {
        console.error('Referral error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get user referral stats
app.get('/api/referral/stats/:userId', async (req, res) => {
    try {
        if (!db) return res.status(500).json({ success: false, error: 'DB not connected' });
        
        const userDoc = await db.collection('users').doc(req.params.userId).get();
        if (!userDoc.exists) return res.status(404).json({ success: false, error: 'User not found' });

        const data = userDoc.data();
        res.json({
            success: true,
            referralCode: data.referralCode,
            referralCount: data.referralCount || 0,
            totalEarned: (data.referralCount || 0) * 50
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// User count
app.get('/api/users/count', async (req, res) => {
    try {
        if (!db) return res.status(500).json({ success: false, error: 'DB not connected' });
        const snapshot = await db.collection('users').get();
        res.json({ success: true, count: snapshot.size });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Admin reset
app.post('/api/admin/reset-gold', async (req, res) => {
    try {
        if (!db) return res.status(500).json({ success: false, error: 'DB not connected' });
        if (req.body.adminKey !== process.env.ADMIN_SECRET_KEY) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }

        const batch = db.batch();
        const snapshot = await db.collection('users').get();
        
        snapshot.forEach(doc => {
            batch.update(doc.ref, {
                gold: 0,
                totalMined: 0,
                miningActive: false,
                sessionGold: 0,
                lastUpdated: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        await batch.commit();
        res.json({ success: true, message: `Reset ${snapshot.size} users` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = app;
