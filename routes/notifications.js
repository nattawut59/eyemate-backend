// routes/notifications.js - Push Notification Routes
const express = require('express');
const { pool } = require('../config/database');
const { authenticateToken, ensurePatient } = require('../middleware/auth');
const { subscribeUser, unsubscribeUser, sendPushNotification } = require('../services/pushNotification');

const router = express.Router();

// Subscribe to push notifications
router.post('/subscribe', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { subscription } = req.body;

        if (!subscription || !subscription.endpoint || !subscription.keys) {
            return res.status(400).json({
                message: 'Invalid subscription data',
                code: 'INVALID_SUBSCRIPTION'
            });
        }

        const success = await subscribeUser(userId, subscription);

        if (success) {
            // Send test notification
            await sendPushNotification(
                userId,
                'การแจ้งเตือนพร้อมใช้งาน',
                'คุณจะได้รับการแจ้งเตือนสำหรับยา และนัดหมายแพทย์',
                { type: 'welcome' }
            );

            res.json({
                message: 'สมัครรับการแจ้งเตือนสำเร็จ',
                success: true
            });
        } else {
            res.status(500).json({
                message: 'ไม่สามารถสมัครรับการแจ้งเตือนได้',
                code: 'SUBSCRIPTION_FAILED'
            });
        }

    } catch (error) {
        console.error('Subscribe push notification error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Unsubscribe from push notifications
router.post('/unsubscribe', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { endpoint } = req.body;

        if (!endpoint) {
            return res.status(400).json({
                message: 'Endpoint required',
                code: 'MISSING_ENDPOINT'
            });
        }

        const success = await unsubscribeUser(userId, endpoint);

        if (success) {
            res.json({
                message: 'ยกเลิกการแจ้งเตือนสำเร็จ',
                success: true
            });
        } else {
            res.status(500).json({
                message: 'ไม่สามารถยกเลิกการแจ้งเตือนได้',
                code: 'UNSUBSCRIBE_FAILED'
            });
        }

    } catch (error) {
        console.error('Unsubscribe push notification error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Get push notification status
router.get('/status', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;

        const [subscriptions] = await pool.execute(
            'SELECT COUNT(*) as count FROM Push_Subscriptions WHERE User_ID = ? AND Is_Active = 1',
            [userId]
        );

        res.json({
            enabled: subscriptions[0].count > 0,
            active_subscriptions: subscriptions[0].count
        });

    } catch (error) {
        console.error('Get notification status error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Send test notification (for testing purposes)
router.post('/test', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { title = 'ทดสอบการแจ้งเตือน', body = 'นี่คือการแจ้งเตือนทดสอบ' } = req.body;

        const result = await sendPushNotification(userId, title, body, { type: 'test' });

        res.json({
            message: 'ส่งการแจ้งเตือนทดสอบแล้ว',
            result: result
        });

    } catch (error) {
        console.error('Send test notification error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Get VAPID public key for client
router.get('/vapid-public-key', (req, res) => {
    res.json({
        publicKey: process.env.VAPID_PUBLIC_KEY || 'BEl62iUYgUivxIkv69yViEuiBIa40HcCGtrxS7aiDw6RKGkLOw-MYwlPqWIDfqW8r3DYLzlhI4HqU5w8w8rD2MQ'
    });
});

module.exports = router;