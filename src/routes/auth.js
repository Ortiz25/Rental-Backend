import express from 'express';
import pool from '../config/database.js';
import rateLimit from 'express-rate-limit';
import { logUserActivity, isAccountLocked, updateFailedAttempts, generateToken, createUserSession } from '../utils/helper.js';
import bcrypt from "bcrypt"
import jwt from 'jsonwebtoken';

const router = express.Router();




// Token verification route (for the loader function in your frontend)
router.post('/verifyToken', async (req, res) => {
    const client = await pool.connect();
    
    try {
      const { token } = req.body;
        console.log(token)
      if (!token) {
        return res.status(401).json({
          status: 401,
          message: 'No token provided'
        });
      }
  
      // Verify JWT token
      let decoded;
      try {
        decoded = jwt.verify(token, process.env.JWT_SECRET, {
          issuer: 'rental-management-system',
          audience: 'rms-users'
        });
      } catch (jwtError) {
        if (jwtError.name === 'TokenExpiredError') {
          return res.status(401).json({
            status: 401,
            message: 'token expired'
          });
        } else if (jwtError.name === 'JsonWebTokenError') {
          return res.status(401).json({
            status: 401,
            message: 'invalid token'
          });
        } else {
          return res.status(401).json({
            status: 401,
            message: 'token verification failed'
          });
        }
      }
  
      // Check if session exists and is active
      const sessionQuery = `
        SELECT 
          us.id,
          us.is_active,
          us.expires_at,
          u.id as user_id,
          u.is_active as user_active,
          u.first_name,
          u.last_name,
          ur.role_name
        FROM user_sessions us
        JOIN users u ON us.user_id = u.id
        JOIN user_roles ur ON u.role_id = ur.id
        WHERE us.session_token = $1 AND us.user_id = $2
      `;
  
      const sessionResult = await client.query(sessionQuery, [token, decoded.id]);
  
      if (sessionResult.rows.length === 0) {
        return res.status(401).json({
          status: 401,
          message: 'session not found'
        });
      }
  
      const session = sessionResult.rows[0];
  
      // Check if session is active
      if (!session.is_active) {
        return res.status(401).json({
          status: 401,
          message: 'session expired'
        });
      }
  
      // Check if session has expired
      if (new Date(session.expires_at) < new Date()) {
        // Mark session as inactive
        await client.query(
          'UPDATE user_sessions SET is_active = false WHERE id = $1',
          [session.id]
        );
  
        return res.status(401).json({
          status: 401,
          message: 'session expired'
        });
      }
  
      // Check if user is still active
      if (!session.user_active) {
        return res.status(403).json({
          status: 403,
          message: 'account deactivated'
        });
      }
  
      // Update session last activity
      await client.query(
        'UPDATE user_sessions SET last_activity = CURRENT_TIMESTAMP WHERE id = $1',
        [session.id]
      );
  
      // Log activity
      await logUserActivity(
        decoded.id,
        'token_verified',
        'Token verification successful',
        req.ip,
        req.headers['user-agent']
      );
  
      res.status(200).json({
        status: 200,
        message: 'token valid',
        user: {
          id: decoded.id,
          email: decoded.email,
          username: decoded.username,
          role: session.role_name,
          name: `${session.first_name} ${session.last_name}`
        }
      });
  
    } catch (error) {
      console.error('Token verification error:', error);
      
      res.status(500).json({
        status: 500,
        message: 'Internal server error'
      });
    } finally {
      client.release();
    }
  });
  
  // Logout route
  router.post('/logout', async (req, res) => {
    const client = await pool.connect();
    
    try {
      const { token } = req.body;
  
      if (token) {
        // Deactivate the session
        await client.query(
          'UPDATE user_sessions SET is_active = false WHERE session_token = $1',
          [token]
        );
  
        // Try to decode token to get user info for logging
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET);
          await logUserActivity(
            decoded.id,
            'logout',
            'User logged out',
            req.ip,
            req.headers['user-agent']
          );
        } catch (jwtError) {
          // Token might be expired, but we still want to deactivate the session
          console.log('Token expired during logout, but session deactivated');
        }
      }
  
      res.status(200).json({
        status: 200,
        message: 'Logged out successfully'
      });
  
    } catch (error) {
      console.error('Logout error:', error);
      
      res.status(500).json({
        status: 500,
        message: 'Internal server error'
      });
    } finally {
      client.release();
    }
  });

  export default router