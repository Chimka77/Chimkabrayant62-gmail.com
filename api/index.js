// ==========================================
// GOLDHUNT BACKEND — VERCEL SERVERLESS (DEBUG)
// api/index.js
// ==========================================

const admin = require('firebase-admin');

// ==========================================
// DEBUG LOGGER
// ==========================================
function log(level, message, data = {}) {
    const timestamp = new Date().toISOString();
    console.log(JSON.stringify({
        timestamp,
        level,
        message,
        ...data
    }));
}

log('INFO', 'Serverless function loaded');

// ==========================================
// 1. FIREBASE INITIALIZATION (with full error handling)
// ==========================================
let db = null;
let firebaseInitialized = false;

function initFirebase() {
    if (firebaseInitialized) return true;
    
    try {
        log('INFO', 'Initializing Firebase...');
        
        // Check if already initialized
        if (admin.apps.length > 0) {
            log('INFO', 'Firebase already initialized');
            db = admin.firestore();
            firebaseInitialized = true;
            return true;
        }
        
        // Build credential from env vars
        const projectId = process.env.FIREBASE_PROJECT_ID;
        const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
        let privateKey = process.env.FIREBASE_PRIVATE_KEY;
        
        log('INFO', 'Checking environment variables', {
            hasProjectId: !!projectId,
            hasClientEmail: !!clientEmail,
            hasPrivateKey: !!privateKey,
            privateKeyLength: privateKey ? privateKey.length : 0
        });
        
        if (!projectId || !clientEmail || !privateKey) {
            log('ERROR', 'Missing Firebase environment variables', {
                projectId: !!projectId,
                clientEmail: !!clientEmail,
                privateKey: !!privateKey
            });
            return false;
        }
        
        // Fix private key formatting
        if (privateKey.includes('\\n')) {
            privateKey = privateKey.replace(/\\n/g, '\n');
            log('INFO', 'Fixed private key newlines');
        }
        
        if (!privateKey.includes('BEGIN PRIVATE KEY')) {
            log('ERROR', 'Private key appears malformed');
            return false;
        }
        
        const credential = admin.credential.cert({
            projectId,
            clientEmail,
            privateKey
        });
        
        admin.initializeApp({
            credential,
            projectId
        });
        
        db = admin.firestore();
        firebaseInitialized = true;
        
        log('INFO', 'Firebase initialized successfully');
        return true;
        
    } catch (error) {
        log('ERROR', 'Firebase initialization failed', {
            error: error.message,
            stack: error.stack
        });
        return false;
    }
}

function getDb() {
    if (!db) {
        initFirebase();
    }
    return db;
}

// ==========================================
// 2. CONFIG
// ==========================================
const REFERRAL_CONFIG = {
    WELCOME_BONUS: 50,
    INVITER_BONUS: 50,
    MAX_REFERRALS_PER_DAY: 100,
    COOLDOWN_MS: 5000,
    ALLOW_SELF_REFERRAL: false
};

// ==========================================
// 3. HELPERS
// ==========================================
function generateReferralCode(telegramId) {
    return 'ref' + telegramId.toString();
}

async function findReferrerByCode(code) {
    const database = getDb();
    if (!database) {
        log('ERROR', 'Database not available in findReferrerByCode');
        return null;
    }
    
    if (!code) return null;
    
    const cleanCode = code.toString().trim().split('?')[0].split('&')[0];
    log('INFO', 'Finding referrer', { code: cleanCode });
    
    try {
        // Direct ID lookup
        let searchId = cleanCode;
        if (cleanCode.startsWith('ref')) {
            searchId = cleanCode.replace('ref', '');
        }
        
        if (/^\d+$/.test(searchId)) {
            const directDoc = await database.collection('users').doc(searchId).get();
            if (directDoc.exists) {
                const data = directDoc.data();
                log('INFO', 'Found referrer by direct ID', { referrerId: data.telegramId });
                return data.telegramId?.toString() || searchId;
            }
        }
        
        // Query by referralCode
        const snapshot = await database.collection('users')
            .where('referralCode', '==', cleanCode)
            .limit(1)
            .get();
        
        if (!snapshot.empty) {
            const id = snapshot.docs[0].data().telegramId?.toString();
            log('INFO', 'Found referrer by code query', { referrerId: id });
            return id;
        }
        
        // Try with ref prefix
        if (!cleanCode.startsWith('ref')) {
            const snapshot2 = await database.collection('users')
                .where('referralCode', '==', 'ref' + cleanCode)
                .limit(1)
                .get();
            if (!snapshot2.empty) {
                const id = snapshot2.docs[0].data().telegramId?.toString();
                log('INFO', 'Found referrer with ref prefix', { referrerId: id });
                return id;
            }
        }
        
        log('INFO', 'No referrer found');
        return null;
        
    } catch (error) {
        log('ERROR', 'Error in findReferrerByCode', { error: error.message });
        return null;
    }
}

async function processReferralAtomic(referrerId, newUserId, newUserName) {
    const database = getDb();
    if (!database) {
        return { success: false, error: 'Database not available' };
    }
    
    const referrerRef = database.collection('users').doc(referrerId.toString());
    
    try {
        log('INFO', 'Starting referral transaction', { referrerId, newUserId });
        
        await database.runTransaction(async (transaction) => {
            const referrerSnap = await transaction.get(referrerRef);
            
            if (!referrerSnap.exists) {
                throw new Error('Referrer not found');
            }
            
            const referrerData = referrerSnap.data();
            
            // Rate limit
            const lastReferral = referrerData.lastReferralTime?.toDate?.() || null;
            const now = admin.firestore.Timestamp.now();
            if (lastReferral && (now.toMillis() - lastReferral.toMillis()) < REFERRAL_CONFIG.COOLDOWN_MS) {
                throw new Error('Rate limit');
            }
            
            // Daily limit
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const todayReferrals = (referrerData.referrals || []).filter(r => {
                const joinDate = r.joinedAt?.toDate?.();
                return joinDate && joinDate >= today;
            });
            
            if (todayReferrals.length >= REFERRAL_CONFIG.MAX_REFERRALS_PER_DAY) {
                throw new Error('Daily limit reached');
            }
            
            // Already referred
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
            
            // Create record
            const recordRef = database.collection('referralRecords').doc();
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
        
        log('INFO', 'Referral transaction completed', { referrerId, newUserId });
        return { success: true };
        
    } catch (error) {
        log('ERROR', 'Referral transaction failed', { 
            error: error.message,
            referrerId,
            newUserId 
        });
        return { success: false, error: error.message };
    }
}

// ==========================================
// 4. CORS
// ==========================================
function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-telegram-init-data');
}

// ==========================================
// 5. MAIN HANDLER
// ==========================================
module.exports = async (req, res) => {
    log('INFO', 'Request received', { 
        method: req.method, 
        url: req.url,
        pathname: req.url.split('?')[0]
    });
    
    setCorsHeaders(res);
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    // Initialize Firebase first
    if (!initFirebase()) {
        log('ERROR', 'Firebase initialization failed, cannot process request');
        return res.status(500).json({ 
            error: 'Service temporarily unavailable',
            details: 'Database connection failed. Check environment variables.'
        });
    }
    
    const pathname = req.url.split('?')[0];
    
    try {
        // ===== HEALTH CHECK =====
        if (pathname === '/api/health' || pathname === '/health') {
            log('INFO', 'Health check');
            return res.status(200).json({ 
                status: 'ok', 
                firebase: firebaseInitialized,
                timestamp: new Date().toISOString() 
            });
        }
        
        // ===== USER REGISTRATION =====
        if ((pathname === '/api/user/register' || pathname === '/user/register') && req.method === 'POST') {
            log('INFO', 'Processing user registration');
            
            let body;
            try {
                body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
            } catch (e) {
                log('ERROR', 'Failed to parse request body', { error: e.message });
                return res.status(400).json({ error: 'Invalid JSON body' });
            }
            
            const { telegramId, username, firstName, startParam } = body;
            
            log('INFO', 'Registration data', { 
                telegramId: telegramId?.toString(),
                hasUsername: !!username,
                hasStartParam: !!startParam 
            });
            
            if (!telegramId) {
                return res.status(400).json({ error: 'telegramId required' });
            }
            
            const database = getDb();
            const userRef = database.collection('users').doc(telegramId.toString());
            
            log('INFO', 'Checking if user exists');
            const userSnap = await userRef.get();
            
            // User exists
            if (userSnap.exists) {
                log('INFO', 'User already exists', { telegramId });
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
                log('INFO', 'Processing referral', { startParam });
                const referrerId = await findReferrerByCode(startParam);
                
                if (referrerId && referrerId !== telegramId.toString()) {
                    log('INFO', 'Valid referrer found', { referrerId });
                    const result = await processReferralAtomic(referrerId, telegramId, username || firstName);
                    
                    if (result.success) {
                        referredBy = referrerId;
                        referralProcessed = true;
                        referralBonus = REFERRAL_CONFIG.WELCOME_BONUS;
                        log('INFO', 'Referral processed successfully');
                    } else {
                        log('WARN', 'Referral processing failed', { error: result.error });
                    }
                } else if (referrerId === telegramId.toString()) {
                    log('WARN', 'Self-referral blocked');
                }
            }
            
            // Create user
            const referralCode = generateReferralCode(telegramId);
            
            const userData = {
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
            };
            
            log('INFO', 'Creating new user', { telegramId, referralCode });
            await userRef.set(userData);
            
            log('INFO', 'User created successfully');
            return res.json({
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
        }
        
        // ===== GET REFERRALS =====
        if ((pathname === '/api/user/referrals' || pathname === '/user/referrals') && req.method === 'GET') {
            const telegramId = req.query.telegramId || req.url.split('telegramId=')[1]?.split('&')[0];
            
            if (!telegramId) {
                return res.status(400).json({ error: 'telegramId required' });
            }
            
            const database = getDb();
            const userRef = database.collection('users').doc(telegramId.toString());
            const userSnap = await userRef.get();
            
            if (!userSnap.exists) {
                return res.status(404).json({ error: 'User not found' });
            }
            
            const data = userSnap.data();
            
            return res.json({
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
        }
        
        // ===== LEADERBOARD =====
        if ((pathname === '/api/leaderboard/referrals' || pathname === '/leaderboard/referrals') && req.method === 'GET') {
            const limit = Math.min(parseInt(req.query.limit) || 50, 100);
            const database = getDb();
            
            const snapshot = await database.collection('users')
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
            
            return res.json({
                success: true,
                leaderboard: leaders
            });
        }
        
        // ===== SYNC =====
        if ((pathname === '/api/user/sync' || pathname === '/user/sync') && req.method === 'POST') {
            let body;
            try {
                body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
            } catch (e) {
                return res.status(400).json({ error: 'Invalid JSON body' });
            }
            
            const { telegramId, gold, totalMined, miningActive, walletAddress } = body;
            
            if (!telegramId) {
                return res.status(400).json({ error: 'telegramId required' });
            }
            
            const database = getDb();
            const userRef = database.collection('users').doc(telegramId.toString());
            const updateData = {
                lastActive: admin.firestore.FieldValue.serverTimestamp(),
                lastUpdated: admin.firestore.FieldValue.serverTimestamp()
            };
            
            if (gold !== undefined) updateData.gold = gold;
            if (totalMined !== undefined) updateData.totalMined = totalMined;
            if (miningActive !== undefined) updateData.miningActive = miningActive;
            if (walletAddress !== undefined) updateData.walletAddress = walletAddress;
            
            await userRef.update(updateData);
            
            return res.json({ success: true });
        }
        
        // ===== 404 =====
        log('WARN', 'Route not found', { pathname });
        return res.status(404).json({ error: 'Not found', path: pathname });
        
    } catch (error) {
        log('ERROR', 'Unhandled error in handler', {
            error: error.message,
            stack: error.stack,
            pathname
        });
        
        return res.status(500).json({ 
            error: 'Internal server error',
            message: error.message,
            path: pathname
        });
    }
};
