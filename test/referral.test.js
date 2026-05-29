const request = require('supertest');
const app = require('../server');

describe('GoldHunt Referral System', () => {
    
    // Test 1: Health check
    test('GET /api/health returns ok', async () => {
        const res = await request(app).get('/api/health');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
    });

    // Test 2: Register new user without referral
    test('POST /api/user/register - new user without referral', async () => {
        const res = await request(app)
            .post('/api/user/register')
            .send({
                telegramId: '123456789',
                username: 'testuser',
                firstName: 'Test',
                startParam: null
            });
        
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.existing).toBe(false);
        expect(res.body.user.gold).toBe(0);
        expect(res.body.user.referralCode).toBe('ref123456789');
    });

    // Test 3: Register with valid referral
    test('POST /api/user/register - new user with valid referral', async () => {
        // First create referrer
        await request(app)
            .post('/api/user/register')
            .send({
                telegramId: '999999999',
                username: 'referrer',
                firstName: 'Referrer',
                startParam: null
            });
        
        // Then create referred user
        const res = await request(app)
            .post('/api/user/register')
            .send({
                telegramId: '111111111',
                username: 'referred',
                firstName: 'Referred',
                startParam: 'ref999999999'
            });
        
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.user.gold).toBe(50); // Welcome bonus
        expect(res.body.user.referredBy).toBe('999999999');
    });

    // Test 4: Prevent self-referral
    test('POST /api/user/register - prevent self-referral', async () => {
        const res = await request(app)
            .post('/api/user/register')
            .send({
                telegramId: '123456789',
                username: 'testuser',
                firstName: 'Test',
                startParam: 'ref123456789' // Self referral
            });
        
        expect(res.status).toBe(200);
        expect(res.body.user.referredBy).toBeNull();
    });

    // Test 5: Prevent duplicate referral
    test('POST /api/user/register - prevent duplicate referral', async () => {
        const res = await request(app)
            .post('/api/user/register')
            .send({
                telegramId: '111111111', // Already registered
                username: 'referred',
                firstName: 'Referred',
                startParam: 'ref999999999'
            });
        
        expect(res.status).toBe(200);
        expect(res.body.existing).toBe(true);
    });

    // Test 6: Get user referrals
    test('GET /api/user/referrals', async () => {
        const res = await request(app)
            .get('/api/user/referrals')
            .query({ telegramId: '999999999' });
        
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.referralCount).toBeGreaterThan(0);
        expect(res.body.referrals.length).toBeGreaterThan(0);
    });

    // Test 7: Get referral leaderboard
    test('GET /api/leaderboard/referrals', async () => {
        const res = await request(app)
            .get('/api/leaderboard/referrals')
            .query({ limit: 10 });
        
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.leaderboard)).toBe(true);
    });

    // Test 8: Invalid telegramId
    test('POST /api/user/register - missing telegramId', async () => {
        const res = await request(app)
            .post('/api/user/register')
            .send({
                username: 'test',
                firstName: 'Test'
            });
        
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('telegramId required');
    });

    // Test 9: Sync user data
    test('POST /api/user/sync', async () => {
        const res = await request(app)
            .post('/api/user/sync')
            .send({
                telegramId: '123456789',
                gold: 1000,
                totalMined: 500
            });
        
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});
