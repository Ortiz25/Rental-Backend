import express from 'express';
import pool from '../config/database.js';
import { authenticateToken,authorizeRole, authenticateTokenSimple} from '../middleware/auth.js';

const router = express.Router();

// Get available amenities - MOVED BEFORE parameterized routes
router.get('/amenities', authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const result = await client.query('SELECT * FROM amenities ORDER BY name');
    
    res.status(200).json({
      status: 200,
      message: 'Amenities retrieved successfully',
      data: result.rows
    });

  } catch (error) {
    console.error('Amenities fetch error:', error);
    
    res.status(500).json({
      status: 500,
      message: 'Failed to fetch amenities'
    });
  } finally {
    client.release();
  }
});

// Create new property - MOVED BEFORE parameterized routes
router.post('/', authenticateTokenSimple, authorizeRole(['Super Admin', 'Admin', 'Manager']), async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    const {
      propertyName,
      address,
      propertyType,
      totalUnits = 1,
      sizeSquareFt,
      monthlyRent,
      securityDeposit,
      description,
      amenities = [],
      units = []
    } = req.body;

    // Validate required fields
    if (!propertyName || !address || !propertyType) {
      return res.status(400).json({
        status: 400,
        message: 'Property name, address, and type are required'
      });
    }

    // Insert property
    const propertyQuery = `
      INSERT INTO properties (
        property_name, address, property_type, total_units, 
        size_sq_ft, monthly_rent, security_deposit, description
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `;

    const propertyResult = await client.query(propertyQuery, [
      propertyName,
      address,
      propertyType,
      totalUnits,
      sizeSquareFt,
      monthlyRent,
      securityDeposit,
      description
    ]);

    const newProperty = propertyResult.rows[0];

    // Add amenities if provided
    if (amenities && amenities.length > 0) {
      for (const amenityName of amenities) {
        // Get or create amenity
        const amenityResult = await client.query(
          'INSERT INTO amenities (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id',
          [amenityName]
        );
        
        const amenityId = amenityResult.rows[0].id;
        
        // Link to property
        await client.query(
          'INSERT INTO property_amenities (property_id, amenity_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [newProperty.id, amenityId]
        );
      }
    }

    // FIXED: Handle unit creation logic properly
    if (units && units.length > 0) {
      // For properties with explicit units, we need to handle the trigger-created unit
      if (propertyType !== 'Apartment' && totalUnits === 1) {
        // The trigger already created a "Main" unit, so we should update it instead of inserting
        const unit = units[0]; // Assuming single unit for non-apartment properties
        
        if (unit.unitNumber === 'Main' || !unit.unitNumber) {
          // Update the trigger-created unit
          await client.query(
            `UPDATE units SET 
              bedrooms = $1, 
              bathrooms = $2, 
              size_sq_ft = $3, 
              monthly_rent = $4, 
              security_deposit = $5, 
              occupancy_status = $6,
              updated_at = CURRENT_TIMESTAMP
            WHERE property_id = $7 AND unit_number = 'Main'`,
            [
              unit.bedrooms || 0,
              unit.bathrooms || 0,
              unit.sizeSquareFt || sizeSquareFt,
              unit.monthlyRent || monthlyRent,
              unit.securityDeposit || securityDeposit,
              unit.occupancyStatus || 'vacant',
              newProperty.id
            ]
          );
        } else {
          // Delete the trigger-created unit and insert the custom one
          await client.query('DELETE FROM units WHERE property_id = $1 AND unit_number = $2', [newProperty.id, 'Main']);
          
          await client.query(
            `INSERT INTO units (
              property_id, unit_number, bedrooms, bathrooms, 
              size_sq_ft, monthly_rent, security_deposit, occupancy_status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              newProperty.id,
              unit.unitNumber,
              unit.bedrooms || 0,
              unit.bathrooms || 0,
              unit.sizeSquareFt || sizeSquareFt,
              unit.monthlyRent || monthlyRent,
              unit.securityDeposit || securityDeposit,
              unit.occupancyStatus || 'vacant'
            ]
          );
        }
      } else {
        // For apartments or multi-unit properties, insert all units normally
        // The trigger won't create a default unit for apartments
        for (const unit of units) {
          await client.query(
            `INSERT INTO units (
              property_id, unit_number, bedrooms, bathrooms, 
              size_sq_ft, monthly_rent, security_deposit, occupancy_status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              newProperty.id,
              unit.unitNumber || 'Main',
              unit.bedrooms || 0,
              unit.bathrooms || 0,
              unit.sizeSquareFt || sizeSquareFt,
              unit.monthlyRent || monthlyRent,
              unit.securityDeposit || securityDeposit,
              unit.occupancyStatus || 'vacant'
            ]
          );
        }
      }
    }
    // If no units provided, the trigger will handle creating the default unit for non-apartments

    // Log activity
    await client.query(
      `INSERT INTO user_activity_log 
       (user_id, activity_type, activity_description, affected_resource_type, affected_resource_id, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        req.user.id,
        'property_created',
        `Created new property: ${propertyName}`,
        'property',
        newProperty.id,
        req.ip,
        req.headers['user-agent']
      ]
    );

    await client.query('COMMIT');

    res.status(201).json({
      status: 201,
      message: 'Property created successfully',
      data: newProperty
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Property creation error:', error);
    
    res.status(500).json({
      status: 500,
      message: 'Failed to create property',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
});

// Get all properties with summary statistics
router.get('/', authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();
  
  try {
    console.log('Fetching properties for user:', req.user.id);

    // Main query to get properties with unit statistics and amenities
    const propertiesQuery = `
      SELECT 
        p.id,
        p.property_name,
        p.address,
        p.property_type,
        p.total_units,
        p.size_sq_ft,
        p.monthly_rent as base_monthly_rent,
        p.security_deposit as base_security_deposit,
        p.description,
        p.created_at,
        
        -- Unit statistics
        COUNT(u.id) as actual_units,
        COUNT(CASE WHEN u.occupancy_status = 'occupied' THEN 1 END) as occupied_units,
        COUNT(CASE WHEN u.occupancy_status = 'vacant' THEN 1 END) as vacant_units,
        COUNT(CASE WHEN u.occupancy_status = 'maintenance' THEN 1 END) as maintenance_units,
        
        -- Occupancy calculations
        CASE 
          WHEN COUNT(u.id) > 0 THEN 
            ROUND((COUNT(CASE WHEN u.occupancy_status = 'occupied' THEN 1 END)::DECIMAL / COUNT(u.id)) * 100, 2)
          ELSE 0
        END as occupancy_rate,
        
        -- Rent range from units
        MIN(u.monthly_rent) as min_unit_rent,
        MAX(u.monthly_rent) as max_unit_rent,
        AVG(u.monthly_rent) as avg_unit_rent,
        
        -- Unit details for multi-unit properties
        CASE 
          WHEN COUNT(u.id) > 1 THEN 
            JSON_AGG(
              JSON_BUILD_OBJECT(
                'id', u.id,
                'unit_number', u.unit_number,
                'bedrooms', u.bedrooms,
                'bathrooms', u.bathrooms,
                'size_sq_ft', u.size_sq_ft,
                'monthly_rent', u.monthly_rent,
                'occupancy_status', u.occupancy_status
              ) ORDER BY u.unit_number
            )
          ELSE NULL
        END as units,
        
        -- Primary unit info (for single-unit properties or average)
        COALESCE(AVG(u.bedrooms), 0) as bedrooms,
        COALESCE(AVG(u.bathrooms), 0) as bathrooms
        
      FROM properties p
      LEFT JOIN units u ON p.id = u.property_id
      GROUP BY p.id, p.property_name, p.address, p.property_type, p.total_units, 
               p.size_sq_ft, p.monthly_rent, p.security_deposit, p.description, p.created_at
      ORDER BY p.created_at DESC
    `;

    const propertiesResult = await client.query(propertiesQuery);

    // Get amenities for each property
    const amenitiesQuery = `
      SELECT 
        pa.property_id,
        JSON_AGG(a.name ORDER BY a.name) as amenities
      FROM property_amenities pa
      JOIN amenities a ON pa.amenity_id = a.id
      WHERE pa.property_id = ANY($1)
      GROUP BY pa.property_id
    `;

    const propertyIds = propertiesResult.rows.map(p => p.id);
    let amenitiesResult = { rows: [] };
    
    if (propertyIds.length > 0) {
      amenitiesResult = await client.query(amenitiesQuery, [propertyIds]);
    }

    // Create amenities lookup
    const amenitiesLookup = {};
    amenitiesResult.rows.forEach(row => {
      amenitiesLookup[row.property_id] = row.amenities || [];
    });

    // Format the response data
    const formattedProperties = propertiesResult.rows.map(property => {
      // Determine occupancy state
      let occupancyState = 'Empty';
      if (property.occupied_units === property.actual_units && property.actual_units > 0) {
        occupancyState = 'Full';
      } else if (property.occupied_units > 0) {
        occupancyState = 'Partial';
      }

      // Determine overall occupancy status for the property
      let occupancyStatus = 'Vacant';
      if (property.property_type === 'Apartment' && property.actual_units > 1) {
        // For multi-unit properties, use occupancy state
        occupancyStatus = occupancyState;
      } else {
        // For single properties, use the unit status
        occupancyStatus = property.occupied_units > 0 ? 'Occupied' : 'Vacant';
      }

      return {
        id: property.id,
        propertyName: property.property_name,
        address: property.address,
        type: property.property_type,
        bedrooms: Math.round(property.bedrooms) || 0,
        bathrooms: parseFloat(property.bathrooms) || 0,
        squareFootage: property.size_sq_ft || 0,
        monthlyRent:  parseFloat(property.base_monthly_rent) || 0,
        minRent: parseFloat(property.min_unit_rent) || parseFloat(property.base_monthly_rent) || 0,
        maxRent: parseFloat(property.max_unit_rent) || parseFloat(property.base_monthly_rent) || 0,
        securityDeposit: parseFloat(property.base_security_deposit) || 0,
        description: property.description,
        
        // Occupancy information
        occupancyStatus: occupancyStatus,
        occupancyState: occupancyState,
        occupancyRate: parseFloat(property.occupancy_rate) || 0,
        
        // Unit statistics - FIXED: Ensure these are numbers, not strings
        totalUnits: parseInt(property.actual_units || property.total_units || 1, 10),
        occupiedUnits: parseInt(property.occupied_units || 0, 10),
        vacantUnits: parseInt(property.vacant_units || 0, 10),
        maintenanceUnits: parseInt(property.maintenance_units || 0, 10),
        
        // Additional data
        amenities: amenitiesLookup[property.id] || [],
        units: property.units, // Detailed unit info for multi-unit properties
        createdAt: property.created_at
      };
    });

    // Calculate portfolio statistics - FIXED: Now properly sums numbers
    const portfolioStats = {
      totalProperties: formattedProperties.length,
      totalUnits: formattedProperties.reduce((sum, prop) => sum + prop.totalUnits, 0),
      totalOccupiedUnits: formattedProperties.reduce((sum, prop) => sum + prop.occupiedUnits, 0),
      totalVacantUnits: formattedProperties.reduce((sum, prop) => sum + prop.vacantUnits, 0),
      totalMaintenanceUnits: formattedProperties.reduce((sum, prop) => sum + prop.maintenanceUnits, 0),
      overallOccupancyRate: 0
    };

    if (portfolioStats.totalUnits > 0) {
      portfolioStats.overallOccupancyRate = parseFloat(
        ((portfolioStats.totalOccupiedUnits / portfolioStats.totalUnits) * 100).toFixed(2)
      );
    }

    // Log activity
    await client.query(
      `INSERT INTO user_activity_log 
       (user_id, activity_type, activity_description, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.user.id,
        'properties_viewed',
        'Viewed properties list',
        req.ip,
        req.headers['user-agent']
      ]
    );

    res.status(200).json({
      status: 200,
      message: 'Properties retrieved successfully',
      data: {
        properties: formattedProperties,
        portfolioStats: portfolioStats,
        totalCount: formattedProperties.length
      }
    });

  } catch (error) {
    console.error('Properties fetch error:', error);
    
    res.status(500).json({
      status: 500,
      message: 'Failed to fetch properties',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
});

// Get single property by ID with detailed information - MOVED AFTER GET /
router.get('/:id', authenticateTokenSimple, authorizeRole(['Super Admin', 'Admin', 'Manager', 'Staff']), async (req, res) => {
  const client = await pool.connect();
  
  try {
    const propertyId = req.params.id;

    const propertyQuery = `
      SELECT 
        p.*,
        COUNT(u.id) as actual_units,
        COUNT(CASE WHEN u.occupancy_status = 'occupied' THEN 1 END) as occupied_units,
        COUNT(CASE WHEN u.occupancy_status = 'vacant' THEN 1 END) as vacant_units,
        COUNT(CASE WHEN u.occupancy_status = 'maintenance' THEN 1 END) as maintenance_units,
        JSON_AGG(
          CASE WHEN u.id IS NOT NULL THEN
            JSON_BUILD_OBJECT(
              'id', u.id,
              'unit_number', u.unit_number,
              'bedrooms', u.bedrooms,
              'bathrooms', u.bathrooms,
              'size_sq_ft', u.size_sq_ft,
              'monthly_rent', u.monthly_rent,
              'security_deposit', u.security_deposit,
              'occupancy_status', u.occupancy_status
            )
          ELSE NULL
          END
        ) FILTER (WHERE u.id IS NOT NULL) as units
      FROM properties p
      LEFT JOIN units u ON p.id = u.property_id
      WHERE p.id = $1
      GROUP BY p.id
    `;

    const propertyResult = await client.query(propertyQuery, [propertyId]);

    if (propertyResult.rows.length === 0) {
      return res.status(404).json({
        status: 404,
        message: 'Property not found'
      });
    }

    // Get amenities
    const amenitiesQuery = `
      SELECT a.name
      FROM property_amenities pa
      JOIN amenities a ON pa.amenity_id = a.id
      WHERE pa.property_id = $1
      ORDER BY a.name
    `;

    const amenitiesResult = await client.query(amenitiesQuery, [propertyId]);

    const property = propertyResult.rows[0];
    const amenities = amenitiesResult.rows.map(row => row.name);

    res.status(200).json({
      status: 200,
      message: 'Property retrieved successfully',
      data: {
        ...property,
        amenities: amenities,
        units: property.units || []
      }
    });

  } catch (error) {
    console.error('Property fetch error:', error);
    
    res.status(500).json({
      status: 500,
      message: 'Failed to fetch property',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
});

// Update property
router.put('/:id', authenticateTokenSimple, authorizeRole(['Super Admin', 'Admin', 'Manager']), async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const propertyId = req.params.id;
    const {
      propertyName,
      address,
      propertyType,
      totalUnits,
      sizeSquareFt,
      monthlyRent,
      securityDeposit,
      description,
      amenities = []
    } = req.body;
    
    // Update property
    const updateQuery = `
      UPDATE properties SET 
        property_name = $1,
        address = $2,
        property_type = $3,
        total_units = $4,
        size_sq_ft = $5,
        monthly_rent = $6,
        security_deposit = $7,
        description = $8,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $9
      RETURNING *
    `;

    const result = await client.query(updateQuery, [
      propertyName,
      address,
      propertyType,
      totalUnits,
      sizeSquareFt,
      monthlyRent,
      securityDeposit,
      description,
      propertyId
    ]);

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        status: 404,
        message: 'Property not found'
      });
    }

    // Update amenities (remove old ones and add new ones)
    await client.query('DELETE FROM property_amenities WHERE property_id = $1', [propertyId]);
    
    if (amenities && amenities.length > 0) {
      for (const amenityName of amenities) {
        const amenityResult = await client.query(
          'INSERT INTO amenities (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id',
          [amenityName]
        );
        
        const amenityId = amenityResult.rows[0].id;
        
        await client.query(
          'INSERT INTO property_amenities (property_id, amenity_id) VALUES ($1, $2)',
          [propertyId, amenityId]
        );
      }
    }

    // Log activity
    await client.query(
      `INSERT INTO user_activity_log 
       (user_id, activity_type, activity_description, affected_resource_type, affected_resource_id, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        req.user.id,
        'property_updated',
        `Updated property: ${propertyName}`,
        'property',
        propertyId,
        req.ip,
        req.headers['user-agent']
      ]
    );

    await client.query('COMMIT');

    res.status(200).json({
      status: 200,
      message: 'Property updated successfully',
      data: result.rows[0]
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Property update error:', error);
    
    res.status(500).json({
      status: 500,
      message: 'Failed to update property',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
});

// Delete property
router.delete('/:id', authenticateTokenSimple, authorizeRole(['Super Admin', 'Admin']), async (req, res) => {
    const client = await pool.connect();
    
    try {
      const propertyId = req.params.id;
  
      // Check if property has active leases
      const leaseCheck = await client.query(
        `SELECT COUNT(*) as count FROM leases l 
         JOIN units u ON l.unit_id = u.id 
         WHERE u.property_id = $1 AND l.lease_status = 'active'`,
        [propertyId]
      );
  
      if (parseInt(leaseCheck.rows[0].count) > 0) {
        return res.status(400).json({
          status: 400,
          message: 'Cannot delete property with active leases. Please terminate all leases first.'
        });
      }
  
      // Check if property has occupied units
      const occupancyCheck = await client.query(
        `SELECT COUNT(*) as count FROM units 
         WHERE property_id = $1 AND occupancy_status = 'occupied'`,
        [propertyId]
      );
  
      if (parseInt(occupancyCheck.rows[0].count) > 0) {
        return res.status(400).json({
          status: 400,
          message: 'Cannot delete property with occupied units. Please move or terminate all tenants first.'
        });
      }
  
      // Get property name for logging
      const propertyResult = await client.query(
        'SELECT property_name FROM properties WHERE id = $1',
        [propertyId]
      );
  
      if (propertyResult.rows.length === 0) {
        return res.status(404).json({
          status: 404,
          message: 'Property not found'
        });
      }
  
      const propertyName = propertyResult.rows[0].property_name;
  
      // Delete property (CASCADE will handle related records)
      await client.query('DELETE FROM properties WHERE id = $1', [propertyId]);
  
      // Log activity
      await client.query(
        `INSERT INTO user_activity_log 
         (user_id, activity_type, activity_description, affected_resource_type, affected_resource_id, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          req.user.id,
          'property_deleted',
          `Deleted property: ${propertyName}`,
          'property',
          propertyId,
          req.ip,
          req.headers['user-agent']
        ]
      );
  
      res.status(200).json({
        status: 200,
        message: 'Property deleted successfully'
      });
  
    } catch (error) {
      console.error('Property deletion error:', error);
      
      res.status(500).json({
        status: 500,
        message: 'Failed to delete property',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    } finally {
      client.release();
    }
  });

// Get units for a specific property
router.get('/:propertyId/units', authenticateTokenSimple, async (req, res) => {
    const client = await pool.connect();
    
    try {
      const { propertyId } = req.params;
  
      const unitsQuery = `
        SELECT 
          u.*,
          CASE 
            WHEN l.id IS NOT NULL AND l.lease_status = 'active' THEN 
              JSON_BUILD_OBJECT(
                'lease_id', l.id,
                'lease_number', l.lease_number,
                'tenant_names', (
                  SELECT STRING_AGG(t.first_name || ' ' || t.last_name, ', ')
                  FROM lease_tenants lt
                  JOIN tenants t ON lt.tenant_id = t.id
                  WHERE lt.lease_id = l.id AND lt.removed_date IS NULL
                ),
                'start_date', l.start_date,
                'end_date', l.end_date,
                'monthly_rent', l.monthly_rent
              )
            ELSE NULL
          END as current_lease
        FROM units u
        LEFT JOIN leases l ON u.id = l.unit_id AND l.lease_status = 'active'
        WHERE u.property_id = $1
        ORDER BY u.unit_number
      `;
  
      const result = await client.query(unitsQuery, [propertyId]);
  
      res.status(200).json({
        status: 200,
        message: 'Units retrieved successfully',
        data: result.rows
      });
  
    } catch (error) {
      console.error('Units fetch error:', error);
      
      res.status(500).json({
        status: 500,
        message: 'Failed to fetch units',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    } finally {
      client.release();
    }
  });

// Update specific unit within a property
router.put('/:propertyId/units/:unitId', authenticateTokenSimple, async (req, res) => {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const { propertyId, unitId } = req.params;
      const {
        unitNumber,
        bedrooms = 0,
        bathrooms = 0,
        sizeSquareFt,
        monthlyRent,
        securityDeposit,
        occupancyStatus = 'vacant'
      } = req.body;
  
      // Validate that the unit belongs to the property
      const unitCheck = await client.query(
        'SELECT id FROM units WHERE id = $1 AND property_id = $2',
        [unitId, propertyId]
      );
  
      if (unitCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          status: 404,
          message: 'Unit not found in this property'
        });
      }
  
      // Check if unit number is unique within the property (excluding current unit)
      const duplicateCheck = await client.query(
        'SELECT id FROM units WHERE property_id = $1 AND unit_number = $2 AND id != $3',
        [propertyId, unitNumber, unitId]
      );
  
      if (duplicateCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          status: 400,
          message: 'Unit number already exists in this property'
        });
      }
  
      // Update unit
      const updateQuery = `
        UPDATE units SET 
          unit_number = $1,
          bedrooms = $2,
          bathrooms = $3,
          size_sq_ft = $4,
          monthly_rent = $5,
          security_deposit = $6,
          occupancy_status = $7,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $8 AND property_id = $9
        RETURNING *
      `;
  
      const result = await client.query(updateQuery, [
        unitNumber,
        bedrooms,
        bathrooms,
        sizeSquareFt,
        monthlyRent,
        securityDeposit,
        occupancyStatus,
        unitId,
        propertyId
      ]);
  
      // Get property name for logging
      const propertyResult = await client.query(
        'SELECT property_name FROM properties WHERE id = $1',
        [propertyId]
      );
      const propertyName = propertyResult.rows[0]?.property_name || 'Unknown';
  
      // Log activity
      await client.query(
        `INSERT INTO user_activity_log 
         (user_id, activity_type, activity_description, affected_resource_type, affected_resource_id, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          req.user.id,
          'unit_updated',
          `Updated unit ${unitNumber} in property: ${propertyName}`,
          'unit',
          unitId,
          req.ip,
          req.headers['user-agent']
        ]
      );
  
      await client.query('COMMIT');
  
      res.status(200).json({
        status: 200,
        message: 'Unit updated successfully',
        data: result.rows[0]
      });
  
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Unit update error:', error);
      
      res.status(500).json({
        status: 500,
        message: 'Failed to update unit',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    } finally {
      client.release();
    }
  });

export default router