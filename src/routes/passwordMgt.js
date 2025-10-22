import express from "express";
import pool from "../config/database.js";
import jwt from 'jsonwebtoken';
import { MailerSend, EmailParams, Sender, Recipient } from "mailersend";
import bcrypt from 'bcryptjs';

const router = express.Router();

// Initialize MailerSend
const mailerSend = new MailerSend({
  apiKey: process.env.MAILERSEND_API_KEY,
});

router.post("/forgotpassword", async (req, res) => {
  const { email } = req.body;
  console.log("Password reset requested for:", email);
  
  try {
    // Validate email input
    if (!email || !email.trim()) {
      return res.status(400).json({ 
        message: "Email is required",
        success: false 
      });
    }

    // Check if user exists
    const result = await pool.query(
      "SELECT id, username, email FROM users WHERE email = $1 AND is_active = true", 
      [email.trim().toLowerCase()]
    );
 
    if (result.rows.length === 0) {
      // Return success to prevent user enumeration
      return res.json({ 
        message: "If your email exists in our system, you will receive a password reset link shortly.",
        success: true
      });
    }
 
    const userId = result.rows[0].id;
    const username = result.rows[0].username;
 
    const expiresAt = new Date(Date.now() + 3600000); // 1 hour from now
 
    // Generate a unique token
    const token = jwt.sign(
      { userId, email: result.rows[0].email }, 
      process.env.SECRET_KEY, 
      { expiresIn: "1h" }
    );
 
    // Save the token and expiration in database (note: matching schema field names)
    await pool.query(
      "UPDATE users SET password_reset_token = $1, password_reset_expires = $2 WHERE id = $3",
      [token, expiresAt, userId]
    );
 
    const resetLink = `${process.env.FRONTEND_URL || 'http://sms.livecrib.pro'}/resetpassword?token=${token}`;
 
    // Email content
    const subject = "Password Reset Request";
    const htmlMessage = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2c3e50;">Password Reset Request</h2>
        <p>Hello ${username || 'there'},</p>
        <p>We received a request to reset your password. If you didn't make this request, you can ignore this email.</p>
        <p>To reset your password, please click the button below:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${resetLink}" style="background-color: #3498db; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">Reset Password</a>
        </div>
        <p>Or copy and paste this link in your browser:</p>
        <p><a href="${resetLink}">${resetLink}</a></p>
        <p>This link will expire in 1 hour.</p>
        <p>Thank you,<br>Rental Management Team</p>
      </div>
    `;
    
    const textMessage = `
      Password Reset Request
      
      Hello ${username || 'there'},
      
      We received a request to reset your password. If you didn't make this request, you can ignore this email.
      
      To reset your password, please visit this link:
      ${resetLink}
      
      This link will expire in 1 hour.
      
      Thank you,
      Rental Management Team
    `;
 
    // Send email using MailerSend
    try {
      const senderEmail = process.env.MAILERSEND_FROM_EMAIL || 'noreply@example.com';
      const senderName = process.env.MAILERSEND_FROM_NAME || 'Rental Management System';
      const sentFrom = new Sender(senderEmail, senderName);
      
      const emailParams = new EmailParams()
        .setFrom(sentFrom)
        .setTo([new Recipient(email)])
        .setReplyTo(sentFrom)
        .setSubject(subject)
        .setHtml(htmlMessage)
        .setText(textMessage);
      
      await mailerSend.email.send(emailParams);
      console.log(`Password reset email sent successfully to ${email}`);
      
      res.json({ 
        message: "Password reset link sent to your email.",
        success: true
      });
    } catch (emailError) {
      console.error("Email sending error:", emailError);
      
      // Still return success to prevent user enumeration
      res.json({ 
        message: "If your email exists in our system, you will receive a password reset link shortly.",
        success: true
      });
    }
  } catch (error) {
    console.error("Password reset error:", error);
    res.status(500).json({ 
      error: "An error occurred while processing your request.",
      success: false
    });
  }
});

// Handle password reset
router.post("/resetpassword", async (req, res) => {
  const { token, newPassword } = req.body;
  
  try {
    // Validate input
    if (!token || !newPassword) {
      return res.status(400).json({ 
        message: "Token and new password are required",
        success: false 
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ 
        message: "Password must be at least 8 characters long",
        success: false 
      });
    }

    // Verify token
    const decoded = jwt.verify(token, process.env.SECRET_KEY);
    
    // Check if token exists in database and hasn't expired
    const userResult = await pool.query(
      `SELECT id, password_reset_token, password_reset_expires 
       FROM users 
       WHERE id = $1 AND password_reset_token = $2 AND is_active = true`,
      [decoded.userId, token]
    );

    if (userResult.rows.length === 0) {
      return res.status(400).json({ 
        message: "Invalid or expired reset token",
        success: false 
      });
    }

    const user = userResult.rows[0];

    // Check if token has expired
    if (new Date(user.password_reset_expires) < new Date()) {
      return res.status(400).json({ 
        message: "Reset token has expired. Please request a new one.",
        success: false 
      });
    }

    // Hash the new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password and clear reset token
    await pool.query(
      `UPDATE users 
       SET password_hash = $1, 
           password_reset_token = NULL, 
           password_reset_expires = NULL,
           failed_login_attempts = 0,
           is_locked = false,
           locked_until = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [hashedPassword, decoded.userId]
    );

    console.log(`Password reset successful for user ID: ${decoded.userId}`);

    res.status(200).json({ 
      message: "Password reset successful. You can now login with your new password.",
      success: true 
    });

  } catch (error) {
    if (error.name === "JsonWebTokenError") {
      return res.status(400).json({ 
        message: "Invalid reset token",
        success: false 
      });
    }
    
    if (error.name === "TokenExpiredError") {
      return res.status(400).json({ 
        message: "Reset token has expired. Please request a new one.",
        success: false 
      });
    }

    console.error("Password reset error:", error);
    res.status(500).json({ 
      message: "An error occurred while resetting your password",
      success: false 
    });
  }
});

export default router;