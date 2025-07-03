import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config/constants.js';
import pool from '../config/database.js';

export const authenticateToken = async (req, res, next) => {
    try {
      const authHeader = req.headers['authorization'];
      const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
  
      console.log('🔍 Auth middleware - Token present:', !!token);
  
      if (!token) {
        console.log('❌ No token provided');
        return res.status(401).json({
          status: 401,
          message: 'Access token required',
          debug: 'No authorization header found'
        });
      }
  
      // Verify JWT token
      let decoded;
      try {
        decoded = jwt.verify(token, process.env.JWT_SECRET, {
          issuer: 'rental-management-system',
          audience: 'rms-users'
        });
        console.log('✅ Token verified for user:', decoded.id);
      } catch (jwtError) {
        console.log('❌ JWT verification failed:', jwtError.message);
        
        if (jwtError.name === 'TokenExpiredError') {
          return res.status(401).json({
            status: 401,
            message: 'Token expired',
            debug: 'JWT token has expired'
          });
        } else if (jwtError.name === 'JsonWebTokenError') {
          return res.status(401).json({
            status: 401,
            message: 'Invalid token',
            debug: 'JWT token is malformed or invalid'
          });
        } else {
          return res.status(401).json({
            status: 401,
            message: 'Token verification failed',
            debug: jwtError.message
          });
        }
      }
  
      // Check if session is still active (optional - can be disabled for testing)
      const client = await pool.connect();
      try {
        const sessionResult = await client.query(
          `SELECT us.is_active, us.expires_at, u.is_active as user_active, ur.role_name
           FROM user_sessions us 
           JOIN users u ON us.user_id = u.id 
           JOIN user_roles ur ON u.role_id = ur.id
           WHERE us.session_token = $1 AND us.user_id = $2`,
          [token, decoded.id]
        );
  
        if (sessionResult.rows.length === 0) {
          console.log('❌ Session not found in database');
          return res.status(401).json({
            status: 401,
            message: 'Session not found',
            debug: 'No active session found for this token'
          });
        }
  
        const session = sessionResult.rows[0];
  
        if (!session.is_active) {
          console.log('❌ Session is inactive');
          return res.status(401).json({
            status: 401,
            message: 'Session expired',
            debug: 'Session has been deactivated'
          });
        }
  
        if (new Date(session.expires_at) < new Date()) {
          console.log('❌ Session has expired');
          // Mark session as inactive
          await client.query(
            'UPDATE user_sessions SET is_active = false WHERE session_token = $1',
            [token]
          );
  
          return res.status(401).json({
            status: 401,
            message: 'Session expired',
            debug: 'Session has expired based on expires_at timestamp'
          });
        }
  
        if (!session.user_active) {
          console.log('❌ User account is inactive');
          return res.status(403).json({
            status: 403,
            message: 'Account deactivated',
            debug: 'User account has been deactivated'
          });
        }
  
        // Update session last activity
        await client.query(
          'UPDATE user_sessions SET last_activity = CURRENT_TIMESTAMP WHERE session_token = $1',
          [token]
        );
  
        // Add role to decoded token data
        decoded.role = session.role_name;
  
      } catch (dbError) {
        console.error('❌ Database error in auth middleware:', dbError);
        // Continue without session check if database fails
        console.log('⚠️  Continuing without session validation due to DB error');
      } finally {
        client.release();
      }
  
      req.user = decoded;
      console.log('✅ Authentication successful for user:', decoded.id, 'role:', decoded.role);
      next();
      
    } catch (error) {
      console.error('❌ Auth middleware error:', error);
      return res.status(500).json({
        status: 500,
        message: 'Authentication error',
        debug: error.message
      });
    }
  };
  
  // Role-based authorization middleware
 export  const authorizeRole = (allowedRoles) => {
    return (req, res, next) => {
      console.log('🔍 Role check - User role:', req.user?.role, 'Allowed:', allowedRoles);
      
      if (!req.user || !req.user.role) {
        console.log('❌ No user role found');
        return res.status(403).json({
          status: 403,
          message: 'No role information found',
          debug: 'User object or role missing from request'
        });
      }
  
      if (!allowedRoles.includes(req.user.role)) {
        console.log('❌ Insufficient permissions');
        return res.status(403).json({
          status: 403,
          message: 'Insufficient permissions',
          debug: `Role '${req.user.role}' not in allowed roles: ${allowedRoles.join(', ')}`
        });
      }
  
      console.log('✅ Role authorization successful');
      next();
    };
  };
  
  // Simplified version without session checking (for testing)
  export const authenticateTokenSimple = async (req, res, next) => {
    try {
      const authHeader = req.headers['authorization'];
      const token = authHeader && authHeader.split(' ')[1];
  
      if (!token) {
        return res.status(401).json({
          status: 401,
          message: 'Access token required'
        });
      }
  
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded;
      next();
      
    } catch (error) {
      return res.status(403).json({
        status: 403,
        message: 'Invalid token',
        debug: error.message
      });
    }
  };
  
  // Clean up expired sessions (run periodically)
  export const cleanupExpiredSessions = async () => {
    const client = await pool.connect();
    try {
      await client.query(
        'UPDATE user_sessions SET is_active = false WHERE expires_at < CURRENT_TIMESTAMP AND is_active = true'
      );
      
      // Delete very old sessions (older than 30 days)
      await client.query(
        'DELETE FROM user_sessions WHERE expires_at < CURRENT_TIMESTAMP - INTERVAL \'30 days\''
      );
      
      console.log('Expired sessions cleaned up');
    } catch (error) {
      console.error('Error cleaning up sessions:', error);
    } finally {
      client.release();
    }
  };
  
  // Run cleanup every hour
  setInterval(cleanupExpiredSessions, 60 * 60 * 1000);
  

  
  // Example usage in your main app.js:
  /*
  const express = require('express');
  const { loginRouter, authenticateToken, authorizeRole } = require('./routes/auth');
  
  const app = express();
  
  // Use the login routes
  app.use('/api', loginRouter);
  
  // Protected route example
  app.get('/api/dashboard', 
    authenticateToken, 
    authorizeRole(['Admin', 'Manager', 'Tenant']), 
    (req, res) => {
      res.json({ message: 'Welcome to dashboard', user: req.user });
    }
  );
  
  // Admin only route example
  app.get('/api/admin/users', 
    authenticateToken, 
    authorizeRole(['Admin']), 
    (req, res) => {
      // Admin functionality
    }
  );
  */