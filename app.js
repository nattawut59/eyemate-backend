// app.js - Complete Application Server
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs').promises;

// Import modules
const { testDbConnection } = require('./config/database');
const authRoutes = require('./routes/auth');
const patientRoutes = require('./routes/patient');
const medicationRoutes = require('./routes/medication');
const patientExtendedRoutes = require('./routes/patient-extended');
const notificationRoutes = require('./routes/notifications');

// Import services
const { startAppointmentScheduler } = require('./services/appointmentScheduler');

const app = express();
const PORT = process.env.PORT || 5001;

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false // Allow for flexibility during development
}));

// CORS Configuration
app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Middleware
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    message: { error: 'Too many requests, please try again later.' }
});

app.use('/api', apiLimiter);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/patient', patientRoutes);
app.use('/api/patient', patientExtendedRoutes);
app.use('/api/patient/medications', medicationRoutes);
app.use('/api/notifications', notificationRoutes);

// Health Check
app.get('/api/health', async (req, res) => {
    const dbStatus = await testDbConnection();
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        database: dbStatus ? 'Connected' : 'Disconnected',
        service: 'EyeMate Glaucoma Management System',
        version: '2.0.0',
        uptime: Math.floor(process.uptime()),
        memory: process.memoryUsage()
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        message: 'EyeMate Backend API is running!',
        version: '2.0.0',
        status: 'OK',
        database: 'EyeMateDB (TiDB Cloud)',
        endpoints: {
            auth: '/api/auth',
            patient: '/api/patient',
            medications: '/api/patient/medications',
            notifications: '/api/notifications',
            health: '/api/health'
        }
    });
});

// Test endpoints for verification
app.get('/api/test/db', async (req, res) => {
    try {
        const { pool } = require('./config/database');
        
        // Test basic query
        const [users] = await pool.execute('SELECT COUNT(*) as user_count FROM Users');
        const [patients] = await pool.execute('SELECT COUNT(*) as patient_count FROM Patients');
        const [appointments] = await pool.execute('SELECT COUNT(*) as appointment_count FROM Appointments');
        
        res.json({
            message: 'Database connection successful',
            tables: {
                users: users[0].user_count,
                patients: patients[0].patient_count,
                appointments: appointments[0].appointment_count
            },
            database: 'EyeMateDB',
            status: 'Connected'
        });
    } catch (error) {
        console.error('Database test error:', error);
        res.status(500).json({
            message: 'Database connection failed',
            error: error.message,
            status: 'Error'
        });
    }
});

// Test patient data endpoint
app.get('/api/test/patient-data', async (req, res) => {
    try {
        const { pool } = require('./config/database');
        
        // Sample queries to test different tables
        const [iopRecords] = await pool.execute('SELECT COUNT(*) as count FROM IOP_Records');
        const [medications] = await pool.execute('SELECT COUNT(*) as count FROM Medications');
        const [notifications] = await pool.execute('SELECT COUNT(*) as count FROM Notifications');
        
        res.json({
            message: 'Patient data tables accessible',
            tables: {
                iop_records: iopRecords[0].count,
                medications: medications[0].count,
                notifications: notifications[0].count
            },
            status: 'OK'
        });
    } catch (error) {
        console.error('Patient data test error:', error);
        res.status(500).json({
            message: 'Error accessing patient data',
            error: error.message
        });
    }
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        message: 'Endpoint not found',
        code: 'NOT_FOUND',
        available_endpoints: [
            'GET /',
            'GET /api/health',
            'POST /api/auth/register',
            'POST /api/auth/login',
            'GET /api/patient/profile',
            'GET /api/patient/dashboard',
            'POST /api/patient/iop-measurement',
            'GET /api/patient/medications',
            'POST /api/notifications/subscribe'
        ]
    });
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Global error handler:', error);
    res.status(500).json({
        message: 'เกิดข้อผิดพลาดของระบบ',
        code: 'INTERNAL_ERROR',
        timestamp: new Date().toISOString()
    });
});

// Start server
const startServer = async () => {
    try {
        // Create upload directory if it doesn't exist
        const uploadsPath = path.join(__dirname, 'uploads', 'medical-docs');
        try {
            await fs.mkdir(uploadsPath, { recursive: true });
            console.log('✅ Upload directory ready');
        } catch (dirError) {
            if (dirError.code !== 'EEXIST') {
                console.error('❌ Failed to create upload directory:', dirError);
            }
        }

        // Test database connection
        const dbConnected = await testDbConnection();
        if (!dbConnected) {
            console.error('❌ Cannot start server: Database connection failed');
            console.error('Please check your TiDB Cloud connection settings');
            process.exit(1);
        }

        // Start appointment scheduler service
        startAppointmentScheduler();

        app.listen(PORT, () => {
            console.log('🚀 EyeMate Glaucoma Management System Started!');
            console.log(`📡 Server running on http://localhost:${PORT}`);
            console.log(`🔗 API Base URL: http://localhost:${PORT}/api`);
            console.log(`🏥 Database: EyeMateDB (TiDB Cloud)`);
            console.log('');
            console.log('📋 Available Endpoints:');
            console.log('🔐 Authentication:');
            console.log('   POST /api/auth/register    - ลงทะเบียนผู้ป่วยใหม่');
            console.log('   POST /api/auth/login       - เข้าสู่ระบบ');
            console.log('   POST /api/auth/logout      - ออกจากระบบ');
            console.log('   POST /api/auth/refresh     - รีเฟรชโทเคน');
            console.log('   GET  /api/auth/me          - ข้อมูลผู้ใช้ปัจจุบัน');
            console.log('');
            console.log('👤 Patient Profile & Settings:');
            console.log('   GET  /api/patient/profile     - ดูข้อมูลส่วนตัว');
            console.log('   PUT  /api/patient/profile     - แก้ไขข้อมูลส่วนตัว');
            console.log('   GET  /api/patient/dashboard   - หน้าแดชบอร์ด');
            console.log('   GET  /api/patient/settings    - ดูการตั้งค่า');
            console.log('   PUT  /api/patient/settings    - แก้ไขการตั้งค่า');
            console.log('');
            console.log('👁️  IOP Management:');
            console.log('   POST /api/patient/iop-measurement  - บันทึกค่าความดันลูกตา');
            console.log('   GET  /api/patient/iop-measurements - ดูประวัติความดันลูกตา');
            console.log('   GET  /api/patient/iop-analytics    - วิเคราะห์ความดันลูกตา');
            console.log('');
            console.log('💊 Medication Management:');
            console.log('   GET  /api/patient/medications          - ดูรายการยา');
            console.log('   GET  /api/patient/medications/reminders - ดูการแจ้งเตือนยา');
            console.log('   POST /api/patient/medications/reminders - ตั้งการแจ้งเตือนยา');
            console.log('   POST /api/patient/medications/usage     - บันทึกการใช้ยา');
            console.log('   GET  /api/patient/medications/adherence - รายงานการใช้ยา');
            console.log('   GET  /api/patient/medications/usage-history - ประวัติการใช้ยา');
            console.log('');
            console.log('📅 Appointments:');
            console.log('   GET  /api/patient/appointments                        - ดูการนัดหมาย');
            console.log('   POST /api/patient/appointment-reschedule-request     - ขอเลื่อนนัด');
            console.log('   GET  /api/patient/reschedule-requests                - ดูสถานะคำขอเลื่อนนัด');
            console.log('');
            console.log('📋 Medical History & Records:');
            console.log('   POST /api/patient/family-history         - เพิ่มประวัติครอบครัว');
            console.log('   GET  /api/patient/family-history         - ดูประวัติครอบครัว');
            console.log('   POST /api/patient/eye-injury             - เพิ่มประวัติอุบัติเหตุทางตา');
            console.log('   POST /api/patient/symptom-report         - บันทึกอาการผิดปกติ');
            console.log('');
            console.log('🔬 Test Results & Special Tests:');
            console.log('   GET  /api/patient/visual-field-tests     - ผลการตรวจลานสายตา');
            console.log('   GET  /api/patient/visual-field-comparison - เปรียบเทียบผลการตรวจ');
            console.log('   GET  /api/patient/special-tests          - ผลการตรวจพิเศษ');
            console.log('   GET  /api/patient/oct-results            - ผลการตรวจ OCT');
            console.log('');
            console.log('📄 Medical Documents:');
            console.log('   POST /api/patient/documents              - อัปโหลดเอกสาร');
            console.log('   GET  /api/patient/documents              - ดูรายการเอกสาร');
            console.log('   GET  /api/patient/documents/:id/download - ดาวน์โหลดเอกสาร');
            console.log('');
            console.log('📞 Help & Support:');
            console.log('   GET  /api/patient/help                   - ดูเนื้อหาช่วยเหลือ');
            console.log('');
            console.log('🔔 Notifications & Push:');
            console.log('   GET  /api/patient/notifications                - ดูการแจ้งเตือน');
            console.log('   PUT  /api/patient/notifications/:id/read      - อ่านการแจ้งเตือน');
            console.log('   POST /api/notifications/subscribe             - สมัครรับ Push Notification');
            console.log('   POST /api/notifications/unsubscribe           - ยกเลิก Push Notification');
            console.log('   GET  /api/notifications/status                - สถานะการแจ้งเตือน');
            console.log('   GET  /api/notifications/vapid-public-key      - VAPID Public Key');
            console.log('');
            console.log('🧪 Test Endpoints:');
            console.log('   GET  /api/test/db           - ทดสอบการเชื่อมต่อฐานข้อมูล');
            console.log('   GET  /api/test/patient-data - ทดสอบข้อมูลผู้ป่วย');
            console.log('   GET  /api/health            - ตรวจสอบสถานะระบบ');
            console.log('');
            console.log(`⏰ ${new Date().toLocaleString('th-TH')}`);
            console.log('');
            console.log('🔄 Automated Features:');
            console.log('   - ตรวจสอบยาที่พลาดทุก 15 นาที');
            console.log('   - แจ้งเตือนยาแบบ Real-time ทุกนาที');
            console.log('   - แจ้งเตือนค่าความดันสูงอัตโนมัติ');
            console.log('   - ตรวจสอบนัดหมายที่ใกล้จะถึงทุกชั่วโมง');
            console.log('   - แจ้งเตือนนัดหมายล่วงหน้า 3 วัน, 1 วัน, และวันนัดหมาย');
            console.log('   - Push Notification แบบออฟไลน์');
            console.log('   - ระบบ audit logging');
            console.log('   - การจัดการ session และ token อัตโนมัติ');
            console.log('');
            console.log('✅ Ready to serve patients!');
        });
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
};

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('🛑 SIGTERM received, shutting down gracefully...');
    const { pool } = require('./config/database');
    await pool.end();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('🛑 SIGINT received, shutting down gracefully...');
    const { pool } = require('./config/database');
    await pool.end();
    process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

// Export for testing
module.exports = app;

startServer();