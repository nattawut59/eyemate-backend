// utils/helpers.js - Helper Functions
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');

// Environment Configuration
const JWT_SECRET = process.env.JWT_SECRET || 'gtms_super_secret_key_2025';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'gtms_refresh_secret_2025';

// Utility Functions
const generateId = () => {
    return Math.random().toString(36).substr(2, 8).toUpperCase();
};

const generateHN = () => {
    const year = new Date().getFullYear().toString().slice(-2);
    const random = Math.floor(Math.random() * 900000) + 100000;
    return `${year}${random}`;
};

// Validation Functions
const validateThaiIdCard = (idCard) => {
    if (!/^\d{13}$/.test(idCard)) return false;
    let sum = 0;
    for (let i = 0; i < 12; i++) {
        sum += parseInt(idCard.charAt(i)) * (13 - i);
    }
    const checkDigit = (11 - (sum % 11)) % 10;
    return checkDigit === parseInt(idCard.charAt(12));
};

const validateEmail = (email) => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};

const validatePhoneNumber = (phone) => {
    return /^0\d{9}$/.test(phone);
};

// User Session Management
const createUserSession = async (userId, token, deviceInfo, ipAddress, expiresAt) => {
    try {
        const sessionId = generateId();
        await pool.execute(
            `INSERT INTO Sessions 
             (Session_ID, National_ID, Session_Token, Session_Expires_At, Device_ID, Session_Status) 
             VALUES (?, ?, ?, ?, ?, 'Active')`,
            [sessionId, userId, token, expiresAt, deviceInfo]
        );
        return sessionId;
    } catch (error) {
        console.error('Failed to create session:', error);
        throw error;
    }
};

const invalidateUserSessions = async (userId, currentSessionId = null) => {
    try {
        if (currentSessionId) {
            await pool.execute(
                'UPDATE Sessions SET Session_Status = "Expired" WHERE National_ID = ? AND Session_ID != ?',
                [userId, currentSessionId]
            );
        } else {
            await pool.execute(
                'UPDATE Sessions SET Session_Status = "Expired" WHERE National_ID = ?',
                [userId]
            );
        }
    } catch (error) {
        console.error('Failed to invalidate sessions:', error);
    }
};

// Audit Log Function
const logUserAction = async (userId, action, entityType, entityId, details, status = 'success', ipAddress = null, userAgent = null) => {
    try {
        const logId = generateId();
        const severity = status === 'failed' ? 'Warning' : 'Info';
        
        await pool.execute(
            `INSERT INTO System_Logs 
             (Log_Level, Module, Message, User_ID, IP_Address, User_Agent, Created_At) 
             VALUES (?, ?, ?, ?, ?, ?, NOW())`,
            [severity, entityType, details, userId, ipAddress, userAgent]
        );
    } catch (error) {
        console.error('Failed to log user action:', error);
    }
};

// JWT Token Functions
const signAccessToken = (payload) => {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });
};

const signRefreshToken = (payload) => {
    return jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: '7d' });
};

const verifyAccessToken = (token) => {
    return jwt.verify(token, JWT_SECRET);
};

const verifyRefreshToken = (token) => {
    return jwt.verify(token, JWT_REFRESH_SECRET);
};

// Password Hashing
const hashPassword = async (password) => {
    const saltRounds = 12;
    return await bcrypt.hash(password, saltRounds);
};

const comparePassword = async (password, hash) => {
    return await bcrypt.compare(password, hash);
};

// Date Helpers
const formatDate = (date) => {
    return new Date(date).toISOString().split('T')[0];
};

const formatDateTime = (date) => {
    return new Date(date).toISOString();
};

module.exports = {
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
    verifyAccessToken,
    verifyRefreshToken,
    hashPassword,
    comparePassword,
    formatDate,
    formatDateTime,
    JWT_SECRET,
    JWT_REFRESH_SECRET
};