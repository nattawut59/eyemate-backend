// routes/patient.js - Patient Routes
const express = require('express');
const { pool } = require('../config/database');
const { authenticateToken, ensurePatient } = require('../middleware/auth');
const { generateId, logUserAction, formatDate } = require('../utils/helpers');

const router = express.Router();

// Get patient profile
router.get('/profile', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;

        const [profiles] = await pool.execute(
            `SELECT p.*, u.Phone_Number, u.Address, u.Created_At
             FROM Patients p
             JOIN Users u ON p.User_ID = u.National_ID
             WHERE p.User_ID = ?`,
            [userId]
        );

        if (profiles.length === 0) {
            return res.status(404).json({
                message: 'ไม่พบข้อมูลผู้ป่วย',
                code: 'PATIENT_NOT_FOUND'
            });
        }

        const profile = profiles[0];

        // Calculate age if Date_Of_Birth exists in Users table
        const [userInfo] = await pool.execute(
            'SELECT Date_Of_Birth FROM Users WHERE National_ID = ?',
            [userId]
        );

        let age = null;
        if (userInfo[0] && userInfo[0].Date_Of_Birth) {
            const birthDate = new Date(userInfo[0].Date_Of_Birth);
            const today = new Date();
            age = today.getFullYear() - birthDate.getFullYear();
        }

        res.json({
            profile: {
                ...profile,
                age,
                Date_First_Diagnosed: profile.Date_First_Diagnosed ? formatDate(profile.Date_First_Diagnosed) : null
            }
        });

    } catch (error) {
        console.error('Get profile error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Update patient profile
router.put('/profile', authenticateToken, ensurePatient, async (req, res) => {
    const connection = await pool.getConnection();
    
    try {
        await connection.beginTransaction();
        
        const userId = req.user.userId;
        const {
            glaucoma_type, glaucoma_stage, primary_hospital, insurance_type, insurance_provider,
            phone_number, address
        } = req.body;

        // Update Users table
        if (phone_number || address) {
            await connection.execute(
                `UPDATE Users SET 
                 Phone_Number = COALESCE(?, Phone_Number), 
                 Address = COALESCE(?, Address),
                 Updated_At = NOW()
                 WHERE National_ID = ?`,
                [phone_number, address, userId]
            );
        }

        // Update Patients table
        await connection.execute(
            `UPDATE Patients SET
             Glaucoma_Type = COALESCE(?, Glaucoma_Type),
             Glaucoma_Stage = COALESCE(?, Glaucoma_Stage),
             Primary_Hospital = COALESCE(?, Primary_Hospital),
             Insurance_Type = COALESCE(?, Insurance_Type),
             Insurance_Provider = COALESCE(?, Insurance_Provider),
             Updated_At = NOW()
             WHERE User_ID = ?`,
            [glaucoma_type, glaucoma_stage, primary_hospital, insurance_type, insurance_provider, userId]
        );

        await connection.commit();

        res.json({
            message: 'อัปเดตข้อมูลสำเร็จ',
            success: true
        });

    } catch (error) {
        await connection.rollback();
        console.error('Update profile error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการอัปเดตข้อมูล',
            code: 'UPDATE_ERROR'
        });
    } finally {
        connection.release();
    }
});

// Record IOP measurement
router.post('/iop-measurement', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const patientId = req.user.patientId;
        const {
            left_eye_iop, right_eye_iop, target_iop_left, target_iop_right,
            measurement_method, notes
        } = req.body;

        const measurementId = Date.now(); // Use timestamp as ID
        const now = new Date();

        await pool.execute(
            `INSERT INTO IOP_Records 
             (ID, Patient_ID, Measured_Date, Left_Eye_IOP, Right_Eye_IOP, 
              Target_IOP_Left, Target_IOP_Right, Measurement_Method, Notes, Created_At)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
            [measurementId, patientId, formatDate(now), left_eye_iop, right_eye_iop,
             target_iop_left, target_iop_right, measurement_method, notes]
        );

        // Check for high IOP alert
        if ((left_eye_iop && left_eye_iop > 21) || (right_eye_iop && right_eye_iop > 21)) {
            await createNotification(
                req.user.userId,
                'high_iop',
                'ค่าความดันลูกตาสูง',
                `ค่าความดันลูกตา: ตาซ้าย ${left_eye_iop} mmHg, ตาขวา ${right_eye_iop} mmHg`,
                'high'
            );
        }

        res.json({
            message: 'บันทึกค่าความดันลูกตาสำเร็จ',
            success: true,
            measurement_id: measurementId
        });

    } catch (error) {
        console.error('Record IOP error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการบันทึกค่าความดันลูกตา',
            code: 'RECORD_ERROR'
        });
    }
});

// Get IOP measurements
router.get('/iop-measurements', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const patientId = req.user.patientId;
        const { period = '30' } = req.query;

        const [measurements] = await pool.execute(
            `SELECT * FROM IOP_Records
             WHERE Patient_ID = ? 
             AND Measured_Date >= DATE_SUB(NOW(), INTERVAL ? DAY)
             ORDER BY Measured_Date DESC, Created_At DESC`,
            [patientId, parseInt(period)]
        );

        res.json({ measurements: measurements || [] });

    } catch (error) {
        console.error('Get IOP measurements error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR',
            measurements: []
        });
    }
});

// Get IOP analytics
router.get('/iop-analytics', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const patientId = req.user.patientId;
        const { period = '90' } = req.query;

        const [dailyData] = await pool.execute(
            `SELECT 
                Measured_Date,
                AVG(Left_Eye_IOP) as avg_left_iop,
                AVG(Right_Eye_IOP) as avg_right_iop,
                MAX(Left_Eye_IOP) as max_left_iop,
                MAX(Right_Eye_IOP) as max_right_iop,
                MIN(Left_Eye_IOP) as min_left_iop,
                MIN(Right_Eye_IOP) as min_right_iop,
                COUNT(*) as measurement_count
             FROM IOP_Records
             WHERE Patient_ID = ? 
             AND Measured_Date >= DATE_SUB(NOW(), INTERVAL ? DAY)
             GROUP BY Measured_Date
             ORDER BY Measured_Date`,
            [patientId, parseInt(period)]
        );

        // Calculate trends
        let trends = {};
        if (dailyData.length > 0) {
            const leftIOPs = dailyData.map(d => d.avg_left_iop).filter(v => v !== null && !isNaN(v));
            const rightIOPs = dailyData.map(d => d.avg_right_iop).filter(v => v !== null && !isNaN(v));
            
            trends = {
                avg_left_iop: leftIOPs.length > 0 ? leftIOPs.reduce((a, b) => a + b, 0) / leftIOPs.length : null,
                avg_right_iop: rightIOPs.length > 0 ? rightIOPs.reduce((a, b) => a + b, 0) / rightIOPs.length : null
            };
        }

        res.json({
            daily_data: dailyData || [],
            trends: trends,
            target_iop: 18,
            period_days: parseInt(period)
        });

    } catch (error) {
        console.error('Get IOP analytics error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR',
            daily_data: [],
            trends: {}
        });
    }
});

// Get appointments
router.get('/appointments', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const patientId = req.user.patientId;
        const { status = 'all', upcoming = false } = req.query;

        let whereClause = 'WHERE Patient_ID = ?';
        let params = [patientId];

        if (status !== 'all') {
            whereClause += ' AND Status = ?';
            params.push(status);
        }

        if (upcoming === 'true') {
            whereClause += ' AND Appointment_Date >= CURDATE()';
        }

        const [appointments] = await pool.execute(
            `SELECT *,
                    DATEDIFF(Appointment_Date, CURDATE()) as days_until_appointment,
                    CASE 
                        WHEN Appointment_Date = CURDATE() THEN 'today'
                        WHEN Appointment_Date = DATE_ADD(CURDATE(), INTERVAL 1 DAY) THEN 'tomorrow'
                        WHEN DATEDIFF(Appointment_Date, CURDATE()) <= 7 THEN 'this_week'
                        ELSE 'later'
                    END as appointment_timing
             FROM Appointments 
             ${whereClause}
             ORDER BY Appointment_Date DESC, Appointment_Time DESC`,
            params
        );

        res.json({ 
            appointments: appointments || [],
            message: appointments.length === 0 ? 'ยังไม่มีการนัดหมาย กรุณาติดต่อเจ้าหน้าที่เพื่อนัดหมาย' : null
        });

    } catch (error) {
        console.error('Get appointments error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR',
            appointments: []
        });
    }
});

// Request appointment reschedule
router.post('/appointment-reschedule-request', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const patientId = req.user.patientId;
        const { appointment_id, preferred_date_1, preferred_date_2, reason } = req.body;

        if (!appointment_id || !preferred_date_1 || !reason) {
            return res.status(400).json({
                message: 'ข้อมูลไม่ครบถ้วน',
                code: 'MISSING_DATA'
            });
        }

        // Check if appointment exists and belongs to this patient
        const [appointments] = await pool.execute(
            `SELECT * FROM Appointments 
             WHERE ID = ? AND Patient_ID = ?`,
            [appointment_id, patientId]
        );

        if (appointments.length === 0) {
            return res.status(404).json({
                message: 'ไม่พบการนัดหมายที่ระบุ กรุณาติดต่อเจ้าหน้าที่',
                code: 'APPOINTMENT_NOT_FOUND'
            });
        }

        const appointment = appointments[0];

        // Log reschedule request
        console.log('=== RESCHEDULE REQUEST LOGGED ===');
        console.log('Timestamp:', new Date().toISOString());
        console.log('Patient ID:', patientId);
        console.log('Appointment ID:', appointment_id);
        console.log('Original Date:', appointment.Appointment_Date);
        console.log('Original Time:', appointment.Appointment_Time);
        console.log('Preferred Date 1:', preferred_date_1);
        console.log('Preferred Date 2:', preferred_date_2 || 'Not specified');
        console.log('Reason:', reason);
        console.log('Status: PENDING ADMIN REVIEW');
        console.log('====================================');

        // Insert into reschedule requests table if it exists, otherwise just log
        try {
            const requestId = Date.now();
            await pool.execute(
                `INSERT INTO Appointment_Reschedule_Requests 
                 (ID, Appointment_ID, Patient_ID, Reason, New_Preferred_Date, Status, Created_At)
                 VALUES (?, ?, ?, ?, ?, 'Pending', NOW())`,
                [requestId, appointment_id, patientId, reason, preferred_date_1]
            );
        } catch (dbError) {
            console.log('Note: Reschedule requests table may not exist, logged to console instead');
        }

        res.json({
            message: 'ส่งคำขอเลื่อนนัดสำเร็จ เจ้าหน้าที่จะติดต่อกลับภายใน 1-2 วันทำการ',
            success: true,
            request_details: {
                appointment_id: appointment_id,
                original_date: appointment.Appointment_Date,
                preferred_dates: {
                    first: preferred_date_1,
                    second: preferred_date_2
                },
                submitted_at: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('Reschedule request error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการส่งคำขอ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Get dashboard data
router.get('/dashboard', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const patientId = req.user.patientId;

        // Get upcoming appointments
        const [appointments] = await pool.execute(
            `SELECT * 
             FROM Appointments
             WHERE Patient_ID = ? AND Appointment_Date >= CURDATE() 
             AND Status = 'Scheduled'
             ORDER BY Appointment_Date, Appointment_Time
             LIMIT 3`,
            [patientId]
        );

        // Get recent IOP measurements
        const [recentIOP] = await pool.execute(
            `SELECT *, 
                    COALESCE(Left_Eye_IOP, 0) as Left_Eye_IOP,
                    COALESCE(Right_Eye_IOP, 0) as Right_Eye_IOP
             FROM IOP_Records
             WHERE Patient_ID = ?
             ORDER BY Measured_Date DESC, Created_At DESC
             LIMIT 5`,
            [patientId]
        );

        res.json({
            upcoming_appointments: appointments || [],
            recent_iop: recentIOP || [],
            summary: {
                next_appointment: appointments.length > 0 ? appointments[0] : null,
                latest_iop: recentIOP.length > 0 ? recentIOP[0] : null,
                total_appointments: appointments.length,
                iop_measurements_count: recentIOP.length
            }
        });

    } catch (error) {
        console.error('Get dashboard error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR',
            error: error.message
        });
    }
});

// Notification helper function
async function createNotification(userId, type, title, body, priority = 'medium') {
    try {
        const notificationId = Date.now();
        await pool.execute(
            `INSERT INTO Notifications 
             (ID, Recipient_ID, Type, Title, Message, Priority, Status, Sent_At)
             VALUES (?, ?, ?, ?, ?, ?, 'Unread', NOW())`,
            [notificationId, userId, type, title, body, priority]
        );
        return notificationId;
    } catch (error) {
        console.error('Create notification error:', error);
    }
}

// Get notifications
router.get('/notifications', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { unread_only = 'false', limit = '50' } = req.query;

        let whereClause = 'WHERE Recipient_ID = ?';
        let params = [userId];

        if (unread_only === 'true') {
            whereClause += ' AND Status = "Unread"';
        }

        const [notifications] = await pool.execute(
            `SELECT ID as notification_id, Type as notification_type, Title as title, 
                    Message as body, Priority as priority, Status, Sent_At as created_at,
                    CASE
                        WHEN Type = 'Medication_Reminder' THEN 'แจ้งเตือนยา'
                        WHEN Type = 'Appointment' THEN 'แจ้งเตือนนัดหมาย'
                        WHEN Type = 'IOP_Alert' THEN 'แจ้งเตือนสุขภาพ'
                        WHEN Type = 'high_iop' THEN 'แจ้งเตือนความดันสูง'
                        ELSE Type
                    END as notification_type_display
             FROM Notifications 
             ${whereClause} 
             ORDER BY Sent_At DESC 
             LIMIT ?`,
            [...params, parseInt(limit)]
        );

        res.json({ notifications: notifications || [] });

    } catch (error) {
        console.error('Get notifications error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR',
            notifications: []
        });
    }
});

// Mark notification as read
router.put('/notifications/:notification_id/read', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { notification_id } = req.params;

        await pool.execute(
            `UPDATE Notifications 
             SET Status = 'Read', Read_At = NOW() 
             WHERE ID = ? AND Recipient_ID = ?`,
            [notification_id, userId]
        );

        res.json({
            message: 'อัปเดตสถานะการอ่านสำเร็จ',
            success: true
        });

    } catch (error) {
        console.error('Mark notification read error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

module.exports = router;