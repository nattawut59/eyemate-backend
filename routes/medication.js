// routes/medication.js - Updated with Push Notifications
const express = require('express');
const cron = require('node-cron');
const { pool } = require('../config/database');
const { authenticateToken, ensurePatient } = require('../middleware/auth');
const { generateId, logUserAction, formatDate } = require('../utils/helpers');
const { sendMedicationReminder } = require('../services/pushNotification');

const router = express.Router();

// Get patient medications
router.get('/', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const patientId = req.user.patientId;

        const [medications] = await pool.execute(
            `SELECT pm.*, m.Name, m.Type, m.Dosage_Form, m.Active_Ingredient, 
                    m.Description, m.Side_Effects,
                    CASE 
                        WHEN pm.eye = 'left' THEN 'ตาซ้าย'
                        WHEN pm.eye = 'right' THEN 'ตาขวา'
                        WHEN pm.eye = 'both' THEN 'ทั้งสองตา'
                        ELSE pm.eye
                    END as eye_display
             FROM Patient_Medications pm
             LEFT JOIN Medications m ON pm.Medication_ID = m.Medication_ID
             WHERE pm.Patient_ID = ? AND pm.Status = 'Active'
             ORDER BY pm.Created_At DESC`,
            [patientId]
        );

        res.json({ medications: medications || [] });

    } catch (error) {
        console.error('Get medications error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Get medication reminders
router.get('/reminders', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const patientId = req.user.patientId;

        const [reminders] = await pool.execute(
            `SELECT mr.*, m.Name as medication_name,
                    CASE 
                        WHEN mr.Eye = 'left' THEN 'ตาซ้าย'
                        WHEN mr.Eye = 'right' THEN 'ตาขวา'
                        WHEN mr.Eye = 'both' THEN 'ทั้งสองตา'
                        ELSE mr.Eye
                    END as eye_display
             FROM Medication_Reminders mr
             LEFT JOIN Patient_Medications pm ON mr.Patient_Medication_ID = pm.ID
             LEFT JOIN Medications m ON pm.Medication_ID = m.Medication_ID
             WHERE mr.Patient_ID = ? AND mr.Status = 'Pending'
             ORDER BY mr.Reminder_Time`,
            [patientId]
        );

        res.json({ reminders: reminders || [] });

    } catch (error) {
        console.error('Get reminders error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Create medication reminder
router.post('/reminders', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const patientId = req.user.patientId;
        const {
            patient_medication_id,
            reminder_time,
            days_of_week = 'Mon,Tue,Wed,Thu,Fri,Sat,Sun',
            notes
        } = req.body;

        if (!patient_medication_id || !reminder_time) {
            return res.status(400).json({
                message: 'ข้อมูลไม่ครบถ้วน',
                code: 'MISSING_DATA'
            });
        }

        // Check if medication exists for this patient
        const [medicationCheck] = await pool.execute(
            `SELECT pm.*, m.Name FROM Patient_Medications pm
             LEFT JOIN Medications m ON pm.Medication_ID = m.Medication_ID
             WHERE pm.ID = ? AND pm.Patient_ID = ?`,
            [patient_medication_id, patientId]
        );

        if (medicationCheck.length === 0) {
            return res.status(404).json({
                message: 'ไม่พบรายการยาที่เลือก',
                code: 'MEDICATION_NOT_FOUND'
            });
        }

        const reminderId = Date.now();

        // แก้ไขจาก Scheduled_Time เป็น Reminder_Time
        await pool.execute(
            `INSERT INTO Medication_Reminders 
             (ID, Patient_ID, Patient_Medication_ID, Reminder_Time, Reminder_Type, Status, Created_At)
             VALUES (?, ?, ?, ?, 'Push', 'Pending', NOW())`,
            [reminderId, patientId, patient_medication_id, reminder_time]
        );

        res.json({
            message: `ตั้งการแจ้งเตือนยา "${medicationCheck[0].Name}" สำเร็จ`,
            success: true,
            reminder_id: reminderId
        });

    } catch (error) {
        console.error('Create reminder error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการสร้างการแจ้งเตือน',
            code: 'CREATE_REMINDER_ERROR'
        });
    }
});

// Record medication usage
router.post('/usage', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const patientId = req.user.patientId;
        const {
            patient_medication_id,
            reminder_id,
            status = 'Taken',
            actual_time,
            notes
        } = req.body;

        const recordId = Date.now();
        const finalActualTime = actual_time || new Date();

        await pool.execute(
            `INSERT INTO Medication_Doses 
             (ID, Patient_Medication_ID, Scheduled_Time, Actual_Time, Status, Notes, Created_At)
             VALUES (?, ?, NOW(), ?, ?, ?, NOW())`,
            [recordId, patient_medication_id, finalActualTime, status, notes]
        );

        // Update reminder status if provided
        if (reminder_id) {
            await pool.execute(
                `UPDATE Medication_Reminders 
                 SET Status = 'Sent', Response_At = NOW() 
                 WHERE ID = ? AND Patient_ID = ?`,
                [reminder_id, patientId]
            );
        }

        res.json({
            message: 'บันทึกการใช้ยาสำเร็จ',
            success: true,
            record_id: recordId
        });

    } catch (error) {
        console.error('Record medication usage error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการบันทึกการใช้ยา',
            code: 'RECORD_ERROR'
        });
    }
});

// Get medication adherence report
router.get('/adherence', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const patientId = req.user.patientId;
        const { period = '30' } = req.query;

        const [adherence] = await pool.execute(
            `SELECT 
                pm.ID as medication_id,
                m.Name as medication_name,
                COUNT(md.ID) as total_scheduled,
                SUM(CASE WHEN md.Status = 'Taken' THEN 1 ELSE 0 END) as total_taken,
                SUM(CASE WHEN md.Status = 'Missed' THEN 1 ELSE 0 END) as total_missed,
                ROUND((SUM(CASE WHEN md.Status = 'Taken' THEN 1 ELSE 0 END) / COUNT(md.ID)) * 100, 2) as adherence_rate
             FROM Patient_Medications pm
             LEFT JOIN Medications m ON pm.Medication_ID = m.Medication_ID
             LEFT JOIN Medication_Doses md ON pm.ID = md.Patient_Medication_ID
                AND md.Scheduled_Time >= DATE_SUB(NOW(), INTERVAL ? DAY)
             WHERE pm.Patient_ID = ? AND pm.Status = 'Active'
             GROUP BY pm.ID, m.Name`,
            [parseInt(period), patientId]
        );

        res.json({ adherence: adherence || [] });

    } catch (error) {
        console.error('Get adherence error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Get medication usage history
router.get('/usage-history', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const patientId = req.user.patientId;
        const { period = '7', date } = req.query;

        let whereClause = 'WHERE pm.Patient_ID = ?';
        let params = [patientId];

        if (date) {
            whereClause += ' AND DATE(md.Scheduled_Time) = ?';
            params.push(date);
        } else if (period) {
            whereClause += ' AND md.Scheduled_Time >= DATE_SUB(NOW(), INTERVAL ? DAY)';
            params.push(parseInt(period));
        }

        const [records] = await pool.execute(
            `SELECT md.*, m.Name as medication_name, pm.Dosage,
                    CASE 
                        WHEN md.Status = 'Taken' THEN 'ใช้แล้ว'
                        WHEN md.Status = 'Missed' THEN 'พลาด'
                        WHEN md.Status = 'Late' THEN 'ใช้ช้า'
                        ELSE md.Status
                    END as status_display
             FROM Medication_Doses md
             LEFT JOIN Patient_Medications pm ON md.Patient_Medication_ID = pm.ID
             LEFT JOIN Medications m ON pm.Medication_ID = m.Medication_ID
             ${whereClause}
             ORDER BY md.Scheduled_Time DESC`,
            params
        );

        res.json({ records: records || [] });

    } catch (error) {
        console.error('Get medication usage history error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Check for missed medications (updated with push notifications)
const checkMissedMedications = async () => {
    try {
        console.log('🔔 Checking for missed medications...');
        
        const [missedMedications] = await pool.execute(
            `SELECT mr.*, m.Name, pm.Patient_ID, p.User_ID
             FROM Medication_Reminders mr
             LEFT JOIN Patient_Medications pm ON mr.Patient_Medication_ID = pm.ID
             LEFT JOIN Medications m ON pm.Medication_ID = m.Medication_ID
             LEFT JOIN Patients p ON pm.Patient_ID = p.Patient_ID
             WHERE mr.Status = 'Pending'
             AND NOT EXISTS (
                 SELECT 1 FROM Medication_Doses md
                 WHERE md.Patient_Medication_ID = mr.Patient_Medication_ID
                 AND DATE(md.Scheduled_Time) = CURDATE()
                 AND md.Status = 'Taken'
             )
             AND TIME(NOW()) > ADDTIME(TIME(mr.Reminder_Time), '00:15:00')`
        );

        for (const missed of missedMedications) {
            // Send push notification
            await sendMedicationReminder(
                missed.Patient_ID,
                missed.Name,
                missed.Reminder_Time
            );

            // Create database notification
            await createMedicationNotification(
                missed.User_ID,
                'missed_medication',
                'ยังไม่ได้หยอดยา',
                `ยังไม่ได้หยอดยา ${missed.Name} ตามเวลาที่กำหนด`,
                'high'
            );

            // Update reminder status
            await pool.execute(
                'UPDATE Medication_Reminders SET Status = "Missed" WHERE ID = ?',
                [missed.ID]
            );
        }
        
        console.log(`✅ Processed ${missedMedications.length} missed medication reminders`);
    } catch (error) {
        console.error('Check missed medications error:', error);
    }
};

// Check for upcoming medication reminders
const checkUpcomingMedications = async () => {
    try {
        console.log('🔔 Checking for upcoming medication reminders...');
        
        const [upcomingMeds] = await pool.execute(
            `SELECT mr.*, m.Name, pm.Patient_ID, p.User_ID
             FROM Medication_Reminders mr
             LEFT JOIN Patient_Medications pm ON mr.Patient_Medication_ID = pm.ID
             LEFT JOIN Medications m ON pm.Medication_ID = m.Medication_ID
             LEFT JOIN Patients p ON pm.Patient_ID = p.Patient_ID
             WHERE mr.Status = 'Pending'
             AND TIME(mr.Reminder_Time) = TIME(NOW())
             AND NOT EXISTS (
                 SELECT 1 FROM Medication_Doses md
                 WHERE md.Patient_Medication_ID = mr.Patient_Medication_ID
                 AND DATE(md.Scheduled_Time) = CURDATE()
                 AND md.Status = 'Taken'
             )`
        );

        for (const med of upcomingMeds) {
            // Send push notification for current time
            await sendMedicationReminder(
                med.Patient_ID,
                med.Name,
                med.Reminder_Time
            );

            console.log(`🔔 Sent reminder for ${med.Name} to patient ${med.Patient_ID}`);
        }
        
        console.log(`✅ Sent ${upcomingMeds.length} medication reminders`);
    } catch (error) {
        console.error('Check upcoming medications error:', error);
    }
};

// Create notification helper function
async function createMedicationNotification(userId, type, title, body, priority = 'medium') {
    try {
        const notificationId = Date.now() + Math.random() * 1000;
        
        await pool.execute(
            `INSERT INTO Notifications 
             (ID, Recipient_ID, Type, Title, Message, Priority, Status, Sent_At)
             VALUES (?, ?, ?, ?, ?, ?, 'Unread', NOW())`,
            [notificationId, userId, type, title, body, priority]
        );
        
        return notificationId;
    } catch (error) {
        console.error('Create medication notification error:', error);
    }
}

// Schedule medication reminder checks
console.log('🔔 Setting up medication reminder cron jobs...');

// Check for current time reminders every minute
cron.schedule('* * * * *', checkUpcomingMedications, {
    timezone: "Asia/Bangkok"
});

// Check for missed medications every 15 minutes
cron.schedule('*/15 * * * *', checkMissedMedications, {
    timezone: "Asia/Bangkok"
});

console.log('✅ Medication reminder cron jobs started');

module.exports = router;