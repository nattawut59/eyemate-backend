// routes/auth.js - Authentication Routes
const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const {
    generateId,
    generateHN,
    validateThaiIdCard,
    validateEmail,
    validatePhoneNumber,
    createUserSession,
    invalidateUserSessions,
    logUserAction,
    signAccessToken,
    signRefreshToken,
    verifyRefreshToken,
    hashPassword,
    comparePassword
} = require('../utils/helpers');

const router = express.Router();

// Rate limiting
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: {
        error: 'Too many login attempts, please try again later.',
        retryAfter: 15 * 60
    }
});

const registrationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 3,
    message: {
        error: 'Too many registration attempts, please try again later.',
        retryAfter: 15 * 60
    }
});

// Register Endpoint
router.post('/register', registrationLimiter, async (req, res) => {
    const connection = await pool.getConnection();
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];
    
    try {
        await connection.beginTransaction();
        
        const {
            firstName, lastName, idCard, birthDate, gender,
            phone, address, emergencyContact, relationship, emergencyPhone,
            username, password, confirmPassword
        } = req.body;

        // Validation
        if (!firstName || !lastName || !idCard || !birthDate || !gender ||  
            !phone || !emergencyContact || !relationship || !emergencyPhone || 
            !password || !confirmPassword) {
            return res.status(400).json({ 
                message: 'ข้อมูลส่วนตัวที่จำเป็น (เช่น ชื่อ, บัตรประชาชน, เบอร์โทร) ไม่ครบถ้วน', 
                code: 'MISSING_CORE_PERSONAL_FIELDS' 
            });
        }

        if (!validateThaiIdCard(idCard)) {
            return res.status(400).json({ 
                message: 'รูปแบบเลขบัตรประชาชนไม่ถูกต้อง', 
                code: 'INVALID_ID_CARD' 
            });
        }

        if (!validatePhoneNumber(phone)) {
            return res.status(400).json({ 
                message: 'รูปแบบเบอร์โทรศัพท์ไม่ถูกต้อง', 
                code: 'INVALID_PHONE' 
            });
        }

        if (password !== confirmPassword) {
            return res.status(400).json({ 
                message: 'รหัสผ่านไม่ตรงกัน', 
                code: 'PASSWORD_MISMATCH' 
            });
        }

        if (password.length < 8) {
            return res.status(400).json({ 
                message: 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร', 
                code: 'WEAK_PASSWORD' 
            });
        }

        // Check if user already exists
        const [existingUsers] = await connection.execute(
            'SELECT National_ID FROM Users WHERE National_ID = ?',
            [idCard]
        );
        
        if (existingUsers.length > 0) {
            await logUserAction(null, 'USER_REGISTRATION_FAILED', 'Users', null, 
                `Duplicate registration attempt - ID: ${idCard}`, 'failed', ipAddress, userAgent);
            return res.status(409).json({ 
                message: 'ผู้ใช้นี้ได้ลงทะเบียนในระบบแล้ว', 
                code: 'USER_ALREADY_EXISTS' 
            });
        }

        const passwordHash = await hashPassword(password);

        // Insert into Users table
        await connection.execute(
            `INSERT INTO Users 
             (National_ID, Password_Hash, First_Name, Last_Name, Date_Of_Birth, Gender, 
              Phone_Number, Address, Role, Account_Status, Data_Consent, Created_At) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Patient', 'Active', 1, NOW())`,
            [idCard, passwordHash, firstName, lastName, birthDate, gender, phone, address]
        );

        // Generate patient ID and HN
        const patientId = Date.now(); // Use timestamp as Patient_ID
        const hn = generateHN();

        // Insert into Patients table
        await connection.execute(
            `INSERT INTO Patients 
             (Patient_ID, User_ID, Medical_Record_Number, Patient_Status, Registration_Date) 
             VALUES (?, ?, ?, 'Active', CURDATE())`,
            [patientId, idCard, hn]
        );

        await connection.commit();
        
        await logUserAction(idCard, 'USER_REGISTRATION', 'Users', idCard, 
            'New patient registration', 'success', ipAddress, userAgent);

        console.log(`✅ Registration completed successfully for user: ${idCard}`);
        
        res.status(201).json({
            message: 'ลงทะเบียนสำเร็จ',
            success: true,
            user: { 
                id: idCard, 
                patientId: patientId,
                hn: hn, 
                firstName: firstName, 
                lastName: lastName, 
                role: 'Patient' 
            }
        });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error('Registration error:', error);
        
        await logUserAction(null, 'USER_REGISTRATION_ERROR', 'Users', null, 
            `Registration failed: ${error.message}`, 'failed', ipAddress, userAgent);

        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ กรุณาลองใหม่อีกครั้ง',
            code: 'INTERNAL_ERROR'
        });
    } finally {
        if (connection) connection.release();
    }
});

// Login Endpoint
router.post('/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    try {
        if (!username || !password) {
            return res.status(400).json({ 
                message: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน',
                code: 'MISSING_CREDENTIALS' 
            });
        }

        // Find user by National_ID or Phone_Number
        const [users] = await pool.execute(
            `SELECT u.*, p.Patient_ID, p.Medical_Record_Number
             FROM Users u
             LEFT JOIN Patients p ON u.National_ID = p.User_ID
             WHERE u.National_ID = ? OR u.Phone_Number = ?`,
            [username, username]
        );

        if (users.length === 0) {
            await logUserAction(null, 'USER_LOGIN_FAILED', 'Users', null, 
                `User not found: ${username}`, 'failed', ipAddress, userAgent);
            return res.status(401).json({ 
                message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
                code: 'INVALID_CREDENTIALS' 
            });
        }

        const user = users[0];

        // Check account status
        if (user.Account_Status !== 'Active') {
            return res.status(423).json({ 
                message: 'บัญชีของคุณถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ',
                code: 'ACCOUNT_INACTIVE' 
            });
        }

        // Verify password
        const isValidPassword = await comparePassword(password, user.Password_Hash);

        if (!isValidPassword) {
            await logUserAction(user.National_ID, 'USER_LOGIN_FAILED', 'Users', user.National_ID, 
                'Invalid password', 'failed', ipAddress, userAgent);
            return res.status(401).json({ 
                message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
                code: 'INVALID_PASSWORD'
            });
        }

        // Generate tokens
        const tokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const refreshTokenExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        const accessToken = signAccessToken({ 
            userId: user.National_ID, 
            role: user.Role,
            patientId: user.Patient_ID
        });

        const refreshToken = signRefreshToken({ 
            userId: user.National_ID, 
            type: 'refresh'
        });

        // Create session
        await createUserSession(user.National_ID, accessToken, userAgent, ipAddress, tokenExpiry);

        // Prepare user profile
        const userProfile = {
            id: user.National_ID,
            patientId: user.Patient_ID,
            role: user.Role,
            firstName: user.First_Name,
            lastName: user.Last_Name,
            phone: user.Phone_Number,
            hn: user.Medical_Record_Number
        };

        await logUserAction(user.National_ID, 'USER_LOGIN', 'Users', user.National_ID, 
            `Successful login from ${ipAddress}`, 'success', ipAddress, userAgent);

        res.json({
            message: 'Login successful',
            token: accessToken,
            refreshToken,
            expiresAt: tokenExpiry.toISOString(),
            user: userProfile
        });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ 
            message: 'เกิดข้อผิดพลาดของระบบ กรุณาลองใหม่อีกครั้ง',
            code: 'INTERNAL_ERROR' 
        });
    }
});

// Refresh Token Endpoint
router.post('/refresh', async (req, res) => {
    try {
        const { refreshToken } = req.body;

        if (!refreshToken) {
            return res.status(401).json({ 
                message: 'Refresh token required',
                code: 'REFRESH_TOKEN_REQUIRED' 
            });
        }

        const decoded = verifyRefreshToken(refreshToken);
        
        const [users] = await pool.execute(
            'SELECT * FROM Users WHERE National_ID = ? AND Account_Status = "Active"',
            [decoded.userId]
        );

        if (users.length === 0) {
            return res.status(401).json({ 
                message: 'User not found or inactive',
                code: 'USER_NOT_FOUND' 
            });
        }

        const user = users[0];
        const newAccessToken = signAccessToken({ 
            userId: user.National_ID, 
            role: user.Role
        });
        const tokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

        res.json({
            message: 'Token refreshed successfully',
            token: newAccessToken,
            expiresAt: tokenExpiry.toISOString()
        });

    } catch (error) {
        console.error('Refresh token error:', error);
        if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
            return res.status(401).json({ 
                message: 'Invalid refresh token',
                code: 'INVALID_REFRESH_TOKEN' 
            });
        }
        res.status(500).json({ 
            message: 'Internal server error',
            code: 'INTERNAL_ERROR' 
        });
    }
});

// Logout Endpoint
router.post('/logout', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        await invalidateUserSessions(userId);
        
        await logUserAction(userId, 'USER_LOGOUT', 'Users', userId, 
            'User logged out', 'success', req.ip, req.headers['user-agent']);

        res.json({ 
            message: 'Logout successful',
            code: 'LOGOUT_SUCCESS' 
        });
    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ 
            message: 'Internal server error',
            code: 'INTERNAL_ERROR' 
        });
    }
});

// Get Current User Info
router.get('/me', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;

        const [users] = await pool.execute(
            `SELECT u.*, p.Patient_ID, p.Medical_Record_Number
             FROM Users u
             LEFT JOIN Patients p ON u.National_ID = p.User_ID
             WHERE u.National_ID = ?`,
            [userId]
        );

        if (users.length === 0) {
            return res.status(404).json({ 
                message: 'User not found',
                code: 'USER_NOT_FOUND' 
            });
        }

        const user = users[0];
        const userProfile = {
            id: user.National_ID,
            patientId: user.Patient_ID,
            role: user.Role,
            firstName: user.First_Name,
            lastName: user.Last_Name,
            phone: user.Phone_Number,
            hn: user.Medical_Record_Number,
            status: user.Account_Status
        };

        res.json({ user: userProfile });

    } catch (error) {
        console.error('Get user info error:', error);
        res.status(500).json({ 
            message: 'Internal server error',
            code: 'INTERNAL_ERROR' 
        });
    }
});

module.exports = router;