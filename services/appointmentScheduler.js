// services/appointmentScheduler.js - Appointment Reminder Service
const cron = require('node-cron');
const { pool } = require('../config/database');
const { sendAppointmentReminder } = require('./pushNotification');

// Check for upcoming appointments and send reminders
const checkUpcomingAppointments = async () => {
    try {
        console.log('🔔 Checking for upcoming appointments...');
        
        // Get appointments for today, tomorrow, and 3 days ahead
        const [appointments] = await pool.execute(`
            SELECT 
                a.*,
                DATEDIFF(a.Appointment_Date, CURDATE()) as days_until,
                p.User_ID
            FROM Appointments a
            JOIN Patients p ON a.Patient_ID = p.Patient_ID
            WHERE a.Status = 'Scheduled'
            AND a.Appointment_Date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 3 DAY)
            AND NOT EXISTS (
                SELECT 1 FROM Appointment_Reminders ar
                WHERE ar.Appointment_ID = a.ID
                AND ar.Reminder_Type = CASE
                    WHEN DATEDIFF(a.Appointment_Date, CURDATE()) = 0 THEN 'same_day'
                    WHEN DATEDIFF(a.Appointment_Date, CURDATE()) = 1 THEN 'next_day'
                    WHEN DATEDIFF(a.Appointment_Date, CURDATE()) = 3 THEN 'three_days'
                    ELSE 'other'
                END
                AND DATE(ar.Sent_At) = CURDATE()
            )
            ORDER BY a.Appointment_Date, a.Appointment_Time
        `);

        let remindersSent = 0;

        for (const appointment of appointments) {
            const daysUntil = appointment.days_until;
            let reminderType;
            let shouldSend = false;

            // Determine when to send reminders
            if (daysUntil === 0 && new Date().getHours() === 8) {
                // Same day reminder at 8 AM
                reminderType = 'same_day';
                shouldSend = true;
            } else if (daysUntil === 1 && new Date().getHours() === 18) {
                // Next day reminder at 6 PM
                reminderType = 'next_day';
                shouldSend = true;
            } else if (daysUntil === 3 && new Date().getHours() === 9) {
                // 3 days ahead reminder at 9 AM
                reminderType = 'three_days';
                shouldSend = true;
            }

            if (shouldSend) {
                // Send push notification
                await sendAppointmentReminder(
                    appointment.Patient_ID,
                    appointment.Appointment_Date,
                    appointment.Appointment_Time,
                    daysUntil
                );

                // Create database notification
                await createAppointmentNotification(
                    appointment.User_ID,
                    appointment,
                    daysUntil
                );

                // Log reminder sent
                await logAppointmentReminder(appointment.ID, reminderType);
                
                remindersSent++;
                console.log(`📅 Sent ${reminderType} reminder for appointment ${appointment.ID}`);
            }
        }

        console.log(`✅ Processed ${appointments.length} appointments, sent ${remindersSent} reminders`);

    } catch (error) {
        console.error('Check appointments error:', error);
    }
};

// Create notification in database
const createAppointmentNotification = async (userId, appointment, daysUntil) => {
    try {
        const notificationId = Date.now() + Math.random() * 1000; // Avoid ID collision
        
        let title, message;
        const appointmentDate = new Date(appointment.Appointment_Date).toLocaleDateString('th-TH');
        const appointmentTime = appointment.Appointment_Time;

        if (daysUntil === 0) {
            title = 'นัดหมายแพทย์วันนี้';
            message = `คุณมีนัดพบแพทย์วันนี้เวลา ${appointmentTime}`;
        } else if (daysUntil === 1) {
            title = 'นัดหมายแพทย์พรุ่งนี้';
            message = `คุณมีนัดพบแพทย์พรุ่งนี้เวลา ${appointmentTime}`;
        } else {
            title = 'แจ้งเตือนนัดหมายแพทย์';
            message = `คุณมีนัดพบแพทย์อีก ${daysUntil} วัน (${appointmentDate} เวลา ${appointmentTime})`;
        }

        await pool.execute(
            `INSERT INTO Notifications 
             (ID, Recipient_ID, Type, Title, Message, Priority, Status, Sent_At)
             VALUES (?, ?, 'appointment_reminder', ?, ?, 'high', 'Unread', NOW())`,
            [notificationId, userId, title, message]
        );

    } catch (error) {
        console.error('Create appointment notification error:', error);
    }
};

// Log that reminder was sent
const logAppointmentReminder = async (appointmentId, reminderType) => {
    try {
        const reminderId = Date.now() + Math.random() * 1000;
        
        await pool.execute(
            `INSERT INTO Appointment_Reminders 
             (ID, Appointment_ID, Reminder_Type, Sent_At, Status)
             VALUES (?, ?, ?, NOW(), 'Sent')`,
            [reminderId, appointmentId, reminderType]
        );

    } catch (error) {
        console.error('Log appointment reminder error:', error);
    }
};

// Check for overdue appointments (missed appointments)
const checkOverdueAppointments = async () => {
    try {
        console.log('⚠️ Checking for overdue appointments...');
        
        const [overdueAppointments] = await pool.execute(`
            SELECT a.*, p.User_ID
            FROM Appointments a
            JOIN Patients p ON a.Patient_ID = p.Patient_ID
            WHERE a.Status = 'Scheduled'
            AND CONCAT(a.Appointment_Date, ' ', a.Appointment_Time) < NOW()
            AND a.Appointment_Date >= DATE_SUB(CURDATE(), INTERVAL 1 DAY)
        `);

        for (const appointment of overdueAppointments) {
            // Update status to missed
            await pool.execute(
                'UPDATE Appointments SET Status = "Missed", Updated_At = NOW() WHERE ID = ?',
                [appointment.ID]
            );

            // Create notification
            const notificationId = Date.now() + Math.random() * 1000;
            await pool.execute(
                `INSERT INTO Notifications 
                 (ID, Recipient_ID, Type, Title, Message, Priority, Status, Sent_At)
                 VALUES (?, ?, 'missed_appointment', 'นัดหมายที่พลาด', 
                 'คุณพลาดนัดหมายแพทย์ กรุณาติดต่อคลินิกเพื่อนัดใหม่', 'high', 'Unread', NOW())`,
                [notificationId, appointment.User_ID]
            );

            console.log(`⚠️ Marked appointment ${appointment.ID} as missed`);
        }

        if (overdueAppointments.length > 0) {
            console.log(`⚠️ Found ${overdueAppointments.length} overdue appointments`);
        }

    } catch (error) {
        console.error('Check overdue appointments error:', error);
    }
};

// Schedule appointment reminders
const startAppointmentScheduler = () => {
    console.log('🔔 Starting appointment reminder scheduler...');
    
    // Check appointments every hour
    cron.schedule('0 * * * *', checkUpcomingAppointments, {
        timezone: "Asia/Bangkok"
    });
    
    // Check for overdue appointments every 6 hours
    cron.schedule('0 */6 * * *', checkOverdueAppointments, {
        timezone: "Asia/Bangkok"
    });
    
    console.log('✅ Appointment scheduler started');
};

module.exports = {
    checkUpcomingAppointments,
    checkOverdueAppointments,
    startAppointmentScheduler
};