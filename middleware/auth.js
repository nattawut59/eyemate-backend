// middleware/auth.js - Authentication Middleware
const { pool } = require('../config/database');
const { verifyAccessToken } = require('../utils/helpers');

// Authentication Middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ 
            message: 'Access token required',
            code: 'TOKEN_REQUIRED' 
        });
    }

    try {
        const user = verifyAccessToken(token);
        
        // Check if session is still active
        pool.execute(
            'SELECT * FROM Sessions WHERE National_ID = ? AND Session_Token = ? AND Session_Status = "Active" AND Session_Expires_At > NOW()',
            [user.userId, token]
        ).then(([sessions]) => {
            if (sessions.length === 0) {
                return res.status(401).json({ 
                    message: 'Session expired or invalid',
                    code: 'SESSION_INVALID' 
                });
            }

            req.user = user;
            next();
        }).catch(error => {
            console.error('Session validation error:', error);
            return res.status(500).json({ message: 'Internal server error' });
        });

    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ 
                message: 'Token expired',
                code: 'TOKEN_EXPIRED' 
            });
        }
        return res.status(403).json({ 
            message: 'Invalid token',
            code: 'TOKEN_INVALID' 
        });
    }
};

// Ensure patient role
const ensurePatient = async (req, res, next) => {
    try {
        // Check if user exists in Users table and has patient role
        const [users] = await pool.execute(
            'SELECT Role FROM Users WHERE National_ID = ?',
            [req.user.userId]
        );

        if (users.length === 0) {
            return res.status(404).json({
                message: 'User not found',
                code: 'USER_NOT_FOUND'
            });
        }

        if (users[0].Role !== 'Patient') {
            return res.status(403).json({
                message: 'Access denied. Patient role required.',
                code: 'INSUFFICIENT_PERMISSIONS'
            });
        }

        // Check if patient profile exists
        const [patients] = await pool.execute(
            'SELECT Patient_ID FROM Patients WHERE User_ID = ?',
            [req.user.userId]
        );

        if (patients.length === 0) {
            return res.status(404).json({
                message: 'Patient profile not found',
                code: 'PATIENT_PROFILE_NOT_FOUND'
            });
        }

        req.user.patientId = patients[0].Patient_ID;
        next();
    } catch (error) {
        console.error('Ensure patient error:', error);
        return res.status(500).json({
            message: 'Internal server error',
            code: 'INTERNAL_ERROR'
        });
    }
};

// Ensure doctor role
const ensureDoctor = async (req, res, next) => {
    try {
        const [users] = await pool.execute(
            'SELECT Role FROM Users WHERE National_ID = ?',
            [req.user.userId]
        );

        if (users.length === 0 || users[0].Role !== 'Doctor') {
            return res.status(403).json({
                message: 'Access denied. Doctor role required.',
                code: 'INSUFFICIENT_PERMISSIONS'
            });
        }

        next();
    } catch (error) {
        console.error('Ensure doctor error:', error);
        return res.status(500).json({
            message: 'Internal server error',
            code: 'INTERNAL_ERROR'
        });
    }
};

// Ensure admin role
const ensureAdmin = async (req, res, next) => {
    try {
        const [users] = await pool.execute(
            'SELECT Role FROM Users WHERE National_ID = ?',
            [req.user.userId]
        );

        if (users.length === 0 || users[0].Role !== 'Admin') {
            return res.status(403).json({
                message: 'Access denied. Admin role required.',
                code: 'INSUFFICIENT_PERMISSIONS'
            });
        }

        next();
    } catch (error) {
        console.error('Ensure admin error:', error);
        return res.status(500).json({
            message: 'Internal server error',
            code: 'INTERNAL_ERROR'
        });
    }
};

module.exports = {
    authenticateToken,
    ensurePatient,
    ensureDoctor,
    ensureAdmin
};