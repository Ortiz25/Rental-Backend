import express from 'express';
import pool from '../config/database.js';
import rateLimit from 'express-rate-limit';
import { logUserActivity, isAccountLocked, updateFailedAttempts, generateToken, createUserSession } from '../utils/helper.js';
import bcrypt from "bcrypt"

const router = express.Router();

// Rate limiting for login attempts
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 15, // Limit each IP to 5 requests per windowMs
    message: {
      status: 429,
      message: 'Too many login attempts, please try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false,
  });




// Main login route
router.post('/', loginLimiter, async (req, res) => {
    const client = await pool.connect();
    
    try {
      const { email, password } = req.body;
      console.log(req.body)
      // Input validation
      if (!email || !password) {
        return res.status(400).json({
          status: 400,
          message: 'Email and password are required'
        });
      }
  
      // Email format validation
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({
          status: 400,
          message: 'Please enter a valid email address'
        });
      }
  
      // Find user with role information
      const userQuery = `
        SELECT 
          u.id,
          u.username,
          u.email,
          u.password_hash,
          u.first_name,
          u.last_name,
          u.phone,
          u.is_active,
          u.is_verified,
          u.failed_login_attempts,
          u.locked_until,
          u.tenant_id,
          ur.role_name,
          ur.permissions,
          t.first_name as tenant_first_name,
          t.last_name as tenant_last_name
        FROM users u
        JOIN user_roles ur ON u.role_id = ur.id
        LEFT JOIN tenants t ON u.tenant_id = t.id
        WHERE u.email = $1
      `;
  
      const userResult = await client.query(userQuery, [email.toLowerCase().trim()]);
        console.log(userResult.rows)
      if (userResult.rows.length === 0) {
        // Log failed login attempt
        await logUserActivity(
          null, 
          'login_failed', 
          `Failed login attempt for non-existent email: ${email}`,
          req.ip,
          req.headers['user-agent']
        );
        
        return res.status(404).json({
          status: 404,
          message: 'User does not exist'
        });
      }
  
      const user = userResult.rows[0];
  
      // Check if account is locked
      if (isAccountLocked(user)) {
        await logUserActivity(
          user.id,
          'login_blocked',
          'Login attempt on locked account',
          req.ip,
          req.headers['user-agent']
        );
  
        return res.status(423).json({
          status: 423,
          message: 'Account is temporarily locked due to multiple failed login attempts. Please try again later.'
        });
      }
  
      // Check if account is active
      if (!user.is_active) {
        await logUserActivity(
          user.id,
          'login_blocked',
          'Login attempt on inactive account',
          req.ip,
          req.headers['user-agent']
        );
  
        return res.status(403).json({
          status: 403,
          message: 'Account is deactivated. Please contact administrator.'
        });
      }
  
      // Check if email is verified
      if (!user.is_verified) {
        await logUserActivity(
          user.id,
          'login_blocked',
          'Login attempt on unverified account',
          req.ip,
          req.headers['user-agent']
        );
  
        return res.status(401).json({
          status: 401,
          message: 'Please verify your email address before logging in.'
        });
      }
  
      // Verify password
      const isPasswordValid = await bcrypt.compare(password.trim(), user.password_hash);
  
      if (!isPasswordValid) {
        // Update failed login attempts
        await updateFailedAttempts(user.id);
        
        await logUserActivity(
          user.id,
          'login_failed',
          'Invalid password attempt',
          req.ip,
          req.headers['user-agent']
        );
  
        return res.status(401).json({
          status: 401,
          message: 'Invalid email or password'
        });
      }
  
      // Check if user needs to reset their password (for first-time login)
      if (user.password_reset_token && user.password_reset_expires && 
          new Date(user.password_reset_expires) > new Date()) {
        
        await logUserActivity(
          user.id,
          'login_redirect',
          'Login redirected to password reset',
          req.ip,
          req.headers['user-agent']
        );
  
        return res.status(200).json({
          status: 200,
          message: 'Please reset your Registration Password, Redirecting...',
          redirect: '/resetpassword'
        });
      }
  
      // Successful login - reset failed attempts
      await updateFailedAttempts(user.id, true);
  
      // Update last login timestamp
      await client.query(
        'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
        [user.id]
      );
  
      // Generate JWT token
      const token = generateToken(user);
  
      // Create session record
      await createUserSession(user.id, token, req);
  
      // Log successful login
      await logUserActivity(
        user.id,
        'login_success',
        'User logged in successfully',
        req.ip,
        req.headers['user-agent']
      );
  
      // Prepare response data
      const responseData = {
        status: 200,
        message: 'Login successful',
        token: token,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          firstName: user.first_name,
          lastName: user.last_name,
          name: `${user.first_name} ${user.last_name}`,
          phone: user.phone,
          role: user.role_name,
          permissions: user.permissions,
          tenantId: user.tenant_id,
          tenantName: user.tenant_id ? `${user.tenant_first_name} ${user.tenant_last_name}` : null
        }
      };
  
      res.status(200).json(responseData);
  
    } catch (error) {
      console.error('Login error:', error);
      
      res.status(500).json({
        status: 500,
        message: 'Internal server error. Please try again later.'
      });
    } finally {
      client.release();
    }
  });
  
  export default router