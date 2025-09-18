// services/pushNotification.js - Push Notification Service
const webpush = require('web-push');
const { pool } = require('../config/database');

// Configure web-push with VAPID keys
webpush.setVapidDetails(
    'mailto:admin@eyemate.com',
    process.env.VAPID_PUBLIC_KEY || 'BEl62iUYgUivxIkv69yViEuiBIa40HcCGtrxS7aiDw6RKGkLOw-MYwlPqWIDfqW8r3DYLzlhI4HqU5w8w8rD2MQ',
    process.env.VAPID_PRIVATE_KEY || 'dUiMGdHqJH7YCGpvMqz2t8YcQ8nL1O2P3RSTwKv9yFs'
);

// Send push notification
const sendPushNotification = async (userId, title, body, data = {}) => {
    try {
        // Get user's push subscriptions
        const [subscriptions] = await pool.execute(
            `SELECT * FROM Push_Subscriptions 
             WHERE User_ID = ? AND Is_Active = 1`,
            [userId]
        );

        if (subscriptions.length === 0) {
            console.log(`No active push subscriptions found for user: ${userId}`);
            return { sent: 0, failed: 0 };
        }

        const payload = JSON.stringify({
            title,
            body,
            icon: '/icons/eyemate-icon-192.png',
            badge: '/icons/eyemate-badge-72.png',
            data: {
                url: '/dashboard',
                timestamp: Date.now(),
                ...data
            }
        });

        let sent = 0, failed = 0;

        for (const subscription of subscriptions) {
            try {
                const pushSubscription = {
                    endpoint: subscription.Endpoint,
                    keys: {
                        p256dh: subscription.P256dh_Key,
                        auth: subscription.Auth_Key
                    }
                };

                await webpush.sendNotification(pushSubscription, payload);
                sent++;
                
                // Update last sent timestamp
                await pool.execute(
                    'UPDATE Push_Subscriptions SET Last_Sent_At = NOW() WHERE ID = ?',
                    [subscription.ID]
                );

            } catch (error) {
                failed++;
                console.error(`Failed to send push notification to subscription ${subscription.ID}:`, error);
                
                // If subscription is invalid, deactivate it
                if (error.statusCode === 410) {
                    await pool.execute(
                        'UPDATE Push_Subscriptions SET Is_Active = 0 WHERE ID = ?',
                        [subscription.ID]
                    );
                }
            }
        }

        // Log notification
        await logNotification(userId, title, body, sent > 0 ? 'sent' : 'failed');

        return { sent, failed };

    } catch (error) {
        console.error('Send push notification error:', error);
        return { sent: 0, failed: 1 };
    }
};

// Send medication reminder
const sendMedicationReminder = async (patientId, medicationName, reminderTime) => {
    try {
        // Get user ID from patient ID
        const [patients] = await pool.execute(
            'SELECT User_ID FROM Patients WHERE Patient_ID = ?',
            [patientId]
        );

        if (patients.length === 0) return;

        const userId = patients[0].User_ID;
        
        await sendPushNotification(
            userId,
            'เวลาหยอดยาตา',
            `ถึงเวลาหยอดยา ${medicationName} แล้ว`,
            {
                type: 'medication_reminder',
                medicationName,
                reminderTime,
                url: '/medications'
            }
        );

    } catch (error) {
        console.error('Send medication reminder error:', error);
    }
};

// Send appointment reminder
const sendAppointmentReminder = async (patientId, appointmentDate, appointmentTime, daysUntil) => {
    try {
        const [patients] = await pool.execute(
            'SELECT User_ID FROM Patients WHERE Patient_ID = ?',
            [patientId]
        );

        if (patients.length === 0) return;

        const userId = patients[0].User_ID;
        
        let title, body;
        if (daysUntil === 0) {
            title = 'นัดหมายแพทย์วันนี้';
            body = `คุณมีนัดพบแพทย์วันนี้เวลา ${appointmentTime}`;
        } else if (daysUntil === 1) {
            title = 'นัดหมายแพทย์พรุ่งนี้';
            body = `คุณมีนัดพบแพทย์พรุ่งนี้เวลา ${appointmentTime}`;
        } else {
            title = 'แจ้งเตือนนัดหมายแพทย์';
            body = `คุณมีนัดพบแพทย์อีก ${daysUntil} วัน (${appointmentDate} เวลา ${appointmentTime})`;
        }

        await sendPushNotification(
            userId,
            title,
            body,
            {
                type: 'appointment_reminder',
                appointmentDate,
                appointmentTime,
                daysUntil,
                url: '/appointments'
            }
        );

    } catch (error) {
        console.error('Send appointment reminder error:', error);
    }
};

// Send high IOP alert
const sendHighIOPAlert = async (patientId, leftEyeIOP, rightEyeIOP) => {
    try {
        const [patients] = await pool.execute(
            'SELECT User_ID FROM Patients WHERE Patient_ID = ?',
            [patientId]
        );

        if (patients.length === 0) return;

        const userId = patients[0].User_ID;
        
        await sendPushNotification(
            userId,
            'ค่าความดันลูกตาสูง',
            `ค่าความดันลูกตาของคุณสูงกว่าปกติ กรุณาติดต่อแพทย์`,
            {
                type: 'high_iop_alert',
                leftEyeIOP,
                rightEyeIOP,
                url: '/iop-analytics'
            }
        );

    } catch (error) {
        console.error('Send high IOP alert error:', error);
    }
};

// Log notification to database
const logNotification = async (userId, title, body, status) => {
    try {
        const notificationId = Date.now();
        await pool.execute(
            `INSERT INTO Notifications 
             (ID, Recipient_ID, Type, Title, Message, Priority, Status, Sent_At)
             VALUES (?, ?, 'push_notification', ?, ?, 'medium', ?, NOW())`,
            [notificationId, userId, title, body, status]
        );
    } catch (error) {
        console.error('Log notification error:', error);
    }
};

// Subscribe user to push notifications
const subscribeUser = async (userId, subscription) => {
    try {
        const subscriptionId = Date.now();
        
        await pool.execute(
            `INSERT INTO Push_Subscriptions 
             (ID, User_ID, Endpoint, P256dh_Key, Auth_Key, Is_Active, Created_At)
             VALUES (?, ?, ?, ?, ?, 1, NOW())
             ON DUPLICATE KEY UPDATE
             P256dh_Key = VALUES(P256dh_Key),
             Auth_Key = VALUES(Auth_Key),
             Is_Active = 1,
             Updated_At = NOW()`,
            [
                subscriptionId,
                userId,
                subscription.endpoint,
                subscription.keys.p256dh,
                subscription.keys.auth
            ]
        );

        return true;
    } catch (error) {
        console.error('Subscribe user error:', error);
        return false;
    }
};

// Unsubscribe user from push notifications
const unsubscribeUser = async (userId, endpoint) => {
    try {
        await pool.execute(
            'UPDATE Push_Subscriptions SET Is_Active = 0 WHERE User_ID = ? AND Endpoint = ?',
            [userId, endpoint]
        );
        return true;
    } catch (error) {
        console.error('Unsubscribe user error:', error);
        return false;
    }
};

module.exports = {
    sendPushNotification,
    sendMedicationReminder,
    sendAppointmentReminder,
    sendHighIOPAlert,
    subscribeUser,
    unsubscribeUser
};