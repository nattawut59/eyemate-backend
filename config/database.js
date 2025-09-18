// config/database.js - Database Configuration
const mysql = require('mysql2/promise');

// Database Configuration for TiDB Cloud
const DB_CONFIG = {
    host: 'gateway01.ap-northeast-1.prod.aws.tidbcloud.com',
    user: '2NiEhDpNeSckc21.root',
    password: 'xO3y0vnKhXUYUeye',
    database: 'EyeMateDB', // ใช้ database name จาก SQL dump
    port: 4000,
    ssl: {
        rejectUnauthorized: false
    },
    connectTimeout: 60000,
    charset: 'utf8mb4'
};

// Create connection pool
const pool = mysql.createPool({
    ...DB_CONFIG,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    idleTimeout: 300000,
    maxIdle: 5,
});

// Test database connection
const testDbConnection = async () => {
    try {
        const connection = await pool.getConnection();
        console.log('✅ Database connected successfully to EyeMateDB');
        connection.release();
        return true;
    } catch (error) {
        console.error('❌ Database connection failed:', error.message);
        return false;
    }
};

module.exports = {
    pool,
    testDbConnection,
    DB_CONFIG
};