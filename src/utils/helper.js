import pool from "../config/database.js"
import jwt from 'jsonwebtoken';








export const generateToken = (user) => {
    const payload = {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role_name,
      tenant_id: user.tenant_id || null
    };
    
    return jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '24h',
      issuer: 'rental-management-system',
      audience: 'rms-users'
    });
  };
  
  // Helper function to check if account is locked
 export const isAccountLocked = (user) => {
    if (!user.locked_until) return false;
    return new Date(user.locked_until) > new Date();
  };
  
  // Helper function to update failed login attempts
 export  const updateFailedAttempts = async (userId, reset = false) => {
    const client = await pool.connect();
    try {
      if (reset) {
        await client.query(
          'UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1',
          [userId]
        );
      } else {
        const result = await client.query(
          'UPDATE users SET failed_login_attempts = failed_login_attempts + 1 WHERE id = $1 RETURNING failed_login_attempts',
          [userId]
        );
        
        const attempts = result.rows[0].failed_login_attempts;
        
        // Lock account after 5 failed attempts for 30 minutes
        if (attempts >= 5) {
          const lockUntil = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes
          await client.query(
            'UPDATE users SET locked_until = $1 WHERE id = $2',
            [lockUntil, userId]
          );
        }
      }
    } finally {
      client.release();
    }
  };
  
  // Helper function to log user activity
  export const logUserActivity = async (userId, activityType, description, ipAddress, userAgent, additionalData = null) => {
    const client = await pool.connect();
    try {
      // Truncate long values to fit database constraints
      const truncatedDescription = description && description.length > 500 ? 
                                  description.substring(0, 497) + '...' : description;
      
      const truncatedUserAgent = userAgent && userAgent.length > 500 ? 
                                userAgent.substring(0, 497) + '...' : userAgent;
      
      const truncatedActivityType = activityType && activityType.length > 100 ? 
                                   activityType.substring(0, 97) + '...' : activityType;
  
      // Ensure IP address is valid or use fallback
      const validIpAddress = ipAddress || '127.0.0.1';
  
      await client.query(
        `INSERT INTO user_activity_log 
         (user_id, activity_type, activity_description, ip_address, user_agent, additional_data)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          userId, 
          truncatedActivityType, 
          truncatedDescription, 
          validIpAddress, 
          truncatedUserAgent,
          additionalData ? JSON.stringify(additionalData) : null
        ]
      );
    } catch (error) {
      console.error('Error logging user activity:', error);
      // Don't throw error here as activity logging shouldn't break the main flow
    } finally {
      client.release();
    }
  };
  
  // Helper function to create user session
  export const createUserSession = async (userId, sessionToken, req) => {
    const client = await pool.connect();
    try {
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
      
      // Get user agent and truncate if necessary
      const userAgent = req.headers['user-agent'] || 'Unknown Browser';
      const truncatedUserAgent = userAgent.length > 500 ? userAgent.substring(0, 497) + '...' : userAgent;
      
      // Get device info (simplified version of user agent)
      const deviceInfo = getDeviceInfo(userAgent);
      
      // Get IP address with fallback
      const ipAddress = req.ip || 
                       req.connection?.remoteAddress || 
                       req.socket?.remoteAddress || 
                       (req.connection?.socket ? req.connection.socket.remoteAddress : null) ||
                       '127.0.0.1';
  
      await client.query(
        `INSERT INTO user_sessions 
         (user_id, session_token, device_info, ip_address, user_agent, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          userId,
          sessionToken,
          deviceInfo, // This should be shorter than user_agent
          ipAddress,
          truncatedUserAgent, // Truncated to fit in column
          expiresAt
        ]
      );
    } catch (error) {
      console.error('Error creating user session:', error);
      throw error; // Re-throw to handle in calling function
    } finally {
      client.release();
    }
  };

  const getDeviceInfo = (userAgent) => {
    if (!userAgent || userAgent === 'Unknown Browser') {
      return 'Unknown Device';
    }
  
    try {
      // Simple device detection
      const ua = userAgent.toLowerCase();
      
      // Mobile devices
      if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone')) {
        if (ua.includes('android')) return 'Android Mobile';
        if (ua.includes('iphone')) return 'iPhone';
        if (ua.includes('mobile')) return 'Mobile Device';
      }
      
      // Tablets
      if (ua.includes('tablet') || ua.includes('ipad')) {
        if (ua.includes('ipad')) return 'iPad';
        return 'Tablet';
      }
      
      // Desktop browsers
      if (ua.includes('chrome')) return 'Chrome Browser';
      if (ua.includes('firefox')) return 'Firefox Browser';
      if (ua.includes('safari') && !ua.includes('chrome')) return 'Safari Browser';
      if (ua.includes('edge')) return 'Edge Browser';
      if (ua.includes('opera')) return 'Opera Browser';
      
      // Operating systems
      if (ua.includes('windows')) return 'Windows PC';
      if (ua.includes('mac')) return 'Mac Computer';
      if (ua.includes('linux')) return 'Linux Computer';
      
      return 'Desktop Computer';
    } catch (error) {
      return 'Unknown Device';
    }
  };