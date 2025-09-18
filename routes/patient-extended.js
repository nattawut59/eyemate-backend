// routes/patient-extended.js - Extended Patient Features
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { pool } = require('../config/database');
const { authenticateToken, ensurePatient } = require('../middleware/auth');
const { generateId, logUserAction, formatDate } = require('../utils/helpers');

const router = express.Router();

// File upload configuration
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadPath = path.join(__dirname, '../uploads', 'medical-docs');
        cb(null, uploadPath);
    },
    filename: function (req, file, cb) {
        const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|pdf|doc|docx/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Invalid file type'));
        }
    }
});

// Add family glaucoma history
router.post('/family-history', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const patientId = req.user.patientId;
        const {
            relationship, glaucoma_type, age_at_diagnosis, severity,
            treatment, current_status, notes
        } = req.body;

        const historyId = Date.now();

        await pool.execute(
            `INSERT INTO Patient_Medical_History 
             (ID, Patient_ID, Category, Disease_Type, Relation, Onset_Date, 
              Severity, Description, Is_Active, Created_At)
             VALUES (?, ?, 'Family_History', ?, ?, ?, ?, ?, 1, NOW())`,
            [historyId, patientId, `Glaucoma_${glaucoma_type}`, relationship, 
             age_at_diagnosis, severity, notes]
        );

        res.json({
            message: 'เพิ่มประวัติครอบครัวสำเร็จ',
            success: true,
            history_id: historyId
        });

    } catch (error) {
        console.error('Add family history error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการเพิ่มประวัติครอบครัว',
            code: 'RECORD_ERROR'
        });
    }
});

// Get family glaucoma history
router.get('/family-history', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const patientId = req.user.patientId;

        const [history] = await pool.execute(
            `SELECT *,
                    CASE 
                        WHEN Relation = 'father' THEN 'พ่อ'
                        WHEN Relation = 'mother' THEN 'แม่'
                        WHEN Relation = 'brother' THEN 'พี่ชาย/น้องชาย'
                        WHEN Relation = 'sister' THEN 'พี่สาว/น้องสาว'
                        WHEN Relation = 'grandfather' THEN 'ปู่/ตา'
                        WHEN Relation = 'grandmother' THEN 'ย่า/ยาย'
                        ELSE Relation
                    END as relationship_display
             FROM Patient_Medical_History
             WHERE Patient_ID = ? AND Category = 'Family_History'
             ORDER BY Created_At DESC`,
            [patientId]
        );

        res.json({ family_history: history });

    } catch (error) {
        console.error('Get family history error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Add eye injury history
router.post('/eye-injury', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const patientId = req.user.patientId;
        const {
            injury_date, eye, injury_type, treatment_received,
            long_term_effects, notes
        } = req.body;

        const injuryId = Date.now();

        await pool.execute(
            `INSERT INTO Patient_Medical_History 
             (ID, Patient_ID, Category, Disease_Type, Onset_Date, 
              Severity, Description, Is_Active, Created_At)
             VALUES (?, ?, 'Eye_Accident', ?, ?, ?, ?, 1, NOW())`,
            [injuryId, patientId, `${injury_type}_${eye}`, injury_date,
             long_term_effects || 'Unknown', notes]
        );

        res.json({
            message: 'เพิ่มประวัติอุบัติเหตุทางตาสำเร็จ',
            success: true,
            injury_id: injuryId
        });

    } catch (error) {
        console.error('Add injury history error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการเพิ่มประวัติอุบัติเหตุ',
            code: 'RECORD_ERROR'
        });
    }
});

// Record symptom report
router.post('/symptom-report', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const patientId = req.user.patientId;
        const {
            symptom_type, severity, duration_hours, trigger_factors,
            description, requires_attention = false
        } = req.body;

        const reportId = Date.now();

        await pool.execute(
            `INSERT INTO Symptom_Reports 
             (ID, Patient_ID, Reported_Date, Symptom_Type, Severity, 
              Duration_Hours, Trigger_Factors, Description, Requires_Attention, Created_At)
             VALUES (?, ?, CURDATE(), ?, ?, ?, ?, ?, ?, NOW())`,
            [reportId, patientId, symptom_type, severity, duration_hours,
             trigger_factors, description, requires_attention]
        );

        // Create alert if severe symptoms
        if (severity >= 7 || requires_attention) {
            await createNotification(
                req.user.userId,
                'symptom_alert',
                'อาการผิดปกติที่ต้องติดตาม',
                `มีการรายงานอาการ: ${symptom_type} ระดับความรุนแรง ${severity}/10`,
                'high'
            );
        }

        res.json({
            message: 'บันทึกอาการผิดปกติสำเร็จ',
            success: true,
            report_id: reportId,
            alert_created: severity >= 7 || requires_attention
        });

    } catch (error) {
        console.error('Record symptom error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการบันทึกอาการ',
            code: 'RECORD_ERROR'
        });
    }
});

// Get visual field test results
router.get('/visual-field-tests', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const patientId = req.user.patientId;

        const [tests] = await pool.execute(
            `SELECT *
             FROM Visual_Field_Tests
             WHERE Patient_ID = ?
             ORDER BY Test_Date DESC`,
            [patientId]
        );

        res.json({ visual_field_tests: tests });

    } catch (error) {
        console.error('Get visual field tests error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Compare visual field test results
router.get('/visual-field-comparison', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const patientId = req.user.patientId;
        const { test_ids } = req.query;

        if (!test_ids) {
            return res.status(400).json({
                message: 'กรุณาระบุ ID ของการตรวจที่ต้องการเปรียบเทียบ',
                code: 'MISSING_TEST_IDS'
            });
        }

        const testIdArray = test_ids.split(',');

        const [tests] = await pool.execute(
            `SELECT * FROM Visual_Field_Tests
             WHERE Patient_ID = ? AND ID IN (${testIdArray.map(() => '?').join(',')})
             ORDER BY Test_Date ASC`,
            [patientId, ...testIdArray]
        );

        // Calculate progression
        const comparison = [];
        for (let i = 1; i < tests.length; i++) {
            const current = tests[i];
            const previous = tests[i - 1];
            
            comparison.push({
                current_test: current,
                previous_test: previous,
                time_difference_days: Math.ceil((new Date(current.Test_Date) - new Date(previous.Test_Date)) / (1000 * 60 * 60 * 24))
            });
        }

        res.json({ 
            tests,
            comparison,
            progression_analysis: comparison.length > 0 ? {
                total_comparisons: comparison.length,
                time_span_days: comparison.reduce((sum, c) => sum + c.time_difference_days, 0)
            } : null
        });

    } catch (error) {
        console.error('Compare visual field tests error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Get special eye tests (OCT, CTVF, etc.)
router.get('/special-tests', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const patientId = req.user.patientId;
        const { test_type } = req.query;

        let whereClause = 'WHERE Patient_ID = ?';
        let params = [patientId];

        if (test_type) {
            whereClause += ' AND Test_Type = ?';
            params.push(test_type);
        }

        const [tests] = await pool.execute(
            `SELECT *,
                    CASE 
                        WHEN Test_Type = 'OCT' THEN 'การตรวจ OCT (ภาพตัดขวาง)'
                        WHEN Test_Type = 'CTVF' THEN 'การตรวจลานสายตา'
                        WHEN Test_Type = 'Pachymetry' THEN 'การวัดความหนาเสื้อตา'
                        WHEN Test_Type = 'Gonioscopy' THEN 'การตรวจมุมรอยต่อ'
                        ELSE Test_Type
                    END as test_type_display
             FROM Visual_Field_Tests 
             ${whereClause}
             ORDER BY Test_Date DESC`,
            params
        );

        res.json({ special_tests: tests });

    } catch (error) {
        console.error('Get special tests error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Get OCT results
router.get('/oct-results', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const patientId = req.user.patientId;

        const [results] = await pool.execute(
            `SELECT *
             FROM OCT_Scans
             WHERE Patient_ID = ?
             ORDER BY Scan_Date DESC`,
            [patientId]
        );

        res.json({ oct_results: results });

    } catch (error) {
        console.error('Get OCT results error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Upload medical document
router.post('/documents', authenticateToken, ensurePatient, upload.single('document'), async (req, res) => {
    try {
        const patientId = req.user.patientId;
        const {
            document_type, document_title, description
        } = req.body;

        if (!req.file) {
            return res.status(400).json({
                message: 'กรุณาเลือกไฟล์',
                code: 'NO_FILE'
            });
        }

        const documentId = Date.now();
        const fileUrl = `/uploads/medical-docs/${req.file.filename}`;

        await pool.execute(
            `INSERT INTO Medical_Documents 
             (ID, Patient_ID, Document_Type, Title, Description, File_Path, 
              File_Size, MIME_Type, Upload_Date, Created_At)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURDATE(), NOW())`,
            [documentId, patientId, document_type, document_title,
             description, fileUrl, req.file.size, req.file.mimetype]
        );

        res.json({
            message: 'อัปโหลดเอกสารสำเร็จ',
            success: true,
            document_id: documentId,
            file_url: fileUrl
        });

    } catch (error) {
        console.error('Upload document error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการอัปโหลดเอกสาร',
            code: 'UPLOAD_ERROR'
        });
    }
});

// Get medical documents
router.get('/documents', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const patientId = req.user.patientId;
        const { document_type, search } = req.query;

        let whereClause = 'WHERE Patient_ID = ?';
        let params = [patientId];

        if (document_type) {
            whereClause += ' AND Document_Type = ?';
            params.push(document_type);
        }

        if (search) {
            whereClause += ' AND (Title LIKE ? OR Description LIKE ?)';
            params.push(`%${search}%`, `%${search}%`);
        }

        const [documents] = await pool.execute(
            `SELECT *,
                    CASE 
                        WHEN MIME_Type LIKE '%pdf%' THEN 'เอกสาร PDF'
                        WHEN MIME_Type LIKE '%image%' THEN 'รูปภาพ'
                        WHEN MIME_Type LIKE '%word%' THEN 'เอกสาร Word'
                        ELSE 'ไฟล์อื่นๆ'
                    END as file_type_display,
                    ROUND(File_Size / 1024 / 1024, 2) as file_size_mb
             FROM Medical_Documents
             ${whereClause}
             ORDER BY Upload_Date DESC`,
            params
        );

        res.json({ documents });

    } catch (error) {
        console.error('Get documents error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Download medical document
router.get('/documents/:document_id/download', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const patientId = req.user.patientId;
        const { document_id } = req.params;

        const [documents] = await pool.execute(
            `SELECT * FROM Medical_Documents
             WHERE ID = ? AND Patient_ID = ?`,
            [document_id, patientId]
        );

        if (documents.length === 0) {
            return res.status(404).json({
                message: 'ไม่พบเอกสาร',
                code: 'DOCUMENT_NOT_FOUND'
            });
        }

        const document = documents[0];
        const filePath = path.join(__dirname, '..', document.File_Path);

        // Log document access
        await logUserAction(
            req.user.userId, 'DOCUMENT_DOWNLOAD', 'Medical_Documents', 
            document_id, `Downloaded ${document.Title}`, 'success'
        );

        res.download(filePath, document.Title);

    } catch (error) {
        console.error('Download document error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการดาวน์โหลด',
            code: 'DOWNLOAD_ERROR'
        });
    }
});

// Get user preferences/settings
router.get('/settings', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;

        const [settings] = await pool.execute(
            'SELECT * FROM User_Preferences WHERE User_ID = ?',
            [userId]
        );

        if (settings.length === 0) {
            // Create default settings
            const settingId = Date.now();
            await pool.execute(
                `INSERT INTO User_Preferences (ID, User_ID) VALUES (?, ?)`,
                [settingId, userId]
            );

            const [newSettings] = await pool.execute(
                'SELECT * FROM User_Preferences WHERE ID = ?',
                [settingId]
            );

            return res.json({ settings: newSettings[0] });
        }

        res.json({ settings: settings[0] });

    } catch (error) {
        console.error('Get settings error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Update user settings
router.put('/settings', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const {
            language, theme, font_size, notification_medication,
            notification_appointment, notification_iop_alert,
            reminder_advance_minutes, sound_enabled, vibration_enabled
        } = req.body;

        await pool.execute(
            `UPDATE User_Preferences SET
             Language = COALESCE(?, Language),
             Theme = COALESCE(?, Theme),
             Font_Size = COALESCE(?, Font_Size),
             Notification_Medication = COALESCE(?, Notification_Medication),
             Notification_Appointment = COALESCE(?, Notification_Appointment),
             Notification_IOP_Alert = COALESCE(?, Notification_IOP_Alert),
             Reminder_Advance_Minutes = COALESCE(?, Reminder_Advance_Minutes),
             Sound_Enabled = COALESCE(?, Sound_Enabled),
             Vibration_Enabled = COALESCE(?, Vibration_Enabled),
             Updated_At = NOW()
             WHERE User_ID = ?`,
            [language, theme, font_size, notification_medication,
             notification_appointment, notification_iop_alert,
             reminder_advance_minutes, sound_enabled, vibration_enabled, userId]
        );

        res.json({
            message: 'อัปเดตการตั้งค่าสำเร็จ',
            success: true
        });

    } catch (error) {
        console.error('Update settings error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการอัปเดตการตั้งค่า',
            code: 'UPDATE_ERROR'
        });
    }
});

// Get help content (สำหรับผู้สูงอายุ)
router.get('/help', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const { category } = req.query;

        let whereClause = 'WHERE Is_Active = 1 AND (Target_Role = "Patient" OR Target_Role = "All")';
        let params = [];

        if (category) {
            whereClause += ' AND Category = ?';
            params.push(category);
        }

        const [helpContent] = await pool.execute(
            `SELECT *
             FROM Help_Content
             ${whereClause}
             ORDER BY Priority DESC, Title`,
            params
        );

        res.json({ 
            help_content: helpContent,
            categories: [
                'Getting_Started',
                'Medication', 
                'Appointments',
                'Reports',
                'Troubleshooting'
            ]
        });

    } catch (error) {
        console.error('Get help content error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Get reschedule request status
router.get('/reschedule-requests', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const patientId = req.user.patientId;

        const [requests] = await pool.execute(
            `SELECT r.*, a.Appointment_Date, a.Appointment_Time, a.Type as Appointment_Type,
                    CASE 
                        WHEN r.Status = 'Pending' THEN 'รอดำเนินการ'
                        WHEN r.Status = 'Approved' THEN 'อนุมัติ'
                        WHEN r.Status = 'Rejected' THEN 'ปฏิเสธ'
                        ELSE r.Status
                    END as status_display
             FROM Appointment_Reschedule_Requests r
             LEFT JOIN Appointments a ON r.Appointment_ID = a.ID
             WHERE r.Patient_ID = ?
             ORDER BY r.Created_At DESC`,
            [patientId]
        );

        res.json({ reschedule_requests: requests });

    } catch (error) {
        console.error('Get reschedule requests error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Helper function for notifications
async function createNotification(userId, type, title, body, priority = 'Medium') {
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

module.exports = router;