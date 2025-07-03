import express from 'express';
import pool from '../config/database.js';
import { authenticateToken, authorizeRole, authenticateTokenSimple } from '../middleware/auth.js';

const router = express.Router();

// UNITS ROUTES
// Get all units with property information
router.get('/units', async (req, res) => {
  try {
    const { occupancy_status, property_id, bedrooms, bathrooms } = req.query;
    
    let query = `
      SELECT 
        u.id,
        u.unit_number,
        u.bedrooms,
        u.bathrooms,
        u.size_sq_ft,
        u.monthly_rent,
        u.security_deposit,
        u.occupancy_status,
        u.created_at,
        u.updated_at,
        p.id as property_id,
        p.property_name,
        p.address as property_address,
        p.property_type
      FROM units u
      JOIN properties p ON u.property_id = p.id
    `;
    
    let whereConditions = [];
    let queryParams = [];
    let paramIndex = 1;
    
    if (occupancy_status) {
      whereConditions.push(`u.occupancy_status = $${paramIndex}`);
      queryParams.push(occupancy_status);
      paramIndex++;
    }
    
    if (property_id) {
      whereConditions.push(`u.property_id = $${paramIndex}`);
      queryParams.push(property_id);
      paramIndex++;
    }
    
    if (bedrooms) {
      whereConditions.push(`u.bedrooms = $${paramIndex}`);
      queryParams.push(bedrooms);
      paramIndex++;
    }
    
    if (bathrooms) {
      whereConditions.push(`u.bathrooms = $${paramIndex}`);
      queryParams.push(bathrooms);
      paramIndex++;
    }
    
    if (whereConditions.length > 0) {
      query += ' WHERE ' + whereConditions.join(' AND ');
    }
    
    query += ' ORDER BY p.property_name, u.unit_number';
    
    const result = await pool.query(query, queryParams);
    
    res.json({
      success: true,
      data: result.rows
    });
    
  } catch (error) {
    console.error('Error fetching units:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching units',
      error: error.message
    });
  }
});

// Get single unit by ID
router.get('/units/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Validate that id is a number
    if (isNaN(parseInt(id))) {
      return res.status(400).json({
        success: false,
        message: 'Invalid unit ID'
      });
    }
    
    const query = `
      SELECT 
        u.*,
        p.property_name,
        p.address as property_address,
        p.property_type,
        
        -- Get utilities for this unit
        COALESCE(
          JSON_AGG(
            CASE WHEN ut.id IS NOT NULL THEN
              JSON_BUILD_OBJECT(
                'id', ut.id,
                'name', ut.name,
                'included', COALESCE(uu.included, pu.included)
              )
            END
          ) FILTER (WHERE ut.id IS NOT NULL),
          '[]'
        ) as utilities,
        
        -- Get amenities from property
        COALESCE(
          JSON_AGG(
            CASE WHEN am.id IS NOT NULL THEN
              JSON_BUILD_OBJECT(
                'id', am.id,
                'name', am.name
              )
            END
          ) FILTER (WHERE am.id IS NOT NULL),
          '[]'
        ) as amenities
        
      FROM units u
      JOIN properties p ON u.property_id = p.id
      LEFT JOIN unit_utilities uu ON u.id = uu.unit_id
      LEFT JOIN property_utilities pu ON p.id = pu.property_id AND uu.utility_id IS NULL
      LEFT JOIN utilities ut ON COALESCE(uu.utility_id, pu.utility_id) = ut.id
      LEFT JOIN property_amenities pa ON p.id = pa.property_id
      LEFT JOIN amenities am ON pa.amenity_id = am.id
      WHERE u.id = $1
      GROUP BY u.id, p.property_name, p.address, p.property_type
    `;
    
    const result = await pool.query(query, [parseInt(id)]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Unit not found'
      });
    }
    
    res.json({
      success: true,
      data: result.rows[0]
    });
    
  } catch (error) {
    console.error('Error fetching unit:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching unit',
      error: error.message
    });
  }
});

// TENANTS ROUTES
// Get all tenants
router.get('/tenants', async (req, res) => {
  try {
    const { search, employment_status, has_active_lease } = req.query;
    
    let query = `
      SELECT 
        t.id,
        t.first_name,
        t.last_name,
        t.email,
        t.phone,
        t.alternate_phone,
        t.date_of_birth,
        t.employment_status,
        t.employer_name,
        t.monthly_income,
        t.created_at,
        
        -- Check if tenant has active lease
        CASE WHEN al.lease_id IS NOT NULL THEN true ELSE false END as has_active_lease,
        al.property_name,
        al.unit_number,
        al.lease_number
        
      FROM tenants t
      LEFT JOIN (
        SELECT DISTINCT
          lt.tenant_id,
          l.id as lease_id,
          l.lease_number,
          p.property_name,
          u.unit_number
        FROM lease_tenants lt
        JOIN leases l ON lt.lease_id = l.id
        JOIN units u ON l.unit_id = u.id
        JOIN properties p ON u.property_id = p.id
        WHERE l.lease_status = 'active' 
        AND lt.removed_date IS NULL
      ) al ON t.id = al.tenant_id
    `;
    
    let whereConditions = [];
    let queryParams = [];
    let paramIndex = 1;
    
    if (search) {
      whereConditions.push(`(
        t.first_name ILIKE $${paramIndex} OR 
        t.last_name ILIKE $${paramIndex} OR 
        t.email ILIKE $${paramIndex} OR
        CONCAT(t.first_name, ' ', t.last_name) ILIKE $${paramIndex}
      )`);
      queryParams.push(`%${search}%`);
      paramIndex++;
    }
    
    if (employment_status) {
      whereConditions.push(`t.employment_status = $${paramIndex}`);
      queryParams.push(employment_status);
      paramIndex++;
    }
    
    if (has_active_lease !== undefined) {
      if (has_active_lease === 'true') {
        whereConditions.push(`al.lease_id IS NOT NULL`);
      } else {
        whereConditions.push(`al.lease_id IS NULL`);
      }
    }
    
    if (whereConditions.length > 0) {
      query += ' WHERE ' + whereConditions.join(' AND ');
    }
    
    query += ' ORDER BY t.last_name, t.first_name';
    
    const result = await pool.query(query, queryParams);
    
    res.json({
      success: true,
      data: result.rows
    });
    
  } catch (error) {
    console.error('Error fetching tenants:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching tenants',
      error: error.message
    });
  }
});

// Get single tenant by ID
router.get('/tenants/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Validate that id is a number
    if (isNaN(parseInt(id))) {
      return res.status(400).json({
        success: false,
        message: 'Invalid tenant ID'
      });
    }
    
    const query = `
      SELECT 
        t.*,
        
        -- Get all leases for this tenant
        COALESCE(
          JSON_AGG(
            CASE WHEN l.id IS NOT NULL THEN
              JSON_BUILD_OBJECT(
                'id', l.id,
                'lease_number', l.lease_number,
                'lease_status', l.lease_status,
                'start_date', l.start_date,
                'end_date', l.end_date,
                'monthly_rent', l.monthly_rent,
                'property_name', p.property_name,
                'unit_number', u.unit_number,
                'is_primary_tenant', lt.is_primary_tenant,
                'tenant_type', lt.tenant_type
              )
            END
          ) FILTER (WHERE l.id IS NOT NULL),
          '[]'
        ) as leases
        
      FROM tenants t
      LEFT JOIN lease_tenants lt ON t.id = lt.tenant_id AND lt.removed_date IS NULL
      LEFT JOIN leases l ON lt.lease_id = l.id
      LEFT JOIN units u ON l.unit_id = u.id
      LEFT JOIN properties p ON u.property_id = p.id
      WHERE t.id = $1
      GROUP BY t.id
    `;
    
    const result = await pool.query(query, [parseInt(id)]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }
    
    res.json({
      success: true,
      data: result.rows[0]
    });
    
  } catch (error) {
    console.error('Error fetching tenant:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching tenant',
      error: error.message
    });
  }
});

// Create new tenant
router.post('/tenants', async (req, res) => {
  try {
    const {
      first_name,
      last_name,
      email,
      phone,
      alternate_phone,
      date_of_birth,
      identification_type,
      identification_number,
      emergency_contact_name,
      emergency_contact_phone,
      emergency_contact_relationship,
      employment_status,
      employer_name,
      employer_phone,
      monthly_income,
      previous_address
    } = req.body;
    
    // Validate required fields
    if (!first_name || !last_name || !email) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: first_name, last_name, email'
      });
    }
    
    // Check if email already exists
    const emailCheck = await pool.query(
      'SELECT id FROM tenants WHERE email = $1',
      [email]
    );
    
    if (emailCheck.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'A tenant with this email already exists'
      });
    }
    
    const result = await pool.query(`
      INSERT INTO tenants (
        first_name, last_name, email, phone, alternate_phone,
        date_of_birth, identification_type, identification_number,
        emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
        employment_status, employer_name, employer_phone, monthly_income, previous_address
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING *
    `, [
      first_name, last_name, email, phone, alternate_phone,
      date_of_birth, identification_type, identification_number,
      emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
      employment_status, employer_name, employer_phone, monthly_income, previous_address
    ]);
    
    res.status(201).json({
      success: true,
      data: result.rows[0],
      message: 'Tenant created successfully'
    });
    
  } catch (error) {
    console.error('Error creating tenant:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating tenant',
      error: error.message
    });
  }
});

// UTILITIES ROUTES
// Get all utilities
router.get('/utilities', async (req, res) => {
  try {
    const query = `
      SELECT 
        id,
        name,
        description,
        (SELECT COUNT(*) FROM property_utilities WHERE utility_id = utilities.id) as property_count,
        (SELECT COUNT(*) FROM unit_utilities WHERE utility_id = utilities.id) as unit_count
      FROM utilities 
      ORDER BY name
    `;
    
    const result = await pool.query(query);
    
    res.json({
      success: true,
      data: result.rows
    });
    
  } catch (error) {
    console.error('Error fetching utilities:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching utilities',
      error: error.message
    });
  }
});

// Get single utility by ID
router.get('/utilities/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Validate that id is a number
    if (isNaN(parseInt(id))) {
      return res.status(400).json({
        success: false,
        message: 'Invalid utility ID'
      });
    }
    
    const result = await pool.query(
      'SELECT * FROM utilities WHERE id = $1',
      [parseInt(id)]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Utility not found'
      });
    }
    
    res.json({
      success: true,
      data: result.rows[0]
    });
    
  } catch (error) {
    console.error('Error fetching utility:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching utility',
      error: error.message
    });
  }
});

// Create new utility
router.post('/utilities', async (req, res) => {
  try {
    const { name, description } = req.body;
    
    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'Utility name is required'
      });
    }
    
    // Check if utility name already exists
    const nameCheck = await pool.query(
      'SELECT id FROM utilities WHERE name = $1',
      [name]
    );
    
    if (nameCheck.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'A utility with this name already exists'
      });
    }
    
    const result = await pool.query(`
      INSERT INTO utilities (name, description)
      VALUES ($1, $2)
      RETURNING *
    `, [name, description]);
    
    res.status(201).json({
      success: true,
      data: result.rows[0],
      message: 'Utility created successfully'
    });
    
  } catch (error) {
    console.error('Error creating utility:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating utility',
      error: error.message
    });
  }
});

// PROPERTIES ROUTES
// Get all properties with basic info
router.get('/properties', async (req, res) => {
  try {
    const query = `
      SELECT 
        p.id,
        p.property_name,
        p.address,
        p.property_type,
        p.total_units,
        COUNT(u.id) as actual_units,
        COUNT(CASE WHEN u.occupancy_status = 'occupied' THEN 1 END) as occupied_units,
        COUNT(CASE WHEN u.occupancy_status = 'vacant' THEN 1 END) as vacant_units
      FROM properties p
      LEFT JOIN units u ON p.id = u.property_id
      GROUP BY p.id, p.property_name, p.address, p.property_type, p.total_units
      ORDER BY p.property_name
    `;
    
    const result = await pool.query(query);
    
    res.json({
      success: true,
      data: result.rows
    });
    
  } catch (error) {
    console.error('Error fetching properties:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching properties',
      error: error.message
    });
  }
});

// Get single property by ID
router.get('/properties/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Validate that id is a number
    if (isNaN(parseInt(id))) {
      return res.status(400).json({
        success: false,
        message: 'Invalid property ID'
      });
    }
    
    const query = `
      SELECT 
        p.*,
        COUNT(u.id) as total_units_actual,
        COUNT(CASE WHEN u.occupancy_status = 'occupied' THEN 1 END) as occupied_units,
        COUNT(CASE WHEN u.occupancy_status = 'vacant' THEN 1 END) as vacant_units,
        COUNT(CASE WHEN u.occupancy_status = 'maintenance' THEN 1 END) as maintenance_units
      FROM properties p
      LEFT JOIN units u ON p.id = u.property_id
      WHERE p.id = $1
      GROUP BY p.id
    `;
    
    const result = await pool.query(query, [parseInt(id)]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }
    
    res.json({
      success: true,
      data: result.rows[0]
    });
    
  } catch (error) {
    console.error('Error fetching property:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching property',
      error: error.message
    });
  }
});

export default router;